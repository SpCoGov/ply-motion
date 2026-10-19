import type { Project, Motion, SceneObject, Clip, Edits, Keyframe } from './types.ts';
import { createMoveScene } from './animation.ts';
import { projectPlans, projectTimeMap } from './project.ts';
import { editedProject, properties, sampleTrack } from './editing.ts';
import { motionTracks, motionAxes, sampleMotion } from './motion-keyframes.ts';
import { locateTime } from './playback.ts';
import { sqCR } from './board.ts';

export type PropertySource = 'object' | 'moves' | { clipId: string; motionId?: string } | null;
type MotionTarget = { clip: Clip; motion: Motion; start: number; duration: number; end: number; origin: { x: number; y: number } };
export type PropertyTarget = { object: SceneObject; actions: Clip[]; parts: Motion[]; clip?: Clip; motion?: Motion; start: number; duration: number; key: string; entries?: MotionTarget[]; origin?: { x: number; y: number } };
const catalogs = new WeakMap<Project, Map<string, Motion[]>>();
const walks = new WeakMap<Project, Map<string, PropertyTarget>>();

export function motionTargetAt(target: PropertyTarget, time: number): PropertyTarget {
  if (!target.entries?.length) return target;
  const entries = target.entries, inside = entries.find(e => time >= e.start - .0001 && time <= e.start + e.duration + .0001);
  const entry = inside || entries.reduce((a, b) => Math.min(Math.abs(time - a.start), Math.abs(time - a.start - a.duration)) <= Math.min(Math.abs(time - b.start), Math.abs(time - b.start - b.duration)) ? a : b);
  return { ...target, ...entry };
}

export function sampleObjectMotion(target: PropertyTarget, axis: string, time: number) {
  if (!target.entries) return sampleTrack(target.object.tracks?.[axis], time, target.object.visual[axis]);
  const entry = target.entries.find(e => time >= e.start && time < e.end), position = axis === 'x' || axis === 'y';
  if (entry) return sampleMotion(entry.motion, (time - entry.start) / entry.duration)[axis as 'x'] + (position ? entry.origin[axis] : 0);
  const landed = target.entries.filter(e => e.end <= time).at(-1);
  if (position && landed) {
    const initial = sqCR(target.object.initialSquare!, false), square = sqCR(landed.clip.params.piece!.to, false);
    return axis === 'x' ? square.c - initial.c : square.r - initial.r;
  }
  return properties[axis].value;
}

function motions(project: Project, clip: Clip) {
  let cache = catalogs.get(project); if (!cache) catalogs.set(project, cache = new Map());
  if (!cache.has(clip.moveId!)) {
    const index = project.segments.findIndex(segment => segment.id === clip.moveId);
    if (index < 0) return [];
    const board = document.createElement('div'); board.className = 'export-board'; board.setAttribute('aria-hidden', 'true'); document.body.append(board);
    try {
      const plans = projectPlans(project), pieces = project.assets.find(a => a.id === 'pieces');
      const scene = createMoveScene(board, plans[index].move, { plan: plans[index], identity: project.segments[index], project,
        flip: project.output.flip, chesscom: pieces?.source.kind === 'builtin' && pieces.source.id === 'chesscom-neo', previousMove: plans[index - 1]?.move || null });
      try { cache.set(clip.moveId!, scene.motions); } finally { scene.dispose(); }
    } finally { board.remove(); }
  }
  return cache.get(clip.moveId!)!.filter(m => m.clipId === clip.id);
}

