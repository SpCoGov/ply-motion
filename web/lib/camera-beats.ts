import type { Camera, CameraKey, CameraPose, Edits, Project } from './types.ts';
import { ease, editedProject, effectTrack, trackState, validEasing } from './editing.ts';
import { timeMap } from './playback.ts';

export const CAMERA_DEFAULT: CameraPose = { x: 0, y: 0, scale: 1, rotation: 0 };
export const emptyCamera = (): Camera => ({ keys: [], shakes: [] });
export const FOLLOW_FOCUS_DEFAULT = { scale: 1.8, durationMs: 500 };
type FocusStep = { id: string; ply: number; square: string; startMs: number; durationMs: number; scale: number };
const cameraCache = new WeakMap<Project, { camera: Camera | undefined; steps: FocusStep[] }>();

export function resolveCamera(project: Project) {
  const cached = cameraCache.get(project); if (cached) return cached;
  const camera = project.edits.camera, follow = camera?.follow;
  if (!follow?.enabled) return { camera, steps: [] as FocusStep[] };
  const effective = editedProject(project), map = timeMap(effective.segments);
  const steps = effective.segments.map((segment, i) => {
    const piece = segment.snapshot.pieces.find(p => segment.before[p.from] === segment.objectId)!;
    const setting = follow.moves[segment.id] || FOLLOW_FOCUS_DEFAULT;
    return { id: segment.id, ply: segment.ply, square: piece.to, startMs: map.ranges[i].start + piece.start, ...setting };
  });
  const keys: CameraKey[] = [{ ...CAMERA_DEFAULT, time: 0, easing: 'hold' }];
  for (const [i, step] of steps.entries()) {
    // Finish before the next move takes over; retain the requested duration in saved edits.
    step.durationMs = Math.max(0, Math.min(step.durationMs, (steps[i + 1]?.startMs ?? 120000000) - step.startMs));
    keys.push({ ...keys.at(-1)!, time: step.startMs, easing: [.25, .1, .25, 1] });
    keys.push({ x: step.square.charCodeAt(0) - 97 - 3.5, y: 8 - Number(step.square[1]) - 3.5, scale: step.scale,
      rotation: 0, time: step.startMs + step.durationMs, easing: 'hold' });
  }
  const result = { camera: { keys: [...new Map(keys.map(k => [k.time, k])).values()], shakes: camera!.shakes }, steps };
  cameraCache.set(project, result); return result;
}

export function cameraPose(camera: Camera | undefined, time: number, shake = true): CameraPose {
  const keys = camera?.keys || [];
  let pose = { ...CAMERA_DEFAULT }, index = -1;
  for (let i = 0; i < keys.length && keys[i].time <= time; i++) index = i;
  if (index >= 0) {
    const a = keys[index], b = keys[index + 1] || a;
    const t = a === b ? 0 : ease((time - a.time) / (b.time - a.time), a.easing);
    for (const axis of ['x', 'y', 'scale', 'rotation'] as const) pose[axis] = a[axis] + (b[axis] - a[axis]) * t;
  }
  if (shake) for (const effect of camera?.shakes || []) {
    const t = (time - effect.startMs) / effect.durationMs;
    if (t <= 0 || t >= 1) continue;
    const amplitude = effect.strength * Math.sin(Math.PI * t) * (1 - t), phase = (time - effect.startMs) / 1000 * Math.PI * 24;
    pose.x += Math.sin(phase) * amplitude; pose.y += Math.sin(phase * 1.37) * amplitude;
    pose.rotation += Math.sin(phase * .73) * amplitude * 3;
  }
  return pose;
}

export function putCameraKey(camera: Camera, key: CameraKey) {
  if (!camera.keys.length && key.time > 0) camera.keys.push({ ...CAMERA_DEFAULT, time: 0, easing: [.25, .1, .25, 1] });
  camera.keys = [...camera.keys.filter(k => Math.abs(k.time - key.time) > .0001), key].sort((a, b) => a.time - b.time);
}

export function focusCamera(camera: Camera, time: number, durationMs: number, square: string, scale: number) {
  if (!/^[a-h][1-8]$/.test(square) || durationMs < 1) throw new Error('请选择有效格子和运镜时长。');
  const start = cameraPose(camera, time, false);
  camera.keys = camera.keys.filter(k => k.time < time || k.time > time + durationMs);
  putCameraKey(camera, { ...start, time, easing: [.25, .1, .25, 1] });
  putCameraKey(camera, { x: square.charCodeAt(0) - 97 - 3.5, y: 8 - Number(square[1]) - 3.5, scale, rotation: start.rotation, time: time + durationMs, easing: 'linear' });
}

