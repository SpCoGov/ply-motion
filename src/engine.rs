use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri_plugin_dialog::DialogExt;

struct Process {
    child: Mutex<Child>,
    io: Mutex<(ChildStdin, BufReader<ChildStdout>)>,
}
impl Drop for Process {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[derive(Default)]
pub struct EngineState(Mutex<HashMap<u64, Arc<Process>>>);
impl EngineState {
    pub fn stop_all(&self) {
        if let Ok(mut engines) = self.0.lock() {
            for (_, engine) in engines.drain() {
                if let Ok(mut child) = engine.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

#[tauri::command]
pub async fn pick_engine(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("UCI 引擎", &["exe"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        Ok(Some(
            path.canonicalize()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn executable(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择本机 UCI 引擎的 .exe 文件".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_engine(state: tauri::State<EngineState>, path: String) -> Result<u64, String> {
    let path = executable(&path)?;
    let mut engines = state.0.lock().map_err(|e| e.to_string())?;
    if engines.len() >= 4 {
        return Err("已有过多引擎进程，请先停止引擎".into());
    }
    let mut command = Command::new(&path);
    command.current_dir(path.parent().ok_or("引擎目录无效")?);
    let process = spawn_process(command)?;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    engines.insert(id, process);
    Ok(id)
}

fn spawn_process(mut command: Command) -> Result<Arc<Process>, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| format!("无法启动引擎：{e}"))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    Ok(Arc::new(Process {
        child: Mutex::new(child),
        io: Mutex::new((stdin, stdout)),
    }))
}

fn end_token(commands: &[String]) -> Result<&'static str, String> {
    if commands.is_empty()
        || commands.len() > 32
        || commands
            .iter()
            .any(|c| c.len() > 256_000 || c.contains(['\r', '\n', '\0']))
    {
        return Err("无效的 UCI 命令".into());
    }
    if commands.iter().any(|c| {
        !["uci", "isready", "ucinewgame"].contains(&c.as_str())
            && !["setoption name ", "position fen ", "go "]
                .iter()
                .any(|p| c.starts_with(p))
    }) {
        return Err("不支持的 UCI 命令".into());
    }
    match commands.last().unwrap().as_str() {
        "uci" => Ok("uciok"),
        "isready" => Ok("readyok"),
        last if last.starts_with("go ") => Ok("bestmove "),
        _ => Err("UCI 请求缺少结束条件".into()),
    }
}

#[tauri::command]
pub async fn engine_exchange(
    state: tauri::State<'_, EngineState>,
    id: u64,
    commands: Vec<String>,
) -> Result<Vec<String>, String> {
    end_token(&commands)?;
    let engine = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("引擎已停止")?;
    tauri::async_runtime::spawn_blocking(move || exchange(&engine, &commands))
        .await
        .map_err(|e| e.to_string())?
}

fn exchange(engine: &Process, commands: &[String]) -> Result<Vec<String>, String> {
    let end = end_token(commands)?;
    let mut io = engine.io.lock().map_err(|e| e.to_string())?;
    for command in commands {
        writeln!(io.0, "{command}").map_err(|e| e.to_string())?;
    }
    io.0.flush().map_err(|e| e.to_string())?;
    let mut lines = Vec::new();
    let mut total = 0;
    loop {
        let mut line = String::new();
        let bytes =
            io.1.by_ref()
                .take(64 * 1024)
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
        if bytes == 0 {
            return Err("引擎意外退出，请检查引擎文件及其所需的网络文件".into());
        }
        total += bytes;
        if bytes >= 64 * 1024 || total > 8 * 1024 * 1024 || lines.len() >= 20000 {
            return Err("引擎输出超出限制".into());
        }
        let line = line.trim_end().to_string();
        let done = if end == "bestmove " {
            line.starts_with(end)
        } else {
            line == end
        };
        lines.push(line);
        if done {
            return Ok(lines);
        }
    }
}

#[tauri::command]
pub fn stop_engine(state: tauri::State<EngineState>, id: u64) -> Result<(), String> {
    if let Some(engine) = state.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        let mut child = engine.child.lock().map_err(|e| e.to_string())?;
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