export function objectProperties(raw: Project, id: string | null, source: PropertySource, selectedClip: string | null, time: number, keyTime: number | null = null): PropertyTarget | null {
  const project = editedProject(raw), object = project.objects.find(o => o.id === id);
  if (!object || object.kind === 'audio') return null;
  const actions = project.clips.filter(c => c.objectId === id && !c.hidden && c.effect !== 'sound' &&
    (c.durationMs > 0 || c.effect === 'previous' || c.effect === 'target'));
  const result: PropertyTarget = { object, actions, parts: [], start: 0, duration: 0, key: `${id}:object` };
  if (source === 'object' || source === null && !selectedClip && raw.edits.objects[id!]) return result;
  const map = projectTimeMap(project), current = project.segments[locateTime(map, time).index]?.id;
  const start = (c: Clip) => (map.ranges.find(r => project.segments[r.index].id === c.moveId)?.start || 0) + c.startMs;
  if (source === 'moves' || source === null && object.kind === 'piece' && !selectedClip) {
    let cache = walks.get(project); if (!cache) walks.set(project, cache = new Map());
    if (!cache.has(object.id)) {
      const initial = sqCR(object.initialSquare!, false);
      const entries = actions.filter(c => c.effect === 'move').flatMap(clip => {
        const motion = motions(project, clip).find(m => m.id === `motion-piece:${object.id}`); if (!motion) return [];
        const from = sqCR(clip.params.piece!.from, false);
        return [{ clip, motion, start: start(clip) - clip.startMs + motion.startMs, duration: motion.durationMs, end: map.ranges.find(r => project.segments[r.index].id === clip.moveId)!.end, origin: { x: from.c - initial.c, y: from.r - initial.r } }];
      }).sort((a, b) => a.start - b.start);
      if (entries.length) cache.set(object.id, { ...result, entries, key: `${id}:moves`,
        object: { ...object, tracks: Object.fromEntries(motionAxes.map(axis => [axis, entries.flatMap(entry => {
          const keys = motionTracks(entry.motion)[axis];
          return keys.map((k, i) => ({ ...k, time: entry.start + k.time * entry.duration, value: k.value + (axis === 'x' || axis === 'y' ? entry.origin[axis] : 0), easing: i === keys.length - 1 ? 'hold' as const : k.easing }));
        })])) } });
    }
    const combined = cache.get(object.id); if (combined) return motionTargetAt(combined, keyTime ?? time);
  }
  const explicit = actions.find(c => c.id === (source && typeof source === 'object' && source.clipId || selectedClip));
  const nearby = actions.filter(c => c.effect === 'move').sort((a, b) => Math.abs(start(a) - time) - Math.abs(start(b) - time));
  const clip = explicit || nearby.find(c => c.moveId === current) || nearby[0]; if (!clip) return result;
  const parts = motions(project, clip), motion = parts.find(m => m.id === (source && typeof source === 'object' && source.motionId)) || parts[0];
  if (!motion) return result;
  const at = start(clip) - clip.startMs + motion.startMs;
  return { ...result, clip, parts, motion, start: at, duration: motion.durationMs, key: `${id}:${clip.id}:${motion.id}`,
    object: { ...object, visual: Object.fromEntries(motionAxes.map(axis => [axis, motion.frames[0][axis]])),
      tracks: Object.fromEntries(Object.entries(motionTracks(motion)).map(([axis, keys]) => [axis, keys.map(k => ({ ...k, time: at + k.time * motion.durationMs }))])) } };
}

export function writeMotionTracks(edits: Edits, target: PropertyTarget, tracks: Record<string, Keyframe[]>, constants?: Record<string, number>) {
  const { motion, clip, start, duration } = target;
  if (!motion || !clip) return;
  const entry = edits.clips[clip.id] ||= {}, edit = (entry.motions ||= {})[motion.id] ||= { frames: structuredClone(motion.frames), easing: motion.easing, tracks: structuredClone(motion.tracks || {}) };
  for (const [axis, keys] of Object.entries(tracks)) (edit.tracks ||= {})[axis as 'x'] = [...keys].filter(k => !target.entries || k.time >= start - .0001 && k.time <= start + duration + .0001).sort((a, b) => a.time - b.time)
    .map(k => ({ ...k, value: k.value - (axis === 'x' || axis === 'y' ? target.origin?.[axis] || 0 : 0), time: Math.max(0, Math.min(1, (k.time - start) / duration)) }));
  if (constants) {
    const values = Object.fromEntries(Object.entries(constants).map(([axis, value]) => [axis, value - (axis === 'x' || axis === 'y' ? target.origin?.[axis] || 0 : 0)]));
    edit.frames = edit.frames.map(frame => ({ ...frame, ...values }));
  }
}
