import type { Game, Move, Project, SceneObject, Segment, Clip, AnimationPlan, AnimationEvent, Review, EngineSettings, Output, Asset, Relation, RelationStep, ClassId, Color, Effect, AnalyzedMove, SoundCue, Director } from './types.ts';
type Identity = Omit<Segment, 'durationMs' | 'snapshot'>;
import { Chess } from '../vendor/chess.ts';
import { parsePgn } from './game.ts';
import { buildAnimationPlan, NAG_ENTER_MS, NAG_EXIT_MS } from './animation-plan.ts';
import { CLASS_ORDER, moveClass, moveAccuracy, expectedScore, EXPECTED_SCORE_MODEL } from './review.ts';
import { videoSettings } from './video.ts';
import { emptyEdits, editedProject, validateEdits, clipTimeLimit, trackState, effectTrack, propertyTrack, properties } from './editing.ts';
import { timeMap } from './playback.ts';
import { engineSettings } from './engine.ts';
import { configuredAsset, audioPieceKey, validateEmbeddedAsset } from './assets.ts';
import { resolveCamera } from './camera-beats.ts';

export const PROJECT_VERSION = 4;
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_OUTPUT: Output = { width: 1080, height: 1080, fps: 30, crf: 23, bitrate: 0, speed: 1, sound: true, showNames: true, showMove: true, showEvaluation: false, flip: false };
// Version 2 uses generic victory/defeat/draw visuals. Version 1 is migrated below.
const director: Director = { id: 'classic', version: 2 };
function validDirector(value: Director) {
  fields(value, ['id', 'version'], ['intensity']);
  return ['classic', 'focus', 'lively'].includes(value.id) && value.version === 2 && (value.intensity === undefined || number(value.intensity, 0, 2));
}
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fail = (message: string): never => { throw new Error(`工程无效：${message}`); };
function check(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
const square = (value: unknown) => typeof value === 'string' && /^[a-h][1-8]$/.test(value);
const number = (value: unknown, min = 0, max = 60000): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), '需要对象');
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), '字段缺失或包含不支持的字段');
}
function safeJson(value: unknown, depth = 0): void {
  check(depth <= 24, '数据层次过深');
  if (typeof value === 'number') check(Number.isFinite(value), '数字必须有限');
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      check(!['__proto__', 'prototype', 'constructor'].includes(key), '不安全的字段');
      safeJson(item, depth + 1);
    }
  } else check(value === null || ['string', 'boolean'].includes(typeof value), '只能保存 JSON 数据');
}

// Identity belongs to the original piece, including after promotion and capture.
export function gameIdentities(game: Game) {
  const positions = new Map<string, string>(), objects: SceneObject[] = [{ id: 'board', kind: 'board', group: 'scene', visual: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }];
  for (const piece of new Chess(game.startFen).board().flat().filter(piece => piece !== null)) {
    const id = `piece:${piece.color}:${piece.type}:${piece.square}`;
    positions.set(piece.square, id);
    objects.push({ id, kind: 'piece', group: piece.color, color: piece.color, initialType: piece.type, initialSquare: piece.square,
      visual: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } });
  }
  objects.push({ id: 'audio:sfx', kind: 'audio', group: 'audio', visual: {} });
  const segments: Identity[] = game.moves.map(move => {
    const before = Object.fromEntries(positions), objectId = positions.get(move.from);
    check(objectId, '走子身份缺失');
    const capturedSquare = move.captured ? (move.flags.includes('e') ? move.to[0] + move.from[1] : move.to) : null;
    const capturedObjectId = capturedSquare ? positions.get(capturedSquare) : null;
    if (capturedSquare) { check(capturedObjectId, '被吃棋子身份缺失'); positions.delete(capturedSquare); }
    positions.delete(move.from); positions.set(move.to, objectId);
    const castle = move.flags.includes('k') || move.flags.includes('q');
    const rookFrom = castle ? (move.flags.includes('k') ? 'h' : 'a') + move.from[1] : null;
    const rookTo = castle ? (move.flags.includes('k') ? 'f' : 'd') + move.from[1] : null;
    const rookObjectId = rookFrom ? positions.get(rookFrom) : null;
    if (castle) { check(rookObjectId, '易位车身份缺失'); positions.delete(rookFrom!); positions.set(rookTo!, rookObjectId!); }
    return { id: `move:${move.ply}:${move.uci}`, ply: move.ply, objectId, capturedObjectId: capturedObjectId ?? null, capturedSquare, rookObjectId: rookObjectId ?? null,
      promotion: move.promotion || null, before, after: Object.fromEntries(positions) };
  });
  return { objects, segments };
}

