use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_BYTES: u64 = 4 * 1024 * 1024;
const WAIT: Duration = Duration::from_secs(10);
struct Pending {
    request: Value,
    expires: Instant,
    taken: bool,
    reply: mpsc::SyncSender<Value>,
}
#[derive(Default)]
pub struct McpState {
    server: Mutex<Option<Server>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
}
struct Server {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}
impl McpState {
    pub fn stop(&self) {
        if let Some(server) = self.server.lock().unwrap().take() {
            server.stop.store(true, Ordering::SeqCst);
            let _ = server.thread.join();
        }
        for (_, pending) in self.pending.lock().unwrap().drain() {
            let _ = pending.reply.send(json!({ "error": "MCP 已关闭" }));
        }
    }
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("MCP 只能由主编辑器控制".into());
    }
    Ok(())
}

#[tauri::command]
pub fn set_mcp_enabled(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, McpState>,
    enabled: bool,
) -> Result<(), String> {
    main_window(&window)?;
    if !enabled {
        state.stop();
        return Ok(());
    }
    let mut server = state.server.lock().unwrap();
    if server.is_some() {
        return Ok(());
    }
    // Raw TCP is private to the stdio adapter; it is never exposed to web origins.
    let listener = TcpListener::bind("127.0.0.1:4174")
        .map_err(|e| format!("无法开启 MCP（端口 4174）：{e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = stop.clone();
    let pending = state.pending.clone();
    let app = window.app_handle().clone();
    let thread = std::thread::spawn(move || {
        let active = Arc::new(AtomicUsize::new(0));
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((socket, _)) => {
                    if active.load(Ordering::SeqCst) >= 8 {
                        continue;
                    }
                    active.fetch_add(1, Ordering::SeqCst);
                    let (app, pending, stop, active) =
                        (app.clone(), pending.clone(), stop.clone(), active.clone());
                    std::thread::spawn(move || {
                        serve(socket, &app, &pending, &stop);
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => break,
            }
        }
    });
    *server = Some(Server {
        stop: server_stop,
        thread,
    });
    Ok(())
}

fn read_request(socket: &mut TcpStream) -> Result<Value, String> {
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let mut line = Vec::new();
    BufReader::new(socket.take(MAX_BYTES + 1))
        .read_until(b'\n', &mut line)
        .map_err(|e| e.to_string())?;
    if line.len() as u64 > MAX_BYTES || line.last() != Some(&b'\n') {
        return Err("MCP 请求过大或不完整".into());
    }
    let request: Value = serde_json::from_slice(&line).map_err(|e| e.to_string())?;
    if !request.is_object()
        || request["name"].as_str().is_none()
        || !request["arguments"].is_object()
        || request
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !["name", "arguments"].contains(&key.as_str()))
    {
        return Err("MCP 请求格式无效".into());
    }
    Ok(request)
}

fn serve(
    mut socket: TcpStream,
    app: &tauri::AppHandle,
    pending: &Mutex<HashMap<u64, Pending>>,
    stop: &AtomicBool,
) {
    let result = (|| -> Result<Value, String> {
        let request = read_request(&mut socket)?;
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = mpsc::sync_channel(1);
        {
            let mut queue = pending.lock().unwrap();
            if stop.load(Ordering::SeqCst) {
                return Err("MCP 已关闭".into());
            }
            queue.insert(
                id,
                Pending {
                    request,
                    expires: Instant::now() + WAIT,
                    taken: false,
                    reply,
                },
            );
        }
        let sent = app
            .get_webview_window("main")
            .ok_or("主编辑器已关闭")
            .and_then(|window| {
                window
                    .eval(&format!(
                        "window.dispatchEvent(new CustomEvent('plymotion-mcp', {{detail:{id}}}))"
                    ))
                    .map_err(|_| "无法通知编辑器")
            });
        let result = if sent.is_ok() {
            receive
                .recv_timeout(WAIT)
                .map_err(|_| "编辑器未响应；请求已过期".to_string())
        } else {
            Err(sent.unwrap_err().to_string())
        };
        pending.lock().unwrap().remove(&id);
        result
    })()
    .unwrap_or_else(|error| json!({ "error": error }));
    let _ = socket.set_write_timeout(Some(Duration::from_secs(2)));
    // Serialize once so large embedded assets and the newline share one write.
    if let Ok(mut bytes) = serde_json::to_vec(&result) {
        bytes.push(b'\n');
        if let Err(error) = socket.write_all(&bytes) {
            eprintln!("MCP 响应发送失败：{error}");
        }
    }
}

#[tauri::command]
pub fn take_mcp_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, McpState>,
    id: u64,
) -> Result<Option<Value>, String> {
    main_window(&window)?;
    let mut pending = state.pending.lock().unwrap();
    let Some(item) = pending.get_mut(&id) else {
        return Ok(None);
    };
    if item.taken || item.expires <= Instant::now() {
        return Ok(None);
    }
    item.taken = true;
    let remaining = item
        .expires
        .saturating_duration_since(Instant::now())
        .as_millis();
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        + remaining;
    Ok(Some(
        json!({ "id": id, "deadline": deadline as u64, "request": item.request }),
    ))
}

#[tauri::command]
pub fn complete_mcp_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, McpState>,
    id: u64,
    response: Value,
) -> Result<(), String> {
    main_window(&window)?;
    if let Some(item) = state.pending.lock().unwrap().remove(&id) {
        let _ = item.reply.send(response);
    }
    Ok(())
}
