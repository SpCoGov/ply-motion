import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { MaterialIcon as Icon } from './ui/material-icon';

type Mode = 'pan' | 'start' | 'end';
type Range = { from: number; to: number };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function TimelineScrollbar({ total, from, to, minSpan, onChange, label = '时间线', controls = 'timeline-scroll-area' }: Range & {
  total: number; minSpan: number; onChange: (from: number, to: number) => void; label?: string; controls?: string;
}) {
  const drag = useRef<(Range & { mode: Mode; x: number; width: number }) | null>(null);
  const change = (mode: Mode, delta: number, range: Range = { from, to }) => {
    const span = range.to - range.from;
    if (mode === 'start') onChange(clamp(range.from + delta, 0, range.to - minSpan), range.to);
    else if (mode === 'end') onChange(range.from, clamp(range.to + delta, range.from + minSpan, total));
    else { const left = clamp(range.from + delta, 0, total - span); onChange(left, left + span); }
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || total <= 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-range-mode]');
    const mode = (target?.dataset.rangeMode || 'pan') as Mode;
    let range = { from, to };
    if (!target) {
      const span = to - from, left = clamp((e.clientX - rect.left) / rect.width * total - span / 2, 0, total - span);
      range = { from: left, to: left + span }; onChange(range.from, range.to);
    } else target.focus();
    drag.current = { ...range, mode, x: e.clientX, width: rect.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const cancel = () => { if (drag.current) { const { from, to } = drag.current; drag.current = null; onChange(from, to); } };
  const key = (e: KeyboardEvent<HTMLElement>, mode: Mode) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); return; }
    const step = (to - from) * (e.shiftKey ? .5 : .05);
    const delta = { ArrowLeft: -step, ArrowRight: step, PageUp: -(to - from), PageDown: to - from, Home: -total, End: total }[e.key];
    if (delta !== undefined) { e.preventDefault(); e.stopPropagation(); change(mode, delta); }
  };
  const valueText = `${(from / 1000).toFixed(2)} – ${(to / 1000).toFixed(2)} 秒`;
  return <div className="timeline-viewport" role="group" aria-label={`${label}滚动与缩放`}>
    <div className="timeline-range-track" onPointerDown={down}
      onPointerMove={e => { if (drag.current) change(drag.current.mode, (e.clientX - drag.current.x) / drag.current.width * total, drag.current); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <div className="timeline-range-thumb" style={{ left: `${total ? from / total * 100 : 0}%`, width: `${total ? (to - from) / total * 100 : 100}%` }}>
        <button className="timeline-range-handle" data-range-mode="start" role="slider" aria-label={`${label}可见范围起点`} aria-orientation="horizontal"
          aria-valuemin={0} aria-valuemax={Math.max(0, to - minSpan)} aria-valuenow={from} aria-valuetext={valueText} onKeyDown={e => key(e, 'start')} title="拖动左端缩放，固定右端" />
        <div className="timeline-range-pan" data-range-mode="pan" role="scrollbar" tabIndex={0} aria-label={`平移${label}`} aria-orientation="horizontal"
          aria-controls={controls} aria-valuemin={0} aria-valuemax={Math.max(0, total - (to - from))} aria-valuenow={from} aria-valuetext={valueText}
          onKeyDown={e => key(e, 'pan')} title="拖动平移；左右端点调整缩放"><Icon name="drag_handle" size={16} /></div>
        <button className="timeline-range-handle" data-range-mode="end" role="slider" aria-label={`${label}可见范围终点`} aria-orientation="horizontal"
          aria-valuemin={Math.min(total, from + minSpan)} aria-valuemax={total} aria-valuenow={to} aria-valuetext={valueText} onKeyDown={e => key(e, 'end')} title="拖动右端缩放，固定左端" />
      </div>
    </div>
  </div>;
}
