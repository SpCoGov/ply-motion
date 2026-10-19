use serde::Deserialize;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSettings {
    width: u32,
    height: u32,
    fps: u32,
    crf: u32,
    bitrate: u32,
    frames: u32,
    sound: bool,
}

impl VideoSettings {
    fn validate(&self) -> Result<(), String> {
        if !(256..=3840).contains(&self.width)
            || !(256..=3840).contains(&self.height)
            || self.width % 2 != 0
            || self.height % 2 != 0
            || u64::from(self.width) * u64::from(self.height) > 3840 * 2160
            || ![24, 25, 30, 50, 60].contains(&self.fps)
            || self.crf > 40
            || self.bitrate > 100_000
            || (self.bitrate > 0 && self.bitrate < 500)
            || self.frames == 0
            || self.frames > self.fps * 600 + 1
        {
            return Err(
                "视频参数无效：尺寸需为 256–3840 的偶数，最多 4K 像素，视频最长 10 分钟".into(),
            );
        }
        Ok(())
    }
}

fn ffmpeg(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn resolve_ffmpeg(path: Option<String>) -> Result<PathBuf, String> {
    let path = path.unwrap_or_default();
    let path = path.trim();
    if path.is_empty() {
        return Ok(PathBuf::from("ffmpeg"));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path.is_file()
        || cfg!(windows)
            && !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择 FFmpeg 可执行文件的完整路径".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

fn ffmpeg_encoders(path: &Path) -> Result<String, String> {
    let mut child = ffmpeg(path)
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动 FFmpeg，请在「导出 → FFmpeg 设置」中检查程序路径：{e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 FFmpeg 输出")?;
    let output = std::thread::spawn(move || {
        let mut text = String::new();
        stdout
            .take(1_000_000)
            .read_to_string(&mut text)
            .map(|_| text)
    });
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(e) => break Err(e.to_string()),
            _ => {}
        }
        if started.elapsed() > Duration::from_secs(10) {
            break Err("FFmpeg 检测超时，请检查所选程序".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if !status.success() {
        return Err("FFmpeg 检测失败，请选择正确的 FFmpeg 可执行文件".into());
    }
    output
        .join()
        .map_err(|_| "无法读取 FFmpeg 输出")?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_ffmpeg(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("选择 FFmpeg 可执行文件")
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        Ok(Some(
            resolve_ffmpeg(Some(path.to_string_lossy().into_owned()))?
                .to_string_lossy()
                .into_owned(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_ffmpeg(path: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let encoders = ffmpeg_encoders(&resolve_ffmpeg(path)?)?;
        if !encoders.contains("libx264 ") {
            return Err("FFmpeg 缺少 H.264（libx264）编码器".into());
        }
        Ok(if encoders.contains(" aac ") {
            "FFmpeg 已就绪，支持 H.264 和 AAC。"
        } else {
            "FFmpeg 支持 H.264；缺少 AAC，只能导出无音效视频。"
        }
        .into())
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Writer {
    pipe: Option<ChildStdin>,
    frames: u32,
}
struct Export {
    id: String,
    settings: VideoSettings,
    ffmpeg_path: PathBuf,
    target: PathBuf,
    dir: PathBuf,
    child: Mutex<Option<Child>>,
    writer: Mutex<Writer>,
    cancelled: AtomicBool,
}

impl Export {
    fn new(target: PathBuf, settings: VideoSettings, ffmpeg_path: PathBuf) -> Result<Self, String> {
        settings.validate()?;
        let parent = target.parent().ok_or("无效的保存目录")?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let (id, dir) = loop {
            let id = format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let dir = parent.join(format!(".plymotion-export-{id}"));
            match fs::create_dir(&dir) {
                Ok(()) => break (id, dir),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("无法创建导出临时目录：{e}")),
            }
        };
        Ok(Self {
            id,
            settings,
            ffmpeg_path,
            target,
            dir,
            child: Mutex::new(None),
            writer: Mutex::new(Writer {
                pipe: None,
                frames: 0,
            }),
            cancelled: AtomicBool::new(false),
        })
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("导出已取消".into())
        } else {
            Ok(())
        }
    }

    fn encoder(&self) -> Result<ChildStdin, String> {
        let mut slot = self.child.lock().unwrap();
        self.check_cancelled()?;
        let s = &self.settings;
        let mut cmd = ffmpeg(&self.ffmpeg_path);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "image2pipe",
            "-framerate",
        ])
        .arg(s.fps.to_string())
        .args(["-vcodec", "png", "-i", "pipe:0"]);
        if s.sound {
            let audio = self.dir.join("audio.wav");
            if !audio.is_file() {
                return Err("缺少视频音轨".into());
            }
            cmd.arg("-i").arg(audio).args([
                "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k",
            ]);
        } else {
            cmd.arg("-an");
        }
        cmd.args([
            "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-r",
        ])
        .arg(s.fps.to_string())
        .arg("-frames:v")
        .arg(s.frames.to_string());
        if s.bitrate == 0 {
            cmd.arg("-crf").arg(s.crf.to_string());
        } else {
            cmd.arg("-b:v").arg(format!("{}k", s.bitrate));
        }
        cmd.args(["-movflags", "+faststart"])
            .arg(self.dir.join("video.mp4"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(File::create(self.dir.join("ffmpeg.log")).map_err(|e| e.to_string())?);
        let mut child = cmd.spawn().map_err(|e| {
            format!("无法启动 FFmpeg，请在「导出 → FFmpeg 设置」中检查程序路径：{e}")
        })?;
        let pipe = child.stdin.take().ok_or("无法打开视频编码管道")?;
        *slot = Some(child);
        Ok(pipe)
    }

    fn write(&self, kind: &str, bytes: &[u8]) -> Result<(), String> {
        self.check_cancelled()?;
        let mut writer = self.writer.lock().unwrap();
        self.check_cancelled()?;
        if kind == "audio" {
            let samples =
                (u64::from(self.settings.frames) * 48_000).div_ceil(u64::from(self.settings.fps));
            if !self.settings.sound
                || writer.frames != 0
                || bytes.len() as u64 != 44 + samples * 2
                || bytes.get(..4) != Some(b"RIFF")
                || bytes.get(8..12) != Some(b"WAVE")
                || bytes.get(20..24) != Some(&[1, 0, 1, 0])
                || bytes.get(24..28) != Some(&48_000u32.to_le_bytes())
                || bytes.get(34..36) != Some(&16u16.to_le_bytes())
                || bytes.get(36..40) != Some(b"data")
            {
                return Err("无效的 48kHz 单声道 PCM 音轨".into());
            }
            return fs::write(self.dir.join("audio.wav"), bytes).map_err(|e| e.to_string());
        }
        if kind != "frame"
            || bytes.len() < 33
            || bytes.len() > 40_000_000
            || bytes[..8] != *b"\x89PNG\r\n\x1a\n"
            || &bytes[12..16] != b"IHDR"
            || bytes[16..20] != self.settings.width.to_be_bytes()
            || bytes[20..24] != self.settings.height.to_be_bytes()
            || writer.frames >= self.settings.frames
        {
            return Err("视频帧格式、尺寸或数量不正确".into());
        }
        if writer.pipe.is_none() {
            writer.pipe = Some(self.encoder()?);
        }
        writer
            .pipe
            .as_mut()
            .unwrap()
            .write_all(bytes)
            .map_err(|e| format!("视频编码中断：{e}。{}", self.log()))?;
        writer.frames += 1;
        Ok(())
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("ffmpeg.log"))
            .unwrap_or_default()
            .chars()
            .rev()
            .take(2000)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    }

    fn finish(&self) -> Result<String, String> {
        {
            let mut writer = self.writer.lock().unwrap();
            if writer.frames != self.settings.frames {
                return Err("视频帧未全部写入".into());
            }
            writer.pipe.take();
        }
        let started = Instant::now();
        loop {
            self.check_cancelled()?;
            let mut child = self.child.lock().unwrap();
            let status = child
                .as_mut()
                .ok_or("编码器未启动")?
                .try_wait()
                .map_err(|e| e.to_string())?;
            if let Some(status) = status {
                if !status.success() {
                    return Err(format!("FFmpeg 编码失败：{}", self.log()));
                }
                self.check_cancelled()?;
                // Only a completely encoded file replaces the chosen destination.
                fs::rename(self.dir.join("video.mp4"), &self.target)
                    .map_err(|e| format!("保存视频失败：{e}"))?;
                return Ok(self.target.to_string_lossy().into_owned());
            }
            drop(child);
            if started.elapsed() > Duration::from_secs(600) {
                self.cancel();
                return Err("视频编码超时".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn cancel(&self) {
        let mut slot = self.child.lock().unwrap();
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Export {
    fn drop(&mut self) {
        self.cancel();
        self.writer.lock().unwrap().pipe.take();
        self.child.lock().unwrap().take();
        for name in ["video.mp4", "audio.wav", "ffmpeg.log"] {
            let _ = fs::remove_file(self.dir.join(name));
        }
        let _ = fs::remove_dir(&self.dir);
    }
}

#[derive(Clone, Default)]
pub struct VideoState(Arc<Mutex<Option<Arc<Export>>>>);
impl VideoState {
    fn get(&self, id: &str) -> Result<Arc<Export>, String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|job| job.id == id)
            .cloned()
            .ok_or("导出任务已结束".into())
    }
    fn remove(&self, id: &str) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|job| job.id == id) {
            slot.take();
        }
    }
    pub fn cancel_all(&self) {
        if let Some(job) = self.0.lock().unwrap().take() {
            job.cancel();
        }
    }
}

#[tauri::command]
pub async fn start_video_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, VideoState>,
    settings: VideoSettings,
    path: Option<String>,
) -> Result<Option<String>, String> {
    settings.validate()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = state.0.lock().unwrap();
        if slot.is_some() {
            return Err("已有视频正在导出".into());
        }
        let ffmpeg_path = resolve_ffmpeg(path)?;
        let encoders = ffmpeg_encoders(&ffmpeg_path)?;
        if !encoders.contains("libx264 ") || settings.sound && !encoders.contains(" aac ") {
            return Err("FFmpeg 缺少 H.264 / AAC 编码器".into());
        }
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("MP4 视频", &["mp4"])
            .set_file_name("plymotion.mp4")
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let mut target = file.into_path().map_err(|e| e.to_string())?;
        if target.extension().is_none() {
            target.set_extension("mp4");
        }
        if !target
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
        {
            return Err("请选择 .mp4 文件名".into());
        }
        let job = Arc::new(Export::new(target, settings, ffmpeg_path)?);
        let id = job.id.clone();
        *slot = Some(job);
        Ok(Some(id))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_video_data(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, VideoState>,
) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-export-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少导出任务编号")?;
    let kind = request
        .headers()
        .get("x-export-kind")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少数据类型")?
        .to_owned();
    let job = state.get(id)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要二进制数据".into());
    };
    if bytes.len() > 60_000_000 {
        return Err("视频数据块过大".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || job.write(&kind, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finish_video_export(
    state: tauri::State<'_, VideoState>,
    id: String,
) -> Result<String, String> {
    let job = state.get(&id)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = job.finish();
        state.remove(&id);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_video_export(
    state: tauri::State<'_, VideoState>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(job) = state.get(&id) {
            job.cancel();
            state.remove(&id);
        }
    })
    .await
    .map_err(|e| e.to_string())
}
