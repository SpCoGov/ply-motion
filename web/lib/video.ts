import type { Move, Game, Outcome, VideoSettings, AnimationPlan, TimelineDriver, BoardElement, Project, Scene, SoundCue } from './types.ts';
export type VideoSchedule = ReturnType<typeof videoSchedule>;
export type VideoExportMetrics = { fps: number; speed: number; remainingSeconds: number | null };
import { createSequenceScene } from './animation.ts';
import { buildAnimationPlan, timelineTime } from './animation-plan.ts';
import { renderBoard, pieceSource } from './board.ts';
import { glyphSvg, statusGlyph, tacticGlyph } from './glyphs.ts';
import { CLASS_ORDER, winPct, formatEval } from './review.ts';
import { timeMap, locateTime, frameTime } from './playback.ts';
import { editedProject, applyVisuals } from './editing.ts';
import { projectPlans, projectSounds, projectTimeMap } from './project.ts';
import { soundBuffers, scheduleSounds } from './audio.ts';
import { parsePgn } from './game.ts';
import { COMPOSITION, paintOverlays, OVERLAY_FONT } from './creation.ts';
import type { Composition } from './types.ts';
import { boardSquareStyle } from './assets.ts';

export function videoSettings(values: Partial<Record<keyof VideoSettings, unknown>>): VideoSettings {
  const keys = ['width', 'height', 'fps', 'crf', 'bitrate', 'speed'] as const;
  const settings = Object.fromEntries(keys.map(key => [key, Number(values[key])])) as Pick<VideoSettings, typeof keys[number]>;
  const { width, height, fps, crf, bitrate, speed } = settings;
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 3840 && n % 2 === 0) || width * height > 3840 * 2160)
    throw new Error('宽高须为 256–3840 的偶数，总像素不超过 3840×2160。');
  if (![24, 25, 30, 50, 60].includes(fps)) throw new Error('请选择支持的帧率。');
  if (!Number.isInteger(crf) || crf < 0 || crf > 40 || !Number.isInteger(bitrate) || bitrate < 0 || bitrate > 100000 || bitrate > 0 && bitrate < 500)
    throw new Error('画质须为 0–40；码率须为 0（自动）或 500–100000 kbps。');
  if (![.5, 1, 1.5, 2].includes(speed)) throw new Error('请选择支持的播放速度。');
  for (const key of ['showNames', 'showMove', 'showEvaluation'] as const)
    if (values[key] !== undefined && typeof values[key] !== 'boolean') throw new Error('视频显示选项须为布尔值。');
  return { ...settings, sound: !!values.sound, showNames: values.showNames !== false,
    showMove: values.showMove !== false, showEvaluation: values.showEvaluation === true };
}

export function videoSchedule(moves: Move[], outcome: Outcome | null, settings: VideoSettings, plans: AnimationPlan[] | null = null, audio: SoundCue[] = [], endMs = 0) {
  if (!moves.length) throw new Error('棋谱没有可导出的着法。');
  if (settings.showEvaluation && moves.some(move => !Number.isFinite(move.cpWhite)))
    throw new Error('显示引擎评分前，请先在「棋局」面板完成分析。');
  const resolved = plans || moves.map((move, i) => buildAnimationPlan(move, { outcome: i === moves.length - 1 ? outcome : null }));
  const { ranges, duration } = timeMap(resolved, settings.speed, Math.max(endMs, ...audio.map(c => c.at + c.durationMs)));
  const clips = moves.map((move, i) => {
    const plan = resolved[i];
    return { start: ranges[i].start, duration: ranges[i].end - ranges[i].start,
      land: ranges[i].start + timelineTime(plan.events.find(e => e.type === 'land')!.at, settings.speed), move };
  });
  if (duration > 600000) throw new Error('单次导出最长 10 分钟，请缩短棋谱或提高播放速度。');
  // Include the final settled position without adding a hold between moves.
  return { clips, sounds: audio.map(c => ({ ...c, at: c.at / settings.speed, durationMs: c.durationMs / settings.speed })), frames: Math.ceil(duration * settings.fps / 1000) + 1, duration };
}

