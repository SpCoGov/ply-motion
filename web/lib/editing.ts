import type { Project, Edits, Clip, Effect, Easing, Keyframe, BoardElement } from './types.ts';
import { validateCreation } from './creation.ts';
import { EFFECTS } from './types.ts';
import { PIECE_KEYS, configuredAsset, audioPieceKey, validateEmbeddedAsset, MAX_EMBEDDED_DATA } from './assets.ts';
import { cameraPose, resolveCamera, validateCameraBeats } from './camera-beats.ts';
// Saved edits contain only user changes; the generated chess facts stay intact.
export const properties: Record<string, { label: string; unit: string; value: number; min: number; max: number; step: number }> = {
  x: { label: '坐标 X', unit: '格', value: 0, min: -32, max: 32, step: .1 },
  y: { label: '坐标 Y', unit: '格', value: 0, min: -32, max: 32, step: .1 },
  scale: { label: '缩放', unit: '×', value: 1, min: .01, max: 10, step: .01 },
  stretch: { label: '横纵拉伸', unit: '×', value: 1, min: .1, max: 10, step: .01 },
  rotation: { label: '旋转', unit: '°', value: 0, min: -3600, max: 3600, step: 1 },
  opacity: { label: '透明度', unit: '', value: 1, min: 0, max: 1, step: .01 },
};
export const emptyEdits = (): Edits => ({ objects: {}, clips: {}, copies: [], segments: {} });
export const removable = (effect: string | undefined) => ['sound', 'nag', 'nag-exit', 'gift', 'hit', 'relation-square', 'relation-exit'].includes(effect ?? "");
export const copyable = (effect: string | undefined) => ['sound', 'nag', 'gift', 'hit', 'relation-square'].includes(effect ?? "");
export const clipTimeLimit = (clip: Pick<Clip, 'moveId'>) => clip.moveId === null ? 120000000 : 60000;
export const editable = (clip: Pick<Clip, 'durationMs' | 'hidden' | 'objectId' | 'effect'>, project?: Project) => clip.durationMs > 0 && !clip.hidden && (!project || !trackState(project, effectTrack(clip.objectId, clip.effect)).locked);
export const effectTrack = (id: string, effect: string) => `${id}/effect/${effect}`;
export const propertyTrack = (id: string, property: string) => `${id}/property/${property}`;
export function trackParent(project: Project, id: string): string | undefined {
  if (id.includes('/')) return id.split('/')[0];
  const object = project.objects.find(o => o.id === id);
  return object ? `group:${object.group}` : undefined;
}
export function trackState(project: Project, id: string) {
  const result = { locked: false, hidden: false, muted: false };
  for (let key: string | undefined = id; key; key = trackParent(project, key)) {
    const state = project.edits.trackStates?.[key];
    result.locked ||= !!state?.locked; result.hidden ||= !!state?.hidden; result.muted ||= !!state?.muted;
  }
  return result;
}

