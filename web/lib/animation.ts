import type { BoardElement, Move, SceneOptions, Scene, AnimationEvent, AnimationPlan, RelationStep, TimelineOptions, Color, OutcomeMarker, Motion, Segment } from './types.ts';
import { timeMap } from './playback.ts';
import { Chess } from '../vendor/chess.ts';
import { renderBoard, pieceSource, sqCR } from './board.ts';
import { glyphSvg, statusGlyph, tacticGlyph } from './glyphs.ts';
import { outcomeMarkers } from './game.ts';
import { CLASSES, moveClass } from './review.ts';
import { buildAnimationPlan, nagFrames, timelineTime, HIGHLIGHT_FADE_MS, NAG_ENTER_MS, NAG_RING_MS, NAG_EXIT_MS } from './animation-plan.ts';
import { cssEasing, effectTrack, propertyTrack, trackState } from './editing.ts';
import { motionFrames, motionKeyframes, motionEasing, sampleMotion } from './motion-keyframes.ts';
import { nagExitFrames, NAG_PARTICLE_PREFIX } from './nag-presets.ts';

const EASE = 'cubic-bezier(.2,.8,.2,1)';

// One clock for every primitive. Abort wakes the pending delay immediately.
export async function runTimeline(events: AnimationEvent[], duration: number, { signal, dispatch, now = () => performance.now() }: TimelineOptions) {
  if (signal?.aborted) return false;
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const abort = () => { clearTimeout(timer); wake?.(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const event of [...events, { at: duration, type: 'complete' as const }]) {
      if (signal?.aborted) return false;
      const delay = event.at - (now() - start);
      if (delay > 0) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, delay); });
      if (signal?.aborted) return false;
      dispatch(event);
    }
    return true;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// Build once per move. DOM lifetimes are reversible, including captures and promotion.