function eventObject(event: AnimationEvent, identity: Identity, plan: Pick<AnimationPlan, "check" | "freePiece">): string {
  if (event.piece) return identity.before[event.piece.from];
  if (event.type === 'capture') return identity.capturedObjectId!;
  if (event.type === 'check') return identity.after[plan.check!];
  if (event.type === 'gift') return identity.after[plan.freePiece!.to];
  if (event.relation) return identity.after[event.type === 'hit' ? event.relation.via || event.relation.to : event.relation.from];
  return ['previous', 'result', 'winner'].includes(event.type) ? 'board' : identity.objectId;
}
function eventId(moveId: string, objectId: string, event: AnimationEvent) {
  const r = event.relation;
  return [moveId, event.type, objectId, r && `${r.kind}:${r.from}:${r.via || '-'}:${r.to}`, event.step?.square].filter(Boolean).join('/');
}
function eventDuration(event: AnimationEvent, plan: Pick<AnimationPlan, "cls" | "freePiece" | "move">) {
  return event.duration ?? event.piece?.duration ?? (({ promotion: 200, nag: plan.cls ? NAG_ENTER_MS : 0,
    'nag-exit': plan.cls || plan.freePiece && plan.freePiece.to !== plan.move.to ? NAG_EXIT_MS : 0,
    gift: 220, result: 240, winner: 240 } as Partial<Record<string, number>>)[event.type] || 0);
}

export function createProject(game: Game, { review = null, depth = 12, engineName = 'Stockfish 18', engineConfig = null, chesscom = false, output = DEFAULT_OUTPUT }: { review?: Review | null; depth?: number; engineName?: string; engineConfig?: EngineSettings | null; chesscom?: boolean; output?: Output } = {}): Project {
  const identities = gameIdentities(game), clips: Clip[] = [], moves = review?.moves || game.moves;
  const segments = identities.segments.map((identity, i) => {
    const plan = buildAnimationPlan(moves[i], { outcome: i === moves.length - 1 ? game.outcome : null });
    for (const event of plan.events) {
      const objectId = eventObject(event, identity, plan), { at, type, ...params } = event, durationMs = eventDuration(event, plan);
      clips.push({ id: eventId(identity.id, objectId, event), objectId, moveId: identity.id, kind: durationMs ? 'clip' : 'event',
        startMs: at, durationMs, effect: type as Effect, params });
    }
    const { move, events, duration, ...snapshot } = plan;
    return { ...identity, durationMs: duration, snapshot };
  });
  const project: Project = clean({ schemaVersion: PROJECT_VERSION, director, pgn: game.pgn,
    analysis: review ? { engine: engineName, depth, ...(engineConfig ? { settings: engineSettings(engineConfig) } : {}), review: { ...review, moves: review.moves.map(({ reason, ...move }) => move) } } : null, objects: identities.objects, segments, clips,
    edits: emptyEdits(), assets: [{ id: 'pieces', kind: 'pieces', source: { kind: 'builtin', id: chesscom ? 'chesscom-neo' : 'cburnett' } },
      { id: 'sound', kind: 'audio', source: { kind: 'builtin', id: chesscom ? 'chesscom' : 'synth' } }], output });
  return { ...project, clips: [...project.clips, ...initialSounds(project, moves, chesscom)] };
}

// Regeneration is scoped to this PGN. New PGNs must go through createProject().
export function regenerationLocked(project: Project, moveId?: string) {
  return trackState(project, 'segments').locked || [...project.clips, ...project.edits.pending || []].some(c => (!moveId || c.moveId === moveId)
    && (trackState(project, effectTrack(c.objectId, c.effect)).locked || Object.keys(properties).some(p => trackState(project, propertyTrack(c.objectId, p)).locked)));
}

