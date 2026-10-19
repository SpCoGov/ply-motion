import { useEffect, useRef, useState } from 'react';
import { executeMcpTool } from '../app.ts';
import { Button } from './ui/button';

export function McpMenu({ notify }: { notify: (message: string) => void }) {
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false);
  const active = useRef(false);
  const status = useRef(notify); status.current = notify;
  useEffect(() => {
    const invoke = window.__TAURI__?.core.invoke;
    if (!invoke) return;
    const handle = async (event: Event) => {
      const id: unknown = (event as CustomEvent).detail;
      if (!active.current || !Number.isSafeInteger(id)) return;
      try {
        const item = await invoke<{ deadline: number; request: { name: string; arguments: unknown } } | null>('take_mcp_request', { id });
        if (!item) return;
        let response;
        try {
          if (!active.current || Date.now() >= item.deadline) throw new Error('MCP 已关闭或请求已过期');
          response = { result: executeMcpTool(item.request.name, item.request.arguments) };
          status.current(`MCP：${item.request.name} 已完成`);
        } catch (error) {
          response = { error: error instanceof Error ? error.message : String(error) };
          status.current(`MCP：${response.error}`);
        }
        await invoke('complete_mcp_request', { id, response });
      } catch (error) { status.current(`MCP 连接错误：${String(error)}`); }
    };
    window.addEventListener('plymotion-mcp', handle);
    return () => { active.current = false; window.removeEventListener('plymotion-mcp', handle); void invoke('set_mcp_enabled', { enabled: false }).catch(() => {}); };
  }, []);
  const toggle = async () => {
    const next = !enabled;
    setBusy(true); active.current = false;
    try {
      await window.__TAURI__!.core.invoke('set_mcp_enabled', { enabled: next });
      active.current = next; setEnabled(next);
      notify(next ? 'MCP 已开启：允许本机 AI 读取工程、修改棋谱和动画' : 'MCP 已关闭');
    } catch (error) { active.current = enabled; notify(`MCP：${String(error)}`); }
    finally { setBusy(false); }
  };
  return <Button disabled={!window.__TAURI__ || busy} aria-pressed={enabled} onClick={() => void toggle()}
    title={window.__TAURI__ ? '允许本机 MCP 客户端读取工程、导入棋谱和修改动画；本次启动有效。接入方法见 README。' : 'MCP 需要桌面程序'}>MCP：{enabled ? '开' : '关'}</Button>;
}
