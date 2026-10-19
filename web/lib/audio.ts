import type { SoundKind, SoundCue, Project } from './types.ts';
export type SoundBuffers = Partial<Record<string, AudioBuffer>>;

const importedBuffers = new Map<string, { data: string; promise: Promise<AudioBuffer> }>();
async function customBuffers(ctx: BaseAudioContext, project?: Project, signal?: AbortSignal): Promise<SoundBuffers> {
  if (!project) return {};
  const assets = (project.edits.assets || []).filter(a => a.kind === 'audio');
  const ids = new Set(assets.map(a => a.id));
  for (const id of importedBuffers.keys()) if (!ids.has(id)) importedBuffers.delete(id);
  const pairs = await Promise.all(assets.map(async asset => {
    if (asset.source.kind !== 'embedded') throw new Error('音效素材来源无效。');
    const { data, name, durationMs } = asset.source;
    let cached = importedBuffers.get(asset.id);
    if (cached?.data !== data) {
      const promise = fetch(data).then(response => response.arrayBuffer()).then(bytes => ctx.decodeAudioData(bytes))
        .catch(() => { importedBuffers.delete(asset.id); throw new Error(`无法解码音效：${name}`); });
      cached = { data, promise }; importedBuffers.set(asset.id, cached);
    }
    const buffer = await cached.promise; signal?.throwIfAborted();
    if (buffer.duration <= 0 || buffer.duration > (project.edits.music?.assetId === asset.id ? 600 : 60) || Math.abs(buffer.duration * 1000 - durationMs!) > 1) throw new Error(`音频时长无效：${name}`);
    return [asset.id, buffer] as const;
  }));
  return Object.fromEntries(pairs);
}

export async function soundBuffers(ctx: BaseAudioContext, chesscom: boolean, signal?: AbortSignal, project?: Project): Promise<SoundBuffers> {
  const [pairs, custom] = await Promise.all([Promise.all((chesscom ? ['move', 'capture'] as const : []).map(async kind => {
    const response = await fetch(`assets/chesscom/sounds/${kind}.mp3`, { signal });
    if (!response.ok) throw new Error(`无法读取 ${kind} 音效。`);
    return [kind, await ctx.decodeAudioData(await response.arrayBuffer())] as const;
  })), customBuffers(ctx, project, signal)]);
  signal?.throwIfAborted();
  return { ...Object.fromEntries(pairs), ...custom };
}

// Live playback and offline export share source offsets, trimming and synthesis.
export function scheduleSound(ctx: BaseAudioContext, kind: SoundCue['kind'], at: number, duration: number, offset = 0, buffer?: AudioBuffer, volume = 1, rate = 1, destination: AudioNode = ctx.destination): AudioScheduledSourceNode | null {
  const length = Math.min(duration * rate, (buffer?.duration ?? .13) - offset);
  if (length <= 0 || volume === 0) return null;
  if (buffer) {
    const source = ctx.createBufferSource(); source.buffer = buffer;
    if (rate !== 1) source.playbackRate.value = rate;
    const gain = volume === 1 ? null : ctx.createGain();
    if (gain) { gain.gain.value = volume; source.connect(gain).connect(destination); } else source.connect(destination);
    source.start(at, offset, length); source.onended = () => { source.disconnect(); gain?.disconnect(); }; return source;
  }
  if (kind === 'music') return null;
  const oscillator = ctx.createOscillator(), gain = ctx.createGain(), frequency = kind === 'capture' ? 240 : 450;
  oscillator.type = kind === 'capture' ? 'triangle' : 'sine';
  oscillator.frequency.setValueAtTime(frequency * (100 / frequency) ** (Math.min(offset, .08) / .08), at);
  if (offset < .08) oscillator.frequency.exponentialRampToValueAtTime(100, at + .08 - offset);
  gain.gain.setValueAtTime(Math.max(.000001, volume * .15 * (.001 / .15) ** (Math.min(offset, .12) / .12)), at);
  if (offset < .12) gain.gain.exponentialRampToValueAtTime(Math.max(.000001, .001 * volume), at + .12 - offset);
  oscillator.connect(gain).connect(destination); oscillator.start(at); oscillator.stop(at + length);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); }; return oscillator;
}

