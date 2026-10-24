import type { Game, Move, AnalyzedMove, Review, Project, Edits, Keyframe, AnimationPlan, Scene, ClassId, Outcome, Output } from './lib/types.ts';
import type { Engine } from './lib/engine.ts';
import { parsePgn, SAMPLE_PGN, outcomeLabel, outcomeMarkers } from './lib/game.ts';
import { readyEngine, stopEngine, engineSnapshot, subscribeEngine, currentEngineProfile, setEngineAnalyzing, setEngineDepth } from './lib/engine-manager.ts';
import { reviewGame, CLASSES, CLASS_INFO, winPct, formatEval, moveClass, EXPECTED_SCORE_MODEL } from './lib/review.ts';
import { renderBoard } from './lib/board.ts';
import { glyphSvg, statusGlyph } from './lib/glyphs.ts';
import { materialIcon } from './lib/material-icons.ts';
import { createSequenceScene } from './lib/animation.ts';
import { timeMap, locateTime, adjacentFrame, createPlayback } from './lib/playback.ts';
import { exportVideo, videoSettings, videoSchedule } from './lib/video.ts';
import { createVideoPreview } from './editor/video-preview.ts';
import { updateCameraFrame } from './editor/camera-frame.ts';
import { createProject, parseProject, serializeProject, projectPlans, projectSounds, projectTimeMap, regenerateProject, MAX_PROJECT_BYTES } from './lib/project.ts';
import { soundWaveforms, soundBuffers, scheduleSounds } from './lib/audio.ts';
import { editedProject, emptyEdits, validateEdits, validateTrackChanges, applyVisuals, createHistory, removable, copyable, properties, sampleTrack, trackState, effectTrack } from './lib/editing.ts';
import { objectProperties, type PropertySource } from './lib/object-properties.ts';
import { validateMcpArguments } from './lib/mcp.ts';

type AppElements = {
  openImport: HTMLButtonElement;
  eventName: HTMLElement;
  board: HTMLElement;
  flip: HTMLButtonElement;
  first: HTMLButtonElement;
  prev: HTMLButtonElement;
  framePrev: HTMLButtonElement;
  play: HTMLButtonElement;
  frameNext: HTMLButtonElement;
  next: HTMLButtonElement;
  last: HTMLButtonElement;
  replayMove: HTMLButtonElement;
  gameResult: HTMLElement;
  topPlayer: HTMLElement;
  topSide: HTMLElement;
  topAccuracy: HTMLElement;
  bottomPlayer: HTMLElement;
  bottomSide: HTMLElement;
  bottomAccuracy: HTMLElement;
  evalFill: HTMLElement;
  evalText: HTMLElement;
  positionCount: HTMLElement;
  reviewStats: HTMLElement;
  reviewStatsBody: HTMLElement;
  depth: HTMLSelectElement;
  analyze: HTMLButtonElement;
  engineStatus: HTMLElement;
  progressText: HTMLElement;
  progress: HTMLProgressElement;
  moves: HTMLElement;
  opening: HTMLElement;
  nagSource: HTMLElement;
  message: HTMLElement;
  importDialog: HTMLDialogElement;
  importForm: HTMLFormElement;
  closeImport: HTMLButtonElement;
  pgn: HTMLTextAreaElement;
  importError: HTMLElement;
  fileButton: HTMLButtonElement;
  sampleButton: HTMLButtonElement;
  pgnFile: HTMLInputElement;
  projectFile: HTMLInputElement;
  unsavedDialog: HTMLDialogElement;
  videoDialog: HTMLDialogElement;
  videoForm: HTMLFormElement;
  closeVideo: HTMLButtonElement;
  videoFields: HTMLFieldSetElement;
  videoPreview: HTMLElement;
  videoPreset: HTMLSelectElement;
  videoWidth: HTMLInputElement;
  videoHeight: HTMLInputElement;
  videoFps: HTMLSelectElement;
  videoCrf: HTMLInputElement;
  videoBitrate: HTMLInputElement;
  videoSound: HTMLInputElement;
  videoShowNames: HTMLInputElement;
  videoShowMove: HTMLInputElement;
  videoShowEvaluation: HTMLInputElement;
  videoEstimate: HTMLElement;
  videoProgress: HTMLProgressElement;
  videoMetrics: HTMLElement;
  videoSpeed: HTMLElement;
  videoEta: HTMLElement;
  videoStatus: HTMLElement;
  cancelVideo: HTMLButtonElement;
  startVideo: HTMLButtonElement;
};
let detachedRoots: HTMLElement[] = [];
function $<K extends keyof AppElements>(id: K): AppElements[K];
function $<T extends HTMLElement = HTMLElement>(id: string): T;
function $(id: string): HTMLElement {
  const element = document.getElementById(id) || detachedRoots.map(root => root.querySelector<HTMLElement>(`[id="${id}"]`)).find(Boolean);
  if (!element) throw new Error(`缺少界面元素：${id}`);
  return element;
}
type AnalysisJob = { engine: Engine | null; signal: { cancelled: boolean }; done: Promise<void>; game: Game };
type AppState = { game: Game; project: Project; review: Review | null; ply: number; flip: boolean; sound: boolean; playing: boolean; motion: { index: number; scene: Scene } | null; job: AnalysisJob | null; chesscom: boolean; dirty: boolean; projectPath: string | null; projectName: string; fileBusy: boolean; timeMs: number; selectedObjectId: string | null; selectedClipId: string | null; selectedClipIds: string[]; selectedBeatTimes: number[]; selectedProperty: string | null; selectedKeyTime: number | null; autoKey: boolean; follow: boolean };
const initialGame = parsePgn(SAMPLE_PGN);
const state: AppState = { game: initialGame, review: null, ply: 0, flip: false, sound: true, playing: false, motion: null, job: null, chesscom: false,
  project: createProject(initialGame), dirty: false, projectPath: null, projectName: '未命名工程', fileBusy: false, timeMs: 0, selectedObjectId: null, selectedClipId: null, selectedClipIds: [], selectedBeatTimes: [], selectedProperty: null, selectedKeyTime: null, autoKey: false, follow: true };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let toastTimer: ReturnType<typeof setTimeout> | undefined, audioContext: AudioContext | undefined, videoJob: AbortController | null = null, playback: ReturnType<typeof createPlayback>, map = timeMap([]), plans: AnimationPlan[] = [], staticKey: string | null = null;