// Frequency-local increases suppress sustained notes; refine candidates to the attack, not its loudest peak.
export function detectBeats(channels: readonly Float32Array[], sampleRate: number): number[] {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  const stride = Math.max(1, Math.floor(sampleRate / 11025)), rate = sampleRate / stride;
  const size = 256, hop = Math.max(1, Math.round(rate * .005)), length = Math.ceil(channels[0].length / stride);
  const signals = channels.map(samples => {
    const signal = new Float32Array(length);
    for (let i = 0; i < samples.length; i++) signal[Math.floor(i / stride)] += samples[i] / stride;
    return signal;
  });
  const frames = Math.ceil(length / hop), bands = [0, 1, 2].map(() => new Float64Array(frames));
  const levels = bands.map(() => new Float64Array(frames));
  const real = new Float64Array(size), imaginary = new Float64Array(size), spectrum = new Float64Array(size / 2), previous = new Float64Array(size / 2);
  const reverse = new Uint16Array(size), window = new Float64Array(size), cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size; i++) {
    let n = i, r = 0; for (let bit = 0; bit < 8; bit++) { r = (r << 1) | (n & 1); n >>= 1; }
    reverse[i] = r; window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / (size - 1));
    if (i < size / 2) { cos[i] = Math.cos(2 * Math.PI * i / size); sin[i] = -Math.sin(2 * Math.PI * i / size); }
  }
  for (let frame = 0; frame < frames; frame++) {
    spectrum.fill(0);
    for (const signal of signals) {
      imaginary.fill(0);
      for (let i = 0; i < size; i++) real[reverse[i]] = (signal[frame * hop + i - size / 2] || 0) * window[i];
      for (let span = 2; span <= size; span *= 2) for (let start = 0; start < size; start += span) for (let j = 0; j < span / 2; j++) {
        const a = start + j, b = a + span / 2, phase = j * size / span;
        const x = real[b] * cos[phase] - imaginary[b] * sin[phase], y = real[b] * sin[phase] + imaginary[b] * cos[phase];
        real[b] = real[a] - x; imaginary[b] = imaginary[a] - y; real[a] += x; imaginary[a] += y;
      }
      for (let k = 1; k < spectrum.length; k++) spectrum[k] += (real[k] ** 2 + imaginary[k] ** 2) / signals.length;
    }
    const level = [0, 0, 0]; let strongestBin = 0;
    for (let k = 1; k < spectrum.length; k++) {
      const band = k * rate / size < 250 ? 0 : k * rate / size < 2000 ? 1 : 2;
      const value = Math.sqrt(spectrum[k]) / size;
      const reference = Math.max(previous[k - 1], previous[k], previous[k + 1] || 0);
      bands[band][frame] += Math.max(0, value - reference); level[band] += value;
      strongestBin = Math.max(strongestBin, value);
      spectrum[k] = value;
    }
    const total = level[0] + level[1] + level[2];
    for (let band = 0; band < 3; band++) {
      levels[band][frame] = level[band];
      if (bands[band][frame] < level[band] * .06 || level[band] < total * .12 || band !== 0 && strongestBin > total * .3) bands[band][frame] = 0;
    }
    previous.set(spectrum);
  }
  const ms = Math.max(1, Math.round(rate / 1000)), energy = new Float64Array(Math.ceil(length / ms));
  for (const signal of signals) for (let i = 0; i < signal.length; i++) energy[Math.floor(i / ms)] += signal[i] ** 2 / ms / signals.length;
  const envelope = energy.map((_, i) => {
    let sum = 0; for (let j = i - 7; j <= i + 7; j++) sum += energy[j] || 0;
    return sum / 15;
  });
  const candidates: { time: number; strength: number }[] = [];
  for (const [band, novelty] of bands.entries()) for (let i = 1; i < frames - 1; i++) {
    const value = novelty[i];
    if (value < .00001 || value < novelty[i - 1] || value <= novelty[i + 1]) continue;
    let sum = 0, peak = 0, levelPeak = 0;
    const from = Math.max(0, i - 40), to = Math.min(frames - 1, i + 40);
    for (let j = from; j <= to; j++) { sum += novelty[j]; peak = Math.max(peak, novelty[j]); levelPeak = Math.max(levelPeak, levels[band][j]); }
    if (value < levelPeak * .01 || value < sum / (to - from + 1) * (band === 1 ? 2.5 : 1.8) + peak * .08) continue;
    const center = Math.round(i * hop / ms), left = Math.max(1, center - 12), right = Math.min(envelope.length - 1, center + 24);
    let before = 0, after = 0;
    for (let j = 5; j <= 20; j++) { before += energy[center - j] || 0; after += energy[center + j] || 0; }
    if (after <= before * 1.08 + 1e-9) continue;
    let attack = left, slope = 0;
    for (let j = left; j <= right; j++) { const rise = envelope[j] - envelope[j - 1]; if (rise > slope) { slope = rise; attack = j; } }
    if (!slope) continue;
    let start = attack;
    const floor = Math.max(0, attack - 50);
    for (let j = floor; j < attack; j++) if (envelope[j] <= envelope[start]) start = j;
    const threshold = envelope[start] + (envelope[attack] - envelope[start]) * .04;
    while (start < attack && envelope[start] < threshold) start++;
    // Compensate the seven-bin lookahead of the centered energy envelope.
    candidates.push({ time: Math.min(Math.round((start + 7) * ms * 1000 / rate), Math.floor(length * 1000 / rate)), strength: value / Math.max(.00001, sum / (to - from + 1)) });
  }
  candidates.sort((a, b) => a.time - b.time);
  const beats: typeof candidates = [];
  for (const candidate of candidates) {
    const last = beats.at(-1);
    if (last && candidate.time - last.time < 60) { if (candidate.strength > last.strength) beats[beats.length - 1] = candidate; }
    else beats.push(candidate);
  }
  return beats.map(b => b.time);
}

