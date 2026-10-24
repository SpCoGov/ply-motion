#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod mcp;
mod media;
mod preview;
mod project;
mod video;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(video::VideoState::default())
        .manage(project::ProjectState::default())
        .manage(engine::EngineState::default())
        .manage(mcp::McpState::default())
        .setup(|app| {
            #[cfg(windows)]
            project::register_file_drop(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::Manager;
            if window.label() != "main" {
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(preview) = window.get_webview_window("preview") {
                    let _ = preview.destroy();
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .state::<project::ProjectState>()
                    .0
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    api.prevent_close();
                    if let Some(webview) = window.get_webview_window(window.label()) {
                        let _ = webview.eval("window.dispatchEvent(new Event('plymotion-close'))");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            mcp::set_mcp_enabled,
            mcp::take_mcp_request,
            mcp::complete_mcp_request,
            preview::open_preview,
            preview::close_preview,
            engine::pick_engine,
            engine::start_engine,
            engine::engine_exchange,
            engine::stop_engine,
            project::open_project,
            project::save_project,
            project::project_ready,
            project::close_project_window,
            video::pick_ffmpeg,
            video::check_ffmpeg,
            video::start_video_export,
            video::write_video_data,
            video::finish_video_export,
            video::cancel_video_export
        ])
        .build(tauri::generate_context!())
        .expect("PlyMotion 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                app.state::<video::VideoState>().cancel_all();
                app.state::<engine::EngineState>().stop_all();
                app.state::<mcp::McpState>().stop();
            }
        });
}
