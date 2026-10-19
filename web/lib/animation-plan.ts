import type { Move, Color, Square, PieceSymbol, Relation, RelationStep, FreePiece, AnimationPlan, AnimationEvent, MovingPiece, Outcome, ClassId } from './types.ts';
import { Chess, SQUARES } from '../vendor/chess.ts';
import { seeGain, moveClass } from './review.ts';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const PATH_STEP_MS = 60;
export const PATH_ENTER_MS = 100;
export const PATH_FADE_MS = 400;
export const HIGHLIGHT_FADE_MS = 280;
export const THREAT_MS = 440;
export const NAG_ENTER_MS = 320;
export const NAG_RING_MS = 360;
export const NAG_EXIT_MS = 240;
const opposite = (color: Color): Color => color === 'w' ? 'b' : 'w';
const coords = (square: string): [number, number] => [square.charCodeAt(0) - 97, Number(square[1]) - 1];
const squareAt = (x: number, y: number): Square | null => x >= 0 && x < 8 && y >= 0 && y < 8 ? ('abcdefgh'[x] + (y + 1)) as Square : null;

// Only narrate relationships involving a piece moved this turn. An attack is not a
// promise of winning material; the latter requires the reviewer's SEE evidence.
function xRays(chess: Chess, color: Color): Relation[] {
  const result: Relation[] = [];
  for (const from of SQUARES) {
    const piece = chess.get(from);
    if (piece?.color !== color || !'brq'.includes(piece.type)) continue;
    const directions: [number, number][] = [];
    if ('rq'.includes(piece.type)) directions.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    if ('bq'.includes(piece.type)) directions.push([1, 1], [-1, 1], [1, -1], [-1, -1]);
    for (const [dx, dy] of directions) {
      let [x, y] = coords(from); let first: { square: Square; type: PieceSymbol } | null = null;
      for (let n = 1; n < 8; n++) {
        const to = squareAt(x + dx * n, y + dy * n);
        if (!to) break;
        const target = chess.get(to);
        if (!target) continue;
        if (target.color === color) break;
        if (!first) { first = { square: to, type: target.type }; continue; }
        const kind = target.type === 'k' || (target.type === 'q' && VALUE[first.type] < 9) ? 'pin'
          : VALUE[first.type] > VALUE[target.type] && VALUE[target.type] >= 3 ? 'skewer' : null;
        if (kind) result.push({ kind, from, via: first.square, to, piece: piece.type, value: 101 });
        break;
      }
    }
  }
  return result;
}

export function tacticalRelations(move: Move) {
  const after = new Chess(move.fenAfter);
  const own = move.color, enemy = opposite(own), relations: Relation[] = [];
  const moved: string[] = [move.to];
  if (move.flags?.includes('k') || move.flags?.includes('q')) moved.push((move.flags.includes('k') ? 'f' : 'd') + move.to[1]);
  for (const to of SQUARES) {
    const target = after.get(to);
    if (target?.color !== enemy) continue;
    for (const from of after.attackers(to as Square, own)) {
      if (!moved.includes(from)) continue;
      relations.push({ kind: 'attack', from, to, piece: after.get(from)!.type, value: VALUE[target.type] });
    }
  }
  // Defenders matter here only when the moved piece lands under enemy control.
  for (const to of moved) {
    if (!after.isAttacked(to as Square, enemy)) continue;
    for (const from of after.attackers(to as Square, own)) {
      relations.push({ kind: 'defense', from, to, piece: after.get(from)!.type, value: VALUE[after.get(to as Square)!.type] });
    }
  }
  for (const ray of xRays(after, own).filter(ray => moved.includes(ray.from))) {
    const redundant = relations.findIndex(r => r.kind === 'attack' && r.from === ray.from && r.to === ray.via);
    if (redundant >= 0) relations.splice(redundant, 1);
    relations.unshift({ ...ray, value: 101 });
  }
  let freePiece: FreePiece | null = null;
  if (move.motif?.kind === 'hung-piece') {
    const captures = after.moves({ verbose: true }).filter(m => m.captured && VALUE[m.captured] >= 3);
    for (const capture of captures) {
      const gain = seeGain(move.fenAfter, capture.to);
      if (gain >= 3 && (!freePiece || gain > freePiece.gain)) freePiece = { from: capture.from, to: capture.to, gain, piece: capture.piece };
    }
  }
  relations.sort((a, b) => Number(a.kind === 'defense') - Number(b.kind === 'defense') || b.value - a.value);
  const fork = relations.some(r => r.kind === 'attack' && relations.filter(other => other.kind === 'attack' && other.from === r.from).length >= 2);
  const king = SQUARES.find(sq => after.get(sq)?.type === 'k' && after.get(sq)?.color === enemy);
  return { relations, fork, freePiece, check: after.isCheck() ? king ?? null : null, mate: after.isCheckmate() };
}