// Enforce locks at the shared edit boundary, including inspector and keyboard edits.
export function validateTrackChanges(before: Project, after: Project) {
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const check = (id: string, a: unknown, b: unknown) => {
    if (changed(a, b) && trackState(before, id).locked) throw new Error('此轨道已锁定，请先解锁。');
  };
  for (const object of before.objects) for (const property of Object.keys(properties)) {
    const a = before.edits.objects[object.id], b = after.edits.objects[object.id];
    check(propertyTrack(object.id, property), a?.visual?.[property], b?.visual?.[property]);
    check(propertyTrack(object.id, property), a?.tracks?.[property], b?.tracks?.[property]);
  }
  const clips = new Map([...editedProject(before).clips, ...before.edits.pending || []].map(c => [c.id, c]));
  for (const clip of clips.values()) if (clip.moveId !== null) check(effectTrack(clip.objectId, clip.effect), before.edits.beatStarts?.[clip.moveId], after.edits.beatStarts?.[clip.moveId]);
  const a = new Map(before.edits.copies.map(c => [c.id, c])), b = new Map(after.edits.copies.map(c => [c.id, c]));
  for (const id of new Set([...Object.keys(before.edits.clips), ...Object.keys(after.edits.clips)])) {
    const clip = clips.get(id) || clips.get(b.get(id)?.sourceId || '');
    if (clip) {
      check(effectTrack(clip.objectId, clip.effect), before.edits.clips[id], after.edits.clips[id]);
      const left = before.edits.clips[id]?.motions || {}, right = after.edits.clips[id]?.motions || {};
      for (const part of new Set([...Object.keys(left), ...Object.keys(right)])) for (const axis of Object.keys(properties)) {
        check(propertyTrack(clip.objectId, axis), left[part]?.tracks?.[axis as 'x'], right[part]?.tracks?.[axis as 'x']);
        check(propertyTrack(clip.objectId, axis), left[part]?.frames.map(f => f[axis as 'x']), right[part]?.frames.map(f => f[axis as 'x']));
      }
    }
  }
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const source = clips.get((a.get(id) || b.get(id))!.sourceId);
    if (source) check(effectTrack(source.objectId, source.effect), a.get(id), b.get(id));
  }
  check('segments', before.edits.segments, after.edits.segments);
  check('segments', before.edits.beatStarts, after.edits.beatStarts);
  check('board', before.edits.boardStyle, after.edits.boardStyle);
  check('camera', before.edits.camera, after.edits.camera);
  check('music', before.edits.music, after.edits.music);
  check('board', before.edits.composition, after.edits.composition);
  check('board', before.edits.coordinates, after.edits.coordinates);
  for (const o of before.edits.overlays || []) if (o.locked) {
    const next = after.edits.overlays?.find(n => n.id === o.id);
    if (!next || changed({ ...o, locked: false }, { ...next, locked: false })) throw new Error('叠加元素已锁定，请先解锁。');
  }
  for (const id of new Set([...Object.keys(before.edits.audio || {}), ...Object.keys(after.edits.audio || {})])) check(effectTrack('audio:sfx', 'sound'), before.edits.audio?.[id], after.edits.audio?.[id]);
  check('beats', before.edits.beats, after.edits.beats);
  check('audio:sfx', before.edits.beatSync, after.edits.beatSync);
  check(effectTrack('audio:sfx', 'sound'), before.edits.beatSync, after.edits.beatSync);
  for (const segment of before.segments) {
    check(segment.objectId, before.edits.segments[segment.id], after.edits.segments[segment.id]);
    check(segment.objectId, before.edits.beatStarts?.[segment.id], after.edits.beatStarts?.[segment.id]);
  }
}
const cache = new WeakMap<Project, Project>();

