import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ComponentProps, type ReactNode } from 'react';
import { seekTime, selectObject, selectTimelineItems, setFollow, beginEdit, finishEdit, editProject, undoEdit, copyClips, deleteTimelineSelection, selectKey, stepFrame } from '../app.ts';
import { locateTime, snapTime } from '../lib/playback.ts';
import { useEditor, type Clip } from './store';
import { editable, removable, copyable, clipTimeLimit, trackState, trackParent, effectTrack, propertyTrack } from '../lib/editing.ts';
import { MaterialIcon as Icon } from './ui/material-icon';
import { TimelineScrollbar } from './timeline-scrollbar';
import { projectTimeMap } from '../lib/project.ts';
import { soundWaveforms, type SoundBuffers } from '../lib/audio.ts';
import { AudioWaveform } from './audio-waveform';
import { configuredAsset, audioPieceKey } from '../lib/assets.ts';
import { CameraTracks } from './camera-tracks';
import { MusicTrack } from './music-track';

const LABEL = 150;
export const names: Record<string, string> = { move: '走子', capture: '吃子', promotion: '升变', nag: 'NAG 入场', 'nag-exit': 'NAG 退场',
  previous: '局面', target: '目标', land: '落子', sound: '音效', settle: '落定', check: '将军', hit: '受击', relation: '关系',
  'relation-square': '路径进入', 'relation-exit': '路径退场', gift: '战术', result: '终局', winner: '获胜' };
const pieces: Record<string, string> = { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' };
export const objectName = (object: { kind: string; color?: string; initialType?: string; initialSquare?: string }) => object.kind === 'audio' ? 'A1' : object.kind === 'board' ? '棋盘' : `${object.color === 'w' ? '白' : '黑'}${pieces[object.initialType!] || ''} · ${object.initialSquare}`;
const clipName = (clip: Clip) => clip.effect === 'sound' ? clip.params.sound === 'capture' ? '吃子音效' : '走子音效' : names[clip.effect];

export function TrackRow({ track, label, header, children, ...props }: ComponentProps<'div'> & { track: string; label: string; header: ReactNode }) {
  const key = `plymotion.track-height.v1:${track}`, min = 28, max = 240;
  const [height, setHeight] = useState(() => {
    try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : 36; }
    catch { return 36; }
  });
  const drag = useRef<{ y: number; height: number; value: number } | null>(null);
  const change = (value: number, save = true) => {
    value = Math.max(min, Math.min(max, Math.round(value))); setHeight(value);
    if (save) { try { localStorage.setItem(key, String(value)); } catch { /* Keep the height for this session. */ } }
    return value;
  };
  const cancel = () => { if (drag.current) { setHeight(drag.current.height); drag.current = null; } };
  return <div {...props} className={`timeline-row ${props.className || ''}`} style={{ ...props.style, height }}>
    <div className="track-name">{header}<div className="track-resize" role="separator" tabIndex={0} aria-orientation="horizontal"
      aria-label={`调整 ${label} 轨道高度`} aria-valuemin={min} aria-valuemax={max} aria-valuenow={height} aria-valuetext={`${height} 像素`}
      title="上下拖动调整高度；双击恢复默认；方向键微调"
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
        drag.current = { y: e.clientY, height, value: height }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (drag.current) drag.current.value = change(drag.current.height + e.clientY - drag.current.y, false); }}
      onPointerUp={() => { if (drag.current) { change(drag.current.value); drag.current = null; } }} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); change(36); }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
        const step = e.shiftKey ? 16 : 4, value = { ArrowUp: height - step, ArrowDown: height + step, Home: min, End: max }[e.key];
        if (value !== undefined) { e.preventDefault(); e.stopPropagation(); change(value); }
      }} /></div>{children}
  </div>;
}