// Knights jump: intermediate squares must not look controlled by the knight.
export function pathSquares(from: string, to: string) {
  const dx = to.charCodeAt(0) - from.charCodeAt(0), dy = Number(to[1]) - Number(from[1]);
  if (dx && dy && Math.abs(dx) !== Math.abs(dy)) return [from, to];
  return Array.from({ length: Math.max(Math.abs(dx), Math.abs(dy)) + 1 }, (_, i) =>
    String.fromCharCode(from.charCodeAt(0) + Math.sign(dx) * i) + (Number(from[1]) + Math.sign(dy) * i));
}

export function relationSteps(relation: Relation): RelationStep[] {
  const defense = relation.kind === 'defense';
  // Both paths start at the piece supplying the attack or defense.
  const squares = pathSquares(relation.from, relation.to);
  const blocker = relation.via ? squares.indexOf(relation.via) : squares.length;
  return squares.map((square, index) => ({ square,
    tone: defense ? 'defense-path' : index > blocker ? 'xray-path' : 'attack-path',
    attacked: !defense && square === (relation.via || relation.to) }));
}

export function nagFrames(cls: string): Keyframe[] {
  const peak = ({ brilliant: 1.28, great: 1.24, best: 1.2, excellent: 1.14, good: 1.12, forced: 1.12, book: 1.08, blunder: 1.24 } as Record<string, number>)[cls] || 1.18;
  const tilt = ['book', 'forced', 'good'].includes(cls) ? 35 : 65;
  return [{ transform: `rotate(${-tilt}deg) scale(0)` },
    { transform: `rotate(8deg) scale(${peak})`, offset: .65 },
    { transform: 'rotate(-2deg) scale(.96)', offset: .85 },
    { transform: 'rotate(0deg) scale(1)' }];
}