export function editedProject(project: Project): Project {
  if (!project.edits) return project;
  if (cache.has(project)) return cache.get(project)!;
  const edits = project.edits;
  const pending = new Set(edits.pending?.map(c => c.id));
  const objects = project.objects.map(o => ({ ...o, visual: { stretch: 1, ...o.visual, ...edits.objects[o.id]?.visual }, tracks: edits.objects[o.id]?.tracks || {} }));
  const originals = new Map(project.clips.map(c => [c.id, c]));
  const clips = project.clips.map(c => {
    const asset = c.effect === 'sound' && configuredAsset(project, audioPieceKey(project, c), c.params.sound!);
    const durationMs = asset && asset.source.kind === 'embedded' ? asset.source.durationMs! : c.durationMs;
    return { ...c, durationMs, ...(edits.beatSync?.[c.id] !== undefined ? { startMs: edits.beatSync[c.id] } : {}), ...(!pending.has(c.id) ? edits.clips[c.id] : {}), params: { ...c.params } };
  });
  for (const copy of edits.copies) {
    if (pending.has(copy.sourceId)) continue;
    const source = originals.get(copy.sourceId)!;
    clips.push({ ...source, ...copy, ...edits.clips[copy.id], params: { ...source.params }, copied: true });
  }
  const byMove = new Map<string, Clip[]>(project.segments.map(s => [s.id, []]));
  for (const clip of clips) if (clip.moveId !== null) byMove.get(clip.moveId)!.push(clip);
  const segments = project.segments.map(segment => {
    const list = byMove.get(segment.id)!, get = (effect: Effect) => list.find(c => c.effect === effect && !c.copied);
    const end = (c: Clip) => c.startMs + c.durationMs;
    const land = get('land')!, oldLand = land.startMs;
    land.startMs = Math.max(...list.filter(c => c.effect === 'move').map(end));
    const promotion = get('promotion');
    if (promotion) promotion.startMs = Math.max(land.startMs, edits.clips[promotion.id]?.startMs ?? promotion.startMs + land.startMs - oldLand);
    const settle = get('settle')!;
    settle.startMs = Math.max(land.startMs, settle.startMs + land.startMs - oldLand, ...list.filter(c => ['capture', 'promotion'].includes(c.effect)).map(end));
    const nag = get('nag')!, exit = get('nag-exit')!;
    if (nag.durationMs) exit.startMs = Math.max(exit.startMs, nag.startMs + nag.durationMs * 1.625);
    for (const c of list) {
      if (c.effect === 'result') c.startMs = Math.max(c.startMs, settle.startMs);
      if (c.effect === 'winner') c.startMs = Math.max(c.startMs, get('result')!.startMs);
      if (c.effect === 'relation-exit') {
        const enter = list.find(e => ['relation-square', 'check'].includes(e.effect) && !e.copied && JSON.stringify(e.params.step) === JSON.stringify(c.params.step) && JSON.stringify(e.params.relation) === JSON.stringify(c.params.relation));
        if (enter) c.startMs = Math.max(c.startMs, enter.startMs + (enter.params.enterDuration || enter.durationMs));
      }
      if (c.params.enterDuration !== undefined) c.params.enterDuration *= c.durationMs / c.params.duration!;
      if (c.params.duration !== undefined) c.params.duration = c.durationMs;
      if (c.params.piece) c.params.piece = { ...c.params.piece, start: c.startMs, duration: c.durationMs };
    }
    const durationMs = Math.max(edits.segments[segment.id]?.durationMs ?? segment.durationMs, ...list.map(end));
    return { ...segment, durationMs, ...(edits.beatStarts?.[segment.id] !== undefined ? { startMs: edits.beatStarts[segment.id] } : {}), snapshot: { ...segment.snapshot, nagAt: nag.startMs, pieces: list.filter(c => c.effect === 'move').map(c => c.params.piece!) } };
  });
  const result = { ...project, objects, clips, segments };
  cache.set(project, result); cache.set(result, result); return result;
}

