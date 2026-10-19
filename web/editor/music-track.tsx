import { useEffect, useRef } from 'react';
import { beginEdit, editProject, finishEdit, seekTime, selectTimelineItems, setFollow } from '../app.ts';
import { changeMusicTiming } from '../lib/assets.ts';
import type { SoundBuffers } from '../lib/audio.ts';
import { trackState } from '../lib/editing.ts';
import { snapTime } from '../lib/playback.ts';
import type { Music } from '../lib/types.ts';
import { AudioWaveform } from './audio-waveform';
import { useEditor } from './store';
import { TrackControls, TrackRow } from './timeline';

type Mode = 'move' | 'left' | 'right';

export function MusicTrack({ start, scale, left, right, waveforms }: { start: number; scale: number; left: number; right: number; waveforms: SoundBuffers }) {
  const project = useEditor(s => s.project), game = useEditor(s => s.game), music = project.edits.music;
  const { locked, muted } = trackState(project, 'music');
  const asset = project.edits.assets?.find(a => a.id === music?.assetId);
  const sourceDuration = asset?.source.kind === 'embedded' ? asset.source.durationMs! : 0;
  const drag = useRef<{ x: number; scroll: number; scale: number; mode: Mode; music: Music; lane: HTMLElement; moved: boolean } | null>(null);
  const end = (cancel = false) => {
    const d = drag.current; if (!d) return;
    drag.current = null; finishEdit(cancel);
    if (!cancel && !d.moved) seekTime(d.music.startMs);
  };
  useEffect(() => () => end(true), [game]);
  if (!music) return null;
  const anchor = (m: Music, mode: Mode) => m.startMs + (mode === 'right' ? m.durationMs : 0);
  const bounds = (m: Music, mode: Mode) => {
    const minDuration = Math.min(m.durationMs, 1000 / project.output.fps);
    return mode === 'move' ? [0, 120000000 - m.durationMs]
      : mode === 'left' ? [Math.max(0, m.startMs - m.offsetMs), m.startMs + m.durationMs - minDuration]
      : [m.startMs + minDuration, Math.min(120000000, m.startMs + sourceDuration - m.offsetMs)];
  };
  const change = (m: Music, mode: Mode, target: number, fromStart = false) => {
    const [min, max] = bounds(m, mode), delta = Math.max(min, Math.min(max, target)) - anchor(m, mode);
    return editProject(edits => changeMusicTiming(edits, mode === 'move' ? { startMs: m.startMs + delta }
      : mode === 'left' ? { startMs: m.startMs + delta, offsetMs: m.offsetMs + delta, durationMs: m.durationMs - delta }
      : { durationMs: m.durationMs + delta }), fromStart);
  };
  const modeOf = (target: EventTarget) => ((target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge || 'move') as Mode;
  return <TrackRow track="music" label="音乐" className="audio-track" data-track-id="music" data-locked={locked} data-disabled={muted}
    header={<><span className="track-label">A2 · 音乐</span><TrackControls id="music" label="音乐" audio /></>}><div className="track-lane">
    <div className="timeline-clip music-clip" style={{ left: (music.startMs - start) * scale, width: Math.max(3, music.durationMs * scale) }}
      title={`${asset?.source.kind === 'embedded' ? asset.source.name : '音乐'} · ${music.startMs.toFixed(1)} ms · ${music.durationMs.toFixed(1)} ms；${locked ? '轨道已锁定' : '拖动移动，拖两端裁剪；方向键微调，Shift 为 10 ms，Alt 拖动不吸附，Esc 取消'}`}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); (e.target as HTMLElement).closest('button')?.focus({ preventScroll: true });
        selectTimelineItems([]);
        if (locked) { seekTime(music.startMs); return; }
        const lane = e.currentTarget.closest<HTMLElement>('.timeline-scroll')!;
        beginEdit(); setFollow(false); e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, scroll: lane.scrollLeft, scale, mode: modeOf(e.target), music, lane, moved: false };
      }}
      onPointerMove={e => {
        const d = drag.current; if (!d) return;
        if (!useEditor.getState().editing) { end(true); return; }
        if (!d.moved && Math.abs(e.clientX - d.x) < 2) return;
        d.moved = true;
        const rect = d.lane.getBoundingClientRect();
        if (e.clientX > rect.right - 16) d.lane.scrollLeft += 20;
        else if (e.clientX < rect.left + 166) d.lane.scrollLeft -= 20;
        const target = anchor(d.music, d.mode) + (e.clientX - d.x + d.lane.scrollLeft - d.scroll) / d.scale;
        if (change(d.music, d.mode, e.altKey ? Math.round(target * 1000) / 1000 : snapTime(target, project.output.fps), true)) end(true);
      }}
      onPointerUp={() => end()} onPointerCancel={() => end(true)} onLostPointerCapture={() => end(true)}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); }
        if (['Delete', 'Backspace'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation(); if (locked || drag.current) return;
        selectTimelineItems([]);
        const mode = modeOf(e.target);
        change(music, mode, anchor(music, mode) + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      }}>
      <button className="music-body" aria-label="音乐片段" onClick={e => { if (e.detail === 0) { selectTimelineItems([]); seekTime(music.startMs); } }}>
        <AudioWaveform buffer={waveforms[music.assetId]} startMs={music.startMs} durationMs={music.durationMs} offsetMs={music.offsetMs} scale={scale} left={left} right={right} />
      </button>
      {(['left', 'right'] as const).map(mode => <button key={mode} className={`clip-edge ${mode}`} data-edge={mode} disabled={locked}
        role="slider" aria-label={mode === 'left' ? '裁剪音乐起点' : '裁剪音乐终点'} aria-orientation="horizontal"
        aria-valuemin={bounds(music, mode)[0]} aria-valuemax={bounds(music, mode)[1]} aria-valuenow={anchor(music, mode)} aria-valuetext={`${anchor(music, mode).toFixed(1)} 毫秒`} />)}
    </div>
  </div></TrackRow>;
}
