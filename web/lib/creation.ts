import type { Project, Overlay, Composition, AudioEnvelope } from './types.ts';

export const COMPOSITION: Composition = { x: 0, y: 0, scale: 1, rotation: 0, background: '#111715', coordinates: true };
export const OVERLAY_FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';
export function newOverlay(time: number, assetId?: string): Overlay {
  return { id: crypto.randomUUID(), kind: assetId ? 'image' : 'text', text: assetId ? '' : '输入文字', ...(assetId ? { assetId } : {}), startMs: time, durationMs: 3000,
    x: 500, y: 100, width: 800, fontSize: 40, color: '#ffffff', align: 'center', opacity: 1, rotation: 0, fadeInMs: 0, fadeOutMs: 0, hidden: false, locked: false };
}
// Coordinates use a 1000-unit canvas width; font and image size stay proportional on export.
export function envelopeAt(time: number, duration: number, fadeIn = 0, fadeOut = 0) {
  if (time < 0 || time >= duration) return 0;
  return Math.min(1, fadeIn > 0 ? time / fadeIn : 1, fadeOut > 0 ? (duration - time) / fadeOut : 1);
}
export function validateCreation(project: Project) {
  const fail = () => { throw new Error('工程无效：构图、叠加元素或音频包络越界'); };
  const number = (v: unknown, min: number, max: number) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(); };
  const fields = (v: unknown, keys: string[]) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail(); };
  const color = (v: unknown) => { if (typeof v !== 'string' || !/^#[\da-f]{6}$/i.test(v)) fail(); };
  const envelope = (v: AudioEnvelope) => {
    fields(v, ['volume', 'offsetMs', 'fadeInMs', 'fadeOutMs']);
    for (const [key, value] of Object.entries(v)) number(value, 0, key === 'volume' ? 1 : 600000);
  };
  const { composition, overlays, audio, coordinates } = project.edits;
  if (coordinates !== undefined) {
    fields(coordinates, ['x', 'y', 'scale', 'rotation', 'opacity']); number(coordinates.x, -32, 32); number(coordinates.y, -32, 32); number(coordinates.scale, .1, 10); number(coordinates.rotation, -3600, 3600); number(coordinates.opacity, 0, 1);
  }
  if (composition !== undefined) {
    fields(composition, Object.keys(COMPOSITION)); number(composition.x, -2000, 2000); number(composition.y, -2000, 2000);
    number(composition.scale, .1, 3); number(composition.rotation, -3600, 3600); color(composition.background);
    if (typeof composition.coordinates !== 'boolean') fail();
  }
  if (audio !== undefined) {
    fields(audio, [...project.clips.filter(c => c.effect === 'sound').map(c => c.id), ...project.edits.copies.filter(c => project.clips.find(s => s.id === c.sourceId)?.effect === 'sound').map(c => c.id)]);
    for (const value of Object.values(audio)) envelope(value);
  }
  if (overlays !== undefined) {
    if (!Array.isArray(overlays) || overlays.length > 100) fail();
    const ids = new Set<string>();
    for (const o of overlays) {
      fields(o, ['id', 'kind', 'text', 'assetId', 'startMs', 'durationMs', 'x', 'y', 'width', 'fontSize', 'color', 'align', 'opacity', 'rotation', 'fadeInMs', 'fadeOutMs', 'hidden', 'locked']);
      if (typeof o.id !== 'string' || !/^[\w-]{1,80}$/.test(o.id) || ids.has(o.id)) fail(); ids.add(o.id);
      if (!['text', 'image'].includes(o.kind) || typeof o.text !== 'string' || o.text.length > 2000 || !['left', 'center', 'right'].includes(o.align) || typeof o.hidden !== 'boolean' || typeof o.locked !== 'boolean') fail();
      if (o.kind === 'image' && !project.edits.assets?.some(a => a.id === o.assetId && a.kind === 'image')) fail();
      if (o.kind === 'text' && o.assetId !== undefined) fail();
      number(o.startMs, 0, 120000000); number(o.durationMs, 1, 600000); number(o.startMs + o.durationMs, 1, 120000000);
      number(o.x, -2000, 3000); number(o.y, -2000, 3000); number(o.width, 1, 3000); number(o.fontSize, 1, 300);
      number(o.opacity, 0, 1); number(o.rotation, -3600, 3600); number(o.fadeInMs, 0, 600000); number(o.fadeOutMs, 0, 600000); color(o.color);
    }
  }
}
export function paintOverlays(ctx: CanvasRenderingContext2D, project: Project, images: Map<string, HTMLImageElement>, time: number) {
  const { width, height } = ctx.canvas;
  for (const o of project.edits.overlays || []) {
    const alpha = o.hidden ? 0 : o.opacity * envelopeAt(time - o.startMs, o.durationMs, o.fadeInMs, o.fadeOutMs);
    if (!alpha) continue;
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(o.x * width / 1000, o.y * height / 1000); ctx.rotate(o.rotation * Math.PI / 180);
    const w = o.width * width / 1000;
    if (o.kind === 'text') {
      const size = o.fontSize * width / 1000;
      ctx.font = `600 ${size}px ${OVERLAY_FONT}`; ctx.fillStyle = o.color; ctx.textAlign = o.align; ctx.textBaseline = 'top';
      o.text.split('\n').forEach((line, i) => ctx.fillText(line, 0, i * size * 1.2, w));
    } else {
      const source = project.edits.assets?.find(a => a.id === o.assetId)?.source;
      const image = source?.kind === 'embedded' ? images.get(source.data) : undefined;
      if (!image) { ctx.restore(); throw new Error('叠加图片缺失，请在创作面板重新导入。'); }
      ctx.drawImage(image, o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0, 0, w, w * image.naturalHeight / image.naturalWidth);
    }
    ctx.restore();
  }
}