// Sample video time, so seeking and slow encoding produce the same eased score.
export function videoEvaluation(schedule: VideoSchedule, time: number, initial: Partial<Move> | null = null, speed = 1) {
  let index = -1;
  // ponytail: scan the bounded ten-minute game; use binary search if long exports are added.
  for (let i = 0; i < schedule.clips.length && schedule.clips[i].land <= time; i++) index = i;
  const from = index > 0 ? schedule.clips[index - 1].move : initial;
  const to = index >= 0 ? schedule.clips[index].move : initial;
  const duration = index < 0 ? 0 : Math.min(350 / speed,
    (schedule.clips[index + 1]?.land ?? schedule.duration) - schedule.clips[index].land);
  const t = index < 0 || duration <= 0 ? 1 : Math.max(0, Math.min(1, (time - schedule.clips[index].land) / duration));
  const eased = 1 - (1 - t) ** 3;
  const white = (move: Partial<Move> | null) => move?.mateWhite != null ? (move.mateWhite > 0 ? 1 : 0)
    : move?.cpWhite == null ? .5 : winPct(move.cpWhite) / 100;
  const cp = from?.cpWhite != null && to?.cpWhite != null && from.mateWhite == null && to.mateWhite == null && !to.san?.endsWith('#')
    ? from.cpWhite + (to.cpWhite - from.cpWhite) * eased : to?.cpWhite ?? null;
  return { cp, white: white(from) + (white(to) - white(from)) * eased,
    label: formatEval(to ? { ...to, cpWhite: cp ?? undefined } : null) };
}

export function exportMetrics(done: number, total: number, elapsedMs: number, videoFps: number): VideoExportMetrics | null {
  if (done <= 0 || elapsedMs <= 0 || !Number.isFinite(elapsedMs)) return null;
  const fps = done * 1000 / elapsedMs;
  return { fps, speed: fps / videoFps, remainingSeconds: Math.max(0, total - done) / fps };
}

// A single frame grid spans the whole game. Slow rendering never drops frames
// or changes the timing of a move, a path, a badge, or a sound.
export function frameTimeline(fps: number, clock: { frame: number; elapsed: number }, capture: (frame: number) => Promise<unknown>): TimelineDriver {
  return async (events, duration, { signal, dispatch, seek }) => {
    let eventIndex = 0;
    const advance = (time: number) => {
      while (eventIndex < events.length && events[eventIndex].at <= time) dispatch(events[eventIndex++]);
      seek!(time);
    };
    while (clock.frame * 1000 / fps < clock.elapsed + duration - 1e-7) {
      signal?.throwIfAborted();
      advance(clock.frame * 1000 / fps - clock.elapsed);
      await capture(clock.frame);
      clock.frame++;
    }
    signal?.throwIfAborted();
    advance(duration);
    clock.elapsed += duration;
    return true;
  };
}

export function pcmWave(samples: Float32Array | number[], sampleRate = 48000) {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const n = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(n * (n < 0 ? 32768 : 32767)), true); });
  return bytes;
}

async function soundtrack(schedule: VideoSchedule, settings: VideoSettings, chesscom: boolean, signal: AbortSignal, project: Project) {
  // ponytail: whole-clip audio is capped at ten minutes; mix chunks for longer exports.
  const ctx = new OfflineAudioContext(1, Math.ceil(schedule.frames * 48000 / settings.fps), 48000);
  const buffers = await soundBuffers(ctx, chesscom, signal, project);
  scheduleSounds(ctx, projectSounds(project), 0, ctx.length / ctx.sampleRate * 1000 * settings.speed, buffers, settings.speed);
  const rendered = await ctx.startRendering(); signal?.throwIfAborted();
  return pcmWave(rendered.getChannelData(0));
}