export function createMoveScene(board: BoardElement, move: Move, options: SceneOptions = {}): Scene {
  const { flip = false, chesscom = false, outcome = null, identity = null, project } = options;
  const speed = Math.min(2, Math.max(.5, Number(options.speed) || 1));
  const plan = options.plan || buildAnimationPlan(move, { outcome });
  const animations: Animation[] = [], temporary: HTMLElement[] = [], ghosts = new Map<string, { img: HTMLImageElement; x: number; y: number; tilt: number }>(), paths = new Map<RelationStep, HTMLElement>(), animationStarts = new Map<Animation, number>();
  const motions: Motion[] = [];
  const motionElements: { el: HTMLElement; motion: Motion; objectId: string }[] = [];
  const sampled: { animation: Animation; motion: Motion }[] = [];
  let logicalTime = 0, activeEvent: AnimationEvent | null = null;
  const lifetimes = new Map<HTMLElement, [number, number]>();
  const initialized = new Set<HTMLElement>();
  const previous = options.previousMove;
  const oldHighlights = 'previousMove' in options
    ? previous ? [previous.from, previous.to].map(square => ({ square, color: CLASSES[moveClass(previous)!] ? `var(${CLASSES[moveClass(previous)!].v})` : '#edf272' })) : []
    : Array.from(board.querySelectorAll<HTMLElement>('.hl'), el => ({ square: el.dataset.sq!, color: el.style.getPropertyValue('--hl-col') || '#edf272' }));
  const unit = board.clientWidth / 8;
  const before = new Chess(move.fenBefore);
  const square = (sq: string) => board.querySelector<HTMLElement>(`[data-sq="${sq}"]`)!;
  const piece = (sq: string) => square(sq)?.querySelector<HTMLImageElement>('.pc')!;
  const animate = (el: HTMLElement | null | undefined, frames: Keyframe[], duration: number, delay = 0, easing = EASE) => {
    if (!el) return;
    const base = ({ promotion: 200, nag: NAG_ENTER_MS, 'nag-exit': NAG_EXIT_MS, gift: 220, result: 240, winner: 240 } as Record<string, number>)[activeEvent?.type ?? ''];
    const ratio = base && activeEvent?.editorDuration !== undefined ? activeEvent!.editorDuration! / base : 1;
    if (activeEvent?.easing) { easing = cssEasing(activeEvent.easing); frames = frames.map(({ easing, ...frame }) => frame); }
    let motion: Motion | undefined, rendered: Motion | undefined;
    if (activeEvent?.clipId) {
      const part = el.className.split(' ')[0], square = el.closest<HTMLElement>('.sq')?.dataset.sq;
      const id = el.dataset.partId || `${part}:${square || el.dataset.objectId || 'board'}`;
      const edit = activeEvent.motions?.[id];
      const labels: Record<string, string> = { 'motion-piece': '棋子', pc: '棋子', badge: '徽标', 'nag-halo': '光晕', 'nag-ring': '扩散环', 'nag-particle': `粒子 ${el.dataset.particleIndex}`, 'move-highlight': '高亮', 'relation-flash': '路径' };
      motion = { id, clipId: activeEvent.clipId, label: `${labels[part] || part}${square ? ` · ${square}` : ''}`,
        startMs: logicalTime + delay * ratio, durationMs: duration * ratio,
        frames: edit?.frames || motionFrames(frames, unit, flip), easing: edit?.easing || motionEasing(easing), tracks: edit?.tracks };
      motions.push(motion);
      const objectId = el.dataset.objectId || activeEvent.objectId || 'board';
      motionElements.push({ el, motion, objectId });
      const tracks = Object.fromEntries(Object.entries(edit?.tracks || {}).filter(([axis]) => !project || !trackState(project, propertyTrack(objectId, axis)).hidden));
      rendered = { ...motion, tracks: Object.keys(tracks).length ? tracks : undefined };
      if (edit) { frames = motionKeyframes(rendered.tracks ? [0, 1].map(offset => ({ ...sampleMotion(rendered!, 0), offset, easing: 'linear' })) : edit.frames, unit, flip); easing = cssEasing(edit.easing); }
    }
    // Future effects must not override earlier effects. The first keyframe is
    // also the underlying style, preserving delayed ring/promotion entrances.
    if (!initialized.has(el)) {
      for (const property of ['opacity', 'transform']) if (frames[0][property] !== undefined) el.style[property as "opacity" | "transform"] = String(frames[0][property as "opacity" | "transform"]);
      initialized.add(el);
    }
    const animation = el.animate(frames, { duration: duration * ratio / speed, delay: delay * ratio / speed, easing, fill: 'forwards' });
    animation.pause(); animation.currentTime = -1;
    if (rendered?.tracks) sampled.push({ animation, motion: rendered });
    animationStarts.set(animation, logicalTime / speed);
    animations.push(animation); return animation;
  };
  const add = <T extends HTMLElement>(el: T, parent: HTMLElement = board): T => { parent.appendChild(el); temporary.push(el); lifetimes.set(el, [logicalTime / speed, activeEvent?.copied ? (logicalTime + activeEvent.editorDuration!) / speed : Infinity]); if (activeEvent?.copied) el.dataset.copy = 'true'; if (activeEvent?.objectId) el.dataset.trackId = effectTrack(activeEvent.objectId, activeEvent.type); return el; };
  function ghost(type: string, color: Color, sq: string) {
    const img = document.createElement('img'), p = sqCR(sq, flip);
    img.dataset.objectId = identity?.before[sq] || '';
    if (img.dataset.objectId) img.dataset.trackId = effectTrack(img.dataset.objectId, 'move');
    img.className = 'motion-piece'; img.src = pieceSource(type, color, chesscom, project); img.alt = ''; img.draggable = false;
    img.style.left = (p.c * 12.5 + .625) + '%'; img.style.top = (p.r * 12.5 + .625) + '%';
    return add(img);
  }
  function hit(sq: string, from: string, duration: number) {
    const a = sqCR(from, flip), b = sqCR(sq, flip);
    const tilt = (Math.sign(b.c - a.c || a.r - b.r) || 1) * 32;
    animate(piece(sq), [
      { transform: 'rotate(0deg)', offset: 0 },
      { transform: `rotate(${tilt}deg)`, offset: .25 },
      { transform: `rotate(${-tilt * .45}deg)`, offset: .55 },
      { transform: `rotate(${tilt * .18}deg)`, offset: .78 },
      { transform: 'rotate(0deg)', offset: 1 },
    ], duration, 0, 'ease-in-out');
  }
  function flashPath(step: RelationStep, duration: number) {
    const tile = document.createElement('span');
    tile.className = `relation-flash ${step.tone}${step.attacked ? ' under-attack' : ''}`;
    add(tile, square(step.square));
    paths.set(step, tile);
    // Keep each cell lit until its own scheduled exit, for both path colors.
    animate(tile, [{ opacity: 0 }, { opacity: 1 }], duration, 0, 'linear');
  }
  function highlight(sq: string, color: string, outgoing = false) {
    const tile = document.createElement('span'); tile.className = `move-highlight${outgoing ? ' previous-highlight' : ''}`;
    tile.dataset.trackId = effectTrack(outgoing ? 'board' : identity?.objectId || 'board', outgoing ? 'previous' : 'target');
    tile.style.background = color; add(tile, square(sq));
    animate(tile, [{ opacity: outgoing ? .55 : 0 }, { opacity: outgoing ? 0 : .55 }], HIGHLIGHT_FADE_MS, 0, 'linear');
  }
  function badge(sq: string, html: string, extra = '') {
    if (!activeEvent?.copied && [...square(sq).querySelectorAll<HTMLElement>('.badge')].some(el => !el.dataset.copy)) return null;
    const el = document.createElement('span'); el.className = `badge ${extra}`; el.innerHTML = html;
    return add(el, square(sq));
  }
  function resultBadge(mark: OutcomeMarker) {
    const icon = mark.icon;
    const el = badge(mark.square, statusGlyph(icon, mark.side), `outcome-badge status-${icon}`);
    if (!el) return;
    el.title = mark.title;
    const frames = icon === 'win' ? [ { transform: 'translateY(-10px) scale(0)', opacity: 0 }, { transform: 'translateY(2px) scale(1.25)', opacity: 1, offset: .7 }, { transform: 'translateY(0) scale(1)', opacity: 1 } ]
      : [{ transform: 'scale(.8)', opacity: 0 }, { transform: 'scale(1.04)', opacity: 1, offset: .7 }, { transform: 'scale(1)', opacity: 1 }];
    animate(el, frames, 240);
  }
  function particles(sq: string, duration: number) {
    const parts = Object.entries(activeEvent?.motions || {}).filter(([id]) => id.startsWith(NAG_PARTICLE_PREFIX));
    if (!parts.length) return;
    const anchor = document.createElement('span'); anchor.className = 'badge nag-particle-anchor';
    anchor.style.setProperty('--nag-color', `var(--${plan.cls || 'best'})`); add(anchor, square(sq));
    for (const [id, motion] of parts) {
      const el = document.createElement('span'); el.className = 'nag-particle'; el.dataset.partId = id;
      el.dataset.particleIndex = String(Number(id.split('-').at(-1)) + 1); add(el, anchor);
      animate(el, motionKeyframes(motion.frames, unit, flip), duration, 0, 'linear');
    }
  }
  const owner = {};
  board.animationOwner = owner;
  try {
    renderBoard(board, move.fenAfter, { flip, chesscom, lastMove: move, project });
    board.classList.add('motion-active');
    if (identity) for (const [sq, id] of Object.entries(identity.after)) {
      if (piece(sq)) piece(sq).dataset.objectId = id;
    }
    activeEvent = plan.events.find(event => event.type === 'previous') || null;
    oldHighlights.forEach(mark => highlight(mark.square, mark.color, true));
    activeEvent = plan.events.find(event => event.type === 'target') || null;
    board.querySelectorAll<HTMLElement>('.hl').forEach(el => highlight(el.dataset.sq!, el.style.getPropertyValue('--hl-col') || '#edf272'));
    activeEvent = null;
    // Reconstruct the previous visual position with movable sprites over the final
    // DOM. This keeps square layout fixed while captures and promotions overlap.
    for (const p of plan.pieces) {
      lifetimes.set(piece(p.to), [Infinity, Infinity]);
      const img = ghost(p.type, p.color, p.from);
      const a = sqCR(p.from, flip), b = sqCR(p.to, flip);
      ghosts.set(p.to, { img, x: (b.c - a.c) * unit, y: (b.r - a.r) * unit,
        tilt: Math.sign(b.c - a.c || a.r - b.r) * (p.type === 'n' ? 32 : 26) });
    }
    const victim = plan.capturedSquare ? before.get(plan.capturedSquare as import("./types.ts").Square) : null;
    const captured = victim ? ghost(victim.type, victim.color, plan.capturedSquare!) : null;
    if (captured?.dataset.objectId) captured.dataset.trackId = effectTrack(captured.dataset.objectId, 'capture');
    captured?.classList.add('motion-victim');
    const terminalMarks = outcomeMarkers(plan.outcome, move.fenAfter);
    const dispatch = (event: AnimationEvent) => {
      const main = ghosts.get(move.to)!, end = `translate(${main.x}px,${main.y}px)`;
      switch (event.type) {
        case 'previous': break;
        case 'target':

          break;
        case 'move': {
          const p = event.piece!, sprite = ghosts.get(p.to)!, { x, y, tilt } = sprite;
          const hop = p.type === 'n' ? unit * .28 : 0;
          // Keep the lean during travel. Translation and rotation share one linear
          // final segment, so neither can finish before the other.
          animate(sprite.img, [
            { transform: 'translate(0px,0px) rotate(0deg)', offset: 0, easing: 'ease-out' },
            { transform: `translate(0px,0px) rotate(${-tilt}deg)`, offset: .18, easing: 'cubic-bezier(.45,0,.25,1)' },
            { transform: `translate(${x * .8}px,${y * .8 - hop}px) rotate(${-tilt * .85}deg)`, offset: .75, easing: 'linear' },
            { transform: `translate(${x}px,${y}px) rotate(0deg)`, offset: 1 },
          ], p.duration, 0, 'linear');
          break;
        }
        case 'land':
          break;
        case 'capture': {
          animate(captured, [{ transform: 'scale(1) rotate(0deg)', opacity: 1 },
            { transform: `scale(.65) rotate(${main.tilt * .2}deg)`, opacity: .85, offset: .55 },
            { transform: `scale(0) rotate(${main.tilt * .4}deg)`, opacity: 0 }], event.duration!, 0, 'ease-in');
          break;
        }
        case 'promotion':
          animate(main.img, [{ transform: `${end} rotate(0deg) scale(1)`, opacity: 1 }, { transform: `${end} rotate(0deg) scale(0)`, opacity: 0 }], 100);
          lifetimes.set(piece(move.to), [logicalTime / speed, Infinity]);
          animate(piece(move.to), [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], 100, 100);
          break;
        case 'settle':
          for (const p of plan.pieces) {
            lifetimes.get(ghosts.get(p.to)!.img)![1] = logicalTime / speed;
            if (lifetimes.get(piece(p.to))![0] === Infinity) lifetimes.set(piece(p.to), [logicalTime / speed, Infinity]);
          }
          if (captured) lifetimes.get(captured)![1] = logicalTime / speed;
          break;
        case 'check':
          hit(plan.check!, move.to, event.duration!);
          if (event.step) flashPath(event.step, event.enterDuration!);
          break;
        case 'relation':

          break;
        case 'relation-square':
          flashPath(event.step!, event.duration!);
          break;
        case 'hit': hit(event.relation!.via || event.relation!.to, event.relation!.from, event.duration!); break;
        case 'relation-exit':
          animate(paths.get(event.step!), [{ opacity: 1 }, { opacity: 0 }], event.duration!, 0, 'linear');
          break;
        case 'gift': {
          if (plan.freePiece!.to !== move.to && !terminalMarks.some(mark => mark.square === plan.freePiece!.to)) {
            const gift = badge(plan.freePiece!.to, tacticGlyph('free_piece'), 'tactic-badge'); animate(gift, nagFrames('best'), 220);
          }
          break;
        }
        case 'nag': {
          if (plan.cls && !terminalMarks.some(mark => mark.square === move.to)) {
            const el = badge(move.to, glyphSvg(plan.cls), 'nag-badge');
            animate(el, nagFrames(plan.cls), NAG_ENTER_MS, 0, 'linear');
            if (el) {
              el.style.setProperty('--nag-color', `var(--${plan.cls})`);
              const halo = document.createElement('span'); halo.className = 'nag-halo'; add(halo, el);
              animate(halo, [{ opacity: 0 }, { opacity: .55, offset: .6 }, { opacity: .25 }], NAG_ENTER_MS, 0, 'linear');
              const ring = document.createElement('span'); ring.className = 'nag-ring';
              add(ring, el);
              animate(ring, [{ transform: 'scale(.8)', opacity: 0 }, { transform: 'scale(1.4)', opacity: .8, offset: .3 },
                { transform: 'scale(3.1)', opacity: 0 }], NAG_RING_MS, NAG_ENTER_MS / 2, 'linear');
              particles(move.to, NAG_ENTER_MS);
            }
          }
          break;
        }
        case 'result': terminalMarks.filter(mark => mark.icon !== 'win').forEach(mark => resultBadge(mark)); break;
        case 'winner': terminalMarks.filter(mark => mark.icon === 'win').forEach(mark => resultBadge(mark)); break;
        case 'nag-exit': {
          const badges = [...board.querySelectorAll<HTMLElement>('.nag-badge,.tactic-badge')].filter(el => !el.dataset.copy);
          badges.forEach(el => animate(el, nagExitFrames(), NAG_EXIT_MS, 0, 'ease-in'));
          const anchor = badges.find(el => el.classList.contains('nag-badge')) || badges[0];
          if (anchor) particles(anchor.closest<HTMLElement>('.sq')!.dataset.sq!, NAG_EXIT_MS);
          break;
        }
      }
    };
    for (const event of plan.events) { logicalTime = event.at; activeEvent = event; if (!event.hidden) dispatch(event); }
    const scene = {
      motions,
      seek(time: number) {
        for (const [animation, start] of animationStarts) animation.currentTime = time - start;
        for (const { animation, motion } of sampled) {
          const frame = sampleMotion(motion, (time * speed - motion.startMs) / motion.durationMs);
          (animation.effect as KeyframeEffect).setKeyframes(motionKeyframes([0, 1].map(offset => ({ ...frame, offset, easing: 'linear' })), unit, flip));
        }
        for (const [el, [start, end]] of lifetimes) el.style.visibility = time >= start && time < end ? '' : 'hidden';
        const picks = new Map<HTMLElement, typeof motionElements[number]>();
        for (const entry of motionElements) if (!picks.has(entry.el) || entry.motion.startMs <= time * speed) picks.set(entry.el, entry);
        for (const { el, motion, objectId } of picks.values()) {
          el.dataset.motionObjectId = objectId; el.dataset.motionClipId = motion.clipId; el.dataset.motionId = motion.id;
        }
      },
      dispose() {
        animations.forEach(animation => animation.cancel()); temporary.forEach(el => el.remove());
        if (board.animationOwner === owner) {
          board.classList.remove('motion-active'); delete board.animationOwner;
        }
      },
    };
    scene.seek(0);
    return scene;
  } catch (error) {
    animations.forEach(animation => animation.cancel()); temporary.forEach(el => el.remove());
    board.classList.remove('motion-active'); delete board.animationOwner;
    throw error;
  }
}