export function TrackControls({ id, label, audio = false }: { id: string | string[]; label: string; audio?: boolean }) {
  const project = useEditor(s => s.project)!, ids = Array.isArray(id) ? id : [id], states = ids.map(key => trackState(project, key));
  const state = { locked: states.some(s => s.locked), hidden: states.some(s => s.hidden), muted: states.some(s => s.muted) }, parent = trackParent(project, ids[0]);
  const inherited = parent ? trackState(project, parent) : { locked: false, hidden: false, muted: false };
  const toggle = (key: 'locked' | 'hidden' | 'muted') => editProject(edits => {
    const settings = edits.trackStates ||= {}; for (const id of ids) settings[id] = { ...settings[id], [key]: !state[key] };
  });
  const output = audio ? 'muted' : 'hidden';
  const lockLabel = `${state.locked ? '解锁' : '锁定'} ${label}`, outputLabel = `${audio ? state.muted ? '取消静音' : '静音' : state.hidden ? '显示' : '隐藏'} ${label}`;
  return <span className="track-controls"><button className="track-control" aria-label={lockLabel} title={inherited.locked ? '父轨道已锁定' : lockLabel} aria-pressed={state.locked} disabled={inherited.locked} onClick={() => toggle('locked')}><Icon name={state.locked ? 'lock' : 'lock_open'} size={16} /></button>
    <button className="track-control" aria-label={outputLabel} title={outputLabel} aria-pressed={state[output]} disabled={inherited[output]} onClick={() => toggle(output)}><Icon name={audio ? state.muted ? 'volume_off' : 'volume_up' : state.hidden ? 'visibility_off' : 'visibility'} size={16} /></button></span>;
}

function Transport() {
  const time = useEditor(s => s.timeMs), duration = useEditor(s => s.durationMs), undo = useEditor(s => s.canUndo), redo = useEditor(s => s.canRedo);
  return <div className="timeline-transport"><button aria-label="撤销" title="撤销 Ctrl+Z" disabled={!undo} onClick={() => undoEdit()}><Icon name="undo" /></button><button aria-label="重做" title="重做 Ctrl+Shift+Z" disabled={!redo} onClick={() => undoEdit(true)}><Icon name="redo" /></button>
    <input id="timePosition" aria-label="播放时间（毫秒）" type="number" min={0} max={duration} step="any" value={Number(time.toFixed(4))} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) seekTime(e.target.valueAsNumber); }} /><span>ms</span><output aria-label="时间码">{(time / 1000).toFixed(3)} / {(duration / 1000).toFixed(3)} s</output></div>;
}