export function buildAnimationPlan(move: Move, { outcome = null }: { outcome?: Outcome | null } = {}): AnimationPlan {
  const before = new Chess(move.fenBefore), piece = before.get(move.from)!;
  const tactics = tacticalRelations(move);
  const cls = moveClass(move);
  const castle = move.flags?.includes('k') || move.flags?.includes('q');
  const capture = !!move.captured;
  const duration = castle ? 520 : capture ? 480 : 460;
  const start = 100, land = start + duration;
  const pieces: MovingPiece[] = [{ from: move.from, to: move.to, type: piece.type, color: piece.color, start, duration }];
  if (castle) {
    const rank = move.from[1], short = move.flags.includes('k');
    pieces.push({ from: (short ? 'h' : 'a') + rank, to: (short ? 'f' : 'd') + rank, type: 'r', color: piece.color, start: start + 50, duration: duration - 50 });
  }
  const capturedSquare = capture ? (move.flags?.includes('e') ? move.to[0] + move.from[1] : move.to) : null;
  const factsDone = land + (move.promotion ? 200 : capture ? 60 : 0), nag = start;
  const relationStart = move.promotion ? land + 200 : land - 60;
  const hasGift = tactics.freePiece && tactics.freePiece.to !== move.to;
  let activeDone = Math.max(factsDone, cls ? nag + NAG_ENTER_MS / 2 + NAG_RING_MS : 0,
    hasGift ? factsDone + 220 : 0), checkDone = null;
  let tacticsDone = factsDone;
  const terminal = !!outcome;
  const events: AnimationEvent[] = [ { at: 0, type: 'previous' }, { at: 50, type: 'target' },
    ...pieces.map(p => ({ at: p.start, type: 'move' as const, piece: p })), { at: land, type: 'land' } ];
  if (capture) {
    const at = start + Math.round(duration * .48);
    events.push({ at, type: 'capture', duration: land + 60 - at });
  }
  if (move.promotion) events.push({ at: land, type: 'promotion' });
  events.push({ at: factsDone, type: 'settle' });
  const hitSquares = new Set();
  tactics.relations.forEach(relation => {
    const steps = relationSteps(relation), target = relation.via || relation.to;
    const defense = relation.kind === 'defense';
    const at = defense ? factsDone : relationStart;
    events.push({ at, type: 'relation', relation });
    const last = at + (steps.length - 1) * PATH_STEP_MS;
    steps.forEach((step, index) => {
      const fadeAt = last + PATH_ENTER_MS + index * PATH_STEP_MS;
      events.push({ at: at + index * PATH_STEP_MS, type: 'relation-square', relation, step, duration: PATH_ENTER_MS },
        { at: fadeAt, type: 'relation-exit', relation, step, duration: PATH_FADE_MS });
      tacticsDone = Math.max(tacticsDone, fadeAt + PATH_FADE_MS);
    });
    if (defense) return;
    const hitAt = at + steps.findIndex(step => step.attacked) * PATH_STEP_MS + 40;
    if (!hitSquares.has(target)) {
      if (target === tactics.check) { checkDone = hitAt + THREAT_MS; events.push({ at: hitAt, type: 'check', duration: THREAT_MS }); }
      else events.push({ at: hitAt, type: 'hit', relation, duration: THREAT_MS });
      tacticsDone = Math.max(tacticsDone, hitAt + THREAT_MS);
    }
    hitSquares.add(target);
  });
  if (tactics.check && checkDone === null) {
    const at = land + 40;
    const step = { square: tactics.check, tone: 'attack-path', attacked: true };
    events.push({ at, type: 'check', step, duration: THREAT_MS, enterDuration: PATH_ENTER_MS },
      { at: at + PATH_ENTER_MS, type: 'relation-exit', step, duration: PATH_FADE_MS });
    checkDone = at + THREAT_MS;
    tacticsDone = Math.max(tacticsDone, checkDone, at + PATH_ENTER_MS + PATH_FADE_MS);
  }
  if (hasGift) {
    events.push({ at: factsDone, type: 'gift' });
  }
  events.push({ at: nag, type: 'nag' });
  if (terminal) {
    const resultAt = Math.max(factsDone, checkDone ?? factsDone);
    events.push({ at: resultAt, type: 'result' });
    if (outcome.winner) events.push({ at: resultAt + 150, type: 'winner' });
    activeDone = Math.max(activeDone, resultAt + (outcome.winner ? 390 : 240));
  }
  // Let badge exit and tactics finish in parallel, without retiming or cutting
  // any animation. The next move starts as soon as both have completed.
  events.push({ at: activeDone, type: 'nag-exit' });
  return { move, cls, pieces, capturedSquare, ...tactics, events: events.sort((a, b) => a.at - b.at),
    duration: Math.max(tacticsDone, activeDone + (cls || hasGift ? NAG_EXIT_MS : 0)), nagAt: nag, outcome: terminal ? outcome : null };
}

export function timelineTime(time: number, speed = 1) {
  const pace = Math.min(2, Math.max(.5, Number(speed) || 1));
  return time / pace;
}
