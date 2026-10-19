import { MaterialIcon as Icon } from './ui/material-icon';
import { Fragment, useEffect, useRef, useState, type PointerEvent } from 'react';
import { beginEdit, finishEdit, editProject, editVisual, selectKey, setAutoKey, seekTime, selectPropertySource, clearDirectorOverride } from '../app.ts';
import { properties, sampleTrack, trackIndex, trackVelocity, positionEasing, velocityEasing, ease, editable, clipTimeLimit, trackState, effectTrack, propertyTrack } from '../lib/editing.ts';
import { snapTime } from '../lib/playback.ts';
import { useEditor, type SceneObject, type Keyframe, type Easing } from './store';
import { objectName, names } from './timeline';
import { TimelineScrollbar } from './timeline-scrollbar';
import { projectTimeMap } from '../lib/project.ts';
import { writeMotionTracks, motionTargetAt, sampleObjectMotion, type PropertyTarget } from '../lib/object-properties.ts';
import { MOVE_PRESETS, movePreset, motionPreset, type MovePreset } from '../lib/move-presets.ts';
import { NAG_PRESETS, NAG_PARTICLES, NAG_PARTICLE_PREFIX, nagPreset, nagPresetId, nagParticles, nagParticleId, type NagPhase, type NagParticle } from '../lib/nag-presets.ts';

export function NumberField({ label, value, min, max, step = 1, disabled = false, change, cancel }: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; change: (value: number) => void; cancel?: (start: number) => void }) {
  const [text, setText] = useState(String(value)), [typing, setTyping] = useState(false), input = useRef<HTMLInputElement>(null);
  const active = useRef<{ kind: 'text' | 'drag'; start: number } | null>(null);
  const drag = useRef<{ startX: number; x: number; value: number; moved: boolean } | null>(null);
  const finish = (rollback = false) => {
    const edit = active.current; active.current = null; drag.current = null; setTyping(false);
    if (edit) { if (rollback) cancel?.(edit.start); finishEdit(rollback); }
  };
  const enter = () => {
    if (active.current?.kind === 'text') return;
    active.current = { kind: 'text', start: value }; setText(String(Number(value.toFixed(4)))); setTyping(true); beginEdit();
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); } };
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('keydown', escape, true); if (active.current) finishEdit(true); };
  }, []);
  return <input ref={input} className="scrub-number" aria-label={label} title="左右拖动调整，点击输入；Shift 加速，Alt 微调" type="number" readOnly={!typing}
    value={typing ? text : Number(value.toFixed(4))} min={min} max={max} step={step} disabled={disabled}
    onPointerDown={e => {
      if (e.button !== 0 || !e.currentTarget.readOnly || e.currentTarget.matches(':disabled')) return;
      e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur();
      drag.current = { startX: e.clientX, x: e.clientX, value, moved: false }; e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={e => {
      const d = drag.current; if (!d) return;
      if (!d.moved) { if (Math.abs(e.clientX - d.startX) < 3) return; d.moved = true; active.current = { kind: 'drag', start: value }; beginEdit(); }
      if (!useEditor.getState().editing) { finish(true); return; }
      d.value = Math.max(min, Math.min(max, Number((d.value + (e.clientX - d.x) * step / 4 * (e.shiftKey ? 10 : e.altKey ? .1 : 1)).toFixed(6)))); d.x = e.clientX; change(d.value);
    }} onPointerUp={e => {
      const d = drag.current; if (!d) return;
      drag.current = null;
      if (d.moved) finish(); else { enter(); input.current!.focus(); requestAnimationFrame(() => input.current?.select()); }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }} onPointerCancel={() => { if (drag.current) finish(true); }} onLostPointerCapture={() => { if (drag.current) finish(true); }}
    onFocus={() => { if (!drag.current) enter(); }} onChange={e => { setText(e.target.value); const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) change(n); }}
    onBlur={e => { const n = e.currentTarget.valueAsNumber; if (active.current?.kind === 'text') finish(!Number.isFinite(n) || n < min || n > max); }}
    onClick={e => { if (e.detail === 0 && !e.currentTarget.matches(':disabled')) enter(); }}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); finish(true); e.currentTarget.blur(); } }} />;
}

