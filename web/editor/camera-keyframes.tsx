import { useEffect, useRef, useState } from 'react';
import { seekTime, togglePlaying } from '../app.ts';
import type { CameraPose } from '../lib/types.ts';
import { trackState } from '../lib/editing.ts';
import { resolveCamera } from '../lib/camera-beats.ts';
import { useEditor } from './store';
import { NumberField, PropertyPlayhead, PropertyTimeRuler } from './inspector';
import { TimeMarker } from './camera-tracks';
import { TimelineScrollbar } from './timeline-scrollbar';
import { MaterialIcon as Icon } from './ui/material-icon';

export function CameraKeyframes({ pose, change, record }: { pose: CameraPose; change: (axis: keyof CameraPose, value: number) => void; record: () => void }) {
  const project = useEditor(s => s.project), time = useEditor(s => s.timeMs), duration = useEditor(s => s.durationMs);
  const playing = useEditor(s => s.playing), editing = useEditor(s => s.editing), game = useEditor(s => s.game);
  const { camera } = resolveCamera(project), keys = camera?.keys || [], shakes = camera?.shakes || [], locked = trackState(project, 'camera').locked;
  const following = !!project.edits.camera?.follow?.enabled, keyLocked = locked || following;
  const total = Math.max(1, duration), fps = project.output.fps, minSpan = Math.min(total, 2000 / fps);
  const [range, setRange] = useState([0, total]), previousTotal = useRef(total);
  useEffect(() => {
    if (editing) return;
    const before = previousTotal.current; previousTotal.current = total;
    setRange(r => r[0] === 0 && Math.abs(r[1] - before) < .0001 ? [0, total] : r);
  }, [total, editing]);
  useEffect(() => { setRange([0, total]); }, [game]);
  // Freeze the ruler while moving a key that changes the project's duration.
  const extent = editing ? Math.max(total, previousTotal.current) : total;
  const from = Math.min(range[0], extent - minSpan), to = Math.min(extent, Math.max(from + minSpan, range[1]));
  const previous = keys.filter(k => k.time < time - .0001).at(-1), next = keys.find(k => k.time > time + .0001);
  const navigate = (at: number) => {
    if (at < from || at > to) { const left = Math.max(0, Math.min(total - (to - from), at - (to - from) / 2)); setRange([left, left + to - from]); }
    seekTime(at);
  };
  const selected = keys.some(k => Math.abs(k.time - time) < .001);
  return <div className="effect-controls camera-keyframes" id="camera-time-rows">
    <div className="camera-keyframe-toolbar">
      <span>{following ? '自动对焦关键帧' : '镜头关键帧'}{locked ? ' · 已锁定' : ''}</span>
      <button aria-label="上一个镜头关键帧" title="上一个关键帧" disabled={!previous} onClick={() => navigate(previous!.time)}><Icon name="skip_previous" size={18} /></button>
      <button aria-label={playing ? '暂停镜头时间线' : '播放镜头时间线'} title={playing ? '暂停' : '播放'} aria-pressed={playing} onClick={togglePlaying}><Icon name={playing ? 'pause' : 'play_arrow'} size={18} /></button>
      <button aria-label="下一个镜头关键帧" title="下一个关键帧" disabled={!next} onClick={() => navigate(next!.time)}><Icon name="skip_next" size={18} /></button>
      <button aria-label="记录镜头关键帧" title="在播放头记录整组镜头参数" aria-pressed={selected} disabled={keyLocked} onClick={record}>◆</button>
    </div>
    <div className="effect-header inspector-row"><div className="effect-header-values">
      <output aria-label="镜头关键帧时间">{(time / 1000).toFixed(3)} s</output>
      <button aria-label="显示完整镜头时间线" title="显示完整时间范围" onClick={() => setRange([0, total])}><Icon name="refresh" size={16} /></button>
    </div><PropertyTimeRuler label="镜头时间尺" time={time} from={from} to={to} total={extent} fps={fps} /></div>
    {(['x', 'y', 'scale', 'rotation'] as const).map(axis => <div className="inspector-row property" data-camera-property={axis} key={axis}>
      <label className="property-value"><span>{({ x: '中心 X / 格', y: '中心 Y / 格', scale: '缩放', rotation: '旋转 / °' })[axis]}</span>
        <NumberField label={`镜头 ${axis}`} value={pose[axis]} disabled={keyLocked} min={axis === 'scale' ? .25 : axis === 'rotation' ? -3600 : -32} max={axis === 'scale' ? 8 : axis === 'rotation' ? 3600 : 32} step={axis === 'rotation' ? 1 : .05} change={v => change(axis, v)} cancel={v => change(axis, v)} />
      </label><div className="effect-time-cell camera-keyframe-cell"><div className="camera-keyframe-lane" role="group" aria-label={`镜头 ${axis} 关键帧轨道`}>
        {keys.map((key, i) => <TimeMarker key={`${following}:${i}`} time={key.time} label={`镜头 ${axis} 关键帧`} start={from} rangeEnd={to} locked={keyLocked} selected={Math.abs(key.time - time) < .001}
          min={i ? keys[i - 1].time + .001 : 0} max={keys[i + 1] ? keys[i + 1].time - .001 : 120000000}
          change={(e, at) => { e.camera!.keys[i].time = at; }} remove={e => { e.camera!.keys.splice(i, 1); }} />)}
      </div><PropertyPlayhead time={time} from={from} to={to} /></div>
    </div>)}
    <div className="inspector-row property"><div className="property-value"><span>镜头震动</span><small>{shakes.length} 段</small></div>
      <div className="effect-time-cell camera-keyframe-cell"><div className="camera-keyframe-lane" role="group" aria-label="镜头震动轨道">
        {shakes.map((shake, i) => <TimeMarker key={shake.id} time={shake.startMs} duration={shake.durationMs} label="镜头震动片段" start={from} rangeEnd={to} locked={locked}
          max={120000000 - shake.durationMs} change={(e, at) => { e.camera!.shakes[i].startMs = at; }} remove={e => { e.camera!.shakes.splice(i, 1); }} />)}
      </div><PropertyPlayhead time={time} from={from} to={to} /></div>
    </div>
    <div className="inspector-row effect-range"><span /><TimelineScrollbar label="镜头时间线" controls="camera-time-rows" total={extent} from={from} to={to} minSpan={minSpan} onChange={(a, b) => setRange([a, b])} /></div>
  </div>;
}