export function validateEdits(project: Project) {
  const fail = () => { throw new Error('工程无效：编辑数据、关键帧或缓动越界'); };
  function check(value: unknown): asserts value { if (!value) fail(); }
  const fields = (o: unknown, keys: string[]) => check(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k)));
  const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const edits = project.edits;
  fields(edits, ['objects', 'clips', 'copies', 'segments', 'pending', 'trackStates', 'assets', 'pieceAssets', 'boardStyle', 'camera', 'music', 'beats', 'beatSync', 'beatOffsets', 'beatStarts', 'overlays', 'composition', 'coordinates', 'audio']);
  for (const key of ['objects', 'clips', 'segments'] as const) check(edits[key] && typeof edits[key] === 'object' && !Array.isArray(edits[key]));
  check(Array.isArray(edits.copies) && edits.copies.length <= 10000);
  const assetIds = new Set(project.assets.map(a => a.id));
  if (edits.assets !== undefined) {
    check(Array.isArray(edits.assets) && edits.assets.length <= 139);
    for (const asset of edits.assets) { validateEmbeddedAsset(asset); check(!assetIds.has(asset.id)); assetIds.add(asset.id); }
    check(edits.assets.reduce((sum, a) => sum + (a.source.kind === 'embedded' ? a.source.data.length : 0), 0) <= MAX_EMBEDDED_DATA);
  }
  if (edits.pieceAssets !== undefined) {
    fields(edits.pieceAssets, PIECE_KEYS);
    for (const setting of Object.values(edits.pieceAssets)) {
      fields(setting, ['icon', 'move', 'capture']);
      for (const [field, id] of Object.entries(setting || {})) {
        const asset = edits.assets?.find(a => a.id === id);
        check(asset && asset.kind === (field === 'icon' ? 'image' : 'audio'));
        if (field !== 'icon') check(asset.source.kind === 'embedded' && asset.source.durationMs! <= 60000);
      }
    }
  }
  if (edits.boardStyle !== undefined) {
    fields(edits.boardStyle, ['light', 'dark']);
    for (const setting of Object.values(edits.boardStyle)) {
      fields(setting, ['color', 'texture']);
      if (setting?.color !== undefined) check(typeof setting.color === 'string' && /^#[\da-f]{6}$/i.test(setting.color));
      if (setting?.texture !== undefined) check(edits.assets?.some(a => a.id === setting.texture && a.kind === 'image'));
    }
  }
  if (edits.trackStates !== undefined) {
    check(edits.trackStates && typeof edits.trackStates === 'object' && !Array.isArray(edits.trackStates));
    const tracks = new Map<string, boolean>([['segments', false], ['camera', false], ['beats', false], ['music', true]]);
    for (const object of project.objects) {
      const audio = object.kind === 'audio'; tracks.set(object.id, audio); tracks.set(`group:${object.group}`, audio);
      if (!audio) for (const property of Object.keys(properties)) tracks.set(propertyTrack(object.id, property), false);
      for (const effect of audio ? ['sound'] : EFFECTS) tracks.set(effectTrack(object.id, effect), audio);
    }
    for (const [id, state] of Object.entries(edits.trackStates)) {
      check(tracks.has(id)); fields(state, tracks.get(id) ? ['locked', 'muted'] : ['locked', 'hidden']);
      check(Object.values(state).every(value => typeof value === 'boolean'));
    }
  }
  const clips = new Map<string, Pick<Clip, 'id' | 'objectId' | 'moveId' | 'effect' | 'durationMs'>>(project.clips.map(c => [c.id, c]));
  if (edits.pending !== undefined) {
    check(Array.isArray(edits.pending) && edits.pending.length <= 10000);
    const ids = new Set<string>();
    for (const c of edits.pending) {
      fields(c, ['id', 'objectId', 'moveId', 'effect', 'durationMs']);
      check(typeof c.id === 'string' && c.id.length <= 512 && !c.id.startsWith('copy:') && !ids.has(c.id)); ids.add(c.id);
      check(project.objects.some(o => o.id === c.objectId) && (c.moveId === null || project.segments.some(s => s.id === c.moveId)));
      check([...EFFECTS, 'sound'].includes(c.effect) && finite(c.durationMs, 0, 60000));
      check(!!edits.clips[c.id] || edits.copies.some(copy => copy.sourceId === c.id));
      check(!clips.has(c.id) || clips.get(c.id)!.durationMs === 0);
      clips.set(c.id, c);
    }
  }
  for (const c of edits.copies) {
    fields(c, ['id', 'sourceId', 'startMs', 'durationMs']);
    check(typeof c.id === 'string' && /^copy:[\w-]{1,80}$/.test(c.id) && !clips.has(c.id) && copyable(clips.get(c.sourceId)?.effect) && !c.sourceId.startsWith('copy:'));
    check(finite(c.startMs, 0, clipTimeLimit(clips.get(c.sourceId)!)) && finite(c.durationMs, 1, Math.min(60000, clipTimeLimit(clips.get(c.sourceId)!) - c.startMs)));
    clips.set(c.id, { ...clips.get(c.sourceId)!, ...c });
  }
  let frameCount = 0;
  for (const [id, c] of Object.entries(edits.clips)) {
    fields(c, ['startMs', 'durationMs', 'hidden', 'easing', 'motions']);
    const base = clips.get(id); check(base);
    if ('hidden' in c) check(typeof c.hidden === 'boolean' && (removable(base.effect) || id.startsWith('copy:')));
    if ('startMs' in c) check(finite(c.startMs, 0, clipTimeLimit(base)));
    if ('durationMs' in c) check(base.durationMs > 0 && finite(c.durationMs, 1, 60000));
    if ('easing' in c) check(validEasing(c.easing));
    if (c.motions !== undefined) {
      check(base.effect !== 'sound' && c.motions && typeof c.motions === 'object' && !Array.isArray(c.motions) && Object.keys(c.motions).length <= 32);
      for (const [part, motion] of Object.entries(c.motions)) {
        check(/^(motion-piece|pc|badge|nag-halo|nag-ring|nag-particle|move-highlight|relation-flash):[\w:-]{1,128}$/.test(part));
        if (part.startsWith('nag-particle:')) check(['nag', 'nag-exit'].includes(base.effect) && /^nag-particle:(burst|dust|orbit)-(?:[0-9]|1[01])$/.test(part));
        fields(motion, ['frames', 'easing', 'tracks']); check(validEasing(motion.easing));
        const frames = motion.frames; check(Array.isArray(frames) && frames.length >= 2 && frames.length <= 128);
        frameCount += frames.length;
        let last = -1;
        for (const frame of frames) {
          fields(frame, ['offset', 'x', 'y', 'rotation', 'scale', 'opacity', 'easing']);
          check(finite(frame.offset, 0, 1) && frame.offset > last && validEasing(frame.easing)); last = frame.offset;
          for (const axis of ['x', 'y', 'rotation', 'scale', 'opacity'] as const) {
            const p = properties[axis]; check(finite(frame[axis], axis === 'scale' ? 0 : p.min, p.max));
          }
        }
        check(frames[0].offset === 0 && frames.at(-1)!.offset === 1);
        if (motion.tracks !== undefined) {
          fields(motion.tracks, ['x', 'y', 'scale', 'rotation', 'opacity']);
          for (const [axis, keys] of Object.entries(motion.tracks)) {
            check(Array.isArray(keys) && keys.length <= 128); frameCount += keys.length;
            let last = -1; const p = properties[axis];
            for (const key of keys) {
              fields(key, ['time', 'value', 'easing']);
              check(finite(key.time, 0, 1) && key.time > last && finite(key.value, axis === 'scale' ? 0 : p.min, p.max) && validEasing(key.easing)); last = key.time;
            }
          }
        }
      }
    }
  }
  for (const [id, value] of Object.entries(edits.segments)) {
    fields(value, ['durationMs']); check(project.segments.some(s => s.id === id) && finite(value.durationMs, 1, 60000));
  }
  for (const [id, object] of Object.entries(edits.objects)) {
    check(project.objects.some(o => o.id === id && o.kind !== 'audio')); fields(object, ['visual', 'tracks']);
    if (object.visual !== undefined) fields(object.visual, Object.keys(properties));
    if (object.tracks !== undefined) fields(object.tracks, Object.keys(properties));
    for (const [prop, value] of Object.entries(object.visual || {})) {
      const p = properties[prop]; check(p && finite(value, p.min, p.max));
    }
    for (const [prop, frames] of Object.entries(object.tracks || {})) {
      const p = properties[prop]; check(p && Array.isArray(frames)); frameCount += frames.length;
      let last = -1;
      for (const frame of frames) {
        fields(frame, ['time', 'value', 'easing']);
        check(finite(frame.time, 0, 120000000) && frame.time > last && finite(frame.value, p.min, p.max) && validEasing(frame.easing)); last = frame.time;
      }
    }
  }
  check(frameCount <= 100000);
  validateCameraBeats(project);
  validateCreation(project);
  check(editedProject(project).segments.every(s => s.durationMs <= 60000));
  check(editedProject(project).clips.filter(c => c.moveId === null).every(c => c.startMs + c.durationMs <= clipTimeLimit(c)));
}