// Reuse each move's authored scene, composing only unfinished moves on one board.
export function createSequenceScene(board: BoardElement, plans: AnimationPlan[], segments: Segment[], index: number, options: SceneOptions = {}): Scene {
  const map = timeMap(plans), origin = map.ranges[index].start;
  const active = map.ranges.filter(r => r.index <= index && (r.index === index || r.end > origin));
  if (active.length === 1) return createMoveScene(board, plans[index].move, { ...options, plan: plans[index], identity: segments[index], previousMove: plans[index - 1]?.move || null });
  const layers: { index: number; start: number; end: number; scene: Scene; nodes: { el: HTMLElement; square?: string }[] }[] = [];
  const capturedAt = new Map(segments.slice(0, index + 1).filter(s => s.capturedObjectId).map(s => {
    const i = s.ply - 1;
    return [s.capturedObjectId!, map.ranges[i].start + plans[i].events.find(e => e.type === 'settle')!.at];
  }));
  const moves = plans.slice(0, index + 1).flatMap((plan, i) => plan.pieces.map(piece => ({
    id: segments[i].before[piece.from], index: i, start: map.ranges[i].start + piece.start,
    end: map.ranges[i].start + plan.events.find(e => e.type === 'settle')!.at,
  })));
  try {
    for (const range of active) {
      const i = range.index, plan = plans[i];
      const scene = createMoveScene(board, plan.move, { ...options, plan, identity: segments[i], previousMove: plans[i - 1]?.move || null });
      const nodes: typeof layers[number]['nodes'] = [];
      for (const child of [...board.children] as HTMLElement[]) {
        if (child.classList.contains('sq')) {
          for (const el of [...child.children] as HTMLElement[]) if (!el.classList.contains('coord')) { nodes.push({ el, square: child.dataset.sq }); el.remove(); }
        } else { nodes.push({ el: child }); child.remove(); }
      }
      layers.push({ ...range, scene, nodes });
    }
    for (const layer of layers) for (const { el, square } of layer.nodes) {
      (square ? board.querySelector(`[data-sq="${square}"]`)! : board).appendChild(el);
      el.dataset.scenePly = String(layer.index + 1);
    }
    return {
      motions: layers.flatMap(layer => layer.scene.motions.map(m => ({ ...m, startMs: m.startMs + layer.start - origin }))),
      seek(local: number) {
        const time = origin + local, owners = new Map<string, number>();
        for (const layer of layers) {
          layer.scene.seek(Math.max(0, time - layer.start));
          if (layer.index !== index && time >= layer.end) continue;
          const plan = plans[layer.index], identity = segments[layer.index];
          for (const event of plan.events) if (['hit', 'check'].includes(event.type) && time >= layer.start + event.at && time < layer.start + event.at + (event.duration || 0)) {
            const square = event.type === 'check' ? plan.check : event.relation?.via || event.relation?.to;
            if (square && identity.after[square] && identity.after[square] === segments[index].after[square]) owners.set(identity.after[square], layer.index);
          }
        }
        const currentMoves = new Map<string, typeof moves[number]>();
        for (const move of moves) if (!currentMoves.has(move.id) || time >= move.start) currentMoves.set(move.id, move);
        for (const move of currentMoves.values()) if (time < move.end) owners.set(move.id, move.index);
        for (const layer of layers) if (layer.index === index || time < layer.end) {
          const identity = segments[layer.index];
          const capture = plans[layer.index].events.find(e => e.type === 'capture');
          if (identity.capturedObjectId && capture && time >= layer.start + capture.at) owners.set(identity.capturedObjectId, layer.index);
        }
        for (const layer of layers) for (const { el } of layer.nodes) {
          const piece = el.matches('.pc,.motion-piece');
          const id = el.dataset.objectId!;
          el.style.display = (layer.index !== index && time >= layer.end) || piece && ((owners.get(id) ?? index) !== layer.index || time >= (capturedAt.get(id) ?? Infinity)) ? 'none' : '';
        }
      },
      dispose() { for (const layer of layers) { layer.scene.dispose(); for (const { el } of layer.nodes) el.remove(); } },
    };
  } catch (error) { for (const layer of layers) layer.scene.dispose(); throw error; }
}