export function regenerateProject(project: Project, { moveId, analysis = project.analysis }: { moveId?: string; analysis?: Project['analysis'] } = {}): Project {
  check(!regenerationLocked(project, moveId), '相关轨道已锁定，请先解锁再重生成');
  check(!moveId || project.segments.some(s => s.id === moveId), '重生成走法不存在');
  check(!moveId || analysis === project.analysis, '重新分析必须更新整盘棋');
  const generated = createProject(parsePgn(project.pgn), { review: analysis?.review, depth: analysis?.depth, engineName: analysis?.engine,
    engineConfig: analysis?.settings, output: project.output,
    chesscom: project.assets.some(a => a.id === 'pieces' && a.source.kind === 'builtin' && a.source.id === 'chesscom-neo') });
  const edits = structuredClone(project.edits);
  let result: Project = { ...generated, assets: project.assets, edits,
    segments: project.segments.map((s, i) => !moveId || s.id === moveId ? generated.segments[i] : s),
    clips: [...project.clips.filter(c => c.moveId === null || moveId && c.moveId !== moveId),
      ...generated.clips.filter(c => c.moveId !== null && (!moveId || c.moveId === moveId))] };
  const current = new Map(result.clips.map(c => [c.id, c]));
  const previous = new Map([...project.clips, ...edits.pending || []].map(c => [c.id, c]));
  const references = new Set([...Object.keys(edits.clips).filter(id => !id.startsWith('copy:')), ...edits.copies.map(c => c.sourceId)]);
  const pending = [...references].filter(id => {
    const clip = current.get(id), edit = edits.clips[id];
    return !clip || clip.durationMs === 0 && (edit?.durationMs !== undefined || !!edit?.motions || edits.copies.some(c => c.sourceId === id));
  }).map(id => {
    const clip = previous.get(id); check(clip, '修改来源不存在');
    const { objectId, moveId, effect, durationMs } = clip;
    return { id, objectId, moveId, effect, durationMs };
  });
  if (pending.length) edits.pending = pending; else delete edits.pending;
  validateEdits(result);
  result = syncAnalysisSounds(result);
  return result;
}

function initialSounds(project: Project, moves: Move[], chesscom: boolean): Clip[] {
  const effective = editedProject(project), map = timeMap(effective.segments);
  const land = new Map(effective.clips.filter(c => c.effect === 'land').map(c => [c.moveId, c.startMs]));
  return moves.map((move, i) => ({ id: `sound:${move.ply}`, objectId: 'audio:sfx', moveId: null, kind: 'audio', effect: 'sound',
    startMs: map.ranges[i].start + land.get(effective.segments[i].id)!,
    durationMs: chesscom ? move.captured ? 400 : 200 : 130, params: { sound: move.captured ? 'capture' : 'move' } }));
}

// Reanalysis can change segment lengths; explicit audio positions and copies stay global.
export function syncAnalysisSounds(project: Project): Project {
  const moves = project.analysis?.review.moves || parsePgn(project.pgn).moves;
  const positions = new Map(initialSounds(project, moves, false).map(clip => [clip.id, clip.startMs]));
  return { ...project, clips: project.clips.map(clip => clip.moveId === null && positions.has(clip.id) && project.edits.clips[clip.id]?.startMs === undefined && !trackState(project, effectTrack(clip.objectId, clip.effect)).locked
    ? { ...clip, startMs: positions.get(clip.id)! } : clip) };
}

export function projectSounds(project: Project): SoundCue[] {
  const cues: SoundCue[] = editedProject(project).clips.filter(c => c.effect === 'sound' && !c.hidden)
    .map(c => { const asset = configuredAsset(project, audioPieceKey(project, c), c.params.sound!);
      return { ...project.edits.audio?.[c.id], at: c.startMs, kind: c.params.sound!, durationMs: c.durationMs, ...(asset ? { assetId: asset.id } : {}), ...(trackState(project, effectTrack(c.objectId, c.effect)).muted ? { muted: true } : {}) };
    });
  const music = project.edits.music;
  if (music) cues.push({ at: music.startMs, kind: 'music', assetId: music.assetId, durationMs: music.durationMs, offsetMs: music.offsetMs, volume: music.volume, ...(music.fadeInMs !== undefined ? { fadeInMs: music.fadeInMs } : {}), ...(music.fadeOutMs !== undefined ? { fadeOutMs: music.fadeOutMs } : {}), muted: trackState(project, 'music').muted });
  return cues.sort((a, b) => a.at - b.at);
}

export function projectTimeMap(project: Project, speed = 1) {
  const camera = resolveCamera(project).camera;
  return timeMap(editedProject(project).segments, speed, Math.max(0, ...project.edits.overlays?.map(o => o.startMs + o.durationMs) || [], ...projectSounds(project).map(c => c.at + c.durationMs), ...camera?.keys.map(k => k.time) || [], ...camera?.shakes.map(s => s.startMs + s.durationMs) || []));
}