export function validEasing(e: unknown): e is Easing {
  return (e === 'linear' || e === 'hold') || Array.isArray(e) && e.length === 4 && e.every(Number.isFinite) && e[0] >= 0 && e[0] <= 1 && e[2] >= 0 && e[2] <= 1 && Math.abs(e[1]) <= 10 && Math.abs(e[3]) <= 10;
}
export const cssEasing = (e: Easing) => Array.isArray(e) ? `cubic-bezier(${e.join(',')})` : e === 'hold' ? 'steps(1,end)' : e;
const bezier = (a: number, b: number, u: number) => 3 * (1-u) ** 2 * u * a + 3 * (1-u) * u * u * b + u ** 3;
function bezierParameter(t: number, curve: number[]) {
  if (t <= 0 || t >= 1) return Math.max(0, Math.min(1, t));
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (bezier(curve[0], curve[2], mid) < t) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** @param {number} t @param {string | number[]} easing */
export function ease(t: number, easing: Easing = 'linear') {
  if (easing === 'hold') return t < 1 ? 0 : 1;
  if (!Array.isArray(easing) || t <= 0 || t >= 1) return t;
  return bezier(easing[1], easing[3], bezierParameter(t, easing));
}
export function easingVelocity(t: number, easing: Easing) {
  if (easing === 'hold') return 0;
  if (!Array.isArray(easing)) return 1;
  const u = bezierParameter(t, easing), derivative = (a: number, b: number) => 3 * ((1-u) ** 2 * a + 2 * (1-u) * u * (b-a) + u * u * (1-b));
  const dx = derivative(easing[0], easing[2]);
  if (dx > 1e-9) return derivative(easing[1], easing[3]) / dx;
  // A vertical time tangent has no finite derivative; sample its finite graph neighborhood.
  const lo = Math.max(0, t - .0001), hi = Math.min(1, t + .0001);
  return (ease(hi, easing) - ease(lo, easing)) / (hi - lo);
}
export function trackIndex(frames: Keyframe[], time: number) {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (frames[m].time <= time) lo = m + 1; else hi = m; }
  return lo - 1;
}
export function sampleTrack(frames: Keyframe[] | undefined, time: number, fallback: number): number {
  if (!frames?.length) return fallback;
  if (time <= frames[0].time) return frames[0].value;
  const i = trackIndex(frames, time), a = frames[i], b = frames[i + 1];
  return b ? a.value + (b.value - a.value) * ease((time - a.time) / (b.time - a.time), a.easing) : a.value;
}
export function trackVelocity(frames: Keyframe[] | undefined, time: number, side: 'before' | 'after' = 'after'): number {
  if (!frames?.length) return 0;
  let i = trackIndex(frames, time); if (side === 'before' && frames[i]?.time === time) i--;
  const a = frames[i], b = frames[i + 1]; if (!a || !b || a.easing === 'hold') return 0;
  return (b.value - a.value) * 1000 / (b.time - a.time) * easingVelocity((time - a.time) / (b.time - a.time), a.easing);
}
// Pair the edited position segment while retaining all existing key times and values.
export function positionEasing(tracks: Record<string, Keyframe[]>, visual: Record<string, number>, from: number, to: number, easing: Easing, link: boolean | 0 | 2 = true): Record<string, Keyframe[]> {
  let result: Record<string, Keyframe[]> = Object.fromEntries(['x', 'y'].map(axis => {
    const source = tracks[axis] || [], next = source.map(k => ({ ...k }));
    for (const time of [from, to]) if (!next.some(k => k.time === time)) next.push({ time, value: sampleTrack(source, time, visual[axis]), easing: source[trackIndex(source, time)]?.easing || 'linear' });
    next.find(k => k.time === from)!.easing = easing;
    return [axis, next.sort((a, b) => a.time - b.time)];
  }));
  if (link === false || !Array.isArray(easing)) return result;
  const times = [...new Set(Object.values(result).flat().map(k => k.time))].sort((a, b) => a - b);
  const average = (a: number, b: number) => Math.hypot(...['x', 'y'].map(axis => sampleTrack(result[axis], b, visual[axis]) - sampleTrack(result[axis], a, visual[axis]))) * 1000 / (b - a);
  for (const time of link === 0 ? [from] : link === 2 ? [to] : [from, to]) {
    const control = time === from ? 0 : 2, i = times.indexOf(time), otherTime = times[i + (control === 0 ? -1 : 1)];
    if (otherTime === undefined) continue;
    const a = Math.min(time, otherTime), b = Math.max(time, otherTime), otherControl = control === 0 ? 2 : 0;
    const axis = Math.abs(sampleTrack(result.x, b, visual.x) - sampleTrack(result.x, a, visual.x)) >= Math.abs(sampleTrack(result.y, b, visual.y) - sampleTrack(result.y, a, visual.y)) ? 'x' : 'y';
    const neighbor = result[axis][trackIndex(result[axis], a)]?.easing || 'linear', edited = result.x.find(k => k.time === from)!.easing;
    const currentAverage = average(from, to), otherAverage = average(a, b);
    const velocity = neighbor === 'hold' ? 0 : Math.min(Math.abs(easingVelocity(control === 0 ? 0 : 1, edited)) * currentAverage, currentAverage * (control === 0 ? 10 : 11) / .001, otherAverage * (otherControl === 0 ? 10 : 11) / .001);
    const influence = (curve: Easing, c: number, avg: number) => Math.min(Array.isArray(curve) ? c === 0 ? curve[0] : 1 - curve[2] : 1 / 3, velocity ? avg * (c === 0 ? 10 : 11) / velocity : 1);
    result = positionEasing(result, visual, from, to, velocityEasing(edited, control, currentAverage, velocity, influence(edited, control, currentAverage)), false);
    if (neighbor !== 'hold') result = positionEasing(result, visual, a, b, velocityEasing(neighbor, otherControl, otherAverage, velocity, influence(neighbor, otherControl, otherAverage)), false);
  }
  return result;
}
export function velocityEasing(easing: Easing, control: number, average: number, velocity: number, influence: number) {
  const next = Array.isArray(easing) ? [...easing] : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  influence = Math.max(.001, Math.min(.999, influence)); next[control] = control === 0 ? influence : 1 - influence;
  if (average) next[control + 1] = control === 0 ? Math.max(0, Math.min(10, velocity / average * influence)) : Math.max(-10, Math.min(1, 1 - velocity / average * influence));
  return next;
}
export function applyVisuals(board: BoardElement, project: Project, time: number, reduced = false, cameraView = true) {
  const unit = board.clientWidth / 8, objects = new Map(project.objects.map(o => [o.id, o]));
  for (const badge of board.querySelectorAll<HTMLElement>('.badge:not([data-track-id])')) {
    const result = badge.classList.contains('outcome-badge');
    const owner = result ? 'board' : badge.parentElement?.querySelector<HTMLElement>('.pc')?.dataset.objectId;
    if (owner) badge.dataset.trackId = effectTrack(owner, result ? badge.classList.contains('status-win') ? 'winner' : 'result' : 'nag');
  }
  const highlights = [...board.querySelectorAll<HTMLElement>('.sq.hl')];
  const highlightOwner = highlights.map(square => square.querySelector<HTMLElement>('.pc')?.dataset.objectId).find(Boolean);
  for (const square of highlights) square.dataset.trackHighlightHidden = String(!!highlightOwner && trackState(project, effectTrack(highlightOwner, 'target')).hidden);
  for (const el of [board, ...board.querySelectorAll<HTMLElement>('[data-object-id],[data-track-id]')]) {
    const id = el === board ? 'board' : el.dataset.trackId || el.dataset.objectId;
    if (id) el.dataset.trackHidden = String(trackState(project, id).hidden);
  }
  for (const el of [board, ...board.querySelectorAll<HTMLElement>('[data-object-id]')]) {
    const object = objects.get(el === board ? 'board' : el.dataset.objectId ?? ""); if (!object) continue;
    const v = Object.fromEntries(Object.entries(properties).map(([key, p]) => [key, sampleTrack(trackState(project, propertyTrack(object.id, key)).hidden ? undefined : object.tracks?.[key], time, object.visual[key] ?? p.value)]));
    // Independent CSS transforms compose outside the existing WAAPI transform.
    el.style.translate = `${v.x * unit}px ${v.y * unit}px`;
    el.style.rotate = `${v.rotation}deg`;
    el.style.scale = v.stretch === 1 ? String(v.scale) : `${v.scale * v.stretch} ${v.scale / v.stretch}`;
    el.style.filter = v.opacity === 1 ? '' : `opacity(${Math.max(0, Math.min(1, v.opacity))})${el === board ? '' : ' drop-shadow(0 2px 1px #0002)'}`;
  }
  const coordinate = project.edits.coordinates;
  for (const el of board.querySelectorAll<HTMLElement>('.coord')) {
    const square = el.parentElement!;
    el.style.visibility = project.edits.composition?.coordinates === false ? 'hidden' : '';
    el.style.transformOrigin = coordinate ? `${board.clientWidth / 2 - square.offsetLeft - el.offsetLeft}px ${board.clientHeight / 2 - square.offsetTop - el.offsetTop}px` : '';
    el.style.transform = coordinate ? `translate(${coordinate.x * unit}px, ${coordinate.y * unit}px) rotate(${coordinate.rotation}deg) scale(${coordinate.scale})` : '';
    el.style.opacity = String(coordinate?.opacity ?? 1);
  }
  const camera = !cameraView || trackState(project, 'camera').hidden ? undefined : resolveCamera(project).camera;
  board.dataset.cameraActive = String(!!camera && !!(camera.keys.length || camera.shakes.length));
  const pose = cameraPose(camera, reduced ? camera?.keys.filter(k => k.time <= time).at(-1)?.time ?? 0 : time, !reduced);
  const direction = project.output.flip ? -1 : 1;
  board.style.transform = camera ? `scale(${pose.scale}) rotate(${-pose.rotation}deg) translate(${-pose.x * unit * direction}px,${-pose.y * unit * direction}px)` : '';
}