async function loadImages(chesscom: boolean, signal: AbortSignal, project: Project) {
  const sources = new Set<string>();
  for (const side of ['w', 'b']) for (const piece of 'pnbrqk') sources.add(pieceSource(piece, side, chesscom, project));
  for (const tone of ['light', 'dark'] as const) { const texture = boardSquareStyle(project, tone).texture; if (texture) sources.add(texture); }
  for (const asset of project.edits.assets || []) if (asset.kind === 'image' && asset.source.kind === 'embedded') sources.add(asset.source.data);
  const icons = [...CLASS_ORDER.map(glyphSvg), tacticGlyph('free_piece'),
    ...['win', 'loss', 'draw'].flatMap(icon => ['w', 'b'].map(side => statusGlyph(icon, side)))];
  icons.forEach(html => { const src = html.match(/src="([^"]+)"/)?.[1]; if (src) sources.add(src); });
  const images = new Map<string, HTMLImageElement>();
  await Promise.all([...sources].map(async src => {
    const image = new Image(); image.src = src;
    await image.decode().catch(() => { throw new Error(`无法加载视频所需的图片：${src.startsWith('data:') ? '自定义图片素材' : src}`); });
    signal?.throwIfAborted(); images.set(image.src, image);
  }));
  await document.fonts.load(`600 40px ${OVERLAY_FONT}`);
  await document.fonts.ready;
  return images;
}

// Paint only the board primitives already produced by the live renderer. WAAPI
// computes transforms/easing; this does not maintain a second animation model.
const boardLayers = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();
function paintTransform(ctx: CanvasRenderingContext2D, s: CSSStyleDeclaration, width: number, height: number) {
  const active = (value: string) => value && value !== 'none';
  if (![s.translate, s.rotate, s.scale, s.transform].some(active)) return;
  const origin = s.transformOrigin.split(' ').map(parseFloat);
  const length = (value: string | undefined, size: number) => value ? parseFloat(value) * (value.endsWith('%') ? size / 100 : 1) : 0;
  const translation = active(s.translate) ? s.translate.split(' ') : [];
  // CSS individual transforms compose before the animated transform, around the same origin.
  ctx.translate(length(translation[0], width), length(translation[1], height));
  ctx.translate(origin[0], origin[1]);
  if (active(s.rotate)) ctx.rotate(parseFloat(s.rotate) * Math.PI / 180);
  if (active(s.scale)) { const [x, y = x] = s.scale.split(' ').map(Number); ctx.scale(x, y); }
  if (active(s.transform)) { const m = new DOMMatrix(s.transform); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f); }
  ctx.translate(-origin[0], -origin[1]);
}
export function paintBoard(ctx: CanvasRenderingContext2D, board: BoardElement, images: Map<string, HTMLImageElement>) {
  const style = (el: HTMLElement) => getComputedStyle(el);
  const root = style(board);
  if (root.display === 'none' || root.visibility === 'hidden' || Number(root.opacity) === 0) return;
  const grouped = root.filter && root.filter !== 'none' || Number(root.opacity) !== 1;
  const output = ctx;
  let layer: HTMLCanvasElement | undefined;
  if (grouped) {
    layer = boardLayers.get(output);
    if (!layer) { layer = document.createElement('canvas'); boardLayers.set(output, layer); }
    if (layer.width !== output.canvas.width || layer.height !== output.canvas.height) {
      layer.width = output.canvas.width; layer.height = output.canvas.height;
    }
    const target = layer.getContext('2d');
    if (!target) throw new Error('无法创建棋盘合成画布。');
    target.setTransform(1, 0, 0, 1, 0, 0); target.clearRect(0, 0, layer.width, layer.height);
    target.setTransform(output.getTransform()); target.globalAlpha = 1; target.filter = 'none';
    ctx = target;
  }
  ctx.save(); paintTransform(ctx, root, board.clientWidth, board.clientHeight);
  try {
  const paint = (el: HTMLElement, x = el.offsetLeft, y = el.offsetTop) => {
    const s = style(el), w = parseFloat(s.width), h = parseFloat(s.height);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return;
    ctx.save(); ctx.translate(x, y); ctx.globalAlpha *= Number(s.opacity);
    paintTransform(ctx, s, w, h);
    if (el.classList.contains('nag-particle')) {
      ctx.fillStyle = s.backgroundColor; ctx.shadowColor = s.color; ctx.shadowBlur = parseFloat(s.fontSize) * .07;
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
    } else if (el.classList.contains('nag-halo')) {
      const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) * .35);
      glow.addColorStop(0, s.color); glow.addColorStop(1, 'transparent'); ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
    } else if (el.classList.contains('nag-ring')) {
      ctx.strokeStyle = s.borderTopColor; ctx.lineWidth = parseFloat(s.borderTopWidth);
      ctx.shadowColor = s.color; ctx.shadowBlur = 5;
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, (w - ctx.lineWidth) / 2, (h - ctx.lineWidth) / 2, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') { ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, w, h); }
      if (el.tagName === 'IMG') {
        const image = images.get((el as HTMLImageElement).src);
        if (!image) throw new Error(`视频图片未加载：${(el as HTMLImageElement).src}`);
        ctx.filter = s.filter;
        const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
        const iw = image.naturalWidth * scale, ih = image.naturalHeight * scale;
        ctx.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih); ctx.filter = 'none';
      } else if (el.classList.contains('coord')) {
        ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`; ctx.fillStyle = s.color; ctx.textBaseline = 'top'; ctx.fillText(el.textContent ?? "", 0, 0);
      }
    }
    ([...el.children] as HTMLElement[]).sort((a, b) => (Number(style(a).zIndex) || 0) - (Number(style(b).zIndex) || 0)).forEach(child => paint(child));
    ctx.restore();
  };
  const layers: { el: HTMLElement; x: number; y: number }[] = [];
  for (const el of [...board.children] as HTMLElement[]) {
    if (!el.classList.contains('sq')) { layers.push({ el, x: el.offsetLeft, y: el.offsetTop }); continue; }
    const s = style(el), x = el.offsetLeft, y = el.offsetTop;
    ctx.fillStyle = s.backgroundColor; ctx.fillRect(x, y, el.offsetWidth, el.offsetHeight);
    const texture = s.backgroundImage?.match(/^url\("(.+)"\)$/)?.[1];
    if (texture) {
      const image = images.get(texture); if (!image) throw new Error('棋盘纹理未加载。');
      const w = el.offsetWidth, h = el.offsetHeight, scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
      const sw = w / scale, sh = h / scale;
      ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
    }
    const highlight = getComputedStyle(el, '::after');
    if (el.classList.contains('hl') && highlight.display !== 'none') {
      ctx.save(); ctx.globalAlpha = Number(highlight.opacity); ctx.fillStyle = highlight.backgroundColor;
      ctx.fillRect(x, y, el.offsetWidth, el.offsetHeight); ctx.restore();
    }
    for (const child of [...el.children] as HTMLElement[]) layers.push({ el: child, x: x + child.offsetLeft, y: y + child.offsetTop });
  }
  layers.sort((a, b) => (Number(style(a.el).zIndex) || 0) - (Number(style(b.el).zIndex) || 0));
  layers.forEach(({ el, x, y }) => paint(el, x, y));
  } finally { ctx.restore(); }
  if (layer) {
    // Filter the composed board once, preserving overlapping pieces and overflow at video bounds.
    output.save(); output.setTransform(1, 0, 0, 1, 0, 0);
    output.globalAlpha *= Number(root.opacity); output.filter = root.filter || 'none';
    output.drawImage(layer, 0, 0); output.restore();
  }
}

export function paintVideoFrame(ctx: CanvasRenderingContext2D, board: BoardElement, images: Map<string, HTMLImageElement>, game: Game, move: Move | null, settings: Pick<VideoSettings, 'width' | 'height'> & Partial<Pick<VideoSettings, 'showNames' | 'showMove' | 'showEvaluation'>>, flip: boolean, evaluation: ReturnType<typeof videoEvaluation> | null = null, composition: Composition = COMPOSITION) {
  const { width, height } = settings, size = Math.min(width, height) * .84 * composition.scale;
  const barWidth = Math.max(20, size * .045), gap = size * .02;
  const x = (width - size + (settings.showEvaluation ? gap + barWidth : 0)) / 2 + composition.x * width / 1000, y = (height - size) / 2 + composition.y * height / 1000;
  ctx.fillStyle = composition.background; ctx.fillRect(0, 0, width, height);
  ctx.save(); ctx.translate(x + size / 2, y + size / 2); ctx.rotate(composition.rotation * Math.PI / 180); ctx.translate(-size / 2, -size / 2); ctx.scale(size / 640, size / 640);
  if (board.dataset.cameraActive === 'true') { ctx.beginPath(); ctx.rect(0, 0, 640, 640); ctx.clip(); }
  paintBoard(ctx, board, images); ctx.restore();
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * .02));
  ctx.font = `600 ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`; ctx.fillStyle = '#e9efeb'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (settings.showNames !== false) {
    ctx.fillText(game.headers[flip ? 'White' : 'Black'] || (flip ? 'White' : 'Black'), x, y - fontSize * 1.7, size);
    ctx.fillText(game.headers[flip ? 'Black' : 'White'] || (flip ? 'Black' : 'White'), x, y + size + fontSize * 1.7, size * (settings.showMove === false ? 1 : .55));
  }
  if (settings.showMove !== false) {
    const label = move ? `${move.moveNo}${move.color === 'w' ? '.' : '...'} ${move.san}` : '';
    ctx.textAlign = 'right'; ctx.fillStyle = '#b9e583'; ctx.fillText(label, x + size, y + size + fontSize * 1.7, size * .4);
  }
  if (settings.showEvaluation) {
    const barX = x - gap - barWidth, white = evaluation?.white ?? .5;
    ctx.fillStyle = '#3a3835'; ctx.fillRect(barX, y, barWidth, size);
    ctx.fillStyle = '#f8f8f8'; ctx.fillRect(barX, y + (flip ? 0 : size * (1 - white)), barWidth, size * white);
    const whiteAhead = white >= .5, labelTop = whiteAhead ? flip : !flip, scoreFont = Math.max(8, Math.round(barWidth * .38));
    ctx.font = `700 ${scoreFont}px "Segoe UI", "Microsoft YaHei", sans-serif`; ctx.textAlign = 'center';
    ctx.fillStyle = whiteAhead ? '#262522' : '#f8f8f8';
    ctx.fillText(evaluation?.label ?? '—', barX + barWidth / 2, labelTop ? y + scoreFont : y + size - scoreFont, barWidth - 2);
  }
  ctx.textAlign = 'left';
}

// The export dialog and encoder sample the same scene and finished-video layout.
export async function createVideoRenderer(project: Project, settings: VideoSettings, chesscom: boolean, signal: AbortSignal) {
  const snapshot = structuredClone(project), effective = editedProject(snapshot);
  const game = parsePgn(snapshot.pgn), plans = projectPlans(snapshot), moves = plans.map(plan => plan.move), flip = snapshot.output.flip;
  settings = videoSettings(settings);
  const schedule = videoSchedule(moves, game.outcome, settings, plans, projectSounds(snapshot), projectTimeMap(snapshot).duration);
  const first = snapshot.analysis?.review.moves[0];
  const initialScore = first ? { cpWhite: first.bestCpWhite, mateWhite: first.bestMateWhite } : null;
  const map = timeMap(plans, settings.speed, schedule.duration * settings.speed);
  const images = await loadImages(chesscom, signal, snapshot); signal.throwIfAborted();
  const board = document.createElement('div'); board.className = 'export-board'; board.setAttribute('aria-hidden', 'true'); document.body.append(board);
  const canvas = document.createElement('canvas'); canvas.width = settings.width; canvas.height = settings.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  let index = -1, scene: Scene | null = null;
  const dispose = () => { scene?.dispose(); scene = null; board.remove(); };
  const initial = () => {
    scene?.dispose(); scene = null; index = -1;
    renderBoard(board, game.startFen, { flip, chesscom, project: snapshot });
    for (const [sq, id] of Object.entries(effective.segments[0].before)) {
      const piece = board.querySelector<HTMLElement>(`[data-sq="${sq}"] .pc`); if (piece) piece.dataset.objectId = id;
    }
  };
  try {
    if (!ctx) throw new Error('无法创建视频画布。');
    initial();
    return { canvas, schedule, project: snapshot, dispose, render(time: number) {
      signal.throwIfAborted();
      const at = locateTime(map, time);
      const begun = at.time > map.ranges[0].start;
      if (begun) {
        if (index !== at.index) {
          scene?.dispose(); index = at.index;
          scene = createSequenceScene(board, plans, effective.segments, index, { flip, chesscom, project: snapshot });
        }
        scene!.seek(Math.max(0, at.local * settings.speed));
      } else if (scene) initial();
      applyVisuals(board, effective, at.time * settings.speed);
      paintVideoFrame(ctx, board, images, game, begun ? moves[at.index] : null, settings, flip,
        settings.showEvaluation ? videoEvaluation(schedule, at.time, initialScore, settings.speed) : null, snapshot.edits.composition);
      paintOverlays(ctx, snapshot, images, at.time * settings.speed);
    } };
  } catch (error) { dispose(); throw error; }
}

const ffmpegPathKey = 'plymotion.ffmpeg.path';
export function getFfmpegPath() {
  try { return localStorage.getItem(ffmpegPathKey) || ''; } catch { return ''; }
}
export function saveFfmpegPath(path: string) { localStorage.setItem(ffmpegPathKey, path.trim()); }

export async function exportVideo({ project, settings, chesscom, signal, onProgress }: { project: Project; settings: VideoSettings; chesscom: boolean; signal: AbortSignal; onProgress: (value: number, text: string, metrics?: VideoExportMetrics | null) => void }): Promise<string | null> {
  const invoke = window.__TAURI__?.core.invoke;
  if (!invoke) throw new Error('视频导出需要在 Tauri 桌面程序中运行。');
  const path = getFfmpegPath() || null;
  settings = videoSettings(settings);
  onProgress(0, '准备棋子与图标…');
  const renderer = await createVideoRenderer(project, settings, chesscom, signal), { canvas, schedule } = renderer;
  const { width, height, fps, crf, bitrate, sound } = settings;
  let id: string | null = null;
  const cancel = () => { if (id) void invoke('cancel_video_export', { id }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    id = await invoke<string | null>('start_video_export', { path, settings: { width, height, fps, crf, bitrate, sound, frames: schedule.frames } });
    if (!id) return null;
    const exportId = id;
    signal.throwIfAborted();
    if (sound) {
      onProgress(0, '生成音乐与音效…');
      const audio = await soundtrack(schedule, settings, chesscom, signal, renderer.project);
      await invoke('write_video_data', audio, { headers: { 'x-export-id': id, 'x-export-kind': 'audio' } });
    }
    signal.throwIfAborted();
    // Count rendering, PNG conversion and encoder backpressure, excluding setup and the save dialog.
    const started = performance.now();
    onProgress(0, `正在导出 0 / ${schedule.frames} 帧`);
    const capture = async (frame: number) => {
      signal.throwIfAborted();
      renderer.render(frameTime(frame, fps));
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('生成视频帧失败。')), 'image/png'));
      signal.throwIfAborted();
      await invoke('write_video_data', await png.arrayBuffer(), { headers: { 'x-export-id': exportId, 'x-export-kind': 'frame' } });
      const metrics = exportMetrics(frame + 1, schedule.frames, performance.now() - started, fps);
      onProgress((frame + 1) / schedule.frames, `正在导出 ${frame + 1} / ${schedule.frames} 帧`, metrics);
    };
    for (let frame = 0; frame < schedule.frames; frame++) await capture(frame);
    const metrics = exportMetrics(schedule.frames, schedule.frames, performance.now() - started, fps);
    signal.throwIfAborted(); onProgress(1, '正在封装 MP4…', metrics ? { ...metrics, remainingSeconds: null } : null);
    return await invoke<string>('finish_video_export', { id });
  } catch (error) {
    if (id) await invoke('cancel_video_export', { id }).catch(() => {});
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel); renderer.dispose();
  }
}