let videoPreview: ReturnType<typeof createVideoPreview> | undefined;
let evalFrame = 0, displayedCp: number | null = null, evalTarget: string | null = null;
let soundEpoch = 0, pendingPlay = false;
let playbackNow = () => performance.now();
const history = createHistory();
let editBase: Project | null = null, editDirty = false, savedProject: Project | null = null;
const sounding = new Set<AudioScheduledSourceNode>();
let buffers: Awaited<ReturnType<typeof soundWaveforms>> = {};
const rows = (): (Move & Partial<AnalyzedMove>)[] => state.review?.moves || state.game.moves;
const current = () => rows()[state.ply - 1];
const editorListeners = new Set<(snapshot: ReturnType<typeof editorSnapshot>) => void>();
let selectedPropertySource: PropertySource = null;
export const getCurrentProject = () => state.project;
let mcpProject = state.project, mcpRevision = 0;
function currentMcpRevision() {
  if (mcpProject !== state.project) { mcpProject = state.project; mcpRevision++; }
  return mcpRevision;
}
export const editorSnapshot = () => ({ moves: state.game ? rows() : [], move: state.game ? current() : null,
  propertyTarget: objectProperties(state.project, state.selectedObjectId, selectedPropertySource, state.selectedClipId, state.timeMs, state.selectedKeyTime),
  ply: state.ply, flip: state.flip, chesscom: state.chesscom, game: state.game, project: state.project && editedProject(state.project),
  plan: state.project && state.ply ? projectPlans(state.project)[state.ply - 1] : null,
  timeMs: state.timeMs, durationMs: map.duration, playing: !!state.playing, selectedObjectId: state.selectedObjectId, selectedClipId: state.selectedClipId, follow: state.follow,
  selectedClipIds: state.selectedClipIds, selectedBeatTimes: state.selectedBeatTimes, selectedProperty: state.selectedProperty, selectedKeyTime: state.selectedKeyTime, autoKey: state.autoKey, canUndo: history.canUndo, canRedo: history.canRedo, editing: !!editBase,
  dirty: state.dirty, projectName: state.projectName, fileBusy: state.fileBusy });
export function subscribeEditor(listener: (snapshot: ReturnType<typeof editorSnapshot>) => void) { editorListeners.add(listener); return () => editorListeners.delete(listener); }
function notifyEditor() { currentMcpRevision(); for (const listener of editorListeners) listener(editorSnapshot()); }
function updateProject(project: Project) { history.push(state.project, project); state.project = project; state.dirty = true; notifyEditor(); }
export function beginEdit() { if (!editBase) { stopPlaying(); editBase = state.project; editDirty = state.dirty; notifyEditor(); } }
export function finishEdit(cancel = false) {
  if (!editBase) return;
  const before = editBase; editBase = null;
  if (cancel) { state.project = before; state.dirty = editDirty; rebuildPreview(); }
  else if (JSON.stringify(before.edits) !== JSON.stringify(state.project.edits)) { history.push(before, state.project); state.dirty = true; }
  else { state.project = before; state.dirty = editDirty; }
  notifyEditor();
}
function rebuildPreview() {
  const beats = new Set(state.project.edits.beats);
  state.selectedBeatTimes = state.selectedBeatTimes.filter(time => beats.has(time));
  const time = state.timeMs; configurePlayback(); playback.seek(time); samplePosition(state.timeMs, true);
}
export function editProject(change: (edits: Edits) => void, fromStart = false) {
  const own = !editBase; if (own) beginEdit();
  const source = fromStart ? editBase : state.project;
  try {
    const edits = structuredClone(source!.edits || emptyEdits()); change(edits);
    const project: Project = { ...source!, edits };
    validateEdits(project); validateTrackChanges(source!, project); state.project = project; state.dirty = true; rebuildPreview(); if (own) finishEdit();
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); if (own) finishEdit(true); message(error.message); return error.message; }
}
export function regenerateAnimation(moveId?: string) {
  finishEdit(); stopPlaying();
  try {
    const project = regenerateProject(state.project, { moveId });
    updateProject(project); rebuildPreview();
    const pending = project.edits.pending?.length || 0;
    message(pending ? `重生成完成，${pending} 项修改暂未匹配；已保留在镜头与卡点面板的旧动画修改列表。` : '重生成完成，手动修改已保留。');
  } catch (error) { message(error instanceof Error ? error.message : String(error)); }
}

export function addBeatAtPlayhead() {
  if (state.fileBusy || editBase) return;
  const time = state.timeMs, beats = state.project.edits.beats || [];
  if (beats.some(t => Math.abs(t - time) < .0001)) return;
  const project = { ...state.project, edits: { ...state.project.edits, beats: [...beats, time].sort((a, b) => a - b) } };
  try {
    validateEdits(project); validateTrackChanges(state.project, project);
    // Marking a beat does not change animation timing or restart playing audio.
    updateProject(project);
  } catch (error) { const text = error instanceof Error ? error.message : String(error); message(text); return text; }
}

export function clearBeats() {
  if (trackState(state.project, 'beats').locked || !state.project.edits.beats?.length) return;
  return editProject(edits => { edits.beats = []; });
}