// Store changed top-level fields by reference, never DOM or per-frame snapshots.
export function createHistory(limit = 100) {
  type Command = [string[], unknown, unknown][];
  const past: Command[] = [], future: Command[] = [];
  const apply = (project: Project, command: Command, side: "before" | "after") => {
    const next = { ...project, edits: { ...project.edits } };
    for (const [path, before, after] of command) {
      const value = side === 'before' ? before : after;
      if (path.length === 1) Object.assign(next, { [path[0]]: value });
      else if (path.length === 2) { if (value === undefined) delete next.edits[path[1] as keyof Edits]; else Object.assign(next.edits, { [path[1]]: value }); }
      else { const group: Record<string, unknown> = { ...(next.edits[path[1] as 'objects' | 'clips' | 'segments' | 'trackStates']) }; Object.assign(next.edits, { [path[1]]: group }); if (value === undefined) delete group[path[2]]; else group[path[2]] = value; }
    }
    return next;
  };
  return {
    get canUndo() { return past.length > 0; }, get canRedo() { return future.length > 0; },
    push(before: Project, after: Project) {
      const command: Command = (Object.keys(after) as (keyof Project)[]).filter(k => k !== 'edits' && before[k] !== after[k]).map(k => [[k], before[k], after[k]]);
      for (const category of ['objects', 'clips', 'segments'] as const) {
        const a = before.edits[category], b = after.edits[category];
        for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) command.push([['edits', category, id], a[id], b[id]]);
      }
      if (JSON.stringify(before.edits.copies) !== JSON.stringify(after.edits.copies)) command.push([['edits', 'copies'], before.edits.copies, after.edits.copies]);
      for (const category of ['pending', 'trackStates', 'assets', 'pieceAssets', 'boardStyle', 'camera', 'music', 'beats', 'beatSync', 'beatOffsets', 'beatStarts', 'overlays', 'composition', 'coordinates', 'audio'] as const)
        if (JSON.stringify(before.edits[category]) !== JSON.stringify(after.edits[category])) command.push([['edits', category], before.edits[category], after.edits[category]]);
      if (!command.length) return;
      past.push(command); if (past.length > limit) past.shift(); future.length = 0;
    },
    undo(project: Project) { const c = past.pop(); if (!c) return project; future.push(c); return apply(project, c, 'before'); },
    redo(project: Project) { const c = future.pop(); if (!c) return project; past.push(c); return apply(project, c, 'after'); },
    clear() { past.length = future.length = 0; },
  };
}