export function Inspector() {
  const project = useEditor(s => s.project)!, id = useEditor(s => s.selectedObjectId), selectedClip = useEditor(s => s.selectedClipId);
  const target = useEditor(s => s.propertyTarget);
  const object = target?.object || project.objects.find(o => o.id === id), clip = target?.clip || project.clips.find(c => c.id === selectedClip);
  if (!object) return <div className="panel-body inspector empty-state">选择棋子、棋盘或时间线片段以编辑属性。</div>;
  return <div className="panel-body inspector" data-object-id={object.id} aria-label={`对象 ${objectName(object)}`}>
    {object.kind !== 'audio' && <ObjectProperties key={target?.key || id} object={object} target={target || undefined} />}
    {clip && <fieldset className="clip-properties" aria-label={`片段 · ${names[clip.effect]}`} disabled={trackState(project, effectTrack(clip.objectId, clip.effect)).locked}>
      <p className="muted">{clip.copied ? '用户新增副本' : project.edits.clips[clip.id] || project.edits.audio?.[clip.id] ? '自动生成 · 已手动覆盖' : '自动生成'}</p>
      <button disabled={(!project.edits.clips[clip.id] && !project.edits.audio?.[clip.id]) || Object.keys(properties).some(p => trackState(project, propertyTrack(clip.objectId, p)).locked)} onClick={() => clearDirectorOverride('clips', clip.id)}>重置当前片段</button>
      {editable(clip) ? <><label>{clip.moveId === null ? '全局起点' : '起点'} / ms<NumberField label="片段起点" value={clip.startMs} min={0} max={clipTimeLimit(clip) - clip.durationMs} change={value => editProject(e => { e.clips[clip.id] = { ...e.clips[clip.id], startMs: value }; })} /></label>
        <label>时长 / ms<NumberField label="片段时长" value={clip.durationMs} min={1} max={Math.min(60000, clipTimeLimit(clip) - clip.startMs)} change={value => editProject(e => { e.clips[clip.id] = { ...e.clips[clip.id], durationMs: value }; })} /></label>
        {clip.effect === 'sound' && (['volume', 'offsetMs', 'fadeInMs', 'fadeOutMs'] as const).map(key => {
          const label = { volume: '音效音量', offsetMs: '音效素材起点', fadeInMs: '音效淡入', fadeOutMs: '音效淡出' }[key];
          return <label key={key}>{label}<NumberField label={label} value={project.edits.audio?.[clip.id]?.[key] ?? (key === 'volume' ? 1 : 0)} min={0} max={key === 'volume' ? 1 : 60000} step={key === 'volume' ? .05 : 10} change={value => editProject(e => { ((e.audio ||= {})[clip.id] ||= {})[key] = value; })} /></label>;
        })}
        {clip.effect !== 'sound' && <><label>片段缓动<select aria-label="片段缓动" value={Array.isArray(clip.easing) ? 'bezier' : clip.easing || 'default'} onChange={e => editProject(edits => { edits.clips[clip.id] = { ...edits.clips[clip.id] }; if (e.target.value === 'default') delete edits.clips[clip.id].easing; else edits.clips[clip.id].easing = e.target.value === 'bezier' ? [.25, .1, .25, 1] : e.target.value === 'hold' ? 'hold' : 'linear'; })}>
          <option value="default">原始动效</option><option value="linear">线性</option><option value="hold">保持</option><option value="bezier">贝塞尔</option></select></label>
        {Array.isArray(clip.easing) && <Bezier value={clip.easing} change={value => editProject(e => { e.clips[clip.id] = { ...e.clips[clip.id], easing: value }; })} />}</>}</> : <p className="muted">此事件跟随棋局动作自动定位。</p>}
    </fieldset>}
    {object.kind !== 'audio' && <SegmentTiming />}
  </div>;
}

