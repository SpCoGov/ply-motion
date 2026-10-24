use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Default)]
pub struct ProjectState(pub AtomicBool);

#[derive(Serialize)]
pub struct OpenedProject {
    path: String,
    content: String,
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err("工程文件不能超过 64 MB".into());
    }
    let data: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("工程 JSON 无效：{e}"))?;
    if ![1, 2, 3, 4].iter().any(|v| data["schemaVersion"] == *v)
        || data["director"]["id"] != "classic"
        || data["director"]["version"] != if data["schemaVersion"] == 1 { 1 } else { 2 }
    {
        return Err("不支持此工程或导演预设版本，请使用兼容版本的 PlyMotion".into());
    }
    Ok(())
}

fn project_path(path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("plymotion"))
    {
        return Err("请选择 .plymotion 工程文件".into());
    }
    Ok(())
}

fn read_project_with(
    path: &Path,
    relocate: impl FnMut(&str) -> Result<PathBuf, String>,
) -> Result<String, String> {
    project_path(path)?;
    let mut content = String::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| format!("读取工程失败：{e}"))?;
    validate_content(&content)?;
    crate::media::hydrate(path, &content, relocate)
}

// Same-directory rename replaces on both Unix and Windows. Never delete the
// destination first: a locked destination or failed write must leave it intact.
fn write_project(path: &Path, content: &str) -> Result<(), String> {
    project_path(path)?;
    validate_content(content)?;
    let content = crate::media::externalize(path, content)?;
    let parent = path.parent().ok_or("保存目录无效")?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let (temp, mut file) = loop {
        let temp = parent.join(format!(
            ".plymotion-save-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => break (temp, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法创建工程临时文件：{e}")),
        }
    };
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e: std::io::Error| format!("保存工程失败，原文件保持不变：{e}"))
}

#[tauri::command]
pub async fn open_project(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<Option<OpenedProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = if let Some(path) = path {
            PathBuf::from(path)
        } else {
            let Some(file) = app
                .dialog()
                .file()
                .add_filter("PlyMotion 工程", &["plymotion"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            file.into_path().map_err(|e| e.to_string())?
        };
        let content = read_project_with(&path, |relative| {
            let file = app
                .dialog()
                .file()
                .set_title(format!("素材缺失，请重新定位：{relative}"))
                .add_filter("PlyMotion 素材", &["plyasset"])
                .blocking_pick_file()
                .ok_or("已取消素材重新定位，原工程保持不变")?;
            file.into_path().map_err(|e| e.to_string())
        })?;
        Ok(Some(OpenedProject {
            path: path.to_string_lossy().into_owned(),
            content,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
pub fn register_file_drop(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        },
        WebMessageReceivedEventHandler, take_pwstr,
    };
    use windows_core::{Interface, PWSTR};

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let target = window.clone();
    // Native Tauri file drops disable Dockview's HTML5 panel dragging on Windows.
    window.with_webview(move |webview| unsafe {
        let install = || -> windows_core::Result<()> {
            let core = webview.controller().CoreWebView2()?;
            let mut token = 0;
            core.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut message = PWSTR::null();
                    args.TryGetWebMessageAsString(&mut message)?;
                    let message = take_pwstr(message);
                    if !serde_json::from_str::<serde_json::Value>(&message).ok()
                        .is_some_and(|v| v["type"] == "plymotion-file-drop")
                    {
                        return Ok(());
                    }
                    let path = (|| -> windows_core::Result<String> {
                        let objects = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
                            .AdditionalObjects()?;
                        let file = objects.GetValueAtIndex(0)?.cast::<ICoreWebView2File>()?;
                        let mut path = PWSTR::null();
                        file.Path(&mut path)?;
                        Ok(take_pwstr(path))
                    })();
                    let detail = match path {
                        Ok(path) => serde_json::json!({ "path": path }),
                        Err(error) => serde_json::json!({ "error": error.to_string() }),
                    };
                    let _ = target.eval(&format!(
                        "window.dispatchEvent(new CustomEvent('plymotion-file-drop', {{detail: {detail}}}))"
                    ));
                    Ok(())
                })),
                &mut token,
            )
        };
        if let Err(error) = install() {
            eprintln!("无法启用工程文件拖入：{error}");
        }
    })
}

#[tauri::command]
pub async fn save_project(
    app: tauri::AppHandle,
    content: String,
    path: Option<String>,
) -> Result<Option<String>, String> {
    validate_content(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = if let Some(path) = path {
            PathBuf::from(path)
        } else {
            let Some(file) = app
                .dialog()
                .file()
                .add_filter("PlyMotion 工程", &["plymotion"])
                .set_file_name("未命名.plymotion")
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let mut path = file.into_path().map_err(|e| e.to_string())?;
            if path.extension().is_none() {
                path.set_extension("plymotion");
            }
            path
        };
        write_project(&path, &content)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn project_ready(state: tauri::State<'_, ProjectState>) {
    state.0.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn close_project_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}