export function TimelinePanel() {
  const project = useEditor(s => s.project)!, ply = useEditor(s => s.ply);
  const chesscom = useEditor(s => s.chesscom);
  const [waveforms, setWaveforms] = useState<SoundBuffers>({});
  const selected = useEditor(s => s.selectedObjectId), selectedClips = useEditor(s => s.selectedClipIds), follow = useEditor(s => s.follow);
  const selectedBeats = useEditor(s => s.selectedBeatTimes);
  const propertyTarget = useEditor(s => s.propertyTarget);
  const [zoomScale, setScale] = useState(.12), [scope, setScope] = useState('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set(['scene']));
  const [view, setView] = useState({ left: 0, width: 1000 });
  const scroll = useRef<HTMLDivElement>(null), head = useRef<HTMLDivElement>(null), ruler = useRef<HTMLDivElement>(null);
  const dragging = useRef(false), zoomAnchor = useRef<{ time: number; x: number } | null>(null);
  const clipDrag = useRef<{ x: number; scroll: number; mode: string; clips: Clip[]; active: Clip; scale: number; boundaries: number[]; moved: boolean } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number; ids: (string | number)[] } | null>(null);
  const selectionFrame = useRef(0), selectionDrag = useRef<{ x: number; y: number; clientX: number; clientY: number; pointer: number; moved: boolean; base: (string | number)[]; ids: (string | number)[];
    targets: { id: string | number; left: number; right: number; top: number; bottom: number }[] } | null>(null);
  const highlighted = selectionBox?.ids || selectedClips;
  const model = useMemo(() => {
    const map = projectTimeMap(project);
    const byMove = new Map(project.segments.map(s => [s.id, [] as typeof project.clips]));
    for (const clip of project.clips) if (clip.moveId !== null) byMove.get(clip.moveId)!.push(clip);
    return { map, byMove };
  }, [project]);
  const current = model.map.ranges[Math.max(0, ply - 1)];
  const start = scope === 'move' ? current?.start || 0 : 0;
  const duration = scope === 'move' ? (current?.end || 0) - start : model.map.duration;
  const viewport = Math.max(1, view.width - LABEL);
  const minScale = viewport / Math.max(1, duration), maxScale = Math.max(.4, minScale * 32);
  const scale = Math.max(minScale, Math.min(maxScale, zoomScale));
  const width = Math.max(viewport, duration * scale);
  const visibleFrom = Math.min(Math.max(0, duration - viewport / scale), view.left / scale);
  const visibleTo = Math.min(duration, visibleFrom + viewport / scale);
  const minSpan = Math.min(duration, Math.max(viewport / maxScale, duration * 28 / viewport));
  const leftTime = start + Math.max(0, view.left - 20) / scale;
  const rightTime = start + (view.left + view.width - LABEL + 20) / scale;
  const ranges = model.map.ranges.filter(r => r.end >= leftTime && r.start <= rightTime && r.end > start && r.start < start + duration);
  const clips = [...ranges.flatMap(range => model.byMove.get(project.segments[range.index].id)!.map(clip => ({ ...clip, at: range.start + clip.startMs }))),
    ...project.clips.filter(c => c.moveId === null).map(c => ({ ...c, at: c.startMs }))]
    .filter(clip => clip.effect !== 'land' && !clip.hidden && clip.at + clip.durationMs >= start && clip.at <= start + duration && (clip.at + clip.durationMs >= leftTime && clip.at <= rightTime || clipDrag.current?.clips.some(c => c.id === clip.id)));
  const toggle = (id: string) => setOpen(values => { const next = new Set(values); next.has(id) ? next.delete(id) : next.add(id); return next; });
  useEffect(() => {
    let active = true;
    setWaveforms({});
    soundWaveforms(chesscom, project).then(buffers => { if (active) setWaveforms(buffers); }).catch(console.error);
    return () => { active = false; };
  }, [chesscom, project.edits.assets]);
  useEffect(() => {
    const object = project.objects.find(o => o.id === selected);
    if (object) setOpen(values => new Set([...values, object.group, object.id]));
  }, [selected]);
  useLayoutEffect(() => {
    if (!selected) return;
    const el = scroll.current!, row = el.querySelector(`[data-object-track="${CSS.escape(selected)}"]`);
    if (!row) return;
    const box = row.getBoundingClientRect(), area = el.getBoundingClientRect();
    const rulerHeight = ruler.current!.parentElement!.clientHeight;
    if (box.top < area.top + rulerHeight) el.scrollTop += box.top - area.top - rulerHeight;
    else if (box.bottom > area.bottom) el.scrollTop += box.bottom - area.bottom;
  }, [selected, open]);
  useLayoutEffect(() => {
    const el = scroll.current!;
    const observe = new ResizeObserver(() => setView({ left: el.scrollLeft, width: el.clientWidth })); observe.observe(el);
    return () => observe.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (zoomAnchor.current) {
      scroll.current!.scrollLeft = (zoomAnchor.current.time - start) * scale - zoomAnchor.current.x;
      zoomAnchor.current = null;
    }
    setView({ left: scroll.current!.scrollLeft, width: scroll.current!.clientWidth });
  }, [scale, start, duration]);
  useEffect(() => {
    const update = () => {
      const state = useEditor.getState(), x = (state.timeMs - start) * scale;
      if (head.current) { head.current.style.left = `${LABEL + x}px`; head.current.hidden = x < 0 || state.timeMs > start + duration; }
      ruler.current?.setAttribute('aria-valuenow', String(state.timeMs));
      ruler.current?.setAttribute('aria-valuetext', `${(state.timeMs / 1000).toFixed(3)} 秒`);
      const el = scroll.current!;
      if (state.playing && state.follow && !dragging.current && (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - LABEL - 40)) el.scrollLeft = Math.max(0, x - 40);
    };
    update(); return useEditor.subscribe(update);
  }, [scale, start, duration]);
  const zoom = (value: number, x = (view.width - LABEL) / 2) => {
    value = Math.max(minScale, Math.min(viewport / Math.max(1, minSpan), value));
    if (value === scale) return;
    zoomAnchor.current = { time: start + (scroll.current!.scrollLeft + x) / scale, x };
    setScale(value);
  };
  const setViewport = (from: number, to: number) => {
    if (to <= from) return;
    setFollow(false);
    const nextScale = viewport / (to - from);
    if (Math.abs(nextScale - scale) < 1e-10) scroll.current!.scrollLeft = from * scale;
    else { zoomAnchor.current = { time: start + from, x: 0 }; setScale(nextScale); }
  };
  useEffect(() => {
    const el = scroll.current!;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        zoom(scale * (event.deltaY > 0 ? .9 : 1.1), Math.max(0, event.clientX - el.getBoundingClientRect().left - LABEL));
      } else if (follow) setFollow(false);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [scale, start, follow, viewport, minSpan]);
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const el = scroll.current!, rect = el.getBoundingClientRect();
    if (event.clientX > rect.right - 16) el.scrollLeft += 24;
    else if (event.clientX < rect.left + LABEL + 16) el.scrollLeft -= 24;
    seekTime(Math.max(start, Math.min(start + duration, snapTime(start + (event.clientX - rect.left - LABEL + el.scrollLeft) / scale, project.output.fps))));
  };
  const startClip = (event: PointerEvent<HTMLButtonElement>, clip: typeof clips[number]) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (additive || !selectedClips.includes(clip.id)) selectObject(clip.objectId, clip.id, additive);
    if (additive || !editable(clip, project)) { seekTime(clip.at); return; }
    const mode = (event.target as HTMLElement).dataset.edge || 'move';
    const selected = mode === 'move' ? project.clips.filter(c => useEditor.getState().selectedClipIds.includes(c.id) && editable(c, project) && (c.moveId === null) === (clip.moveId === null)) : [clip];
    beginEdit(); setFollow(false); event.currentTarget.setPointerCapture(event.pointerId);
    clipDrag.current = { x: event.clientX, scroll: scroll.current!.scrollLeft, mode, clips: selected, active: clip, scale, moved: false,
      boundaries: project.clips.filter(c => c.moveId === clip.moveId && !selected.some(s => s.id === c.id)).flatMap(c => [c.startMs, c.startMs + c.durationMs]) };
  };
  const moveClip = (event: PointerEvent<HTMLButtonElement>) => {
    const d = clipDrag.current, el = scroll.current!; if (!d || !useEditor.getState().editing) return;
    if (Math.abs(event.clientX - d.x) < 2 && !d.moved) return;
    d.moved = true;
    const rect = el.getBoundingClientRect();
    if (event.clientX > rect.right - 16) el.scrollLeft += 20;
    else if (event.clientX < rect.left + LABEL + 16) el.scrollLeft -= 20;
    let delta = (event.clientX - d.x + el.scrollLeft - d.scroll) / d.scale;
    const anchor = d.mode === 'right' ? d.active.startMs + d.active.durationMs : d.active.startMs;
    let target = snapTime(anchor + delta, project.output.fps);
    const near = d.boundaries.filter(t => Math.abs(t - target) * d.scale < 5).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    if (!event.altKey && near !== undefined) target = near;
    delta = target - anchor;
    const frame = 1000 / project.output.fps;
    if (d.mode === 'move') delta = Math.max(-Math.min(...d.clips.map(c => c.startMs)), Math.min(delta, ...d.clips.map(c => clipTimeLimit(c) - c.startMs - c.durationMs)));
    else if (d.mode === 'left') delta = Math.max(-d.active.startMs, Math.min(delta, d.active.durationMs - frame));
    else delta = Math.max(frame - d.active.durationMs, Math.min(delta, clipTimeLimit(d.active) - anchor, 60000 - d.active.durationMs));
    editProject(edits => { for (const c of d.clips) edits.clips[c.id] = { ...edits.clips[c.id],
      startMs: c.startMs + (d.mode === 'right' ? 0 : delta), durationMs: c.durationMs + (d.mode === 'right' ? delta : d.mode === 'left' ? -delta : 0) }; }, true);
  };
  const endClip = (cancel = false) => { const d = clipDrag.current; if (d) { clipDrag.current = null; finishEdit(cancel); if (!cancel && !d.moved) { const range = model.map.ranges[project.segments.findIndex(s => s.id === d.active.moveId)]; seekTime((range?.start || 0) + d.active.startMs); } } };
  useEffect(() => () => endClip(true), []);
  const updateSelection = () => {
    const d = selectionDrag.current, el = scroll.current; if (!d || !el) return;
    const r = el.getBoundingClientRect(), rulerHeight = ruler.current!.parentElement!.clientHeight;
    const x = Math.max(r.left + LABEL, Math.min(r.left + el.clientWidth, d.clientX)) - r.left + el.scrollLeft;
    const y = Math.max(r.top + rulerHeight, Math.min(r.top + el.clientHeight, d.clientY)) - r.top + el.scrollTop;
    if (!d.moved && Math.hypot(x - d.x, y - d.y) < 3) return;
    d.moved = true;
    const left = Math.min(d.x, x), top = Math.min(d.y, y), right = Math.max(d.x, x), bottom = Math.max(d.y, y);
    d.ids = [...new Set([...d.base, ...d.targets.filter(t => t.left <= right && t.right >= left && t.top <= bottom && t.bottom >= top).map(t => t.id)])];
    setSelectionBox({ left, top, width: right - left, height: bottom - top, ids: d.ids });
  };
  const endSelection = (cancel = false) => {
    const d = selectionDrag.current; if (!d) return;
    selectionDrag.current = null; cancelAnimationFrame(selectionFrame.current); setSelectionBox(null);
    if (scroll.current?.hasPointerCapture(d.pointer)) scroll.current.releasePointerCapture(d.pointer);
    if (!cancel) selectTimelineItems(d.ids.filter((id): id is string => typeof id === 'string'), d.ids.filter((id): id is number => typeof id === 'number'));
  };
  useEffect(() => () => endSelection(true), [project, scale, start, open]);
  const startSelection = (event: PointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget, r = el.getBoundingClientRect();
    if (event.button !== 0 || event.clientX < r.left + LABEL || event.clientX >= r.left + el.clientWidth || (event.target as Element).closest('button,input,select,.track-name,.timeline-ruler,.timeline-playhead')) return;
    event.preventDefault(); el.focus({ preventScroll: true }); setFollow(false);
    const content = el.querySelector('.timeline-content')!.getBoundingClientRect();
    const starts = new Map(project.segments.map((s, i) => [s.id, model.map.ranges[i].start]));
    // Include offscreen time ranges so edge scrolling works with virtualized clip buttons.
    const candidates = project.clips.filter(c => c.effect !== 'land' && !c.hidden && !trackState(project, effectTrack(c.objectId, c.effect)).locked)
      .map(c => ({ clip: c, at: (c.moveId ? starts.get(c.moveId)! : 0) + c.startMs }))
      .filter(c => c.at + c.clip.durationMs >= start && c.at <= start + duration);
    const targets: NonNullable<typeof selectionDrag.current>['targets'] = [...el.querySelectorAll<HTMLElement>('[data-clip-object]')].flatMap(lane => {
      const row = lane.getBoundingClientRect();
      return candidates.filter(c => c.clip.objectId === lane.dataset.clipObject && (!lane.dataset.clipEffect || c.clip.effect === lane.dataset.clipEffect)).map(({ clip, at }) => {
        const left = row.left - content.left + (at - start) * scale;
        return { id: clip.id, left, right: left + Math.max(3, clip.durationMs * scale), top: row.top - content.top + 5, bottom: row.bottom - content.top - 5 };
      });
    });
    const beatLane = el.querySelector<HTMLElement>('[data-track-id="beats"] .track-lane'), beatState = trackState(project, 'beats');
    if (beatLane && !beatState.locked && !beatState.hidden) {
      const row = beatLane.getBoundingClientRect(), centerY = row.top - content.top + beatLane.clientHeight / 2;
      for (const time of project.edits.beats || []) if (time >= start && time <= start + duration) {
        const centerX = row.left - content.left + (time - start) * scale;
        targets.push({ id: time, left: centerX - 7, right: centerX + 7, top: centerY - 13, bottom: centerY + 13 });
      }
    }
    const base = event.shiftKey || event.ctrlKey || event.metaKey ? [...selectedClips, ...selectedBeats] : [];
    selectionDrag.current = { x: event.clientX - r.left + el.scrollLeft, y: event.clientY - r.top + el.scrollTop,
      clientX: event.clientX, clientY: event.clientY, pointer: event.pointerId, moved: false, base, ids: base, targets };
    el.setPointerCapture(event.pointerId);
    const scrollSelection = () => {
      const d = selectionDrag.current; if (!d) return;
      const area = el.getBoundingClientRect(), x = el.scrollLeft, y = el.scrollTop;
      if (d.moved) {
        el.scrollLeft += d.clientX > area.right - 16 ? 16 : d.clientX < area.left + LABEL + 16 ? -16 : 0;
        el.scrollTop += d.clientY > area.bottom - 16 ? 12 : d.clientY < area.top + ruler.current!.parentElement!.clientHeight + 16 ? -12 : 0;
        if (x !== el.scrollLeft || y !== el.scrollTop) updateSelection();
      }
      selectionFrame.current = requestAnimationFrame(scrollSelection);
    };
    selectionFrame.current = requestAnimationFrame(scrollSelection);
  };
  const bars = (items: typeof clips, detail: boolean) => items.map(clip => <button key={clip.id} data-clip-id={clip.id}
    data-locked={trackState(project, effectTrack(clip.objectId, clip.effect)).locked} data-disabled={trackState(project, effectTrack(clip.objectId, clip.effect)).hidden || trackState(project, effectTrack(clip.objectId, clip.effect)).muted}
    className={`timeline-clip event-${clip.effect}${highlighted.includes(clip.id) ? ' selected' : ''}${clip.kind === 'event' ? ' is-event' : ''}`} aria-pressed={highlighted.includes(clip.id)}
    aria-label={`${clipName(clip)} ${(clip.at / 1000).toFixed(3)} 秒`} title={`${clipName(clip)} · ${clip.startMs.toFixed(1)} ms · ${clip.durationMs.toFixed(1)} ms`}
    style={{ left: (clip.at - start) * scale, width: Math.max(clip.durationMs * scale, 3) }}
    onPointerDown={e => startClip(e, clip)} onPointerMove={moveClip} onPointerUp={() => endClip()} onPointerCancel={() => endClip(true)} onLostPointerCapture={() => endClip(true)}
    onClick={e => { if (e.detail === 0) { selectObject(clip.objectId, clip.id, e.shiftKey); seekTime(clip.at); } }}>
    {clip.effect === 'sound' ? <AudioWaveform buffer={waveforms[configuredAsset(project, audioPieceKey(project, clip), clip.params.sound!)?.id || clip.params.sound!]} startMs={clip.at} durationMs={clip.durationMs} offsetMs={project.edits.audio?.[clip.id]?.offsetMs || 0} scale={scale} left={leftTime} right={rightTime} /> : detail && <span>{clipName(clip)}</span>}{editable(clip, project) && (clip.effect !== 'sound' || clip.durationMs * scale >= 18) && <><i className="clip-edge left" data-edge="left" title="调整起点" /><i className="clip-edge right" data-edge="right" title="调整终点" /></>}
  </button>);
  const rowState = (id: string) => { const state = trackState(project, id); return { 'data-track-id': id, 'data-locked': state.locked, 'data-disabled': state.hidden || state.muted }; };
  const tickStep = scale >= .2 ? 250 : scale >= .08 ? 1000 : 5000;
  const ticks = Array.from({ length: Math.max(0, Math.ceil((rightTime - leftTime) / tickStep) + 1) }, (_, i) => Math.ceil(leftTime / tickStep) * tickStep + i * tickStep).filter(t => t <= start + duration);
  return <div className="panel-body timeline-panel" tabIndex={-1} onKeyDown={e => {
    if ((e.target as HTMLElement).closest('input,select')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endSelection(true); endClip(true); }
    if (selectionDrag.current) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteTimelineSelection(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); copyClips(); }
  }}><div className="timeline-toolbar"><Transport />
    <label>范围 <select aria-label="时间线范围" value={scope} onChange={e => { setScope(e.target.value); scroll.current!.scrollLeft = 0; }}><option value="all">整盘</option><option value="move">当前走法</option></select></label>
    <label><input aria-label="跟随播放" type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />跟随播放</label><button aria-label="复制片段" disabled={!project.clips.some(c => selectedClips.includes(c.id) && editable(c, project) && copyable(c.effect))} onClick={copyClips}><Icon name="content_copy" size={16} />复制</button><button aria-label={selectedBeats.length ? '删除所选项目' : '删除片段'} disabled={(!selectedBeats.length || trackState(project, 'beats').locked) && !project.clips.some(c => selectedClips.includes(c.id) && editable(c, project) && (removable(c.effect) || c.copied))} onClick={deleteTimelineSelection}><Icon name="delete" size={16} />删除</button></div>
    <div ref={scroll} id="timeline-scroll-area" className="timeline-scroll" tabIndex={-1} title="在空白处拖动框选片段和节拍；Shift/Ctrl 追加选择，Esc 取消" onPointerDown={startSelection}
      onPointerMove={e => { if (selectionDrag.current) { selectionDrag.current.clientX = e.clientX; selectionDrag.current.clientY = e.clientY; updateSelection(); } }}
      onPointerUp={() => endSelection()} onPointerCancel={() => endSelection(true)} onLostPointerCapture={() => endSelection(true)}
      onScroll={e => { setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth }); updateSelection(); }}>
      <div className="timeline-content" style={{ width: width + LABEL }}>
        <div className="timeline-row timeline-ruler"><span className="track-name">时间 / 秒</span><div ref={ruler} className="track-lane" role="slider" tabIndex={0}
          aria-label="时间线播放头" aria-valuemin={start} aria-valuemax={start + duration}
          onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Home') seekTime(start); else if (e.key === 'End') seekTime(start + duration); else stepFrame(e.key === 'ArrowLeft' ? -1 : 1); } }}
          onPointerDown={e => { if (e.button !== 0) return; dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); drag(e); }}
          onPointerMove={e => { if (dragging.current) drag(e); }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
          {ticks.map(t => <span key={t} style={{ left: (t - start) * scale }}>{(t / 1000).toFixed(tickStep < 1000 ? 2 : 0)}</span>)}
        </div></div>
        <TrackRow track="segments" label="走法分段" {...rowState('segments')} header={<><span className="track-label">走法分段 · {project.segments.length}</span><TrackControls id="segments" label="走法分段" /></>}><div className="track-lane">{ranges.map(range => <button key={range.index}
          className={`timeline-segment${ply === range.index + 1 ? ' active' : ''}`} style={{ left: (range.start - start) * scale, width: (range.end - range.start) * scale }}
          title={`${range.index + 1}. ${useEditor.getState().moves[range.index].san}`} onClick={() => { seekTime(range.start); selectObject(project.segments[range.index].objectId); }}>
          {range.index + 1}. {useEditor.getState().moves[range.index].san}</button>)}</div></TrackRow>
        <CameraTracks start={start} scale={scale} left={leftTime} right={rightTime} selectedBeats={selectionBox ? selectionBox.ids.filter((id): id is number => typeof id === 'number') : selectedBeats} />
        {['scene', 'w', 'b'].map(group => <div key={group}>
          <TrackRow track={`group:${group}`} label={group === 'scene' ? '场景' : group === 'w' ? '白方棋子' : '黑方棋子'} className="track-group" {...rowState(`group:${group}`)} header={<><button className="track-label" aria-expanded={open.has(group)} onClick={() => toggle(group)}><Icon name={open.has(group) ? 'expand_more' : 'chevron_right'} size={16} />{group === 'scene' ? '场景' : group === 'w' ? '白方棋子' : '黑方棋子'}</button><TrackControls id={`group:${group}`} label={group === 'scene' ? '场景' : group === 'w' ? '白方棋子' : '黑方棋子'} /></>}><div className="track-lane" /></TrackRow>
          {open.has(group) && project.objects.filter(o => o.group === group).map(original => {
            const object = propertyTarget?.object.id === original.id ? propertyTarget.object : original;
            const items = clips.filter(c => c.objectId === object.id);
            return <div key={object.id}><TrackRow track={object.id} label={objectName(object)} className={selected === object.id ? 'selected-track' : ''} data-object-track={object.id} {...rowState(object.id)}
              header={<><button aria-label={`展开 ${objectName(object)}`} aria-expanded={open.has(object.id)} onClick={() => toggle(object.id)}><Icon name={open.has(object.id) ? 'expand_more' : 'chevron_right'} size={16} /></button>
                <button className="track-label" aria-pressed={selected === object.id} onClick={() => selectObject(object.id)}>{objectName(object)}</button><TrackControls id={object.id} label={objectName(object)} /></>}><div className="track-lane" data-clip-object={object.id}>{bars(items, false)}</div></TrackRow>
              {open.has(object.id) && ['position', 'scale', 'stretch', 'rotation', 'opacity'].map(property => {
                const members = property === 'position' ? ['x', 'y'] : [property], keys = members.flatMap(axis => object.tracks?.[axis] || []);
                if (!keys.length) return null;
                const label = ({ position: '坐标', scale: '缩放', stretch: '横纵拉伸', rotation: '旋转', opacity: '透明度' } as Record<string, string>)[property];
                const ids = members.map(axis => propertyTrack(object.id, axis)), states = ids.map(id => trackState(project, id));
                return <TrackRow key={property} track={propertyTrack(object.id, property)} label={`${objectName(object)} ${label}`} className="effect-row" data-track-id={propertyTrack(object.id, property)} data-locked={states.some(s => s.locked)} data-disabled={states.some(s => s.hidden)}
                  header={<><span className="track-label">{label}</span><TrackControls id={ids} label={`${objectName(object)} ${label}`} /></>}>
                  <div className="track-lane">{[...new Set(keys.map(k => k.time))].sort((a, b) => a - b).filter(t => t >= leftTime && t <= rightTime).map(t => <button key={t} className="property-keyframe" style={{ left: (t - start) * scale }} title={`${t.toFixed(1)} ms`} aria-label={`${label}关键帧 ${t}`} onClick={() => { if (selected !== object.id) selectObject(object.id); selectKey(property, t); seekTime(t); }}><Icon name="diamond" size={12} /></button>)}</div>
                </TrackRow>;
              })}
              {open.has(object.id) && [...new Set(project.clips.filter(c => c.objectId === object.id && c.effect !== 'land').map(c => c.effect))].map(effect => <TrackRow key={effect} track={effectTrack(object.id, effect)} label={`${objectName(object)} ${names[effect]}`} className="effect-row" {...rowState(effectTrack(object.id, effect))}
                header={<><span className="track-label">{names[effect]}</span><TrackControls id={effectTrack(object.id, effect)} label={`${objectName(object)} ${names[effect]}`} /></>}><div className="track-lane" data-clip-object={object.id} data-clip-effect={effect}>{bars(items.filter(c => c.effect === effect), true)}</div></TrackRow>)}
            </div>;
          })}
        </div>)}
        <TrackRow track="audio:sfx" label="A1" className={`audio-track${selected === 'audio:sfx' ? ' selected-track' : ''}`} data-object-track="audio:sfx" {...rowState('audio:sfx')}
          header={<><button className="track-label" aria-label="音轨 1" aria-pressed={selected === 'audio:sfx'} onClick={() => selectObject('audio:sfx')}>A1</button><TrackControls id="audio:sfx" label="A1" audio /></>}><div className="track-lane" data-clip-object="audio:sfx">{bars(clips.filter(c => c.moveId === null), true)}</div>
        </TrackRow>
        <MusicTrack start={start} scale={scale} left={leftTime} right={rightTime} waveforms={waveforms} />
        <div ref={head} className="timeline-playhead" aria-hidden="true"
          onPointerDown={e => { if (e.button !== 0) return; dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); drag(e); }}
          onPointerMove={e => { if (dragging.current) drag(e); }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }} />
        {selectionBox && <div className="timeline-selection-box" aria-hidden="true" style={{ left: selectionBox.left, top: selectionBox.top, width: selectionBox.width, height: selectionBox.height }} />}
      </div>
    </div>
    <TimelineScrollbar total={duration} from={visibleFrom} to={visibleTo} minSpan={minSpan} onChange={setViewport} />
  </div>;
}