function ObjectProperties({ object, target }: { object: SceneObject; target?: PropertyTarget }) {
  const project = useEditor(s => s.project!);
  const time = useEditor(s => s.timeMs), duration = useEditor(s => s.durationMs), auto = useEditor(s => s.autoKey), fps = useEditor(s => s.project!.output.fps);
  const selectedTime = useEditor(s => s.selectedKeyTime), selectedProperty = useEditor(s => s.selectedProperty), editing = useEditor(s => s.editing), locked = useEditor(s => trackState(s.project!, target?.clip ? effectTrack(object.id, target.clip.effect) : object.id).locked);
  const resetLocked = useEditor(s => Object.keys(properties).some(axis => trackState(s.project!, propertyTrack(object.id, axis)).locked) || !!target?.entries?.some(e => trackState(s.project!, effectTrack(object.id, e.clip.effect)).locked));
  const moveEntries = target?.motion && target.clip?.effect === 'move' ? target.entries || [target] : [];
  const presets = moveEntries.map(entry => motionPreset(project.edits.clips[entry.clip!.id]?.motions?.[entry.motion!.id], entry.clip!.params.piece!));
  const preset = new Set(presets).size === 1 ? presets[0] : 'mixed';
  const nagPhase = target?.clip?.effect === 'nag' || target?.clip?.effect === 'nag-exit';
  const total = Math.max(1, duration, ...Object.values(object.tracks || {}).flat().map(k => k.time));
  const [range, setRange] = useState(target?.motion && !target.entries ? [target.start, target.start + target.duration] : [0, total]), minSpan = Math.min(total, 2000 / fps);
  const previousTotal = useRef(total);
  useEffect(() => {
    const before = previousTotal.current; previousTotal.current = total;
    setRange(r => r[0] === 0 && Math.abs(r[1] - before) < .0001 ? [0, total] : r);
  }, [total]);
  useEffect(() => {
    if (target?.motion && !target.entries) setRange([target.start, target.start + target.duration]);
  }, [target?.start, target?.duration]);
  const from = Math.min(range[0], total - minSpan), to = Math.min(total, Math.max(from + minSpan, range[1]));
  const lastSelection = useRef<string | null>(null);
  useEffect(() => {
    if (editing) return;
    const selection = `${selectedProperty}:${selectedTime}`;
    if (lastSelection.current === selection) return; // Follow a new selection without undoing manual scrolling.
    lastSelection.current = selection;
    if (selectedTime !== null && (selectedTime < from || selectedTime > to)) {
      const start = Math.max(0, Math.min(total - (to - from), selectedTime - (to - from) / 2)); setRange([start, start + to - from]);
    }
  }, [selectedTime, selectedProperty, editing, from, to, total]);
  return <>{target && target.actions.length > 0 && <div className="clip-properties property-source">
      <label>对象动画<select aria-label="对象动画" value={target.entries ? 'moves' : target.clip?.id || 'object'} onChange={e => selectPropertySource(e.target.value === 'object' || e.target.value === 'moves' ? e.target.value : { clipId: e.target.value })}>
        <option value="object">整体变换</option>{object.kind === 'piece' && target.actions.some(c => c.effect === 'move') && <option value="moves">全部走子</option>}{target.actions.map(c => <option key={c.id} value={c.id}>第 {c.moveId?.split(':')[1]} 手 · {names[c.effect]}{c.copied ? '（副本）' : ''}</option>)}</select></label>
      {target.parts.length > 1 && <label>动画部件<select aria-label="动画部件" value={target.motion!.id} onChange={e => selectPropertySource({ clipId: target.clip!.id, motionId: e.target.value })}>{target.parts.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>}
      {moveEntries.length > 0 && <label>移动预设<select aria-label="移动预设" title={target.entries ? '应用到该棋子的全部走子' : '应用到当前走子'} value={preset} disabled={locked || resetLocked} onChange={event => {
        const value = event.target.value; finishEdit();
        editProject(edits => {
          for (const entry of moveEntries) {
            if (value === 'default') delete edits.clips[entry.clip!.id]?.motions?.[entry.motion!.id];
            else {
              const clip = edits.clips[entry.clip!.id] ||= {};
              (clip.motions ||= {})[entry.motion!.id] = movePreset(value as MovePreset, entry.clip!.params.piece!);
            }
          }
        });
      }}><option value="default">默认（倾斜移动）</option>
        {preset === 'custom' && <option value="custom" disabled>自定义</option>}{preset === 'mixed' && <option value="mixed" disabled>多种预设</option>}
        {Object.entries(MOVE_PRESETS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
      {nagPhase && <NagEffects target={target} disabled={resetLocked} />}
      {target.motion && !moveEntries.length && (!nagPhase || !target.motion.id.startsWith('badge:')) && <button disabled={locked || resetLocked} onClick={() => editProject(e => { delete e.clips[target.clip!.id]?.motions?.[target.motion!.id]; })}>恢复默认动作</button>}
    </div>}<div className="effect-controls" id="property-time-rows">
    <div className="effect-header inspector-row"><div className="effect-header-values"><label className="auto-key" title="修改属性时会在当前播放头位置自动添加或更新关键帧。"><input type="checkbox" disabled={locked} checked={auto} onChange={e => setAutoKey(e.target.checked)} />自动关键帧</label>
      <output>{(time / 1000).toFixed(3)} s</output><button aria-label="显示完整属性时间线" title="显示完整时间范围" onClick={() => setRange([0, total])}><Icon name="refresh" size={16} /></button></div>
      <PropertyTimeRuler label="属性时间尺" time={time} from={from} to={to} total={total} fps={fps} /></div>
    {['position', 'scale', ...(!target?.motion ? ['stretch'] : []), 'rotation', 'opacity'].map(property => <Property key={property} object={object} target={target} property={property} from={from} to={to} />)}
    <div className="inspector-row effect-range"><span /><TimelineScrollbar label="属性时间线" controls="property-time-rows" total={total} from={from} to={to} minSpan={minSpan} onChange={(a, b) => setRange([a, b])} /></div>
  </div></>;
}

function NagEffects({ target, disabled }: { target: PropertyTarget; disabled: boolean }) {
  const project = useEditor(s => s.project!);
  const current = target.clip!, square = project.segments.find(segment => segment.id === current.moveId)?.snapshot.pieces[0].to;
  const badge = target.parts.find(part => part.id === `badge:${square}`) || target.parts.find(part => part.id.startsWith('badge:'));
  if (!badge) return null;
  const clips = current.copied ? [current] : (['nag', 'nag-exit'] as const).flatMap(effect => {
    const clip = project.clips.find(clip => clip.moveId === current.moveId && clip.effect === effect && !clip.copied && clip.durationMs > 0);
    return clip ? [clip] : [];
  });
  return <>{clips.map(clip => {
    const phase = clip.effect as NagPhase, motions = project.edits.clips[clip.id]?.motions || {};
    const preset = nagPresetId(phase, motions[badge.id]), particle = nagParticleId(motions);
    const enter = phase === 'nag', label = enter ? 'NAG 入场预设' : 'NAG 退场预设';
    const locked = disabled || trackState(project, effectTrack(clip.objectId, clip.effect)).locked;
    return <Fragment key={clip.id}>
    <label>{enter ? '入场特效' : '退场特效'}<select aria-label={label} value={preset} disabled={locked} onChange={event => {
      const value = event.target.value; finishEdit();
      editProject(edits => {
        if (value === 'default') delete edits.clips[clip.id]?.motions?.[badge.id];
        else ((edits.clips[clip.id] ||= {}).motions ||= {})[badge.id] = nagPreset(phase, value);
      });
    }}><option value="default">{enter ? '默认（旋转弹入）' : '默认（旋转缩小）'}</option>
      {preset === 'custom' && <option value="custom" disabled>自定义</option>}
      {Object.entries(NAG_PRESETS[phase]).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label>{enter ? '入场粒子' : '退场粒子'}<select aria-label={enter ? 'NAG 入场粒子' : 'NAG 退场粒子'} value={particle} disabled={locked} onChange={event => {
      const value = event.target.value; finishEdit();
      editProject(edits => {
        const parts = ((edits.clips[clip.id] ||= {}).motions ||= {});
        for (const id of Object.keys(parts)) if (id.startsWith(NAG_PARTICLE_PREFIX)) delete parts[id];
        if (value !== 'none') Object.assign(parts, nagParticles(value as NagParticle));
      });
    }}><option value="none">无粒子</option>{particle === 'custom' && <option value="custom" disabled>自定义</option>}
      {Object.entries(NAG_PARTICLES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    </Fragment>;
  })}</>;
}

export function PropertyTimeRuler({ label, time, from, to, total, fps }: { label: string; time: number; from: number; to: number; total: number; fps: number }) {
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); seekTime(snapTime(Math.max(from, Math.min(to, from + ((e.clientX - r.left) / r.width * 300 - 12) / 276 * (to - from))), fps));
  };
  const step = 10 ** Math.floor(Math.log10((to - from) / 4)), tick = [1, 2, 5, 10].map(n => n * step).find(n => n >= (to - from) / 4)!;
  const ticks = Array.from({ length: Math.floor((to - from) / tick) + 2 }, (_, i) => (Math.ceil(from / tick) + i) * tick).filter(t => t <= to);
  return <div className="effect-ruler effect-time-cell" role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={time} aria-valuetext={`${(time / 1000).toFixed(3)} 秒`}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}
    onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    onKeyDown={e => { const delta = { ArrowLeft: -1000 / fps, ArrowRight: 1000 / fps, Home: -time, End: total - time }[e.key]; if (delta !== undefined) { e.preventDefault(); e.stopPropagation(); seekTime(time + delta); } }}>
    {ticks.map(t => <span key={t} className="effect-tick" style={{ left: `${4 + (t - from) / (to - from) * 92}%` }}>{Number((t / 1000).toFixed(3))} s</span>)}<PropertyPlayhead time={time} from={from} to={to} />
  </div>;
}

export function PropertyPlayhead({ time, from, to }: { time: number; from: number; to: number }) {
  return <div className="effect-playhead" hidden={time < from || time > to} style={{ left: `${4 + (time - from) / (to - from) * 92}%` }} />;
}

function SegmentTiming() {
  const project = useEditor(s => s.project)!, ply = useEditor(s => s.ply), clipId = useEditor(s => s.selectedClipId);
  const target = useEditor(s => s.propertyTarget);
  const clip = target?.clip || project.clips.find(c => c.id === clipId), segment = clip ? project.segments.find(s => s.id === clip.moveId) : project.segments[Math.max(0, ply - 1)];
  const [duration, setDuration] = useState('');
  useEffect(() => { setDuration(String(segment?.durationMs || 0)); }, [segment]);
  if (!segment) return null;
  const locked = trackState(project, 'segments').locked || trackState(project, segment.objectId).locked;
  const scaleLocked = project.clips.filter(c => c.moveId === segment.id).some(c => trackState(project, effectTrack(c.objectId, c.effect)).locked);
  const apply = (scale: boolean) => {
    const target = Number(duration); if (!Number.isFinite(target) || target < 1 || target > 60000) return;
    editProject(edits => {
      if (scale) for (const c of project.clips.filter(c => c.moveId === segment.id)) {
        edits.clips[c.id] = { ...edits.clips[c.id], startMs: c.startMs * target / segment.durationMs, ...(c.durationMs ? { durationMs: Math.max(1, c.durationMs * target / segment.durationMs) } : {}) };
      }
      edits.segments[segment.id] = { durationMs: target };
    });
  };
  return <fieldset className="clip-properties" aria-label={`分段时序 · ${segment.ply}`} disabled={locked}><label>目标时长 / ms<NumberField label="分段时长" value={Number(duration)} min={1} max={60000} change={value => setDuration(String(value))} cancel={value => setDuration(String(value))} /></label>
    <div className="property-actions"><button onClick={() => apply(false)}>调整尾部</button><button disabled={scaleLocked} onClick={() => apply(true)}>缩放整段时序</button></div></fieldset>;
}

function Property({ object, target, property, from, to }: { object: SceneObject; target?: PropertyTarget; property: string; from: number; to: number }) {
  const [expanded, setExpanded] = useState(false);
  const time = useEditor(s => s.timeMs), duration = useEditor(s => s.durationMs), fps = useEditor(s => s.project!.output.fps);
  const auto = useEditor(s => s.autoKey);
  const position = property === 'position', members = position ? ['x', 'y'] : [property], p = properties[members[0]], label = position ? '坐标' : p.label;
  const locked = useEditor(s => members.some(axis => trackState(s.project!, propertyTrack(object.id, axis)).locked) || !!target?.clip && trackState(s.project!, effectTrack(object.id, target.clip.effect)).locked);
  const selectedProperty = useEditor(s => s.selectedProperty), selectedTime = useEditor(s => s.selectedKeyTime);
  const tracks = Object.fromEntries(members.map(axis => [axis, object.tracks?.[axis] || []]));
  const frames = Object.values(tracks).flat(), times = [...new Set(frames.map(k => k.time))].sort((a, b) => a - b);
  const selected = selectedProperty === property && selectedTime !== null ? times.find(t => Math.abs(t - selectedTime) < .0001) ?? null : null;
  const axisFrames = position ? times.map((time, i) => {
    const end = times[i + 1] ?? time, axis = Math.abs(sampleTrack(tracks.x, end, object.visual.x) - sampleTrack(tracks.x, time, object.visual.x)) >= Math.abs(sampleTrack(tracks.y, end, object.visual.y) - sampleTrack(tracks.y, time, object.visual.y)) ? 'x' : 'y';
    return { time, value: 0, easing: tracks[axis][trackIndex(tracks[axis], time)]?.easing || 'linear' };
  }) : tracks[property], index = axisFrames.findIndex(k => k.time === selected);
  const sameMotion = (a: Keyframe, b: Keyframe) => !target?.entries || motionTargetAt(target, a.time).clip?.id === motionTargetAt(target, b.time).clip?.id;
  const segmentIndex = index >= 0 && index < axisFrames.length - 1 && sameMotion(axisFrames[index], axisFrames[index + 1]) ? index : index - 1;
  const segment = index >= 0 && segmentIndex >= 0 && axisFrames.length > 1 && sameMotion(axisFrames[segmentIndex], axisFrames[segmentIndex + 1]) ? { a: axisFrames[segmentIndex], b: axisFrames[segmentIndex + 1] } : null;
  const handles = index < 0 ? [] : [index > 0 ? { a: axisFrames[index - 1], b: axisFrames[index], control: 2, side: '进入' } : null,
    index < axisFrames.length - 1 ? { a: axisFrames[index], b: axisFrames[index + 1], control: 0, side: '离开' } : null].filter(h => h !== null).filter(h => sameMotion(h.a, h.b));
  const lower = target?.motion ? target.start : 0, upper = target?.motion ? target.start + target.duration : Math.max(duration, ...times);
  const clampTime = (t: number) => Math.max(lower, Math.min(upper, snapTime(t, fps)));
  const addTarget = target?.entries ? motionTargetAt(target, time) : target;
  const at = addTarget?.motion ? Math.max(addTarget.start, Math.min(addTarget.start + addTarget.duration, snapTime(time, fps))) : clampTime(time), keyHere = times.some(t => Math.abs(t - at) < .0001);
  const activeFrames = frames.filter(k => !target?.entries || k.time >= lower - .0001 && k.time <= upper + .0001);
  const sample = (axis: string, t: number) => target?.entries ? sampleObjectMotion(target, axis, t) : sampleTrack(tracks[axis], t, object.visual[axis]);
  const value = (axis: string) => sample(axis, !auto && selected !== null ? selected : time);
  const setTracks = (next: Record<string, Keyframe[]>, owner = target) => editProject(e => { if (owner?.motion) { writeMotionTracks(e, owner, next); return; } const o = e.objects[object.id] ||= { visual: {}, tracks: {} }; for (const axis of members) (o.tracks ||= {})[axis] = [...next[axis]].sort((a, b) => a.time - b.time); });
  const changeValue = (axis: string, v: number) => {
    if (!target?.motion) { editVisual(object.id, axis, v); return; }
    const t = !auto && selected !== null ? selected : at;
    if (!activeFrames.length && !auto) editProject(e => writeMotionTracks(e, target, { [axis]: [] }, { [axis]: v }));
    else {
      setTracks(Object.fromEntries(members.map(member => [member, [...tracks[member].filter(k => Math.abs(k.time - t) >= .0001),
        { time: t, value: member === axis ? v : sampleTrack(tracks[member], t, object.visual[member]), easing: tracks[member].find(k => Math.abs(k.time - t) < .0001)?.easing || 'linear' }].sort((a, b) => a.time - b.time)])));
      selectKey(property, t);
    }
  };
  const add = () => { setTracks(Object.fromEntries(members.map(axis => [axis, tracks[axis].some(k => Math.abs(k.time - at) < .0001) ? tracks[axis] : [...tracks[axis], { time: at, value: sample(axis, at), easing: 'linear' }]])), addTarget); selectKey(property, at); };
  const remove = () => { setTracks(Object.fromEntries(members.map(axis => [axis, tracks[axis].filter(k => k.time !== selected)]))); selectKey(property, null); };
  const changeKey = (patch: Partial<Keyframe>) => {
    if (selected === null || patch.time !== undefined && times.some(t => t !== selected && Math.abs(t - patch.time!) < .0001)) return;
    setTracks(Object.fromEntries(members.map(axis => [axis, tracks[axis].map(k => k.time === selected ? { ...k, ...patch } : k)])));
    if (patch.time !== undefined) selectKey(property, patch.time);
  };
  const select = (t: number) => { selectKey(property, t); seekTime(t); };
  const setEasing = (a: Keyframe, b: Keyframe, easing: Easing, link: boolean | 0 | 2 = true) => setTracks(position ? positionEasing(tracks, object.visual, a.time, b.time, easing, link) : { [property]: axisFrames.map(k => k.time === a.time ? { ...k, easing } : k) });
  const distance = (a: Keyframe, b: Keyframe) => Math.hypot(...members.map(axis => sampleTrack(tracks[axis], b.time, object.visual[axis]) - sampleTrack(tracks[axis], a.time, object.visual[axis])));
  const speed = (t: number, side: 'before' | 'after' = 'after') => Math.hypot(...members.map(axis => trackVelocity(tracks[axis], t, side)));
  const samples = Math.max(2, Math.min(100, Math.floor(300 / Math.max(1, times.length - 1))));
  const speedCurves = position ? times.slice(0, -1).map((a, i) => Array.from({ length: samples + 1 }, (_, j) => { const time = a + (times[i + 1] - a) * j / samples; return { time, value: speed(time, j === samples ? 'before' : 'after') }; })) : [];
  const previous = times.filter(t => t < time - .0001).at(-1), next = times.find(t => t > time + .0001);
  const drag = useRef<{ x: number; y: number; key: Keyframe; tracks: Record<string, Keyframe[]>; times: number[]; low: number; high: number; end: number; width: number; height: number; timeOnly: boolean; handle?: { b: Keyframe; control: number; easing: number[]; average: number; speed: number } } | null>(null);
  const curveValues = Object.values(tracks).flatMap(keys => keys.flatMap((a, i) => { const b = keys[i + 1], curve = a.easing; return b && Array.isArray(curve) ? [a.value, ...[1, 3].map(j => a.value + (b.value - a.value) * curve[j])] : [a.value]; }));
  const low = drag.current?.low ?? (position ? 0 : Math.min(p.value, ...curveValues) - (property === 'rotation' ? 30 : .5));
  const high = drag.current?.high ?? (position ? speedCurves.reduce((max, keys) => keys.reduce((max, k) => Math.max(max, k.value), max), 1) * 1.25 : Math.max(p.value, ...curveValues) + (property === 'rotation' ? 30 : .5));
  const end = drag.current?.end ?? (to - from);
  const point = (t: number, v: number) => `${12 + (t - from) / end * 276},${108 - (v - low) / (high - low) * 96}`;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current; if (!d || !useEditor.getState().editing) return;
    if (d.handle) {
      const { b, control, easing } = d.handle, next = [...easing], span = b.value - d.key.value;
      next[control] = Math.max(position ? .001 : 0, Math.min(position ? .999 : 1, easing[control] + (e.clientX - d.x) / d.width * 300 / 276 * d.end / (b.time - d.key.time)));
      if (position) {
        const velocity = Math.max(0, d.handle.speed - (e.clientY - d.y) / d.height * 128 / 96 * (d.high - d.low)), influence = control === 0 ? next[0] : 1 - next[2];
        setTracks(positionEasing(d.tracks, object.visual, d.key.time, b.time, velocityEasing(easing, control, d.handle.average, velocity, influence), e.ctrlKey || e.metaKey ? false : control === 0 ? 0 : 2));
      } else { if (span) next[control + 1] = Math.max(-10, Math.min(10, easing[control + 1] - (e.clientY - d.y) / d.height * 128 / 96 * (d.high - d.low) / span)); setTracks({ [property]: d.tracks[property].map(k => k.time === d.key.time ? { ...k, easing: next } : k) }); }
      return;
    }
    const index = d.times.indexOf(d.key.time), prev = d.times[index - 1], next = d.times[index + 1];
    const t = Math.max(lower, prev !== undefined ? prev + .001 : lower, Math.min(upper, next !== undefined ? next - .001 : upper, snapTime(d.key.time + (e.clientX - d.x) / d.width * 300 / 276 * d.end, fps)));
    const v = Math.max(target?.motion && property === 'scale' ? 0 : p.min, Math.min(p.max, d.key.value - (e.clientY - d.y) / d.height * 128 / 96 * (d.high - d.low)));
    setTracks(Object.fromEntries(members.map(axis => [axis, d.tracks[axis].map(k => k.time === d.key.time ? { ...k, time: t, ...(!position && !d.timeOnly ? { value: v } : {}) } : k)]))); selectKey(property, t);
  };
  const startDrag = (e: PointerEvent<SVGCircleElement>, key: Keyframe, handle?: { b: Keyframe; control: number; easing: number[]; average: number; speed: number }) => {
    const owner = target?.entries ? motionTargetAt(target, key.time) : target, project = useEditor.getState().project!;
    if (e.button !== 0 || members.some(axis => trackState(project, propertyTrack(object.id, axis)).locked) || owner?.clip && trackState(project, effectTrack(object.id, owner.clip.effect)).locked) return;
    e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur();
    const svg = e.currentTarget.ownerSVGElement!, r = svg.getBoundingClientRect();
    if (!handle) select(key.time);
    beginEdit(); drag.current = { x: e.clientX, y: e.clientY, key, tracks, times, low, high, end, width: r.width, height: r.height, timeOnly: svg.classList.contains('property-key-lane'), handle }; svg.setPointerCapture(e.pointerId);
  };
  const finish = (cancel = false) => { if (drag.current) { drag.current = null; finishEdit(cancel); if (cancel) selectKey(property, null); } };
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.current) { e.preventDefault(); e.stopPropagation(); finish(true); } };
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('keydown', escape, true); finish(true); };
  }, []);
  const easing = segment?.a.easing || 'linear';
  return <div className="property property-curve" data-property={property} data-expanded={expanded}><div className="inspector-row property-row"><div className="property-value">
    <button className="curve-toggle" aria-label={`${expanded ? '收起' : '展开'}${label}曲线`} aria-expanded={expanded} onClick={() => { finish(true); setExpanded(!expanded); }}><Icon name={expanded ? 'expand_more' : 'chevron_right'} size={16} /></button><label>{label}<small>{p.unit}</small></label>
    <span className={`property-numbers${members.length > 1 ? ' position-numbers' : ''}`}>{members.map(axis => <span key={axis}>{members.length > 1 && <small>{axis.toUpperCase()}</small>}<NumberField label={properties[axis].label} value={value(axis)} min={target?.motion && property === 'scale' ? 0 : p.min} max={p.max} step={p.step} disabled={locked || !!activeFrames.length && selected === null && !auto} change={v => changeValue(axis, v)} /></span>)}</span>
    <span className="keyframe-navigation"><button title="跳转到上一个关键帧" aria-label={`${label}上一个关键帧`} disabled={previous === undefined} onClick={() => select(previous!)}><Icon name="skip_previous" size={16} /></button>
      <button title="在播放头添加关键帧" aria-label={`添加${label}关键帧`} disabled={locked} aria-pressed={keyHere} onClick={add}><Icon name="diamond" size={16} /></button>
      <button title="跳转到下一个关键帧" aria-label={`${label}下一个关键帧`} disabled={next === undefined} onClick={() => select(next!)}><Icon name="skip_next" size={16} /></button></span></div>
    <div className="effect-time-cell"><svg className="property-key-lane" viewBox="0 0 300 32" preserveAspectRatio="none" aria-label={`${label}关键帧时间轴`} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}>
      {axisFrames.map((k, i) => <circle key={k.time} data-motion-clip={target?.entries ? motionTargetAt(target, k.time).clip?.id : undefined} cx={12 + (k.time - from) / end * 276} cy="16" r="4" fill={selected === k.time ? 'var(--accent)' : '#bdbdbd'} role="button" tabIndex={0} aria-pressed={selected === k.time} aria-label={`${label}关键帧 ${i + 1}`} onClick={() => select(k.time)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(k.time); } }} onPointerDown={e => startDrag(e, k)}><title>{target?.entries && `第 ${motionTargetAt(target, k.time).clip!.moveId?.split(':')[1]} 手 · `}{(k.time / 1000).toFixed(3)} s</title></circle>)}
    </svg><PropertyPlayhead time={time} from={from} to={to} /></div></div>
    {expanded && <div className="inspector-row property-expanded"><div className="property-settings">
      <div className="curve-toolbar"><span>{position ? '速度 · 格／秒' : `${label}值`}</span>
        {position && index > 0 && index < axisFrames.length - 1 && <button className="link-velocity" disabled={locked || Math.abs(speed(selected!, 'before') - speed(selected!)) < .000001} title="让当前关键帧的进入速度与离开速度相同" onClick={() => setEasing(segment!.a, segment!.b, Array.isArray(easing) ? easing : [1 / 3, 1 / 3, 2 / 3, 2 / 3], 0)}>联动速度</button>}
        {segment && <label>{index === axisFrames.length - 1 ? '前段' : '后段'}{position ? '时间' : ''}插值<select aria-label={`${label}插值`} disabled={locked} value={Array.isArray(easing) ? 'bezier' : easing} onChange={e => setEasing(segment.a, segment.b, e.target.value === 'bezier' ? position ? [1 / 3, 0, 2 / 3, 1] : [.25, .1, .25, 1] : e.target.value as Easing)}><option value="linear">线性</option><option value="hold">保持</option><option value="bezier">贝塞尔</option></select></label>}</div>
      <div className="curve-help">{selected === null ? '选择关键帧后拖动手柄调整曲线' : segment ? position ? '上下调速度，左右调影响范围' : '拖动空心手柄调整曲线' : '至少两个关键帧才能调整曲线'}</div>
      {selected !== null && <fieldset disabled={locked} className="keyframe-properties"><label>时间 / ms<NumberField label={`${label}关键帧时间`} value={selected} min={lower} max={upper} step={1000 / fps} change={t => changeKey({ time: clampTime(t) })} cancel={t => selectKey(property, t)} /></label>
        <button className="delete-key" onClick={remove}>删除此关键帧</button></fieldset>}
      <div className="property-mode">{frames.length > 0 && <button disabled={locked} onClick={() => { editProject(e => { if (target?.motion) { writeMotionTracks(e, target, Object.fromEntries(members.map(axis => [axis, []])), Object.fromEntries(members.map(axis => [axis, value(axis)]))); return; } const o = e.objects[object.id] ||= {}; for (const axis of members) { (o.visual ||= {})[axis] = value(axis); if (o.tracks) delete o.tracks[axis]; } }); selectKey(property, null); }}>{target?.entries ? '当前走子转为静态' : '转为静态'}</button>}</div>
      </div><div className="effect-time-cell property-graph"><svg viewBox="0 0 300 128" preserveAspectRatio="none" aria-label={`${label}${position ? '速度' : ''}曲线`} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}>
        <path d="M12 8V108H288" fill="none" stroke="#555555" />
        {position ? <path className="position-speed-curve" fill="none" stroke="var(--accent)" strokeWidth="2" d={speedCurves.length ? speedCurves.map(keys => keys.map((k, i) => `${i ? 'L' : 'M'}${point(k.time, k.value)}`).join(' ')).join(' ') : `M${point(from, 0)}L${point(to, 0)}`} /> : <>
          <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={Array.from({ length: 101 }, (_, i) => point(from + end * i / 100, sample(property, from + end * i / 100))).join(' ')} />
          {axisFrames.map((k, i) => { const [x, y] = point(k.time, k.value).split(','); return <circle key={i} cx={x} cy={y} r={selected === k.time ? 5 : 4} fill="var(--accent)" role="button" tabIndex={0} aria-label={`${label}值关键帧 ${i + 1}`} onClick={() => select(k.time)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(k.time); } }} onPointerDown={e => startDrag(e, k)} />; })}</>}
        {handles.map(({ a, b, control, side }) => {
          const curve = Array.isArray(a.easing) ? a.easing : [1 / 3, 1 / 3, 2 / 3, 2 / 3], anchor = control === 0 ? a : b;
          const average = distance(a, b) * 1000 / (b.time - a.time), velocity = speed(anchor.time, control === 0 ? 'after' : 'before'), influence = control === 0 ? curve[0] : 1 - curve[2], disabled = locked || position && !average;
          const [x, y] = point(a.time + (b.time - a.time) * curve[control], position ? velocity : a.value + (b.value - a.value) * curve[control + 1]).split(',');
          return <g key={side} className="curve-handle"><path d={`M${point(anchor.time, position ? velocity : anchor.value)}L${x},${y}`} fill="none" stroke="var(--accent)" strokeDasharray="3 2" />
            {position && <circle cx={12 + (anchor.time - from) / end * 276} cy={y} r="4" fill="var(--accent)" />}
            <circle cx={x} cy={y} r="4.5" fill="var(--bg)" stroke="var(--accent)" strokeWidth="1.5" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`${label}${side}手柄`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={position ? influence : curve[control]} aria-valuetext={position ? `速度 ${velocity.toFixed(2)} 格／秒，影响 ${(influence * 100).toFixed(1)}%` : `时间 ${curve[control].toFixed(2)}，幅度 ${curve[control + 1].toFixed(2)}`}
              onPointerDown={e => { if (!disabled) startDrag(e, a, { b, control, easing: curve, average, speed: velocity }); }}
              onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); if (disabled) return; const horizontal = ['ArrowLeft', 'ArrowRight'].includes(e.key), delta = (['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1) * (e.shiftKey ? .1 : .02);
                if (position) setEasing(a, b, velocityEasing(curve, control, average, Math.max(0, velocity + (horizontal ? 0 : high * delta)), influence + (horizontal ? delta * (control === 0 ? 1 : -1) : 0)), e.ctrlKey || e.metaKey ? false : control === 0 ? 0 : 2);
                else { const next = [...curve], i = horizontal ? control : control + 1; if (!horizontal && a.value === b.value) return; next[i] = Math.max(horizontal ? 0 : -10, Math.min(horizontal ? 1 : 10, next[i] + delta)); setEasing(a, b, next); }
              }}><title>{position ? '上下调速度，左右调影响范围；Ctrl 拖动单独调整一侧；方向键微调' : '拖动调整曲线；方向键微调'}</title></circle></g>;
        })}
      </svg><PropertyPlayhead time={time} from={from} to={to} /></div></div>}
  </div>;
}