// Paths are portable project-relative references, never OS paths or remote URLs.
export function assetUrl(asset: Asset, projectUrl: string | URL): string | null {
  if (asset.source.kind === 'builtin') return ({ cburnett: 'vendor/pieces/cburnett/', 'chesscom-neo': 'assets/chesscom/pieces/', chesscom: 'assets/chesscom/sounds/', synth: null } as Record<string, string | null>)[asset.source.id];
  if (asset.source.kind === 'embedded') { validateEmbeddedAsset(asset); return asset.source.data; }
  const path = asset.source.path;
  check(typeof path === 'string' && path.length <= 1024 && path.split('/').every(part => part && part !== '.' && part !== '..') && !/[:\\%?#\x00-\x1f]/.test(path), '素材路径必须为工程内的相对路径');
  return new URL(path, projectUrl).href;
}

function validateAnalysis(analysis: Project["analysis"], game: Game) {
  if (analysis === null) return;
  fields(analysis, ['engine', 'depth', 'review'], ['settings']);
  check(typeof analysis.engine === 'string' && analysis.engine.length > 0 && analysis.engine.length <= 200 && Number.isInteger(analysis.depth) && number(analysis.depth, 0, 128), '不支持的分析参数');
  if (analysis.settings) {
    fields(analysis.settings, ['threads', 'hash', 'depth', 'movetime', 'multipv']);
    engineSettings(analysis.settings);
    check(analysis.depth === analysis.settings.depth, '分析深度不一致');
  } else check(analysis.depth > 0, '分析缺少搜索限制');
  const review = analysis.review;
  fields(review, ['moves', 'accWhite', 'accBlack', 'phases', 'est', 'counts', 'opening'], ['scoreModel']);
  check(review.scoreModel === undefined || review.scoreModel === EXPECTED_SCORE_MODEL, '不支持的评分模型');
  check(Array.isArray(review.moves) && review.moves.length === game.moves.length, '分析走法数量不匹配');
  check([review.accWhite, review.accBlack].every(n => n === null || number(n, 0, 100)), '准确率无效');
  check(review.opening === null || Array.isArray(review.opening) && review.opening.every(v => typeof v === 'string'), '开局说明无效');
  fields(review.phases, ['opening', 'middlegame', 'endgame']); fields(review.counts, ['w', 'b']); fields(review.est, ['w', 'b']);
  for (const side of ['w', 'b'] as const) {
    fields(review.counts[side], CLASS_ORDER);
    check(Object.values(review.counts[side]).every(n => Number.isInteger(n) && number(n, 0, game.moves.length)), '分类计数无效');
    if (review.est[side] !== null) { fields(review.est[side], ['elo', 'lo', 'hi']); check(Object.values(review.est[side]).every(n => number(n, 250, 3200)), '棋力估计无效'); }
    for (const phase of Object.values(review.phases)) {
      fields(phase, ['w', 'b']);
      if (phase[side] !== null) { fields(phase[side], ['acc', 'n']); check(number(phase[side].acc, 0, 100) && Number.isInteger(phase[side].n) && number(phase[side].n, 1, game.moves.length), '阶段准确率无效'); }
    }
  }
  for (const [i, move] of review.moves.entries()) {
    const facts = game.moves[i];
    const expectedFields = ['bestMove', 'expectedScoreBest', 'expectedScorePlayed', 'expectedPointsLoss', 'moveAccuracy'];
    if (review.scoreModel === EXPECTED_SCORE_MODEL) check([...expectedFields, 'playedCpWhite', 'playedMateWhite'].every(key => Object.hasOwn(move, key)), '缺少平滑评分分析数据');
    fields(move, [...Object.keys(clean(facts)).filter(k => k !== 'cls'), 'cls', 'phase', 'cpWhite', 'mateWhite', 'bestSan', 'bestFrom', 'bestTo', 'bestPromo', 'bestCpWhite', 'bestMateWhite', 'bestLine', 'showBetter', 'motif', 'afterLine', 'sacPiece', 'sacGiven', 'onlyGap', 'opening'], ['playedCpWhite', 'playedMateWhite', 'cpLoss', 'loss', ...expectedFields]);
    if (expectedFields.some(key => Object.hasOwn(move, key))) {
      check(expectedFields.every(key => Object.hasOwn(move, key)), '缺少期望得分分析数据');
      check(move.bestMove === null || typeof move.bestMove === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.bestMove), '最佳着无效');
      check(['expectedScoreBest', 'expectedScorePlayed', 'expectedPointsLoss'].every(key => number(move[key as keyof AnalyzedMove], 0, 1)) && number(move.moveAccuracy, 0, 100), '期望得分或着法准确率无效');
      check(Math.abs(move.expectedPointsLoss - Math.max(0, move.expectedScoreBest - move.expectedScorePlayed)) < 1e-12 && Math.abs(move.moveAccuracy - moveAccuracy(move.expectedPointsLoss)) < 1e-9, '期望得分损失与准确率不一致');
      check(move.cls !== 'best' || move.bestMove === move.uci && move.expectedPointsLoss === 0, '最佳着必须为零损失的引擎首选');
      if (review.scoreModel === EXPECTED_SCORE_MODEL) {
        check(Math.abs(move.expectedScoreBest - expectedScore({ cp: move.bestCpWhite, mate: move.bestMateWhite }, move.color)) < 1e-12 && Math.abs(move.expectedScorePlayed - expectedScore({ cp: move.playedCpWhite, mate: move.playedMateWhite }, move.color)) < 1e-12, '期望得分与平滑评分模型不一致');
      }
    } else check(number(move.loss, 0, 100), '缺少分析损失'); // Existing projects retain their original snapshots.
    for (const [key, value] of Object.entries(clean(facts))) if (key !== 'cls') check(same(move[key as keyof AnalyzedMove], value), '分析不能改写棋谱事实');
    check(CLASS_ORDER.includes(move.cls), '未知着法分类');
    check(move.showBetter === undefined || typeof move.showBetter === 'boolean', '最佳着标记无效');
    for (const key of ['phase', 'bestSan', 'bestPromo', 'sacPiece', 'opening']) check(move[key as keyof AnalyzedMove] == null || typeof move[key as keyof AnalyzedMove] === 'string', '分析文字无效');
    for (const key of ['cpWhite', 'mateWhite', 'loss', 'bestCpWhite', 'bestMateWhite', 'sacGiven', 'onlyGap', 'playedCpWhite', 'playedMateWhite', 'cpLoss']) check(move[key as keyof AnalyzedMove] == null || number(move[key as keyof AnalyzedMove], -1e9, 1e9), '分析数值无效');
    for (const key of ['bestFrom', 'bestTo']) check(move[key as keyof AnalyzedMove] == null || square(move[key as keyof AnalyzedMove]), '最佳着坐标无效');
    for (const key of ['bestLine', 'afterLine'] as const) check(move[key as keyof AnalyzedMove] == null || Array.isArray(move[key as keyof AnalyzedMove]) && move[key]!.every(v => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(v)), '引擎变化无效');
    if (move.motif != null) { fields(move.motif, ['kind', 'text']); check(typeof move.motif.kind === 'string' && typeof move.motif.text === 'string', '战术说明无效'); }
  }
}

function validateRelation(r: Relation) {
  fields(r, ['kind', 'from', 'to', 'piece', 'value'], ['via']);
  check(['attack', 'defense', 'pin', 'skewer'].includes(r.kind) && square(r.from) && square(r.to) && (r.via === undefined || square(r.via)) && /^[pnbrqk]$/.test(r.piece) && number(r.value, 0, 101), '关系快照无效');
}
function validateStep(step: RelationStep) {
  fields(step, ['square', 'tone', 'attacked']);
  check(square(step.square) && ['attack-path', 'defense-path', 'xray-path'].includes(step.tone) && typeof step.attacked === 'boolean', '路径快照无效');
}
const effects: Record<Effect, string[]> = {
  previous: [], target: [], move: ['piece'], land: [], capture: ['duration'], promotion: [], settle: [], relation: ['relation'],
  'relation-square': ['relation', 'step', 'duration'], 'relation-exit': ['step', 'duration'], check: ['duration'], hit: ['relation', 'duration'],
  gift: [], nag: [], result: [], winner: [], 'nag-exit': [],
};

function migrateV1(project: Project) {
  check(same(project.director, { id: 'classic', version: 1 }), '不支持的导演预设版本');
  check(Array.isArray(project.segments) && Array.isArray(project.clips), '分段或片段无效');
  if (project.analysis !== null) {
    check(Array.isArray(project.analysis?.review?.moves), '分析走法无效');
    for (const move of project.analysis.review.moves) delete move.reason;
  }
  for (const segment of project.segments) {
    const outcome = segment.snapshot?.outcome;
    if (outcome) {
      fields(outcome, ['result', 'winner'], ['type', 'icon', 'label', 'detail', 'provisional']);
      segment.snapshot.outcome = { result: outcome.result, winner: outcome.winner };
    }
  }
  // Keep saved move timings, including the old ending's tail; only the removed
  // repetition-specific transition and its display metadata are discarded.
  project.clips = project.clips.filter(c => String(c.effect) !== 'draw');
  for (const clip of project.clips) if (clip.effect === 'result') clip.durationMs = 240;
  project.schemaVersion = PROJECT_VERSION; project.director = { ...director };
}

export function parseProject(text: string): Project {
  check(typeof text === 'string' && new TextEncoder().encode(text).length <= MAX_PROJECT_BYTES, '文件超过 64 MB');
  let project!: Project;
  try { project = JSON.parse(text) as Project; } catch { fail('不是有效 JSON'); }
  check([1, 2, 3, PROJECT_VERSION].includes(project?.schemaVersion), `不支持工程版本 ${project?.schemaVersion ?? '未知'}，请使用兼容版本的 PlyMotion`);
  safeJson(project);
  fields(project, ['schemaVersion', 'director', 'pgn', 'analysis', 'objects', 'segments', 'clips', 'assets', 'output'], ['edits']);
  const version = project.schemaVersion;
  if (version === 1) migrateV1(project);
  project.schemaVersion = PROJECT_VERSION; project.edits ??= emptyEdits();
  check(validDirector(project.director), '不支持的导演预设版本');
  const game = parsePgn(project.pgn), identities = gameIdentities(game);
  check(Array.isArray(project.objects), '对象列表无效');
  if (version < 4 && !project.objects.some(o => o.id === 'audio:sfx')) {
    project.objects.push(identities.objects.find(o => o.id === 'audio:sfx')!);
  }
  validateAnalysis(project.analysis, game);
  check(same(project.objects, identities.objects), '对象身份或基础视觉属性不匹配');
  fields(project.output, Object.keys(DEFAULT_OUTPUT).filter(key => !key.startsWith('show')), ['showNames', 'showMove', 'showEvaluation']);
  project.output = { ...DEFAULT_OUTPUT, ...project.output };
  check(typeof project.output.flip === 'boolean' && typeof project.output.sound === 'boolean' && same(videoSettings(project.output), Object.fromEntries(Object.entries(project.output).filter(([k]) => k !== 'flip'))), '输出参数无效');
  check(Array.isArray(project.assets) && project.assets.length >= 2 && project.assets.length <= 1000, '素材列表无效');
  const allIds = new Set();
  const unique = (id: string) => { check(typeof id === 'string' && id.length <= 512 && !allIds.has(id), 'ID 缺失或重复'); allIds.add(id); };
  project.objects.forEach(o => unique(o.id));
  for (const asset of project.assets) {
    fields(asset, ['id', 'kind', 'source']); unique(asset.id);
    check(['pieces', 'audio', 'image', 'font'].includes(asset.kind), '素材类型无效');
    if (asset.source?.kind === 'builtin') {
      fields(asset.source, ['kind', 'id']); check(['cburnett', 'chesscom-neo', 'chesscom', 'synth'].includes(asset.source.id), '未知内置素材');
    } else if (asset.source?.kind === 'embedded') validateEmbeddedAsset(asset);
    else { fields(asset.source, ['kind', 'path']); check(asset.source.kind === 'relative', '未知素材来源'); assetUrl(asset, 'file:///project/example.plymotion'); }
  }
  const pieces = project.assets.find(a => a.id === 'pieces'), sound = project.assets.find(a => a.id === 'sound');
  check(pieces?.kind === 'pieces' && pieces.source.kind === 'builtin' && ['cburnett', 'chesscom-neo'].includes(pieces.source.id), '当前版本需要内置棋子');
  check(sound?.kind === 'audio' && sound.source.kind === 'builtin' && sound.source.id === (pieces.source.id === 'chesscom-neo' ? 'chesscom' : 'synth'), '音效素材引用不匹配');
  check(Array.isArray(project.segments) && project.segments.length === game.moves.length && Array.isArray(project.clips) && project.clips.length <= 200000, '分段或片段数量无效');
  const segmentMap = new Map<string, { segment: Segment; clips: Clip[] }>(), objectIds = new Set(project.objects.map(o => o.id));
  for (const [i, segment] of project.segments.entries()) {
    fields(segment, [...Object.keys(identities.segments[i]), 'durationMs', 'snapshot']); unique(segment.id);
    for (const [key, value] of Object.entries(identities.segments[i])) check(same(segment[key as keyof Segment], value), '走法身份或引用不匹配');
    check(number(segment.durationMs, 1), '分段时长无效');
    const s = segment.snapshot;
    fields(s, ['cls', 'pieces', 'capturedSquare', 'relations', 'fork', 'freePiece', 'check', 'mate', 'nagAt', 'outcome'], ['director']);
    if (s.director !== undefined) check(validDirector(s.director), '不支持的分段导演预设');
    check((s.cls === null || CLASS_ORDER.includes(s.cls)) && typeof s.fork === 'boolean' && typeof s.mate === 'boolean' && (s.check === null || square(s.check)) && number(s.nagAt, 0, segment.durationMs), '动画快照无效');
    check(s.cls === moveClass(project.analysis?.review.moves[i] || game.moves[i]), '动画分类与分析快照不匹配');
    check(s.capturedSquare === segment.capturedSquare && same(s.outcome, i === game.moves.length - 1 ? game.outcome : null), '终局或吃子快照不匹配');
    const move = game.moves[i], before = new Chess(move.fenBefore), after = new Chess(move.fenAfter);
    check(s.check === (after.isCheck() ? after.board().flat().find(p => p?.type === 'k' && p.color !== move.color)?.square : null) && s.mate === after.isCheckmate(), '将军快照不匹配');
    check(Array.isArray(s.pieces) && s.pieces.length === (segment.rookObjectId ? 2 : 1), '走子快照数量无效');
    for (const p of s.pieces) {
      fields(p, ['from', 'to', 'type', 'color', 'start', 'duration']);
      const id = segment.before[p.from];
      check(id && [segment.objectId, segment.rookObjectId].includes(id) && segment.after[p.to] === id && before.get(p.from as import("./types.ts").Square)?.type === p.type && p.color === move.color && number(p.start, 0, segment.durationMs) && number(p.duration, 1, segment.durationMs - p.start), '走子快照或时长无效');
    }
    check(new Set(s.pieces.map(p => p.from)).size === s.pieces.length, '重复走子快照');
    check(Array.isArray(s.relations) && s.relations.length <= 128, '关系数量无效'); s.relations.forEach(validateRelation);
    if (s.freePiece !== null) { fields(s.freePiece, ['from', 'to', 'gain', 'piece']); check(square(s.freePiece.from) && square(s.freePiece.to) && segment.after[s.freePiece.to] && number(s.freePiece.gain, 0, 100) && /^[pnbrqk]$/.test(s.freePiece.piece), '弃子快照无效'); }
    segmentMap.set(segment.id, { segment, clips: [] });
  }
  for (const clip of project.clips) {
    fields(clip, ['id', 'objectId', 'moveId', 'kind', 'startMs', 'durationMs', 'effect', 'params']); unique(clip.id);
    if (clip.moveId === null) {
      fields(clip.params, ['sound']);
      check(clip.effect === 'sound' && clip.kind === 'audio' && clip.objectId === 'audio:sfx' && /^sound:[\w-]{1,80}$/.test(clip.id) && ['move', 'capture'].includes(clip.params.sound!) && number(clip.startMs, 0, clipTimeLimit(clip)) && number(clip.durationMs, 1, Math.min(60000, clipTimeLimit(clip) - clip.startMs)), '音效片段无效');
      continue;
    }
    const entry = segmentMap.get(clip.moveId);
    check(entry && objectIds.has(clip.objectId), '片段引用不存在');
    const { segment } = entry, s = segment.snapshot;
    check(Object.hasOwn(effects, clip.effect), '未知动画效果');
    fields(clip.params, effects[clip.effect as Effect], clip.effect === 'relation-exit' ? ['relation'] : clip.effect === 'check' ? ['step', 'enterDuration'] : clip.effect === 'land' ? ['duration'] : []);
    check(number(clip.startMs, 0, segment.durationMs) && number(clip.durationMs, 0, segment.durationMs - clip.startMs) && clip.kind === (clip.durationMs ? 'clip' : 'event'), '片段时长或类型无效');
    const event = { at: clip.startMs, type: clip.effect as Effect, ...clip.params };
    check(clip.objectId === eventObject(event, segment, s) && clip.id === eventId(segment.id, clip.objectId, event), '片段身份不匹配');
    if (event.relation) { validateRelation(event.relation); check(s.relations.some(r => same(r, event.relation)), '片段关系引用不存在'); }
    if (event.step) validateStep(event.step);
    if (event.duration !== undefined) check(event.duration === clip.durationMs, '效果时长不匹配');
    if (event.enterDuration !== undefined) check(event.step && number(event.enterDuration, 1, clip.durationMs), '路径进入时长无效');
    if (event.piece) check(s.pieces.some(p => same(p, event.piece)) && event.piece.start === clip.startMs && event.piece.duration === clip.durationMs, '走子片段不匹配');
    check(clip.durationMs === eventDuration(event, { ...s, move: game.moves[segment.ply - 1] }), '当前预设不支持此效果时长');
    entry.clips.push(clip);
  }
  for (const { segment, clips } of segmentMap.values()) {
    for (const effect of ['previous', 'target', 'land', 'settle', 'nag', 'nag-exit']) check(clips.filter(c => c.effect === effect).length === 1, '必要事件缺失');
    check(clips.filter(c => c.effect === 'move').length === segment.snapshot.pieces.length, '走子事件缺失');
    for (const [effect, present] of [['capture', segment.capturedObjectId], ['promotion', segment.promotion], ['check', segment.snapshot.check], ['result', segment.snapshot.outcome]]) check(clips.filter(c => c.effect === effect).length === (present ? 1 : 0), '棋规事件缺失或重复');
    check(clips.filter(c => c.effect === 'winner').length === (segment.snapshot.outcome?.winner ? 1 : 0), '终局事件不匹配');
    const land = clips.find(c => c.effect === 'land')!.startMs, settle = clips.find(c => c.effect === 'settle')!.startMs;
    check(land === Math.max(...segment.snapshot.pieces.map(p => p.start + p.duration)) && settle >= land, '走子落定时序无效');
    check(clips.find(c => c.effect === 'nag')!.startMs === segment.snapshot.nagAt, '评价时序不匹配');
    for (const clip of clips.filter(c => c.effect === 'relation-exit')) check(clips.some(c => ['relation-square', 'check'].includes(c.effect) && same(c.params.step, clip.params.step) && same(c.params.relation, clip.params.relation) && c.startMs <= clip.startMs), '路径退出没有对应的进入事件');
  }
  validateEdits(project);
  if (project.director.id !== 'classic' || project.director.intensity !== undefined || project.segments.some(s => s.snapshot.director)) {
    // Retired presets reopen with the original choreography, keeping user edits.
    const { trackStates, ...edits } = project.edits;
    const restored = regenerateProject({ ...project, edits });
    if (trackStates) restored.edits = { ...restored.edits, trackStates };
    const lockedSounds = new Map(project.clips.filter(c => c.effect === 'sound' && trackState(project, effectTrack(c.objectId, c.effect)).locked).map(c => [c.id, c]));
    restored.clips = restored.clips.map(c => lockedSounds.get(c.id) || c);
    return restored;
  }
  if (version < 4 && !project.clips.some(c => c.effect === 'sound')) {
    // Freeze legacy sound positions from their edited landing times once, on migration.
    return { ...project, clips: [...project.clips, ...initialSounds(project, game.moves, pieces.source.id === 'chesscom-neo')] };
  }
  return project;
}

export function serializeProject(project: Project) {
  return JSON.stringify(parseProject(JSON.stringify(project))) + '\n';
}

const planCache = new WeakMap<Project, AnimationPlan[]>();
let cachedPgn: string | undefined, cachedGame: Game;
export function projectPlans(project: Project): AnimationPlan[] {
  if (!planCache.has(project)) {
    const effective = editedProject(project);
    if (cachedPgn !== project.pgn) { cachedPgn = project.pgn; cachedGame = parsePgn(project.pgn); }
    const game = cachedGame, moves = project.analysis?.review.moves || game.moves;
    const events = new Map<string, AnimationEvent[]>(effective.segments.map(s => [s.id, []]));
    for (const clip of effective.clips) if (clip.moveId !== null) events.get(clip.moveId)!.push({ at: clip.startMs, type: clip.effect as Effect, clipId: clip.id, motions: clip.motions, objectId: clip.objectId, ...clip.params,
      ...(project.edits?.clips[clip.id] || clip.copied ? { editorDuration: clip.durationMs, easing: clip.easing, hidden: clip.hidden, copied: clip.copied } : {}),
      ...(!['move', 'capture', 'promotion', 'land', 'settle'].includes(clip.effect) && trackState(project, effectTrack(clip.objectId, clip.effect)).hidden ? { hidden: true } : {}) });
    planCache.set(project, effective.segments.map((segment, i) => {
      const steps = new Map<string, RelationStep>();
      const sequence = events.get(segment.id)!.sort((a, b) => a.at - b.at).map(event => {
        if (!event.step) return event;
        if (event.copied) return { ...event, step: { ...event.step } };
        // JSON cannot retain shared object references used by the WAAPI renderer.
        const r = event.relation, key = `${r ? `${r.kind}:${r.from}:${r.via || '-'}:${r.to}` : 'check'}:${event.step.square}`;
        if (!steps.has(key)) steps.set(key, event.step);
        return { ...event, step: steps.get(key)! };
      });
      return { ...segment.snapshot, move: moves[i], events: sequence, duration: segment.durationMs, ...(segment.startMs !== undefined ? { startMs: segment.startMs } : {}) };
    }));
  }
  return planCache.get(project)!
}