export function alignMovesToBeats(project: Project): Edits {
  const effective = editedProject(project), beats = project.edits.beats || [], edits = structuredClone(project.edits);
  if (!beats.length) throw new Error('请先导入音乐检测节拍，或添加手动节拍。');
  if (trackState(project, 'segments').locked || effective.clips.some(c => c.moveId !== null && trackState(project, effectTrack(c.objectId, c.effect)).locked)) throw new Error('走子或分段轨道已锁定，请先解锁。');
  let previousStart = -1, previousMotionStart = -1, beatIndex = 0;
  const ready = new Map<string, number>();
  edits.beatStarts = {};
  const byMove = new Map(effective.segments.map(s => [s.id, [] as typeof effective.clips]));
  for (const clip of effective.clips) if (clip.moveId !== null) byMove.get(clip.moveId)!.push(clip);
  for (const segment of effective.segments) {
    const clips = byMove.get(segment.id)!, land = clips.find(c => c.effect === 'land')!, settle = clips.find(c => c.effect === 'settle')!;
    // Old projects stored leading waits in every clip; remove only those auto offsets.
    const leading = project.edits.beatOffsets?.[segment.id] || 0;
    const offset = Math.min(leading, ...clips.map(c => c.startMs));
    if (offset) {
      for (const clip of clips) edits.clips[clip.id] = { ...edits.clips[clip.id], startMs: clip.startMs - offset };
      edits.segments[segment.id] = { durationMs: segment.durationMs - offset };
    }
    const moving = clips.filter(c => c.effect === 'move');
    const motionStart = Math.min(...moving.map(c => c.startMs)) - offset;
    let earliestStart = Math.max(0, previousStart + 1, previousMotionStart + 1 - motionStart, ...moving.map(c => (ready.get(c.objectId) || 0) - (c.startMs - offset)));
    const capture = clips.find(c => c.effect === 'capture');
    if (segment.capturedObjectId && capture) earliestStart = Math.max(earliestStart, (ready.get(segment.capturedObjectId) || 0) - (capture.startMs - offset));
    const localLand = land.startMs - offset;
    while (beatIndex < beats.length && beats[beatIndex] < earliestStart + localLand - .0001) beatIndex++;
    if (beatIndex === beats.length) throw new Error(`可用节拍不足，第 ${segment.ply} 手起无法对齐。请补充节拍或延长音乐。`);
    const beat = beats[beatIndex++], start = beat - localLand;
    edits.beatStarts[segment.id] = start;
    for (const clip of moving) ready.set(clip.objectId, start + settle.startMs - offset);
    const sound = `sound:${segment.ply}`;
    if (edits.clips[sound]?.startMs === undefined && !trackState(project, 'audio:sfx').locked && !trackState(project, effectTrack('audio:sfx', 'sound')).locked) (edits.beatSync ||= {})[sound] = beat;
    previousStart = start;
    previousMotionStart = start + motionStart;
  }
  delete edits.beatOffsets;
  return edits;
}

