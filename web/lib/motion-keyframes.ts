import type { Easing, MotionFrame, MotionEdit, MotionAxis, Keyframe as PropertyKeyframe } from './types.ts';
import { cssEasing, ease, sampleTrack } from './editing.ts';

export const motionAxes: MotionAxis[] = ['x', 'y', 'scale', 'rotation', 'opacity'];

export function motionEasing(value = 'linear'): Easing {
  const named: Record<string, Easing> = { linear: 'linear', 'steps(1,end)': 'hold', ease: [.25, .1, .25, 1],
    'ease-in': [.42, 0, 1, 1], 'ease-out': [0, 0, .58, 1], 'ease-in-out': [.42, 0, .58, 1] };
  return named[value] || value.slice(value.indexOf('(') + 1, -1).split(',').map(Number);
}

// The native renderer uses translation, one rotation and uniform scale. Keep
// zero-scale rotations intact; matrix decomposition would lose those angles.
export function motionFrames(frames: Keyframe[], unit: number, flip = false): MotionFrame[] {
  const offsets = frames.map((frame, i) => frame.offset ?? (i === 0 ? 0 : i === frames.length - 1 ? 1 : null));
  for (let i = 0; i < offsets.length - 1; i++) if (offsets[i] !== null) {
    let end = i + 1; while (offsets[end] === null) end++;
    for (let j = i + 1; j < end; j++) offsets[j] = offsets[i]! + (offsets[end]! - offsets[i]!) * (j - i) / (end - i);
  }
  return frames.map((frame, i) => {
    const transform = String(frame.transform || ''), translation = transform.match(/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/);
    return { offset: offsets[i]!, x: Number(translation?.[1] || 0) / unit * (flip ? -1 : 1) || 0,
      y: Number(translation?.[2] || transform.match(/translateY\(([-.\d]+)px\)/)?.[1] || 0) / unit * (flip ? -1 : 1) || 0,
      rotation: Number(transform.match(/rotate\(([-.\d]+)deg\)/)?.[1] || 0),
      scale: Number(transform.match(/scale\(([-.\d]+)\)/)?.[1] ?? 1), opacity: Number(frame.opacity ?? 1), easing: motionEasing(frame.easing) };
  });
}

export function motionKeyframes(frames: MotionFrame[], unit: number, flip = false): Keyframe[] {
  const direction = flip ? -1 : 1;
  return frames.map(frame => ({ offset: frame.offset, opacity: frame.opacity, easing: cssEasing(frame.easing),
    transform: `translate(${frame.x * unit * direction}px,${frame.y * unit * direction}px) rotate(${frame.rotation}deg) scale(${frame.scale})` }));
}

export function sampleMotion(motion: MotionEdit, time: number): MotionFrame {
  time = Math.max(0, Math.min(1, time));
  const progress = ease(time, motion.easing), frame = { ...motion.frames[0] };
  for (const axis of motionAxes) frame[axis] = motion.tracks?.[axis] !== undefined
    ? sampleTrack(motion.tracks[axis], time, motion.frames[0][axis])
    : sampleTrack(motion.frames.map(f => ({ time: f.offset, value: f[axis], easing: f.easing })), progress, frame[axis]);
  return frame;
}

const cubic = (a: number, b: number, t: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
function parameter(offset: number, curve: number[]) {
  if (offset === 0 || offset === 1) return offset;
  let low = 0, high = 1;
  for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (cubic(curve[1], curve[3], mid) < offset) low = mid; else high = mid; }
  return (low + high) / 2;
}
function split(points: number[][], t: number) {
  const mix = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * t);
  const a = mix(points[0], points[1]), b = mix(points[1], points[2]), c = mix(points[2], points[3]), d = mix(a, b), e = mix(b, c), f = mix(d, e);
  return [[points[0], a, d, f], [f, e, c, points[3]]];
}

// Expand the whole animation's easing into real key times and per-segment
// curves, so the existing object editor works in milliseconds.
export function motionTracks(motion: MotionEdit): Record<MotionAxis, PropertyKeyframe[]> {
  const curve = Array.isArray(motion.easing) ? motion.easing : null;
  const parameters = motion.frames.map(frame => curve ? parameter(frame.offset, curve) : frame.offset);
  const times = parameters.map(t => curve ? cubic(curve[0], curve[2], t) : t);
  return Object.fromEntries(motionAxes.map(axis => {
    if (motion.tracks?.[axis] !== undefined) return [axis, motion.tracks[axis]];
    if (motion.easing === 'hold') return [axis, [{ time: 0, value: motion.frames[0][axis], easing: 'hold' }, { time: 1, value: motion.frames.at(-1)![axis], easing: 'linear' }]];
    return [axis, motion.frames.map((frame, i) => {
      let easing = frame.easing;
      if (curve && i < motion.frames.length - 1 && frame.easing === 'linear') {
        const left = split([[0, 0], [curve[0], curve[1]], [curve[2], curve[3]], [1, 1]], parameters[i + 1])[0];
        const points = split(left, parameters[i] / parameters[i + 1])[1], start = points[0], end = points[3];
        easing = points.slice(1, 3).flatMap(point => point.map((v, j) => (v - start[j]) / (end[j] - start[j])));
      }
      return { time: times[i], value: frame[axis], easing };
    })];
  })) as Record<MotionAxis, PropertyKeyframe[]>;
}
