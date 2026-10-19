use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Serialize, Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
fn visible(bounds: &Bounds, x: i32, y: i32, width: u32, height: u32) -> bool {
    bounds.width >= 320
        && bounds.height >= 240
        && bounds.width <= width
        && bounds.height <= height
        && bounds.x >= x
        && bounds.y >= y
        && i64::from(bounds.x) + i64::from(bounds.width) <= i64::from(x) + i64::from(width)
        && i64::from(bounds.y) + i64::from(bounds.height) <= i64::from(y) + i64::from(height)
}
#[tauri::command]
pub async fn open_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session: String,
) -> Result<(), String> {
    if window.label() != "main"
        || session.len() != 36
        || !session.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
    {
        return Err("无效的预览窗口请求".into());
    }
    if let Some(preview) = app.get_webview_window("preview") {
        let mut url = preview.url().map_err(|e| e.to_string())?;
        let query = format!("preview={session}");
        if url.query() != Some(query.as_str()) {
            url.set_query(Some(&query));
            preview.navigate(url).map_err(|e| e.to_string())?;
        }
        // Reopening also recovers a window left on a disconnected display.
        let pos = preview.outer_position().map_err(|e| e.to_string())?;
        let size = preview.outer_size().map_err(|e| e.to_string())?;
        let bounds = Bounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        };
        if !preview
            .available_monitors()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|m| {
                visible(
                    &bounds,
                    m.work_area().position.x,
                    m.work_area().position.y,
                    m.work_area().size.width,
                    m.work_area().size.height,
                )
            })
        {
            if let Some(monitor) = preview.primary_monitor().map_err(|e| e.to_string())? {
                let area = monitor.work_area();
                preview
                    .set_size(PhysicalSize::new(
                        bounds.width.min(area.size.width.saturating_sub(48)),
                        bounds.height.min(area.size.height.saturating_sub(80)),
                    ))
                    .map_err(|e| e.to_string())?;
                preview
                    .set_position(PhysicalPosition::new(
                        area.position.x + 16,
                        area.position.y + 16,
                    ))
                    .map_err(|e| e.to_string())?;
            }
        }
        preview.show().map_err(|e| e.to_string())?;
        preview.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let preview = tauri::WebviewWindowBuilder::new(
        &app,
        "preview",
        tauri::WebviewUrl::App(format!("index.html?preview={session}").into()),
    )
    .title("PlyMotion · 独立镜头预览")
    .inner_size(960., 760.)
    .min_inner_size(320., 240.)
    .center()
    .prevent_overflow()
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    if let Ok(dir) = app.path().app_config_dir() {
        if let Ok(bytes) = std::fs::read(dir.join("preview-window.json")) {
            if let Ok(bounds) = serde_json::from_slice::<Bounds>(&bytes) {
                if preview
                    .available_monitors()
                    .map_err(|e| e.to_string())?
                    .iter()
                    .any(|m| {
                        visible(
                            &bounds,
                            m.work_area().position.x,
                            m.work_area().position.y,
                            m.work_area().size.width,
                            m.work_area().size.height,
                        )
                    })
                {
                    preview
                        .set_size(PhysicalSize::new(bounds.width, bounds.height))
                        .map_err(|e| e.to_string())?;
                    preview
                        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let handle = app.clone();
    preview.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            if let Some(w) = handle.get_webview_window("preview") {
                if let (Ok(pos), Ok(size), Ok(dir)) = (
                    w.outer_position(),
                    w.inner_size(),
                    handle.path().app_config_dir(),
                ) {
                    let bounds = Bounds {
                        x: pos.x,
                        y: pos.y,
                        width: size.width,
                        height: size.height,
                    };
                    if std::fs::create_dir_all(&dir).is_ok() {
                        if let Ok(bytes) = serde_json::to_vec(&bounds) {
                            let _ = std::fs::write(dir.join("preview-window.json"), bytes);
                        }
                    }
                }
            }
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(main) = handle.get_webview_window("main") {
                let _ = main.eval("window.dispatchEvent(new Event('plymotion-preview-closed'))");
            }
        }
    });
    preview.show().map_err(|e| e.to_string())?;
    preview.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn close_preview(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "preview" {
        return Err("此命令只适用于独立预览".into());
    }
    window.close().map_err(|e| e.to_string())
}