export function validateCameraBeats(project: Project) {
  const fail = () => { throw new Error('工程无效：镜头、音乐或节拍数据越界'); };
  function check(value: unknown): asserts value { if (!value) fail(); }
  const finite = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  const fields = (v: unknown, keys: string[], optional: string[] = []) => check(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k)) && keys.every(k => Object.hasOwn(v, k)));
  const { camera, music, beats, beatSync, beatOffsets, beatStarts } = project.edits;
  if (camera !== undefined) {
    fields(camera, ['keys', 'shakes'], ['follow']); check(Array.isArray(camera.keys) && camera.keys.length <= 10000 && Array.isArray(camera.shakes) && camera.shakes.length <= 10000);
    if (camera.follow !== undefined) {
      fields(camera.follow, ['enabled', 'moves']); check(typeof camera.follow.enabled === 'boolean');
      const moves = camera.follow.moves;
      check(moves && typeof moves === 'object' && !Array.isArray(moves));
      const ids = new Set(project.segments.map(s => s.id));
      for (const [id, setting] of Object.entries(moves)) {
        check(ids.has(id)); fields(setting, ['scale', 'durationMs']);
        check(finite(setting.scale, .25, 8) && finite(setting.durationMs, 1, 60000));
      }
    }
    let last = -1;
    for (const key of camera.keys) {
      fields(key, ['time', 'x', 'y', 'scale', 'rotation', 'easing']);
      check(finite(key.time, 0, 120000000) && key.time > last && validEasing(key.easing)); last = key.time;
      check(finite(key.x, -32, 32) && finite(key.y, -32, 32) && finite(key.scale, .25, 8) && finite(key.rotation, -3600, 3600));
    }
    const ids = new Set<string>();
    for (const shake of camera.shakes) {
      fields(shake, ['id', 'startMs', 'durationMs', 'strength']);
      check(typeof shake.id === 'string' && /^[\w-]{1,80}$/.test(shake.id) && !ids.has(shake.id)); ids.add(shake.id);
      check(finite(shake.startMs, 0, 120000000) && finite(shake.durationMs, 1, 10000) && shake.startMs + shake.durationMs <= 120000000 && finite(shake.strength, 0, .5));
    }
  }
  if (music !== undefined) {
    fields(music, ['assetId', 'startMs', 'offsetMs', 'durationMs', 'volume'], ['fadeInMs', 'fadeOutMs']);
    for (const key of ['fadeInMs', 'fadeOutMs'] as const) if (music[key] !== undefined) check(finite(music[key], 0, 600000));
    const asset = project.edits.assets?.find(a => a.id === music.assetId && a.kind === 'audio');
    check(asset?.source.kind === 'embedded' && finite(music.startMs, 0, 120000000) && finite(music.offsetMs, 0, asset.source.durationMs!));
    check(finite(music.durationMs, 1, asset.source.durationMs! - music.offsetMs + .001) && music.startMs + music.durationMs <= 120000000 && finite(music.volume, 0, 1));
  }
  if (beats !== undefined) {
    check(Array.isArray(beats) && beats.length <= 10000); let last = -1;
    for (const time of beats) { check(finite(time, 0, 120000000) && time > last); last = time; }
  }
  if (beatSync !== undefined) {
    check(beatSync && typeof beatSync === 'object' && !Array.isArray(beatSync));
    for (const [id, time] of Object.entries(beatSync)) check(project.clips.some(c => c.id === id && c.effect === 'sound') && finite(time, 0, 120000000));
  }
  if (beatOffsets !== undefined) {
    check(beatOffsets && typeof beatOffsets === 'object' && !Array.isArray(beatOffsets));
    for (const [id, time] of Object.entries(beatOffsets)) check(project.segments.some(s => s.id === id) && finite(time, 0, 60000));
  }
  if (beatStarts !== undefined) {
    check(beatStarts && typeof beatStarts === 'object' && !Array.isArray(beatStarts) && Object.keys(beatStarts).length === project.segments.length);
    let previous = -1;
    for (const segment of project.segments) {
      const start = beatStarts[segment.id]; check(finite(start, 0, 120000000 - 60000) && start > previous); previous = start;
    }
  }
}