export function clearDirectorOverride(kind: 'clips' | 'objects' | 'segments' | 'copies' | 'pending', id: string) {
  editProject(edits => {
    if (kind === 'pending') {
      delete edits.clips[id];
      for (const copy of edits.copies.filter(c => c.sourceId === id)) delete edits.clips[copy.id];
      edits.copies = edits.copies.filter(c => c.sourceId !== id);
    } else if (kind === 'copies') {
      edits.copies = edits.copies.filter(c => c.id !== id); delete edits.clips[id];
    } else delete edits[kind][id];
    if (kind === 'clips' && edits.audio) delete edits.audio[id];
    if (edits.audio) for (const key of Object.keys(edits.audio)) if (key.startsWith('copy:') && !edits.copies.some(c => c.id === key)) delete edits.audio[key];
    if (edits.pending) {
      edits.pending = edits.pending.filter(c => edits.clips[c.id] || edits.copies.some(copy => copy.sourceId === c.id));
      if (!edits.pending.length) delete edits.pending;
    }
  });
}
export function undoEdit(redo = false) {
  if (editBase) { finishEdit(true); return; }
  const project = redo ? history.redo(state.project) : history.undo(state.project);
  if (project === state.project) return;
  state.project = project; state.dirty = !savedProject || (Object.keys(project) as (keyof Project)[]).some(k => k === 'edits' ? JSON.stringify(project.edits) !== JSON.stringify(savedProject!.edits) : project[k] !== savedProject![k]);
  state.review = project.analysis?.review || null; state.flip = project.output.flip;
  syncOutput(); renderMoves();
  if (state.review) renderReviewStatus();
  else { $('engineStatus').textContent = `${currentEngineProfile().name} · 就绪`; $('analyze').textContent = '开始分析'; $('progressText').textContent = '等待分析'; $('progress').value = 0; }
  rebuildPreview(); notifyEditor();
}
export function setAutoKey(value: boolean) { state.autoKey = value; state.selectedKeyTime = null; notifyEditor(); }
export function selectKey(property: string, time: number | null) {
  state.selectedBeatTimes = [];
  state.selectedProperty = ['x', 'y'].includes(property) ? 'position' : property; state.selectedKeyTime = time;
  if (selectedPropertySource === 'moves' && time !== null) {
    const target = objectProperties(state.project, state.selectedObjectId, 'moves', null, time, time);
    if (target?.clip) { state.selectedClipId = target.clip.id; state.selectedClipIds = [target.clip.id]; }
  }
  notifyEditor();
}
export function editVisual(id: string, property: string, value: number) {
  const p = properties[property]; if (!p || !Number.isFinite(value)) return;
  value = Math.max(p.min, Math.min(p.max, value));
  const position = ['x', 'y'].includes(property), selection = position ? 'position' : property;
  const selected = state.selectedProperty === property || state.selectedProperty === selection;
  editProject(edits => {
    const o = edits.objects[id] ||= { visual: {}, tracks: {} };
    if (selected && state.selectedKeyTime !== null || state.autoKey) {
      const time = !state.autoKey && selected && state.selectedKeyTime !== null ? state.selectedKeyTime : Math.round(state.timeMs * state.project.output.fps / 1000) * 1000 / state.project.output.fps;
      if (position) for (const axis of ['x', 'y']) {
        const frames = (o.tracks ||= {})[axis] ||= [];
        if (!frames.some(k => Math.abs(k.time - time) < .0001)) frames.push({ time, value: sampleTrack(frames, time, o.visual?.[axis] ?? editedProject(state.project).objects.find(object => object.id === id)!.visual[axis]), easing: 'linear' });
        frames.sort((a, b) => a.time - b.time);
      }
      const frames = (o.tracks ||= {})[property] ||= [], existing = frames.find(k => Math.abs(k.time - time) < .0001);
      if (existing) existing.value = value; else frames.push({ time, value, easing: 'linear' });
      frames.sort((a, b) => a.time - b.time); state.selectedProperty = selection; state.selectedKeyTime = time;
    } else (o.visual ||= {})[property] = value;
  });
}
export function deleteTimelineSelection() {
  const clips = editedProject(state.project).clips.filter(c => state.selectedClipIds.includes(c.id) && !c.hidden &&
    !trackState(state.project, effectTrack(c.objectId, c.effect)).locked && (removable(c.effect) || c.copied));
  const beats = new Set(trackState(state.project, 'beats').locked ? [] : state.selectedBeatTimes);
  if (!clips.length && !beats.size) return;
  return editProject(edits => {
    for (const clip of clips) edits.clips[clip.id] = { ...edits.clips[clip.id], hidden: true };
    if (beats.size) edits.beats = (edits.beats || []).filter(time => !beats.has(time));
  });
}
export function copyClips() {
  const ids: string[] = [];
  editProject(edits => { for (const id of state.selectedClipIds) {
    const clip = editedProject(state.project).clips.find(c => c.id === id); if (!clip || trackState(state.project, effectTrack(clip.objectId, clip.effect)).locked || !copyable(clip.effect)) continue;
    const newId = `copy:${crypto.randomUUID()}`; ids.push(newId);
    edits.copies.push({ id: newId, sourceId: clip.sourceId || clip.id, startMs: clip.startMs + clip.durationMs, durationMs: clip.durationMs });
    if (edits.audio?.[id]) (edits.audio ||= {})[newId] = { ...edits.audio[id] };
    if (clip.easing) edits.clips[newId] = { easing: clip.easing };
    if (clip.motions) edits.clips[newId] = { ...edits.clips[newId], motions: structuredClone(clip.motions) };
  } });
  if (ids.length) { state.selectedClipIds = ids; state.selectedClipId = ids[0]; state.selectedBeatTimes = []; notifyEditor(); }
}
export function selectMove(ply: number) { stopPlaying(); return navigate(ply); }
// Layout and visibility refreshes must not interrupt the shared transport or audio.
export function refreshPreview() { cancelMotion(); if (state.game) samplePosition(state.timeMs, true); }
export function seekTime(time: number) { stopSounds(); playback?.seek(time); }
export function stepFrame(direction: number) { seekTime(adjacentFrame(state.timeMs, direction, state.project.output.fps)); }
export function setFollow(value: boolean) { state.follow = value; notifyEditor(); }
/** @param {string} id @param {string | null} clipId */
export function selectObject(id: string, clipId: string | null = null, additive = false) {
  if (!additive) state.selectedBeatTimes = [];
  if (state.selectedObjectId !== id || clipId && state.selectedClipId !== clipId) { state.selectedProperty = null; state.selectedKeyTime = null; selectedPropertySource = clipId ? { clipId } : null; }
  state.selectedObjectId = state.project.objects.some(o => o.id === id) ? id : null;
  state.selectedClipId = editedProject(state.project).clips.some(c => c.id === clipId) ? clipId : null;
  state.selectedClipIds = additive && clipId ? (state.selectedClipIds.includes(clipId) ? state.selectedClipIds.filter(id => id !== clipId) : [...state.selectedClipIds, clipId]) : clipId ? [clipId] : [];
  decorateSelection(); notifyEditor();
}
export function selectTimelineItems(ids: string[], beatTimes: number[] = []) {
  const wanted = new Set(ids), clips = editedProject(state.project).clips.filter(c => wanted.has(c.id));
  const beats = new Set(beatTimes); state.selectedBeatTimes = (state.project.edits.beats || []).filter(time => beats.has(time));
  const active = clips.find(c => c.id === state.selectedClipId) || clips.at(-1);
  state.selectedClipIds = clips.map(c => c.id); state.selectedClipId = active?.id || null;
  state.selectedObjectId = active?.objectId || null;
  state.selectedProperty = null; state.selectedKeyTime = null; selectedPropertySource = active ? { clipId: active.id } : null;
  decorateSelection(); notifyEditor();
}
export function selectBeat(time: number, additive = false) {
  const beats = additive ? state.selectedBeatTimes.includes(time) ? state.selectedBeatTimes.filter(t => t !== time) : [...state.selectedBeatTimes, time] : [time];
  selectTimelineItems(additive ? state.selectedClipIds : [], beats);
}
export function selectPropertySource(source: PropertySource) {
  state.selectedBeatTimes = [];
  selectedPropertySource = source; state.selectedProperty = null; state.selectedKeyTime = null;
  if (source && typeof source === 'object') { state.selectedClipId = source.clipId; state.selectedClipIds = [source.clipId]; }
  notifyEditor();
}
function decorateSelection() {
  for (const el of $('board').querySelectorAll<HTMLElement>('[data-object-id],[data-motion-object-id]')) {
    const id = el.dataset.motionObjectId || el.dataset.objectId;
    el.setAttribute('data-selected', String(id === state.selectedObjectId));
    el.style.pointerEvents = 'auto';
    el.tabIndex = el.style.visibility === 'hidden' ? -1 : 0;
    el.setAttribute('role', 'button'); el.setAttribute('aria-label', `选择棋子 ${id}`);
  }
}
function message(text: string) {
  $('message').textContent = text; $('message').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('message').hidden = true, 5000);
}
async function startPlaying(until = map.duration) {
  const epoch = soundEpoch, clock = playback;
  pendingPlay = true;
  try {
    if (state.sound) {
      audioContext ||= new AudioContext();
      const [, decoded] = await Promise.all([audioContext.resume(), soundWaveforms(state.chesscom, state.project)]);
      if (epoch !== soundEpoch || clock !== playback) return;
      buffers = decoded;
    }
  } catch {
    if (epoch === soundEpoch) message('声音输出初始化失败，继续播放画面。');
  }
  if (epoch !== soundEpoch || clock !== playback) return;
  playbackNow = audioContext?.state === 'running' ? () => audioContext!.currentTime * 1000 : () => performance.now();
  pendingPlay = false;
  clock.play(until);
}
function stopSounds() {
  soundEpoch++; pendingPlay = false;
  for (const oscillator of sounding) { try { oscillator.stop(); } catch { /* Already ended. */ } }
  sounding.clear();
}
function badge(cls: ClassId) {
  const element = document.createElement('span');
  element.className = 'mini-badge';
  element.style.background = `var(${CLASSES[cls].v})`;
  element.title = CLASSES[cls].label;
  element.innerHTML = glyphSvg(cls);
  return element;
}
function statusBadge(icon: string, title: string, side = '') {
  const element = document.createElement('span');
  element.className = `status-icon status-${icon} ${side ? 'side-' + side : ''}`;
  element.title = title; element.setAttribute('aria-label', title);
  element.innerHTML = statusGlyph(icon, side);
  return element;
}
function outcomeText(outcome: Outcome) {
  return `${outcomeLabel(outcome)} · ${outcome.result}`;
}
function renderEvaluation(move: Move | null | undefined) {
  const target = `${move?.cpWhite}:${move?.mateWhite}:${move?.san?.endsWith('#')}`;
  if (evalTarget === target) return;
  evalTarget = target;
  cancelAnimationFrame(evalFrame);
  $('evalFill').style.width = (move?.cpWhite == null ? 50 : move.mateWhite != null ? (move.mateWhite > 0 ? 100 : 0) : winPct(move.cpWhite)) + '%';
  const label = $('evalText'), text = formatEval(move);
  label.dataset.target = text;
  const cp = move?.mateWhite == null && !move?.san?.endsWith('#') && Number.isFinite(move?.cpWhite) ? move!.cpWhite! : null;
  if (cp === null || displayedCp === null || reducedMotion.matches) {
    displayedCp = cp; label.textContent = text; return;
  }
  const from = displayedCp, start = performance.now();
  const tick = (now: number) => {
    const t = reducedMotion.matches ? 1 : Math.min(1, (now - start) / 350);
    displayedCp = from + (cp - from) * (1 - (1 - t) ** 3);
    label.textContent = t === 1 ? text : formatEval({ ...move!, cpWhite: displayedCp });
    evalFrame = t < 1 ? requestAnimationFrame(tick) : 0;
  };
  evalFrame = requestAnimationFrame(tick);
}
function renderReviewStats() {
  $('reviewStats').hidden = !state.review;
  $('reviewStatsBody').replaceChildren();
  if (!state.review) return;
  for (const cls of ['brilliant', 'great', 'book', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'] as const) {
    const row = document.createElement('tr'); row.dataset.class = cls; row.style.color = `var(${CLASSES[cls].v})`;
    const name = document.createElement('th'); name.scope = 'row'; name.textContent = CLASS_INFO[cls].split(' · ')[0]; name.title = CLASS_INFO[cls]; row.append(name);
    for (const color of ['w', 'b'] as const) {
      if (color === 'b') { const icon = document.createElement('td'); icon.append(badge(cls)); row.append(icon); }
      const count = document.createElement('td'); count.dataset.side = color; count.textContent = String(state.review.counts[color][cls]); row.append(count);
    }
    $('reviewStatsBody').append(row);
  }
}
function renderMoves() {
  renderReviewStats();
  $('moves').replaceChildren();
  let row: HTMLDivElement; let number: number | undefined;
  rows().forEach((move, index) => {
    if (move.moveNo !== number) {
      number = move.moveNo; row = document.createElement('div'); row.className = 'move-row';
      const label = document.createElement('span'); label.className = 'move-number'; label.textContent = number + '.';
      row.append(label); $('moves').append(row);
      if (move.color === 'b') row.append(document.createElement('span'));
    }
    const button = document.createElement('button');
    button.className = 'move-button'; button.dataset.ply = String(index + 1);
    button.setAttribute('aria-label', `${move.moveNo}${move.color === 'w' ? '. 白方' : '... 黑方'} ${move.san}${move.cls ? ' ' + CLASSES[move.cls].label : ''}`);
    if (move.cls) button.title = CLASS_INFO[move.cls] + (move.expectedPointsLoss != null
      ? ` 期望得分损失：${move.expectedPointsLoss.toFixed(4)}；本手准确率：${move.moveAccuracy!.toFixed(1)}。` : '') + (move.bestSan ? ` 引擎首选：${move.bestSan}。` : '');
    const san = document.createElement('span'); san.textContent = move.san; button.append(san);
    if (move.cls) button.append(badge(move.cls));
    else if (move.nags?.length) {
      const nag = document.createElement('span'); nag.className = 'original-nag';
      nag.textContent = move.nags.map(n => (({ 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!', 7: '□' } as Record<number, string>)[n] || '$' + n)).join(' ');
      nag.title = '原棋谱 NAG，尚未经过引擎分析'; button.append(nag);
    }
    if (move.cls) { const score = document.createElement('span'); score.className = 'move-eval'; score.textContent = formatEval(move); button.append(score); }
    button.onclick = () => { stopPlaying(); navigate(index + 1); };
    row.append(button);
  });
  const outcome = state.game.outcome;
  if (outcome) {
    const end = document.createElement('button'); end.className = 'move-outcome';
    end.append(statusBadge(outcome.winner ? 'win' : 'draw', outcomeLabel(outcome)), document.createTextNode(outcomeText(outcome)));
    end.onclick = () => { stopPlaying(); navigate(rows().length); };
    $('moves').append(end);
  }
}
function renderPosition() {
  const move = current();
  $('board').setAttribute('aria-label', `第 ${state.ply} 手${move ? ' ' + move.san : '，初始局面'}`);
  const headers = state.game.headers;
  for (const [where, color] of [['top', 'b'], ['bottom', 'w']]) {
    $(where + 'Player').textContent = headers[color === 'w' ? 'White' : 'Black'] || (color === 'w' ? 'White' : 'Black');
    $(where + 'Side').textContent = (color === 'w' ? '白方' : '黑方') + (headers[color === 'w' ? 'WhiteElo' : 'BlackElo'] ? ' · ' + headers[color === 'w' ? 'WhiteElo' : 'BlackElo'] : '');
    const avatar = $(where + 'Player').parentElement!.previousElementSibling!;
    avatar.className = `avatar ${color === 'w' ? 'white' : 'black'}`;
    const acc = state.review?.[color === 'w' ? 'accWhite' : 'accBlack'];
    $(where + 'Accuracy').replaceChildren(document.createTextNode(acc == null ? '—' : acc.toFixed(1)));
    const small = document.createElement('small'); small.textContent = '准确率'; $(where + 'Accuracy').append(small);
  }
  $('positionCount').textContent = `${state.ply} / ${rows().length}`;
  $('prev').disabled = state.ply === 0;
  $('next').disabled = state.ply === rows().length;
  $('moves').querySelectorAll<HTMLButtonElement>('.move-button').forEach(button => {
    const active = Number(button.dataset.ply) === state.ply;
    button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'step' : 'false');
  });
  const selected = $('moves').querySelector<HTMLElement>('.move-button.active');
  if (selected && state.follow) {
    const top = selected.offsetTop - $('moves').offsetTop;
    if (top < $('moves').scrollTop || top + selected.offsetHeight > $('moves').scrollTop + $('moves').clientHeight) $('moves').scrollTop = top - $('moves').clientHeight / 2;
  }
  renderEvaluation(move);
  notifyEditor();
}
function cancelMotion() {
  state.motion?.scene.dispose(); state.motion = null; staticKey = null;
  $('board').removeAttribute('aria-busy');
}
function configurePlayback() {
  stopPlaying(); cancelMotion();
  plans = projectPlans(state.project); map = projectTimeMap(state.project);
  playback = createPlayback({ duration: map.duration,
    sample: time => samplePosition(time),
    now: () => playbackNow(),
    onStart: (time, end, speed, anchor) => {
      stopSounds();
      if (!state.sound || audioContext?.state !== 'running') return;
      for (const source of scheduleSounds(audioContext, projectSounds(state.project), time, end, buffers, speed, anchor / 1000)) {
        sounding.add(source); source.addEventListener('ended', () => sounding.delete(source), { once: true });
      }
    },
    onState: playing => {
      if (!playing) stopSounds();
      state.playing = playing; $('play').innerHTML = materialIcon(playing ? 'pause' : 'play_arrow'); $('play').setAttribute('aria-label', playing ? '暂停' : '播放');
      notifyEditor();
    },
  });
}
function samplePosition(time: number, force = false) {
  const at = locateTime(map, time), oldPly = state.ply, plan = plans[at.index], segment = state.project.segments[at.index];
  const source = selectedPropertySource;
  if (at.time !== state.timeMs && source && typeof source === 'object') {
    const selected = editedProject(state.project).clips.find(c => c.id === source.clipId);
    const moving = plan?.events.find(e => e.type === 'move' && e.objectId === state.selectedObjectId);
    if (state.selectedClipIds.length === 1 && !state.selectedBeatTimes.length && moving?.clipId && selected?.moveId !== segment.id) {
      selectedPropertySource = { clipId: moving.clipId };
      state.selectedClipId = moving.clipId; state.selectedClipIds = [moving.clipId];
      state.selectedProperty = null; state.selectedKeyTime = null;
    }
  }
  state.timeMs = at.time; state.ply = at.time <= map.ranges[0].start ? 0 : at.index + 1;
  $('first').disabled = at.time === 0; $('last').disabled = at.time >= map.duration;
  $('framePrev').disabled = at.time === 0; $('frameNext').disabled = at.time >= map.duration;
  if (force || oldPly !== state.ply) renderPosition();
  const board = $('board'), visible = board.getClientRects().length && document.visibilityState !== 'hidden';
  if (!visible) { cancelMotion(); notifyEditor(); return; }
  const reduced = reducedMotion.matches;
  if (!state.ply || reduced) {
    const landedIndex = state.ply ? plans.reduce((found, p, i) => map.ranges[i].start + p.events.find(e => e.type === 'land')!.at <= at.time ? i : found, -1) : -1;
    const key = `${landedIndex}:${state.ply === 0}:${state.flip}`;
    if (force || staticKey !== key || state.motion) {
      cancelMotion();
      const move = plans[landedIndex]?.move;
      const fen = move?.fenAfter || state.game.startFen;
      renderBoard(board, fen, { flip: state.flip, chesscom: state.chesscom, lastMove: move, project: state.project,
        outcomeBadges: outcomeMarkers(landedIndex === plans.length - 1 ? state.game.outcome : null, fen) });
      const positions = state.project.segments[landedIndex]?.after || state.project.segments[0]?.before || {};
      for (const [sq, id] of Object.entries(positions)) { const pc = board.querySelector<HTMLElement>(`[data-sq="${sq}"] .pc`); if (pc) pc.dataset.objectId = id; }
      staticKey = key;
    }
  } else {
    if (!state.motion || state.motion.index !== at.index || force) {
      cancelMotion();
      state.motion = { index: at.index, scene: createSequenceScene(board, plans, state.project.segments, at.index, { flip: state.flip, chesscom: state.chesscom, project: state.project }) };
    }
    state.motion.scene.seek(Math.max(0, at.local));
  }
  const effective = editedProject(state.project);
  applyVisuals(board, effective, at.time, reduced, false);
  updateCameraFrame(board, effective, at.time, reduced);
  decorateSelection();
  notifyEditor();
}
function navigate(ply: number) {
  const target = Math.max(0, Math.min(rows().length, ply));
  seekTime(target === 0 ? 0 : target === rows().length ? map.duration
    : map.ranges[target - 1].start + Math.min(plans[target - 1].duration - .001, plans[target - 1].events.find(e => e.type === 'settle')!.at));
  if (target) selectObject(state.project.segments[target - 1].objectId);
}
function stopPlaying() { playback?.pause(); stopSounds(); }
export function togglePlaying() {
  if (playback?.playing || pendingPlay) { stopPlaying(); return; }
  if (state.timeMs >= map.duration) seekTime(0);
 
  void startPlaying();
}
function replayMove() {
  const index = Math.max(0, state.ply - 1), range = map.ranges[index];
  if (!range) return;
  seekTime(range.start); void startPlaying(range.end);
}
function cancelAnalysis() {
  if (state.job) { state.job.signal.cancelled = true; stopEngine(); }
}
export async function cancelEngineAnalysis() { const job = state.job; cancelAnalysis(); if (job) await job.done; }
function syncEngineControls() {
  const snapshot = engineSnapshot(), depth = snapshot.settings.depth;
  if (![...$('depth').options].some(o => Number(o.value) === depth)) $('depth').add(new Option(depth ? String(depth) : '不限（按时间）', String(depth)));
  $('depth').value = String(depth);
  $('depth').disabled = snapshot.busy || snapshot.analyzing;
  $('analyze').disabled = snapshot.busy && !state.job;
  if (!state.job) $('engineStatus').textContent = state.review ? `${state.project.analysis!.engine} · 分析完成` : `${currentEngineProfile().name} · ${snapshot.ready ? '已就绪' : '待启动'}`;
}
function syncOutput() {
  const project = state.project;
  state.sound = project.output.sound;
  for (const key of ['width', 'height', 'fps', 'crf', 'bitrate'] as const) $<HTMLInputElement>('video' + key[0].toUpperCase() + key.slice(1)).value = String(project.output[key]);
  $('videoSound').checked = project.output.sound; $('videoPreset').value = 'custom';
  $('videoShowNames').checked = project.output.showNames;
  $('videoShowMove').checked = project.output.showMove;
  $('videoShowEvaluation').checked = project.output.showEvaluation;
}
function loadGame(game: Game, project = createProject(game, { chesscom: state.chesscom }), path: string | null = null, name = '未命名工程', dirty = true) {
  cancelAnimationFrame(evalFrame); evalFrame = 0; displayedCp = null; evalTarget = null;
  cancelAnalysis(); stopPlaying(); cancelMotion(); state.job = null; setEngineAnalyzing(false);
  state.game = game; state.review = project.analysis?.review || null; state.ply = 0;
  history.clear(); editBase = null; savedProject = dirty ? null : project;
  state.project = project; state.projectPath = path; state.projectName = name; state.dirty = dirty;
  state.flip = project.output.flip; state.sound = project.output.sound;
  const source = project.assets.find(a => a.id === 'pieces')!.source;
  state.chesscom = source.kind === 'builtin' && source.id === 'chesscom-neo';
  syncOutput();
  $('eventName').textContent = game.headers.Event || `${game.headers.White || 'White'} vs ${game.headers.Black || 'Black'}`;
  $('gameResult').textContent = game.outcome?.result || game.headers.Result || '*';
  $('analyze').textContent = '开始分析'; $('depth').disabled = false;
  $('engineStatus').textContent = `${currentEngineProfile().name} · 就绪`; $('progressText').textContent = '等待分析'; $('progress').value = 0;
  $('opening').textContent = '标准国际象棋'; $('nagSource').textContent = '尚未分析';
  $('opening').title = '';
  if (state.review) renderReviewStatus();
  syncEngineControls();
  state.selectedObjectId = null; state.selectedClipId = null; state.selectedClipIds = []; state.selectedBeatTimes = []; state.selectedProperty = null; state.selectedKeyTime = null;
  selectedPropertySource = null;
  configurePlayback(); renderMoves(); samplePosition(0, true);
}
function renderReviewStatus() {
  const result = state.review!;
  $('analyze').textContent = '重新分析'; $('engineStatus').textContent = `${state.project.analysis!.engine} · 分析完成`;
  $('progressText').textContent = `${result.moves.length} 手已标记`; $('progress').value = 1;
  $('opening').textContent = result.opening ? result.opening.join(' · ') : '未匹配到命名开局';
  $('opening').title = $('opening').textContent;
  $('nagSource').textContent = result.scoreModel === EXPECTED_SCORE_MODEL ? '引擎标记' : '旧分析 · 请重新分析';
}
export function executeMcpTool(name: string, value: unknown) {
  const args = validateMcpArguments(name, value);
  if (name !== 'get_project') {
    if (state.fileBusy || editBase || state.job) throw new Error('编辑器忙碌，请在当前操作完成后重试');
    if ('revision' in args && args.revision !== currentMcpRevision()) throw new Error('工程已改变，请重新读取 get_project 后再修改');
  }
  if (name === 'set_pgn') {
    const game = parsePgn(args.pgn as string), project = createProject(game, { chesscom: state.chesscom });
    if (state.dirty && args.replaceUnsaved !== true) throw new Error('当前工程有未保存修改；需要 replaceUnsaved=true 才能替换');
    loadGame(game, project);
  } else if (name === 'update_animation') {
    const candidate = parseProject(JSON.stringify({ ...state.project, edits: { ...state.project.edits, ...(args.edits as Partial<Edits>) } }));
    validateTrackChanges(state.project, candidate);
    const error = editProject(edits => Object.assign(edits, candidate.edits));
    if (error) throw new Error(error);
  } else if (name === 'seek_timeline') {
    if ((args.timeMs as number) > map.duration) throw new Error('时间超出当前工程时长');
    stopPlaying(); seekTime(args.timeMs as number);
  } else if (name === 'undo' || name === 'redo') {
    stopPlaying(); undoEdit(name === 'redo');
  }
  const snapshot = editorSnapshot();
  const result = { revision: currentMcpRevision(), projectName: state.projectName, dirty: state.dirty,
    timeMs: state.timeMs, durationMs: map.duration, canUndo: history.canUndo, canRedo: history.canRedo };
  if (name === 'get_project') {
    const project = JSON.parse(serializeProject(state.project));
    if (args.includeAssetData !== true) for (const asset of project.edits.assets || []) if (asset.source.kind === 'embedded') delete asset.source.data;
    return { ...result, assetDataIncluded: args.includeAssetData === true, project,
      scene: { objects: snapshot.project.objects, clips: snapshot.project.clips, segments: snapshot.project.segments } };
  }
  message(`MCP：${name} 已完成`);
  return result;
}
async function analyze() {
  if (state.job) { cancelAnalysis(); return; }
  if (engineSnapshot().busy) return;
  stopPlaying();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const job: AnalysisJob = { engine: null, signal: { cancelled: false }, done, game: state.game };
  state.job = job; $('analyze').textContent = '取消分析'; $('depth').disabled = true;
  setEngineAnalyzing(true);
  $('engineStatus').textContent = '正在加载本地引擎…'; $('progressText').textContent = '准备中'; $('progress').value = 0;
  try {
    job.engine = await readyEngine();
    if (state.job !== job || job.signal.cancelled) return;
    const settings = { ...job.engine.settings };
    $('engineStatus').textContent = `${job.engine.name} · 分析中`;
    const result = await reviewGame(job.engine, job.game.moves, job.game.startFen, { ...settings, signal: job.signal,
      onProgress(done, total) {
        if (state.job !== job) return;
        $('progress').value = done / total; $('progressText').textContent = `${done} / ${total} 局面`;
      } });
    if (!result || state.job !== job || job.signal.cancelled || state.game !== job.game) return;
    finishEdit(); stopPlaying();
    const project = regenerateProject(state.project, { analysis: { review: result, depth: settings.depth, engine: job.engine.name, settings } });
    state.review = result; updateProject(project);
    renderReviewStatus();
    const time = state.timeMs; configurePlayback(); renderMoves(); playback.seek(time); samplePosition(state.timeMs, true);
    message(project.edits.pending?.length ? `分析完成，${project.edits.pending.length} 项修改暂未匹配，已保留待处理。` : '分析完成，点击步序即可查看着法。');
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught));
    if (state.job !== job) return;
    const cancelled = error.name === 'AbortError' || job.signal.cancelled;
    $('engineStatus').textContent = cancelled ? '分析已取消' : '分析失败';
    $('progressText').textContent = cancelled ? '可重新开始' : '请重试';
    if (!cancelled) message(error.message);
  } finally {
    if (state.job === job) {
      const status = $('engineStatus').textContent;
      state.job = null; setEngineAnalyzing(false);
      $('engineStatus').textContent = status;
      $('analyze').textContent = state.review ? '重新分析' : '开始分析';
    }
    finish();
  }
}

function downloadFile(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
let savingProject = false;
export async function saveCurrentProject(saveAs = false) {
  if (savingProject) return false;
  finishEdit();
  const project = state.project, previousBusy = state.fileBusy;
  savingProject = true; state.fileBusy = true; notifyEditor();
  try {
    const content = serializeProject(project);
    if (window.__TAURI__) {
      const path = await window.__TAURI__.core.invoke<string | null>('save_project', { content, path: saveAs ? null : state.projectPath });
      if (!path) return false;
      state.projectPath = path; state.projectName = path.split(/[\\/]/).at(-1)!;
    } else {
      const name = state.projectName.endsWith('.plymotion') ? state.projectName : `${state.projectName}.plymotion`;
      downloadFile(content, name, 'application/json'); state.projectName = name;
    }
    savedProject = project; state.dirty = state.project !== project;
    message(state.dirty ? '已保存快照；保存期间产生的新修改仍未保存。' : window.__TAURI__ ? '工程已保存。' : '工程副本已下载。');
    return !state.dirty;
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); message(`保存工程失败：${error.message || error}`); return false; }
  finally { savingProject = false; state.fileBusy = previousBusy; notifyEditor(); }
}
async function confirmProjectReplacement() {
  if (!state.dirty) return true;
  const dialog = $('unsavedDialog');
  dialog.returnValue = 'cancel'; dialog.showModal();
  const choice = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (choice === 'save') return saveCurrentProject();
  return choice === 'discard';
}
async function checkProjectAssets(project: Project) {
  await Promise.all((project.edits.assets || []).filter(a => a.kind === 'image').map(async asset => {
    if (asset.source.kind !== 'embedded') throw new Error('图片素材来源无效。');
    const image = new Image(); image.src = asset.source.data;
    await image.decode().catch(() => { throw new Error(`无法读取图片素材：${asset.source.kind === 'embedded' ? asset.source.name : asset.id}`); });
    if (image.naturalWidth > 1024 || image.naturalHeight > 1024) throw new Error('工程的图片素材尺寸超过 1024 像素。');
  }));
  await soundBuffers(new OfflineAudioContext(1, 1, 48000), false, undefined, project);
  const source = project.assets.find(a => a.id === 'pieces')!.source;
  if (source.kind !== 'builtin' || source.id !== 'chesscom-neo') return;
  const paths = ['manifest.json', ...['w', 'b'].flatMap(color => ['k', 'q', 'r', 'b', 'n', 'p'].map(piece => `pieces/${color}${piece}.png`)), 'sounds/move.mp3', 'sounds/capture.mp3'];
  const available = await Promise.all(paths.map(path => fetch(`assets/chesscom/${path}`, { method: 'HEAD' }).then(r => r.ok && !r.headers.get('content-type')?.includes('text/html')).catch(() => false)));
  if (available.includes(false)) throw new Error('工程需要 Neo 棋子与 Chess.com 音效，请先安装该素材包。');
}
async function openProjectContent(content: string, path: string | null, name: string) {
  const project = parseProject(content); // Validate before offering to discard the current work.
  await checkProjectAssets(project);
  if (!await confirmProjectReplacement()) return;
  loadGame(parsePgn(project.pgn), project, path, name, false);
  message('工程已打开，分析与动画快照已恢复。');
}
export async function openCurrentProject(path: string | null = null) {
  if (state.fileBusy) return;
  if (!window.__TAURI__) { $('projectFile').click(); return; }
  state.fileBusy = true; notifyEditor();
  try {
    const file = await window.__TAURI__.core.invoke<{ content: string; path: string } | null>('open_project', { path });
    if (file) await openProjectContent(file.content, file.path, file.path.split(/[\\/]/).at(-1)!);
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); message(`打开工程失败：${error.message || error}`); }
  finally { state.fileBusy = false; notifyEditor(); }
}

const readVideoSettings = () => videoSettings({ width: $('videoWidth').value, height: $('videoHeight').value,
  fps: $('videoFps').value, crf: $('videoCrf').value, bitrate: $('videoBitrate').value,
  speed: 1, sound: $('videoSound').checked, showNames: $('videoShowNames').checked,
  showMove: $('videoShowMove').checked, showEvaluation: $('videoShowEvaluation').checked });
function videoEstimate(previewTime?: number) {
  try {
    const settings = readVideoSettings(), schedule = videoSchedule(rows(), state.game.outcome, settings, projectPlans(state.project), projectSounds(state.project), projectTimeMap(state.project).duration);
    const output = { ...settings, flip: state.flip };
    if ((Object.keys(output) as (keyof Output)[]).some(key => output[key] !== state.project.output[key])) updateProject({ ...state.project, output });
    state.sound = settings.sound;
    $('videoEstimate').textContent = `${settings.width} × ${settings.height} · ${settings.fps} fps · ${(schedule.frames / settings.fps).toFixed(1)} 秒 · ${schedule.frames} 帧`;
    $('videoCrf').disabled = settings.bitrate > 0;
    if (!videoJob) $('startVideo').disabled = false;
    if ($('videoDialog').matches(':modal')) void videoPreview?.update(state.project, settings, state.chesscom, previewTime);
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); $('videoEstimate').textContent = error.message;
    if (!videoJob) $('startVideo').disabled = true;
    if ($('videoDialog').matches(':modal')) videoPreview?.dispose(error.message);
  }
}
export function setOutputSize(width: number, height: number) {
  finishEdit(); stopPlaying();
  const output = { ...state.project.output, ...videoSettings({ ...state.project.output, width, height }) };
  updateProject({ ...state.project, output }); syncOutput(); rebuildPreview();
}
export function openVideoExport() {
  if (videoJob) { if (!$('videoDialog').open) $('videoDialog').show(); return; }
  if ($('videoDialog').open) $('videoDialog').close();
  stopPlaying(); $('videoStatus').textContent = ''; $('videoStatus').className = '';
  $('videoProgress').hidden = true; $('videoMetrics').hidden = true;
  $('videoSpeed').textContent = $('videoEta').textContent = '—';
  $('startVideo').disabled = false;
  $('videoDialog').showModal(); videoEstimate(state.timeMs);
};