// Web Audio owns cue timing, including cues crossed while the UI thread is busy.
export function scheduleSounds(ctx: BaseAudioContext, cues: SoundCue[], fromMs: number, untilMs: number,
  buffers: SoundBuffers, speed = 1, start = ctx.currentTime): AudioScheduledSourceNode[] {
  if (cues.some(cue => !cue.muted && cue.assetId && !buffers[cue.assetId])) throw new Error('音频素材缺失，请重新导入。');
  const sources: AudioScheduledSourceNode[] = [];
  for (const cue of cues) {
    if (cue.muted) continue;
    const begin = Math.max(cue.at, fromMs), end = Math.min(cue.at + cue.durationMs, untilMs);
    if (end <= begin) continue;
    let envelope: GainNode | undefined;
    if (cue.fadeInMs || cue.fadeOutMs) {
      envelope = ctx.createGain(); envelope.connect(ctx.destination);
      const fadeIn = cue.fadeInMs || 0, fadeOut = cue.fadeOutMs || 0, duration = cue.durationMs;
      const value = (t: number) => Math.max(0, Math.min(1, fadeIn ? t / fadeIn : 1, fadeOut ? (duration - t) / fadeOut : 1));
      const first = begin - cue.at, last = end - cue.at, anchor = start + (begin - fromMs) / 1000 / speed;
      envelope.gain.setValueAtTime(value(first), anchor);
      const points = [fadeIn, duration - fadeOut, duration * fadeIn / (fadeIn + fadeOut), last];
      for (const t of [...new Set(points)].filter(t => t > first && t <= last).sort((a, b) => a - b)) envelope.gain.linearRampToValueAtTime(value(t), anchor + (t - first) / 1000 / speed);
    }
    const source = scheduleSound(ctx, cue.kind, start + (begin - fromMs) / 1000 / speed,
      (end - begin) / 1000 / speed, (cue.offsetMs || 0) / 1000 + (begin - cue.at) / 1000 / (cue.kind === 'music' ? 1 : speed), buffers[cue.assetId || cue.kind], cue.volume ?? 1, cue.kind === 'music' ? speed : 1, envelope || ctx.destination);
    if (envelope) { if (source) source.addEventListener('ended', () => envelope!.disconnect(), { once: true }); else envelope.disconnect(); }
    if (source) sources.push(source);
  }
  return sources;
}

const waveformBuffers = new Map<boolean, Promise<Partial<Record<SoundKind, AudioBuffer>>>>();
export async function soundWaveforms(chesscom: boolean, project?: Project): Promise<SoundBuffers> {
  let result = waveformBuffers.get(chesscom);
  if (!result) {
    result = (async () => {
      const buffers = await soundBuffers(new OfflineAudioContext(1, 6240, 48000), chesscom).catch(() => ({} as Partial<Record<SoundKind, AudioBuffer>>));
      const pairs = await Promise.all((['move', 'capture'] as const).map(async kind => {
        if (buffers[kind]) return [kind, buffers[kind]] as const;
        const ctx = new OfflineAudioContext(1, 6240, 48000);
        scheduleSound(ctx, kind, 0, .13);
        return [kind, await ctx.startRendering()] as const;
      }));
      return Object.fromEntries(pairs);
    })().catch(error => { waveformBuffers.delete(chesscom); throw error; });
    waveformBuffers.set(chesscom, result);
  }
  return { ...await result, ...await customBuffers(new OfflineAudioContext(1, 1, 48000), project) };
}

const envelopes = new WeakMap<AudioBuffer, { samples: Float32Array; peak: number; stride: number }>();
// Sample the source on the clip's time scale; extending a clip adds silence.
export function waveformPath(buffer: AudioBuffer | undefined, durationMs: number, width: number, offsetMs = 0): string {
  let path = `M0 13H${width.toFixed(2)}`;
  if (!buffer) return path;
  let envelope = envelopes.get(buffer);
  if (!envelope) {
    const stride = 128;
    const samples = new Float32Array(Math.ceil(buffer.length / stride)); let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const source = buffer.getChannelData(channel);
      for (let i = 0; i < source.length; i++) { const amplitude = Math.abs(source[i]); samples[Math.floor(i / stride)] = Math.max(samples[Math.floor(i / stride)], amplitude); peak = Math.max(peak, amplitude); }
    }
    envelope = { samples, peak, stride }; envelopes.set(buffer, envelope);
  }
  const { samples, peak, stride } = envelope, columns = Math.max(1, Math.ceil(width));
  if (!peak) return path;
  const sources = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const step = durationMs / 1000 * buffer.sampleRate / columns, offset = offsetMs / 1000 * buffer.sampleRate;
  for (let column = 0; column < columns; column++) {
    let amplitude = 0;
    // Use cached peaks only for whole blocks so zooming and trimming cannot smear nearby attacks.
    for (let i = Math.max(0, Math.floor(offset + column * step)), end = Math.min(buffer.length, Math.ceil(offset + (column + 1) * step)); i < end;) {
      if (i % stride === 0 && i + stride <= end) { amplitude = Math.max(amplitude, samples[i / stride]); i += stride; }
      else { for (const source of sources) amplitude = Math.max(amplitude, Math.abs(source[i])); i++; }
    }
    if (amplitude) {
      const height = 11 * amplitude / peak;
      path += `M${((column + .5) * width / columns).toFixed(2)} ${(13 - height).toFixed(2)}V${(13 + height).toFixed(2)}`;
    }
  }
  return path;
}
