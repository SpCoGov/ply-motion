import type { Asset, Edits, PieceKey, PieceAssetField, Project, Clip, BoardTone, Music } from './types.ts';

export const PIECE_KEYS: PieceKey[] = ['wk', 'wq', 'wr', 'wb', 'wn', 'wp', 'bk', 'bq', 'br', 'bb', 'bn', 'bp'];
export const pieceName = (key: PieceKey) => (key[0] === 'w' ? '白' : '黑') + ({ k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' } as Record<string, string>)[key[1]];
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_EMBEDDED_DATA = 48 * 1024 * 1024;
export const BOARD_COLORS = { light: '#ebecd0', dark: '#779556' };
export function boardSquareStyle(project: Project | undefined, tone: BoardTone) {
  const setting = project?.edits.boardStyle?.[tone];
  const asset = project?.edits.assets?.find(a => a.id === setting?.texture);
  return { color: setting?.color || BOARD_COLORS[tone], texture: asset?.source.kind === 'embedded' ? asset.source.data : null };
}

export function configuredAsset(project: Project | undefined, key: PieceKey | null, field: PieceAssetField): Asset | undefined {
  const id = key && project?.edits.pieceAssets?.[key]?.[field];
  return id ? project?.edits.assets?.find(asset => asset.id === id) : undefined;
}
export function audioPieceKey(project: Project, clip: Pick<Clip, 'id' | 'sourceId'>): PieceKey | null {
  const match = /^sound:(\d+)$/.exec(clip.sourceId || clip.id);
  const segment = match && project.segments[Number(match[1]) - 1];
  const piece = segment?.snapshot.pieces.find(p => segment.before[p.from] === segment.objectId);
  return piece ? `${piece.color}${piece.type}` : null;
}

export function validateEmbeddedAsset(asset: Asset) {
  const fail = () => { throw new Error('工程无效：导入素材数据或类型无效'); };
  const source = asset?.source;
  if (!asset || Object.keys(asset).some(key => !['id', 'kind', 'source'].includes(key)) ||
    typeof asset.id !== 'string' || !/^custom:[\w-]{1,80}$/.test(asset.id) || !['image', 'audio'].includes(asset.kind) ||
    source?.kind !== 'embedded' || typeof source.name !== 'string' || !source.name.length || source.name.length > 256 || /[\x00-\x1f]/.test(source.name) ||
    typeof source.data !== 'string' || source.data.length > Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 256 ||
    Object.keys(source).some(key => !(asset.kind === 'audio' ? ['kind', 'name', 'data', 'durationMs'] : ['kind', 'name', 'data']).includes(key))) fail();
  if (!source || source.kind !== 'embedded') return;
  const match = /^data:(image\/png|audio\/(?:wav|x-wav|mpeg|mp4|aac|ogg|flac|webm));base64,([A-Za-z0-9+/]+={0,2})$/.exec(source.data);
  if (!match || match[2].length % 4 !== 0 ||
    (asset.kind === 'image' ? match[1] !== 'image/png' || !match[2].startsWith('iVBORw0KGgo')
      : !match[1].startsWith('audio/') || !Number.isFinite(source.durationMs) || source.durationMs! < 1 || source.durationMs! > 600000)) fail();
}

function storeAsset(edits: Edits, asset: Asset, kind: 'image' | 'audio') {
  validateEmbeddedAsset(asset);
  if (asset.kind !== kind) throw new Error('素材类型与设置不匹配');
  const existing = asset && edits.assets?.find(a => a.kind === asset.kind && a.source.kind === 'embedded' && asset.source.kind === 'embedded' && a.source.data === asset.source.data);
  if (!existing) (edits.assets ||= []).push(asset);
  return (existing || asset).id;
}
export function cleanAssets(edits: Edits) {
  const used = new Set([...Object.values(edits.pieceAssets || {}).flatMap(setting => Object.values(setting || {})), ...Object.values(edits.boardStyle || {}).map(setting => setting?.texture), edits.music?.assetId, ...edits.overlays?.map(o => o.assetId) || []]);
  edits.assets = (edits.assets || []).filter(a => used.has(a.id));
  if (!edits.assets.length) delete edits.assets;
  if ((edits.assets || []).reduce((sum, a) => sum + (a.source.kind === 'embedded' ? a.source.data.length : 0), 0) > MAX_EMBEDDED_DATA)
    throw new Error('工程内的素材总大小超过 48 MB，请使用较小的图片或音效。');
}
export function assignPieceAsset(edits: Edits, keys: PieceKey[], field: PieceAssetField, asset: Asset | null) {
  if (keys.some(key => !PIECE_KEYS.includes(key)) || !['icon', 'move', 'capture'].includes(field)) throw new Error('未知棋子或素材设置');
  const id = asset && storeAsset(edits, asset, field === 'icon' ? 'image' : 'audio');
  const settings = edits.pieceAssets ||= {};
  for (const key of keys) {
    const next = { ...settings[key] };
    if (id) next[field] = id; else delete next[field];
    if (Object.keys(next).length) settings[key] = next; else delete settings[key];
  }
  if (!Object.keys(settings).length) delete edits.pieceAssets;
  cleanAssets(edits);
}
export function assignBoardStyle(edits: Edits, tone: BoardTone, change: { color?: string; texture?: Asset | null } | null) {
  if (!['light', 'dark'].includes(tone)) throw new Error('未知棋盘方格');
  const settings = edits.boardStyle ||= {}, next = { ...settings[tone] };
  if (change === null) delete settings[tone];
  else {
    if (change.color !== undefined) {
      if (!/^#[\da-f]{6}$/i.test(change.color)) throw new Error('棋盘颜色无效');
      next.color = change.color; delete next.texture;
    }
    if (change.texture !== undefined) { if (change.texture) next.texture = storeAsset(edits, change.texture, 'image'); else delete next.texture; }
    if (Object.keys(next).length) settings[tone] = next; else delete settings[tone];
  }
  if (!Object.keys(settings).length) delete edits.boardStyle;
  cleanAssets(edits);
}

export function assignMusic(edits: Edits, asset: Asset | null) {
  if (asset) edits.music = { assetId: storeAsset(edits, asset, 'audio'), startMs: 0, offsetMs: 0, durationMs: asset.source.kind === 'embedded' ? asset.source.durationMs! : 0, volume: .6 };
  else delete edits.music;
  cleanAssets(edits);
}

export function changeMusicTiming(edits: Edits, timing: Partial<Pick<Music, 'startMs' | 'offsetMs' | 'durationMs'>>) {
  const before = edits.music; if (!before) return;
  const source = edits.assets?.find(a => a.id === before.assetId)?.source;
  const music = { ...before, ...timing };
  if (source?.kind === 'embedded') music.durationMs = Math.min(music.durationMs, source.durationMs! - music.offsetMs, 120000000 - music.startMs);
  const delta = music.startMs - before.startMs - (music.offsetMs - before.offsetMs);
  const trimmed = music.offsetMs !== before.offsetMs || music.durationMs !== before.durationMs;
  edits.music = music;
  if (edits.beats) edits.beats = edits.beats.map(t => t + delta).filter(t => t >= 0 && t <= 120000000 && (!trimmed || t >= music.startMs && t < music.startMs + music.durationMs));
}

export async function importMedia(file: File, kind: 'image' | 'audio', maxDurationMs = 60000): Promise<Asset> {
  if (!file.size || file.size > MAX_MEDIA_BYTES) throw new Error('请选择不超过 16 MB 的有效素材文件。');
  const id = `custom:${crypto.randomUUID()}`, name = file.name;
  if (kind === 'image') {
    if (!/\.(png|jpe?g|webp|svg)$/i.test(name)) throw new Error('图片支持 PNG、JPEG、WebP 和 SVG。');
    const url = URL.createObjectURL(file), image = new Image(); image.src = url;
    try {
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error('图片尺寸须在 4096 × 4096 以内。');
      const scale = Math.min(1, 1024 / image.naturalWidth, 1024 / image.naturalHeight);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('无法读取图片。');
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const asset: Asset = { id, kind, source: { kind: 'embedded', name, data: canvas.toDataURL('image/png') } }; validateEmbeddedAsset(asset); return asset;
    } catch (error) { throw new Error(`无法导入图片：${error instanceof Error ? error.message : error}`); }
    finally { URL.revokeObjectURL(url); }
  }
  const mime = ({ wav: 'wav', mp3: 'mpeg', m4a: 'mp4', aac: 'aac', ogg: 'ogg', flac: 'flac', webm: 'webm' } as Record<string, string>)[name.split('.').at(-1)!.toLowerCase()];
  if (!mime) throw new Error('音效支持 WAV、MP3、M4A、AAC、OGG、FLAC 和 WebM。');
  const bytes = await file.arrayBuffer(), ctx = new OfflineAudioContext(1, 1, 48000);
  let decoded: AudioBuffer;
  try { decoded = await ctx.decodeAudioData(bytes.slice(0)); } catch { throw new Error('无法解码音效，请选择有效的音频文件。'); }
  const durationMs = Math.ceil(decoded.duration * 1000);
  if (durationMs < 1 || durationMs > maxDurationMs) throw new Error(`音频最长 ${maxDurationMs / 1000} 秒。`);
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('无法读取音效。')); reader.readAsDataURL(file); });
  const asset: Asset = { id, kind, source: { kind: 'embedded', name, data: `data:audio/${mime};base64,${data}`, durationMs } }; validateEmbeddedAsset(asset); return asset;
}
