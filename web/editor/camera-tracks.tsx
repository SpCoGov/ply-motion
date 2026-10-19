import { useEffect, useRef } from 'react';
import { beginEdit, editProject, finishEdit, seekTime, setFollow, selectBeat, deleteTimelineSelection } from '../app.ts';
import type { Edits } from '../lib/types.ts';
import { trackState } from '../lib/editing.ts';
import { resolveCamera } from '../lib/camera-beats.ts';
import { useEditor } from './store';
import { TrackControls, TrackRow } from './timeline';

export function TimeMarker({ time, duration = 0, label, scale = 1, start, rangeEnd, selected, min = 0, max = 120000000, locked, change, remove, beat = false }:
  { time: number; duration?: number; label: string; scale?: number; start: number; rangeEnd?: number; selected?: boolean; min?: number; max?: number; locked: boolean; change: (edits: Edits, time: number) => void; remove: (edits: Edits) => void; beat?: boolean }) {
  const drag = useRef<{ x: number; time: number; value: number; playhead: number; scroll: number; scale: number; lane: HTMLElement } | null>(null);
  const end = (cancel = false) => { const d = drag.current; if (!d) return; drag.current = null; finishEdit(cancel); if (beat) selectBeat(cancel ? d.time : d.value); seekTime(cancel ? d.playhead : d.value); };
  useEffect(() => () => end(true), []);
  const bounded = (value: number) => Math.max(min, Math.min(max, Math.round(value * 1000) / 1000));
  return <button className={`camera-marker${beat ? ' beat-marker' : ''}${duration ? ' shake-marker' : ''}`} data-time={time} aria-pressed={selected || (beat && !!drag.current)}
    tabIndex={rangeEnd !== undefined && (time + duration < start || time > rangeEnd) ? -1 : 0}
    style={{ left: rangeEnd === undefined ? (time - start) * scale : `${(time - start) / (rangeEnd - start) * 100}%`, ...(duration ? { width: rangeEnd === undefined ? Math.max(8, duration * scale) : `${duration / (rangeEnd - start) * 100}%`, minWidth: 8 } : {}) }}
    aria-label={`${label} ${time.toFixed(1)} ms`} title={`${label} · ${time.toFixed(1)} ms；${locked ? '点击定位预览' : '拖动调整，方向键微调，Delete 删除'}`}
    onPointerDown={e => {
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
      if (beat) { const additive = e.shiftKey || e.ctrlKey || e.metaKey; selectBeat(time, additive); if (additive) { seekTime(time); return; } }
      if (locked) { seekTime(time); return; }
      const lane = (rangeEnd === undefined ? e.currentTarget.closest('.timeline-scroll') : e.currentTarget.parentElement) as HTMLElement;
      const playhead = useEditor.getState().timeMs;
      beginEdit(); setFollow(false); drag.current = { x: e.clientX, time, value: time, playhead, scroll: lane.scrollLeft, scale: rangeEnd === undefined ? scale : lane.clientWidth / (rangeEnd - start), lane }; e.currentTarget.setPointerCapture(e.pointerId); seekTime(time);
    }}
    onPointerMove={e => { const d = drag.current; if (!d) return; if (!useEditor.getState().editing) { end(true); return; } const value = bounded(d.time + (e.clientX - d.x + d.lane.scrollLeft - d.scroll) / d.scale); if (!editProject(edits => change(edits, value), true)) { d.value = value; seekTime(value); } }}
    onPointerUp={() => end()} onPointerCancel={() => end(true)} onLostPointerCapture={() => end(true)}
    onClick={e => { if (e.detail === 0) { if (beat) selectBeat(time, e.shiftKey || e.ctrlKey || e.metaKey); seekTime(time); } }}
    onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); }
      if (['Delete', 'Backspace', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation(); if (locked) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (beat) { if (!useEditor.getState().selectedBeatTimes.includes(time)) selectBeat(time); deleteTimelineSelection(); }
          else editProject(remove);
        } else { const value = bounded(time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)); if (!editProject(edits => change(edits, value))) { if (beat) selectBeat(value); seekTime(value); } }
      }
    }}>{duration ? '震动' : beat ? '│' : '◆'}</button>;
}

export function CameraTracks({ start, scale, left, right, selectedBeats }: { start: number; scale: number; left: number; right: number; selectedBeats: number[] }) {
  const project = useEditor(s => s.project), { beats = [] } = project.edits, { camera } = resolveCamera(project);
  const state = (id: string) => { const s = trackState(project, id); return { 'data-track-id': id, 'data-locked': s.locked, 'data-disabled': s.hidden || s.muted }; };
  const visible = (time: number, duration = 0) => time + duration >= left && time <= right;
  return <>
    <TrackRow track="camera" label="镜头" {...state('camera')} header={<><span className="track-label">镜头</span><TrackControls id="camera" label="镜头" /></>}><div className="track-lane">
      {camera?.shakes.map((s, i) => visible(s.startMs, s.durationMs) && <TimeMarker key={s.id} time={s.startMs} duration={s.durationMs} label="镜头震动" start={start} scale={scale} locked={trackState(project, 'camera').locked}
        max={120000000 - s.durationMs} change={(e, time) => { e.camera!.shakes[i].startMs = time; }} remove={e => { e.camera!.shakes.splice(i, 1); }} />)}
      {camera?.keys.map((k, i, keys) => visible(k.time) && <TimeMarker key={`${!!project.edits.camera?.follow?.enabled}:${i}`} time={k.time} label="镜头关键帧" start={start} scale={scale} locked={trackState(project, 'camera').locked || !!project.edits.camera?.follow?.enabled}
        min={i ? keys[i - 1].time + .001 : 0} max={keys[i + 1] ? keys[i + 1].time - .001 : 120000000}
        change={(e, time) => { e.camera!.keys[i].time = time; }} remove={e => { e.camera!.keys.splice(i, 1); }} />)}
    </div></TrackRow>
    <TrackRow track="beats" label="节拍" {...state('beats')} header={<><span className="track-label">节拍 · {beats.length}</span><TrackControls id="beats" label="节拍" /></>}><div className="track-lane">
      {!trackState(project, 'beats').hidden && beats.map((time, i) => visible(time) && <TimeMarker key={i} time={time} label="节拍" beat selected={selectedBeats.includes(time)} start={start} scale={scale} locked={trackState(project, 'beats').locked}
        min={i ? beats[i - 1] + .001 : 0} max={beats[i + 1] ? beats[i + 1] - .001 : 120000000}
        change={(e, value) => { e.beats![i] = value; }} remove={e => { e.beats!.splice(i, 1); }} />)}
    </div></TrackRow>
  </>;
}