function Bezier({ value, change }: { value: number[]; change: (v: number[]) => void }) {
  const drag = useRef<{ index: number; value: number[] } | null>(null);
  const xy = (x: number, y: number) => `${20 + x * 260},${100 - y * 60}`;
  const finish = (cancel = false) => { if (drag.current) { drag.current = null; finishEdit(cancel); } };
  useEffect(() => () => finish(true), []);
  return <div className="bezier"><span className="muted">缓动 · 时间 → 进度</span><svg viewBox="0 0 300 140" aria-label="贝塞尔缓动" onPointerMove={e => {
    if (!drag.current || !useEditor.getState().editing) return;
    const r = e.currentTarget.getBoundingClientRect(), next = [...drag.current.value], i = drag.current.index;
    next[i] = Math.max(0, Math.min(1, ((e.clientX - r.left) / r.width * 300 - 20) / 260));
    next[i + 1] = Math.max(-10, Math.min(10, (100 - (e.clientY - r.top) / r.height * 140) / 60)); change(next);
  }} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}>
    <path d="M20 100H280 M20 40H280" stroke="#404040" />
    <polyline points={Array.from({ length: 81 }, (_, i) => xy(i / 80, ease(i / 80, value))).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2" />
    <path d={`M20 100L${xy(value[0], value[1])} M280 40L${xy(value[2], value[3])}`} stroke="#8a8a8a" />
    {[0, 2].map(i => <circle key={i} cx={20 + value[i] * 260} cy={100 - value[i + 1] * 60} r="5" fill="var(--accent)" aria-label={`贝塞尔控制点 ${i / 2 + 1}`} onPointerDown={e => { if (e.currentTarget.closest('fieldset:disabled')) return; e.preventDefault(); beginEdit(); drag.current = { index: i, value }; e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId); }} />)}
  </svg><div className="bezier-values">{['X1', 'Y1', 'X2', 'Y2'].map((label, i) => <label key={label}>{label}<NumberField label={`贝塞尔 ${label}`} value={value[i]} min={i % 2 ? -10 : 0} max={i % 2 ? 10 : 1} step={.01} change={n => change(value.map((v, j) => i === j ? n : v))} /></label>)}</div></div>;
}