export function animationPhase(plan: AnimationPlan, time: number) {
  let phase = '上一局面';
  for (const event of plan.events) {
    if (event.at > time) break;
    const r = event.relation;
    phase = ({ target: '目标预提示', move: '走子', land: '落子', check: plan.mate ? '将死' : '将军',
      'nag-exit': '收尾', result: '终局', winner: '获胜' } as Record<string, string>)[event.type] || (event.type === 'relation'
        ? r!.kind === 'defense' ? '落点防御 · 蓝色' : '移动棋子的攻击 · 红色' : phase);
  }
  return phase;
}

// Existing offline frame driver and standalone demos share the same sampled scene.
// The editor owns its RAF clock and samples createMoveScene() directly.
export async function animateMove(board: BoardElement, move: Move, options: SceneOptions = {}) {
  const { flip = false, chesscom = false, outcome = null, signal, onLand = () => {}, onEvaluation = () => {}, onPhase = (_phase: string) => {} } = options;
  const speed = Math.min(2, Math.max(.5, Number(options.speed) || 1));
  const plan = options.plan || buildAnimationPlan(move, { outcome });
  const finalOptions = { flip, chesscom, lastMove: move, project: options.project, outcomeBadges: outcomeMarkers(plan.outcome, move.fenAfter) };
  if (signal?.aborted) return false;
  if (options.reduced || typeof board.animate !== 'function') {
    renderBoard(board, move.fenAfter, finalOptions); onLand(); onEvaluation(); onPhase('静态播放');
    return runTimeline([], Math.max(350, 700 / speed), { signal, dispatch() {} });
  }
  const scene = createMoveScene(board, move, { ...options, plan });
  const start = performance.now();
  const timer = options.timeline ? null : setInterval(() => scene.seek(performance.now() - start), 16);
  try {
    return await (options.timeline || runTimeline)(plan.events.map(event => ({ ...event, at: timelineTime(event.at, speed) })), timelineTime(plan.duration, speed), {
      signal, seek: (time: number) => scene.seek(time), dispatch(event: AnimationEvent) {
        scene.seek(event.at); onPhase(animationPhase(plan, event.at * speed));
        if (event.type === 'land') { onLand(); onEvaluation(); }
      },
    });
  } finally {
    if (timer !== null) clearInterval(timer); scene.dispose();
    if (!signal?.aborted) renderBoard(board, move.fenAfter, finalOptions);
  }
}
