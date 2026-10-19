import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { getCurrentProject, openVideoExport, seekTime, stepFrame, togglePlaying } from '../app.ts';
import { createVideoRenderer } from '../lib/video.ts';
import { useEditor } from './store';
import { Button } from './ui/button';
import { MaterialIcon as Icon } from './ui/material-icon';

export function CameraPreview({ api }: IDockviewPanelProps) {
  const project = useEditor(s => s.project), chesscom = useEditor(s => s.chesscom), playing = useEditor(s => s.playing);
  const [visible, setVisible] = useState(api.isVisible), [status, setStatus] = useState('');
  const frame = useRef<HTMLDivElement>(null), clock = useRef<HTMLOutputElement>(null);
  useEffect(() => { const event = api.onDidVisibilityChange(() => setVisible(api.isVisible)); return () => event.dispose(); }, [api]);
  useEffect(() => {
    if (!visible) return;
    const job = new AbortController(), host = frame.current!;
    let renderer: Awaited<ReturnType<typeof createVideoRenderer>> | undefined, lastTime = -1;
    const settings = project.output;
    const draw = () => {
      if (!renderer || job.signal.aborted || !clock.current || !host.isConnected) return;
      const state = useEditor.getState(), time = state.timeMs / settings.speed;
      const sample = time >= renderer.schedule.duration ? renderer.schedule.duration : Math.floor(time * settings.fps / 1000) * 1000 / settings.fps;
      clock.current.value = `${(state.timeMs / 1000).toFixed(3)} / ${(state.durationMs / 1000).toFixed(3)} s`;
      if (sample === lastTime) return;
      try {
        renderer.render(sample); lastTime = sample;
        renderer.canvas.dataset.timeMs = String(sample * settings.speed);
      } catch (error) { job.abort(); host.replaceChildren(); renderer.dispose(); setStatus(`镜头预览失败：${error instanceof Error ? error.message : error}`); }
    };
    setStatus('正在准备镜头预览…');
    const unsubscribe = useEditor.subscribe(draw);
    // Use the saved source: reapplying edits to an effective snapshot would duplicate copies.
    void createVideoRenderer(getCurrentProject(), settings, chesscom, job.signal).then(view => {
      if (job.signal.aborted) { view.dispose(); return; }
      renderer = view; view.canvas.setAttribute('role', 'img'); view.canvas.setAttribute('aria-label', '镜头成片画面');
      host.replaceChildren(view.canvas); setStatus(''); draw();
    }).catch(error => { if (!job.signal.aborted) setStatus(`镜头预览失败：${error instanceof Error ? error.message : error}`); });
    return () => { job.abort(); unsubscribe(); renderer?.dispose(); host.replaceChildren(); };
  }, [project, chesscom, visible]);
  return <div className="panel-body camera-preview">
    <div className="camera-preview-heading"><span>{project.output.width} × {project.output.height} · {project.output.fps} fps · 成片画面</span><Button onClick={openVideoExport}>输出设置</Button></div>
    <div ref={frame} className="camera-preview-frame" />
    {status && <p className="camera-preview-status" role="status">{status}</p>}
    <div className="camera-preview-transport">
      <Button aria-label="镜头预览回到开头" onClick={() => seekTime(0)}><Icon name="first_page" /></Button>
      <Button aria-label="镜头预览上一帧" onClick={() => stepFrame(-1)}><Icon name="skip_previous" /></Button>
      <Button aria-label={playing ? '暂停镜头预览' : '播放镜头预览'} aria-pressed={playing} onClick={togglePlaying}><Icon name={playing ? 'pause' : 'play_arrow'} /></Button>
      <Button aria-label="镜头预览下一帧" onClick={() => stepFrame(1)}><Icon name="skip_next" /></Button>
      <output ref={clock} aria-label="镜头预览时间" />
    </div>
  </div>;
}