export async function initializeApp(roots: HTMLElement[] = []) {
detachedRoots = roots;
videoPreview = createVideoPreview($('videoPreview'));
subscribeEditor(() => { if ($('videoDialog').matches(':modal') && !videoJob) videoEstimate(); });
$('openImport').onclick = () => { if (state.fileBusy) return; stopPlaying(); $('pgn').value = state.game.pgn; $('importError').textContent = ''; $('importDialog').showModal(); };
$('closeImport').onclick = () => $('importDialog').close();
$('fileButton').onclick = () => $('pgnFile').click();
$('pgnFile').onchange = async event => {
  const file = (event.target as HTMLInputElement).files![0]; if (!file) return;
  try { if (file.size > 1_000_000) throw new Error('请选择不超过 1 MB 的 PGN 文件。'); $('pgn').value = await file.text(); $('importError').textContent = ''; }
  catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); $('importError').textContent = error.message; }
  (event.target as HTMLInputElement).value = '';
};
$('sampleButton').onclick = () => { $('pgn').value = SAMPLE_PGN; $('importError').textContent = ''; };
$('importForm').onsubmit = async event => {
  event.preventDefault();
  if (state.fileBusy) return;
  const shouldAnalyze = event.submitter?.id === 'importAnalyze';
  state.fileBusy = true; notifyEditor();
  try { const game = parsePgn($('pgn').value); const project = createProject(game, { chesscom: state.chesscom });
    if (await confirmProjectReplacement()) {
      if (shouldAnalyze) await cancelEngineAnalysis();
      loadGame(game, project); $('importDialog').close();
      if (shouldAnalyze) void analyze();
    } }
  catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); $('importError').textContent = '导入失败：' + error.message; }
  finally { state.fileBusy = false; notifyEditor(); }
};
async function openProjectFile(file: File | undefined) {
  if (!file || state.fileBusy) return;
  state.fileBusy = true; notifyEditor();
  try {
    if (file.size > MAX_PROJECT_BYTES) throw new Error('工程文件不能超过 64 MB');
    await openProjectContent(await file.text(), null, file.name);
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); message(`打开工程失败：${error.message || error}`); }
  finally { state.fileBusy = false; notifyEditor(); }
}
$('projectFile').onchange = event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  void openProjectFile(file);
};
window.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = state.fileBusy ? 'none' : 'copy';
  }
}, true);
window.addEventListener('drop', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); event.stopPropagation();
  const files = [...event.dataTransfer.files];
  if (files.length !== 1 || !/\.plymotion$/i.test(files[0].name)) {
    message('请一次拖入一个 .plymotion 工程文件。'); return;
  }
  if (state.fileBusy) { message('正在处理工程文件，请稍后再拖入。'); return; }
  const webview = window.chrome?.webview;
  if (window.__TAURI__ && webview?.postMessageWithAdditionalObjects) {
    try { webview.postMessageWithAdditionalObjects(JSON.stringify({ type: 'plymotion-file-drop' }), files); }
    catch (error) { message(`打开工程失败：${error}`); }
  } else void openProjectFile(files[0]);
}, true);
window.addEventListener('plymotion-file-drop', event => {
  const { path, error } = (event as CustomEvent<{ path?: string; error?: string }>).detail;
  if (error) message(`打开工程失败：${error}`);
  else if (typeof path === 'string') void openCurrentProject(path);
});
$('analyze').onclick = analyze;
$('flip').onclick = () => { stopPlaying(); state.flip = !state.flip; updateProject({ ...state.project, output: { ...state.project.output, flip: state.flip } }); refreshPreview(); };
for (const [id, target] of [['first', () => 0], ['prev', () => state.ply - 1], ['next', () => state.ply + 1], ['last', () => rows().length]] as const) {
  $(id).onclick = () => { stopPlaying(); navigate(target()); };
}
$('play').onclick = togglePlaying;
$('replayMove').onclick = replayMove;
reducedMotion.addEventListener('change', refreshPreview);
document.addEventListener('visibilitychange', refreshPreview);
$('framePrev').onclick = () => stepFrame(-1); $('frameNext').onclick = () => stepFrame(1);
const pick = (event: Event) => {
  const el = (event.target as Element).closest<HTMLElement>('[data-object-id],[data-motion-object-id]'), id = el?.dataset.motionObjectId || el?.dataset.objectId;
  if (!id) return;
  selectObject(id, el?.dataset.motionClipId || null);
  const source = el?.dataset.motionClipId ? { clipId: el.dataset.motionClipId, motionId: el.dataset.motionId } : null;
  const target = objectProperties(state.project, id, source || { clipId: '' }, null, state.timeMs);
  selectPropertySource(el?.matches('.pc,.motion-piece') && state.project.objects.find(o => o.id === id)?.kind === 'piece' ? 'moves' : target?.clip ? { clipId: target.clip.id, motionId: target.motion!.id } : 'object');
};
$('board').addEventListener('click', pick);
$('board').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(event); } });
$('videoPreset').onchange = () => {
  if ($('videoPreset').value !== 'custom') [$('videoWidth').value, $('videoHeight').value] = $('videoPreset').value.split('x');
  videoEstimate();
};
for (const id of ['videoWidth', 'videoHeight']) $(id).oninput = () => { $('videoPreset').value = 'custom'; videoEstimate(); };
$('videoFields').addEventListener('change', () => videoEstimate());
const cancelVideo = () => { videoJob?.abort(); };
$('cancelVideo').onclick = cancelVideo;
$('closeVideo').onclick = () => { if (videoJob) cancelVideo(); else $('videoDialog').close(); };
$('videoDialog').addEventListener('cancel', event => { if (videoJob) { event.preventDefault(); cancelVideo(); } });
$('videoDialog').addEventListener('close', () => { if (!$('videoDialog').matches(':modal')) videoPreview?.dispose(); });
$('videoForm').onsubmit = async event => {
  event.preventDefault(); if (videoJob) return;
  videoPreview?.dispose();
  const job = new AbortController(); videoJob = job;
  $('videoFields').disabled = true; $('startVideo').disabled = true;
  $('cancelVideo').hidden = false; $('videoProgress').hidden = false; $('videoProgress').value = 0;
  $('videoMetrics').hidden = false; $('videoSpeed').textContent = $('videoEta').textContent = '—';
  $('videoStatus').className = ''; $('videoStatus').textContent = '请选择视频保存位置…';
  try {
    const settings = readVideoSettings();
    const task = exportVideo({ project: state.project, settings, chesscom: state.chesscom, signal: job.signal,
      onProgress(value, text, metrics) {
        $('videoProgress').value = value; $('videoStatus').textContent = text;
        $('videoSpeed').textContent = metrics ? `${metrics.fps.toFixed(1)} fps · ${metrics.speed.toFixed(2)}×` : '—';
        if (!metrics) $('videoEta').textContent = '—';
        else if (metrics.remainingSeconds === null) $('videoEta').textContent = '封装中';
        else {
          const seconds = Math.ceil(metrics.remainingSeconds);
          $('videoEta').textContent = (seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时` : '') +
            (seconds >= 60 ? `${Math.floor(seconds / 60) % 60}分` : '') + `${seconds % 60}秒`;
        }
      } });
    $('videoDialog').close(); $('videoDialog').show();
    const path = await task;
    $('videoStatus').textContent = path ? `视频已保存：${path}` : '已取消选择保存位置。';
    if (path) $('videoEta').textContent = '已完成'; else $('videoMetrics').hidden = true;
  } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught));
    $('videoStatus').className = job.signal.aborted ? '' : 'error';
    $('videoStatus').textContent = job.signal.aborted ? '导出已取消，临时文件已清理。' : `导出失败：${error.message || error}`;
    $('videoMetrics').hidden = true;
  } finally {
    videoJob = null; $('videoFields').disabled = false; $('startVideo').disabled = false; $('cancelVideo').hidden = true;
    videoEstimate();
  }
};
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || document.querySelector('dialog:modal')) return;
  if (event.key === 'Escape' && editBase) { event.preventDefault(); finishEdit(true); return; }
  if (!(event.target as Element).closest('input,textarea,select,[contenteditable]') && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); undoEdit(event.key.toLowerCase() === 'y' || event.shiftKey); return; }
  if ((event.ctrlKey || event.metaKey) && ['s', 'o'].includes(event.key.toLowerCase())) {
    event.preventDefault(); if (!state.fileBusy) void (event.key.toLowerCase() === 's' ? saveCurrentProject(event.shiftKey) : openCurrentProject()); return;
  }
  if (event.key.toLowerCase() === 'b' && !event.ctrlKey && !event.metaKey && !event.altKey && !(event.target as Element).closest('input,textarea,select,[contenteditable],[role="menu"],[role="dialog"]')) {
    event.preventDefault(); if (!event.repeat) addBeatAtPlayhead(); return;
  }
  if ((event.target as Element).closest('input,textarea,select,button,[contenteditable],[role="menu"],[role="dialog"],[role="tablist"]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === ',' || event.key === '.') { event.preventDefault(); stepFrame(event.key === ',' ? -1 : 1); return; }
  const actions: Record<string, string> = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last', ' ': 'play' };
  if (actions[event.key]) { event.preventDefault(); $(actions[event.key]).click(); }
});
window.addEventListener('beforeunload', event => {
  if (state.dirty || state.fileBusy) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { cancelAnimationFrame(evalFrame); videoPreview?.dispose(); cancelVideo(); cancelAnalysis(); stopEngine(); stopPlaying(); cancelMotion(); });
let closing = false;
window.addEventListener('plymotion-close', async () => {
  if (closing || !window.__TAURI__) return;
  if (state.fileBusy) { message('正在处理工程文件，请稍后关闭。'); return; }
  closing = true;
  try { if (await confirmProjectReplacement()) { cancelVideo(); cancelAnalysis(); await window.__TAURI__.core.invoke('close_project_window'); } }
  catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); message(`关闭失败：${error}`); }
  finally { closing = false; }
});

subscribeEngine(syncEngineControls);
$('depth').onchange = () => { try { setEngineDepth(Number($('depth').value)); } catch (caught) { const error = caught instanceof Error ? caught : new Error(String(caught)); message(error.message); syncEngineControls(); } };
loadGame(initialGame, undefined, null, '示例工程', false);
try {
  const response = await fetch('assets/chesscom/manifest.json');
  if (response.ok) {
    await response.json();
    stopPlaying();
    state.chesscom = true;
    loadGame(state.game, createProject(state.game, { chesscom: true }), null, '示例工程', false);
  }
} catch { /* Open-source checkout uses the included GPL pieces and synthesized sounds. */ }
if (window.__TAURI__) await window.__TAURI__.core.invoke('project_ready');
}
