export type TimeMap = ReturnType<typeof timeMap>;
export type { SoundCue } from './types.ts';
// Milliseconds are never rounded per segment. Preview and export share this map.
/** @param {{ durationMs?: number, duration?: number }[]} segments */
export function timeMap(segments: (({ durationMs: number; duration?: number } | { duration: number; durationMs?: number }) & { startMs?: number })[], speed = 1, endTimeMs = 0) {
  let duration = 0, cursor = 0;
  const ranges = segments.map((segment, index) => {
    const start = segment.startMs === undefined ? cursor : segment.startMs / speed;
    cursor = start + (segment.durationMs ?? segment.duration!) / speed;
    duration = Math.max(duration, cursor);
    return { index, start, end: cursor };
  });
  return { ranges, duration: Math.max(duration, endTimeMs / speed) };
}

export function locateTime(map: TimeMap, time: number) {
  if (!Number.isFinite(time)) throw new Error('时间必须是有限数字');
  time = Math.max(0, Math.min(map.duration, time));
  let low = 0, high = map.ranges.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (map.ranges[mid].start <= time) low = mid; else high = mid - 1;
  }
  const range = map.ranges[low];
  return { time, index: range ? low : -1, local: range ? time - range.start : 0 };
}

export const frameTime = (frame: number, fps: number) => frame * 1000 / fps;
export const snapTime = (time: number, fps: number) => frameTime(Math.round(time * fps / 1000), fps);
export function adjacentFrame(time: number, direction: number, fps: number) {
  const frame = time * fps / 1000;
  return frameTime(direction > 0 ? Math.floor(frame + 1e-7) + 1 : Math.ceil(frame - 1e-7) - 1, fps);
}

// Prepare sound once on play; seeking and frame stepping only sample the picture.
export function createPlayback({ duration, sample, onStart = (_time: number, _end: number, _speed: number, _anchor: number) => {}, onState = (_playing: boolean) => {},
  now = () => performance.now(), requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }: { duration: number; sample: (time: number) => void; onStart?: (time: number, end: number, speed: number, anchor: number) => void; onState?: (playing: boolean) => void; now?: () => number; requestFrame?: (callback: FrameRequestCallback) => number; cancelFrame?: (id: number) => void }) {
  let time = 0, speed = 1, playing = false, frame = 0, anchor = 0, origin = 0, end = duration;
  const advance = (timestamp: number) => {
    time = Math.min(end, origin + Math.max(0, timestamp - anchor) * speed);
    sample(time);
  };
  const tick = () => {
    if (!playing) return;
    // RAF only requests a repaint; its timestamp may use a different clock origin.
    advance(now());
    if (time >= end) { playing = false; onState(false); }
    else frame = requestFrame(tick);
  };
  return {
    get time() { return time; }, get playing() { return playing; },
    seek(value: number) {
      if (!Number.isFinite(value)) return;
      this.pause(); time = Math.max(0, Math.min(duration, value)); sample(time);
    },
    play(until = duration) {
      if (playing || time >= duration) return;
      end = Math.max(time, Math.min(duration, until)); origin = time; anchor = now();
      playing = true; onStart(time, end, speed, anchor); onState(true); frame = requestFrame(tick);
    },
    pause() { cancelFrame(frame); if (playing) { const timestamp = now(); playing = false; onState(false); advance(timestamp); } },
    setSpeed(value: number) {
      if (!Number.isFinite(value) || value <= 0) return;
      if (playing) advance(now());
      speed = value; origin = time; anchor = now();
      if (playing) onStart(time, end, speed, anchor);
    },
  };
}
