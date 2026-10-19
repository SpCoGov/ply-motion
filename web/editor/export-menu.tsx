import { useRef, useState } from 'react';
import { openVideoExport } from '../app.ts';
import { getFfmpegPath, saveFfmpegPath } from '../lib/video.ts';
import { Button } from './ui/button';
import { MaterialIcon as Icon } from './ui/material-icon';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu';

export function ExportMenu({ disabled }: { disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('');
  const native = !!window.__TAURI__;
  const run = async (action: () => Promise<unknown>) => {
    setError(''); setStatus(''); setBusy(true);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const check = async () => {
    if (!window.__TAURI__) throw new Error('请在桌面程序中配置 FFmpeg。');
    return window.__TAURI__.core.invoke<string>('check_ffmpeg', { path: path.trim() || null });
  };
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild><Button disabled={disabled}><Icon name="file_download" />导出<Icon name="expand_more" size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuItem onSelect={openVideoExport}><Icon name="video_file" />导出视频…</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => { setPath(getFfmpegPath()); setError(''); setStatus(''); dialog.current!.showModal(); }}><Icon name="settings" />FFmpeg 设置…</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <dialog ref={dialog} aria-labelledby="ffmpeg-title" onCancel={e => { if (busy) e.preventDefault(); }}>
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await check(); saveFfmpegPath(path); dialog.current!.close(); }); }}>
        <h2 id="ffmpeg-title">FFmpeg 设置</h2>
        <p id="ffmpeg-path-hint">选择 FFmpeg 可执行文件，或输入完整路径；留空使用系统 PATH 中的 FFmpeg。设置保存在本机，下次导出生效。</p>
        <label>FFmpeg 路径<input value={path} disabled={!native || busy} spellCheck={false} aria-describedby="ffmpeg-path-hint" placeholder="留空使用系统 PATH" onChange={e => { setPath(e.target.value); setError(''); setStatus(''); }} /></label>
        <div className="dialog-actions">
          <Button type="button" disabled={!native || busy} onClick={() => void run(async () => {
            const selected = await window.__TAURI__!.core.invoke<string | null>('pick_ffmpeg');
            if (selected) setPath(selected);
          })}><Icon name="folder_open" />选择文件…</Button>
          <Button type="button" disabled={!native || busy} onClick={() => void run(async () => setStatus(await check()))}>检测</Button>
        </div>
        {!native && <p>请在桌面程序中配置 FFmpeg。</p>}
        {busy && <p role="status">正在处理…</p>}
        {status && <p role="status">{status}</p>}
        {error && <p role="alert" className="engine-error">{error}</p>}
        <div className="dialog-actions"><Button type="button" disabled={busy} onClick={() => dialog.current!.close()}>取消</Button><Button type="submit" variant="accent" disabled={!native || busy}>保存设置</Button></div>
      </form>
    </dialog>
  </>;
}
