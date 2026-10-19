import type { Move, AnalyzedMove, Review, ClassId, Color, Phase, EngineNode, Evaluation, ReviewEngine, SearchOptions, PieceSymbol, Square } from './types.ts';
// Adapted from Barabosik/chess-analyzer @ b89cbf1 (GPL-3.0). See THIRD_PARTY.md.
// Full-game review: runs the engine over every position, classifies each move,
// and estimates per-side accuracy. CP/mate are White's POV; expected scores are the mover's POV.
import { Chess } from "../vendor/chess.ts";
import { OPENING_POSITIONS } from "../vendor/openings.ts";
import { explainMove } from "./motifs.ts";

export const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function formatEval(move: Partial<Move> | null | undefined) {
  if (!move || move.cpWhite == null) return '—';
  if (move.san?.endsWith('#')) return move.color === 'w' ? '1–0' : '0–1';
  if (move.mateWhite != null) return `${move.mateWhite < 0 ? '−' : ''}M${Math.abs(move.mateWhite)}`;
  return (move.cpWhite > 0 ? '+' : '') + (move.cpWhite / 100).toFixed(1);
}

// Legal move orders can transpose into the same opening position; rights still matter.
export function bookLookup(fen: string, uci: string) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  try {
    const chess = new Chess(fen);
    chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci.slice(4) || undefined });
    return OPENING_POSITIONS[chess.fen().split(' ').slice(0, 4).join(' ')] || null;
  } catch { return null; }
}

const BOOK_MAX_LOSS = 0.05; // expected points

// A Brilliant must hand over at least this much material on net, having offered a
// piece (>= 3 points) to do it. See the sacrifice test for why both halves matter.
const SAC_MIN_GIVEN = 1;
// The deepest named opening the game reached.
export function detectOpening(moves: Move[]) {
  let last = null;
  for (let i = 0; i < moves.length && i < 30; i++) {
    const e = bookLookup(moves[i].fenBefore, moves[i].uci);
    if (e) last = e;
  }
  return last;
}

// Classification metadata (id -> glyph/label/colour var). Order = display order.
export const CLASSES: Record<ClassId, { g: string; label: string; v: string }> = {
  brilliant:  { g: "!!", label: "Brilliant",  v: "--brilliant" },
  great:      { g: "!",  label: "Great",  v: "--great" },
  best:       { g: "★", label: "Best", v: "--best" },
  excellent:  { g: "✓", label: "Excellent",   v: "--excellent" },
  good:       { g: "•", label: "Good",     v: "--good" },
  forced:     { g: "→", label: "Forced",   v: "--forced" },
  book:       { g: "◇", label: "Book",     v: "--book" },
  inaccuracy: { g: "?!", label: "Inaccuracy",  v: "--inacc" },
  mistake:    { g: "?",  label: "Mistake",     v: "--mistake" },
  miss:       { g: "×", label: "Miss",        v: "--miss" },
  blunder:    { g: "??", label: "Blunder",     v: "--blunder" },
};
export const CLASS_ORDER: ClassId[] = ["brilliant", "great", "best", "excellent", "good", "forced", "book", "inaccuracy", "mistake", "miss", "blunder"];

export function moveClass(move: Move | null | undefined): ClassId | null {
  return move?.cls || (({ 1: 'great', 2: 'mistake', 3: 'brilliant', 4: 'blunder', 6: 'inaccuracy', 7: 'forced' } as Record<number, ClassId>)[move?.nags?.[0] ?? -1]) || null;
}

export const CLASS_INFO: Record<ClassId, string> = {
  brilliant: '妙手 · 有补偿的弃子，走后局面仍然成立。',
  great: '关键着 · 最佳选择明显优于第二候选。',
  best: '最佳着 · 与本次搜索的引擎第一选择完全一致。',
  excellent: '优秀 · 几乎没有损失局面价值。',
  good: '好棋 · 合理选择，存在小幅改进空间。',
  forced: '强制着 · 当前局面仅有一个合法着法。',
  book: '理论着 · 命中本地开局线路。',
  inaccuracy: '不精准 · 局面价值有所下降。',
  mistake: '失误 · 明显损失局面价值。',
  miss: '错失机会 · 未利用对手上一手送出的胜机。',
  blunder: '严重失误 · 局面价值大幅下降。',
};

export function classifyMove({ legalCount, book = false, sacrifice = false, expectedPointsLoss, isBest = false, gap = null, evalAfter = 0, evalBefore = 0, materialBefore = 0, priorChance = null, chanceBefore = 0, chanceAfter = 0 }: { legalCount: number; book?: boolean; sacrifice?: boolean; expectedPointsLoss: number; isBest?: boolean; gap?: number | null; evalAfter?: number; evalBefore?: number; materialBefore?: number; priorChance?: number | null; chanceBefore?: number; chanceAfter?: number }): ClassId {
  const loss = expectedPointsLoss;
  if (legalCount === 1) return 'forced';
  if (book) return 'book';
  if (sacrifice && loss < 0.03 && materialBefore > 3 && evalAfter >= 0 && evalAfter < 9000 && evalBefore <= 300) return 'brilliant';
  if (isBest && gap != null && gap >= 12 && loss < 0.02) return 'great';
  if (isBest && loss === 0) return 'best';
  // ponytail: fixed expected-score thresholds approximate missed wins; calibrate with a labelled corpus before adding rating models.
  if (priorChance != null && priorChance < 65 && chanceBefore >= 70 && chanceBefore - priorChance >= 10 && chanceAfter < 65 && loss >= 0.10) return 'miss';
  // Tolerance only absorbs floating-point subtraction at the inclusive boundaries.
  if (loss <= 0.02 + 1e-12) return 'excellent';
  if (loss <= 0.05 + 1e-12) return 'good';
  if (loss <= 0.10 + 1e-12) return 'inaccuracy';
  if (loss <= 0.20 + 1e-12) return 'mistake';
  return 'blunder';
}

// A position with no legal moves has no engine evaluation: Stockfish answers
// "bestmove (none)" with no principal variation, so `best` comes back null and
// the position reads as a dead-equal 0.00. For stalemate that happens to be
// right (a draw IS 0.00). For CHECKMATE it is badly wrong: the mating move looks
// like it threw the game away, and the mater's accuracy collapses (delivering
// Scholar's mate scored 51%). So decide terminal positions ourselves rather than
// asking the engine — which also saves a search.
export const MATE_CP = 100000;   // Terminal display value, not a numeric mate-distance penalty.
export const EXPECTED_SCORE_MODEL = 'logistic-cp-v1';

function terminalNode(fen: string, c = new Chess(fen)): EngineNode | null {
  if (!c.isGameOver()) return null;
  const stm = fen.split(" ")[1] === "b" ? "b" : "w";
  const best = c.isCheckmate()
    // the side to move is the one being mated, so the other side just won
    ? { cp: stm === "b" ? MATE_CP : -MATE_CP, mate: null, wdl: [0, 0, 1000] }
    : { cp: 0, mate: null, wdl: [0, 1000, 0] }; // stalemate or another draw
  return { stm, bestmove: null, best, played: best, lines: [best] };
}

export function winPct(cp: number) {
  return 100 / (1 + Math.exp(-0.00368208 * cp));
}
function evalWhite(node: Evaluation | null | undefined) {
  if (!node) return 0;
  if (node.mate != null) return node.mate > 0 ? 10000 - node.mate * 10 : -10000 - node.mate * 10;
  return node.cp == null ? 0 : node.cp;
}
// Reuse the evaluation bar's fixed smooth curve, independent of player rating and WDL.
// ponytail: this is a score proxy, not calibrated human outcome probabilities or Chess.com CAPS;
// fit a replacement curve against labelled games if calibration becomes necessary.
export function expectedScore(evaluation: Partial<Pick<Evaluation, 'cp' | 'mate'>> | null | undefined, color: Color = 'w') {
  if (color !== 'w' && color !== 'b') throw new Error('无效的走棋方');
  const sign = color === 'w' ? 1 : -1;
  if (evaluation?.mate != null) {
    if (!Number.isInteger(evaluation.mate) || evaluation.mate === 0) throw new Error('引擎未返回有效将杀评估。');
    return sign * evaluation.mate > 0 ? 1 : 0;
  }
  if (typeof evaluation?.cp !== 'number' || !Number.isFinite(evaluation.cp)) throw new Error('引擎未返回有效评分，无法计算 Expected Points Loss。');
  return winPct(sign * evaluation.cp) / 100;
}
function material(chess: Chess, color: Color) {
  let sum = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.color === color) sum += VAL[sq.type];
    }
  }
  return sum;
}

// Static exchange evaluation: how much material the side to move can win by
// capturing on `square`, if both sides keep recapturing with their cheapest
// attacker and either may stop when the exchange turns bad.
//
// This replaces asking the engine "what would you reply?" to detect a sacrifice.
// That question is the wrong one twice over: the engine's reply may simply
// collect material that was ALREADY hanging before the move (a quiet pawn move
// like h3 was being called a sacrifice), and its choice of reply is not stable
// between runs at the same depth, so the same game could be reviewed twice and
// report different Brilliants. This local exchange heuristic is deterministic.
// ponytail: cheapest-attacker exchanges omit alternative captures and distant compensation;
// validate sacrifice candidates with deeper engine searches when precision matters.
const SEE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };   // king captures last

export function seeGain(fen: string, square: string): number {
  const c = new Chess(fen);
  const caps = c.moves({ verbose: true }).filter((m) => m.to === square && m.captured);
  if (!caps.length) return 0;
  caps.sort((a, b) => SEE_VAL[a.piece] - SEE_VAL[b.piece]);   // cheapest attacker first
  const m = caps[0];
  const c2 = new Chess(fen);
  c2.move({ from: m.from, to: m.to, promotion: m.promotion });
  // taking is optional, so a losing exchange is simply declined
  return Math.max(0, VAL[m.captured!] - seeGain(c2.fen(), square));
}
export function moveAccuracy(expectedPointsLoss: number) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * expectedPointsLoss * 100) - 3.1669));
}
export function accuracy(moveAccuracies: number[]) {
  return moveAccuracies.length ? moveAccuracies.reduce((a, b) => a + b, 0) / moveAccuracies.length : null;
}

// A rough game-rating estimate from mean expected-points loss, expressed as a percent.
//
// Be clear-eyed about what this is: measured against 64 real games, NO mapping from
// single-game play quality to Elo gets closer than ~850 points on average — a quiet
// game reads too strong and a sharp one too weak, whoever is playing.
// It was removed for exactly that reason, and re-added by request as
// a labelled estimate. The curve is chosen, not fitted: monotone in mean loss, and
// unlike the old one it does not saturate at 2100 — near-perfect play reads 2800+,
// mean loss ~4%/move reads ~1650, ~8 reads ~900.
//
// Now returned as a BAND, not a lone number, because a lone number reads as a verdict
// the data can't support. The band is the game's OWN spread mapped through the curve:
// the standard error of its mean loss (std / sqrt(n)), so a game of consistent small
// errors gives a tight band and an erratic one a wide band. A width floor keeps even a
// flawless-looking game from reading as a point estimate. This uses no external corpus
// — the centre is deliberately left where it is (there is nothing to re-fit it against),
// so the honest lever is showing uncertainty, not pretending to a lower number.
// null under 8 judged moves, where even this is too much to claim.
const eloCurve = (loss: number) => 3150 * Math.exp(-0.155 * Math.max(0, loss));
export function estimateElo(losses: number[]) {
  if (losses.length < 8) return null;
  const n = losses.length;
  const avg = losses.reduce((a, b) => a + b, 0) / n;
  const variance = losses.reduce((a, b) => a + (b - avg) * (b - avg), 0) / n;
  const se = Math.sqrt(variance / n);          // standard error of the mean loss
  const clamp = (x: number) => Math.max(250, Math.min(3200, x));
  const r50 = (x: number) => Math.round(clamp(x) / 50) * 50;
  const elo = eloCurve(avg);
  // More loss -> lower Elo, so the +se edge is the LOW end. Floor the half-width at
  // 200 Elo: one game maps to a band several hundred wide however clean it looks.
  const HALF = 200;
  const lo = Math.min(eloCurve(avg + se), elo - HALF);
  const hi = Math.max(eloCurve(avg - se), elo + HALF);
  return { elo: r50(elo), lo: r50(lo), hi: r50(hi) };
}

// Non-pawn material on the board, both sides: 62 at the start, 0 in a pawn endgame.
// Kings and pawns are excluded because neither ever leaves.
export function nonPawnMaterial(fen: string) {
  let t = 0;
  for (const ch of fen.split(" ")[0]) {
    const p = ch.toLowerCase();
    if (p === "n" || p === "b") t += 3;
    else if (p === "r") t += 5;
    else if (p === "q") t += 9;
  }
  return t;
}

// Which third of the game a move belongs to, for the accuracy breakdown.
//
// This is a PRESENTATION heuristic, not a claim about chess: it exists so the app can
// say "you leak eval in the middlegame", and it is deliberately crude. The endgame is
// decided by material rather than by move number, because a queen trade on move 14
// really does produce an endgame. The opening runs as long as theory did — floored at
// ply 12 so a game that leaves book on move 2 still has an opening to report, and
// capped at ply 24 so a deeply-booked game doesn't swallow the whole middlegame.
export const PHASE_ENDGAME_NPM = 20;   // of 62
export function phaseOf(fenBefore: string, ply: number, openingEndPly: number): Phase {
  if (nonPawnMaterial(fenBefore) <= PHASE_ENDGAME_NPM) return "endgame";
  return ply <= openingEndPly ? "opening" : "middlegame";
}

// moves: [{san, from, to, uci, color, fenBefore, fenAfter, moveNo}]
// Returns { moves:[...with expectedPointsLoss, moveAccuracy, cls, bestSan], accWhite, accBlack, counts }
export async function reviewGame(engine: ReviewEngine | ReviewEngine[], moves: Move[], startFen: string, opts: SearchOptions & { onProgress?: (done: number, total: number) => void; signal?: { cancelled?: boolean } } = {}): Promise<Review | null> {
  const depth = opts.depth ?? 14;
  const onProgress = opts.onProgress || ((_done: number, _total: number) => {});
  const signal = opts.signal || {};

  // One engine, or a pool of them. A review is ~100 INDEPENDENT positions, so it is
  // embarrassingly parallel: give each engine a slice and they never touch each other.
  //
  // Note this is the opposite of asking one engine for Threads=8. That is Lazy SMP —
  // eight threads piling onto the same short search, thrashing one shared hash table —
  // and it measured 5-6x SLOWER than a single thread here, as well as non-deterministic.
  // Separate engines on separate positions share nothing, so they just scale. (Measured:
  // 12.5s -> 2.6s on six.)
  const engines = Array.isArray(engine) ? engine : [engine];

  // Start every engine from a clean transposition table, so a review depends only on the
  // game being reviewed. Otherwise the same game scores differently depending on what was
  // analysed before it, and labels flip around the class boundaries.
  for (const e of engines) if (e.newGame) await e.newGame();

  // Each move has two independent searches at its root, plus one final position.
  const fens = moves.map((m) => m.fenBefore);
  fens.push(moves.length ? moves[moves.length - 1].fenAfter : startFen);

  const node: EngineNode[] = new Array(fens.length);
  const todo: number[] = [];
  let done = 0;
  const history = new Chess(startFen);
  for (let i = 0; i < fens.length; i++) {
    // A claimable draw can occur before the PGN ends; still analyse every played move.
    const term = i === moves.length ? terminalNode(fens[i], history) : null;
    if (term) { node[i] = term; onProgress(++done, fens.length); }
    else todo.push(i);
    if (i < moves.length) history.move(moves[i].san);
  }

  // The partition is STATIC — engine k takes every Nth position, always. A dynamic work
  // queue (whoever is free takes the next one) would be marginally faster and would let
  // TIMING decide which engine searches which position. Each engine holds its own hash,
  // so that would make the evaluations depend on the scheduler, and the same game would
  // review differently twice: exactly the irreproducibility this file already fought once.
  const N = engines.length;
  await Promise.all(engines.map(async (e, k) => {
    for (let j = k; j < todo.length; j += N) {
      if (signal.cancelled) return;
      const i = todo[j];
      const wantMulti = i < moves.length ? (opts.multipv ?? 2) : 1; // second-best only needed before a move
      // Clear search history at every root, including restricted searches below.
      // This avoids carrying an earlier search's extra work into one candidate.
      if (e.newGame) await e.newGame();
      const search = { depth, movetime: opts.movetime ?? 0, multipv: wantMulti, startFen, moves: moves.slice(0, i).map(m => m.uci) };
      node[i] = await e.analyse(fens[i], search);
      if (!node[i]?.best) throw new Error('引擎未返回有效评估，请重试。');
      expectedScore(node[i].best, fens[i].split(' ')[1] as Color);
      if (i < moves.length) {
        if (signal.cancelled) return;
        if (e.newGame) await e.newGame();
        // Always search the actual move separately, even when it was the first choice.
        // Both searches use the same depth/time limits and a cleared hash table.
        const played = await e.analyse(fens[i], { ...search, multipv: 1, searchmoves: [moves[i].uci] });
        if (!played?.best || played.best.move !== moves[i].uci) throw new Error('引擎未返回实战着法的有效评估，请重试。');
        expectedScore(played.best, moves[i].color);
        node[i].played = played.best;
      }
      onProgress(++done, fens.length);
    }
  }));
  if (signal.cancelled) return null;

  const out: AnalyzedMove[] = [];
  const counts = { w: {}, b: {} } as Record<Color, Record<ClassId, number>>;
  for (const k of CLASS_ORDER) { counts.w[k] = 0; counts.b[k] = 0; }

  // The book includes intermediate positions, so ordinary move-order transpositions match.
  // Once outside those positions, keep later re-entry from hiding an off-book detour.
  const named = moves.map(m => bookLookup(m.fenBefore, m.uci));
  let bookEnd = 0;      // last ply still counted as theory
  for (let i = 0; i < named.length; i++) {
    if (!named[i]) break;
    bookEnd = i + 1;
  }
  // The opening is named from the deepest named position the game reached, even
  // past bookEnd — reaching it by transposition still identifies the opening.
  let opening = null;
  for (let i = named.length - 1; i >= 0; i--) if (named[i]) { opening = named[i]; break; }

  // The opening phase runs as long as theory did, floored and capped — see phaseOf.
  const openingEnd = Math.min(24, Math.max(bookEnd, 12));

  let inBook = true;    // cleared for good the moment the game leaves theory

  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    const whiteMove = mv.color === "w";

    const before = node[i];
    const after = node[i + 1];
    // Compare the played move and best move at the same root, not two unrelated searches.
    const played = before.played;
    const expectedScoreBest = expectedScore(before.best, mv.color);
    const expectedScorePlayed = expectedScore(played, mv.color);
    const expectedPointsLoss = Math.max(0, expectedScoreBest - expectedScorePlayed);

    const bestUci = before.bestmove ?? before.best?.move;
    const sign = whiteMove ? 1 : -1;
    const isBest = !!bestUci && bestUci === mv.uci;

    let bestSan = null;
    if (bestUci) {
      const c = new Chess(mv.fenBefore);
      try {
        const m = c.move({ from: bestUci.slice(0, 2) as Square, to: bestUci.slice(2, 4) as Square, promotion: bestUci.slice(4, 5) || undefined });
        bestSan = m ? m.san : null;
      } catch (e) { bestSan = null; }
    }

    // Only-move gap: expected-score percentage points, in the same root POV.
    let gap = null;
    if (before.lines && before.lines.length >= 2) {
      gap = 100 * (expectedScore(before.lines[0], mv.color) - expectedScore(before.lines[1], mv.color));
    }

    // Sacrifice: the move must OFFER material — after it, the opponent can win at
    // least a couple of points by taking on the square just played to, and the
    // exchange there does not win it back. Two earlier attempts at this were both
    // wrong on real games: counting only the mover's own material called an
    // ordinary recapture a sacrifice (67% of Brilliants were plain trades), and
    // trusting the engine's best reply blamed a quiet move for material that was
    // already hanging before it.
    const cBefore = new Chess(mv.fenBefore);
    const matBefore = material(cBefore, mv.color);
    const taken = cBefore.get(mv.to);                           // what this move captured
    const winBack = seeGain(mv.fenAfter, mv.to);                // what the opponent wins back there
    const offered = new Chess(mv.fenAfter).get(mv.to);          // the piece now standing there
    // Net material handed over. Netting off the capture is essential: queen takes
    // queen and is recaptured gives up nothing, though the exchange on that square
    // still "wins" a queen for the opponent.
    const given = winBack - (taken ? VAL[taken.type] : 0);
    // A sacrifice offers a PIECE and ends up down on the deal. Requiring 2+ points
    // of loss instead would reject the commonest brilliancy there is — a bishop for
    // two pawns (Bxh6!) nets only 1 — while allowing any 1-point loss would promote
    // ordinary pawn sacs. Offering a piece is what makes it a sacrifice; how much
    // is left on the table afterwards only has to be more than nothing.
    const sac = offered && VAL[offered.type] >= 3 && given >= SAC_MIN_GIVEN;
    const evalAfterMover = sign * evalWhite(played);
    const evalBeforeMover = whiteMove ? evalWhite(before.best) : -evalWhite(before.best);

    // A move is theory only if the game is still inside the book phase AND the
    // move didn't actually cost anything. That second half matters: without it,
    // a blunder that lands on a named position would be labelled Book, which
    // hides it from the counts and suppresses its "better move" suggestion.
    // A costly move ENDS the book phase rather than merely skipping itself —
    // otherwise book moves could resume after it, which is the very thing this
    // is fixing. So book is always an unbroken prefix of the game.
    const bookEntry = inBook && i + 1 <= bookEnd && expectedPointsLoss < BOOK_MAX_LOSS
      ? (named[i] || true) : null;
    if (!bookEntry) inBook = false;

    // Book moves are theory, not YOUR play. Counting a memorised move as a 0%-loss
    // move of your own inflates accuracy — the more theory you happen to know, the
    // better your "accuracy" looks without you having found anything over the board.
    // They are excluded from every accuracy number below; they still show as Book in
    // the counts.
    const phase = phaseOf(mv.fenBefore, i + 1, openingEnd);

    const cls = classifyMove({ legalCount: cBefore.moves().length, book: !!bookEntry, sacrifice: sac, expectedPointsLoss, isBest, gap,
      evalAfter: evalAfterMover, evalBefore: evalBeforeMover, materialBefore: matBefore,
      priorChance: i > 0 ? 100 * expectedScore(node[i - 1].best, mv.color) : null,
      chanceBefore: expectedScoreBest * 100, chanceAfter: expectedScorePlayed * 100 });
    counts[mv.color][cls]++;

    // Name WHY a move went wrong (hung piece, fork, allowed mate, missed
    // material...). Decided statically from the position -- see motifs.ts.
    const motif = explainMove({ ...mv, cls }, before, after);

    // For the rare good moves, keep what makes them explainable: the engine's line
    // FROM AFTER the move (the follow-up that shows why the sacrifice works, or why
    // the only-move holds), the piece a brilliancy offered, and the gap to the
    // second-best move. A bad move explains itself with the line it should have
    // played (bestLine); a brilliant one explains itself with what happens next.
    const celebrated = cls === "brilliant" || cls === "great";
    const afterLine = celebrated && after.best && after.best.pv && after.best.pv.length
      ? after.best.pv : null;

    out.push({
      ...mv,
      phase,
      cpWhite: evalWhite(after.best),
      mateWhite: after.best ? after.best.mate : null,
      playedCpWhite: evalWhite(played),
      playedMateWhite: played?.mate ?? null,
      bestMove: bestUci || null,
      expectedScoreBest,
      expectedScorePlayed,
      expectedPointsLoss,
      moveAccuracy: moveAccuracy(expectedPointsLoss),
      // cls is the existing persisted classification field used throughout the editor.
      cls,
      // Book moves are theory — there is no "better" move to suggest.
      bestSan: bookEntry ? null : bestSan,
      bestFrom: bookEntry || !bestUci ? null : bestUci.slice(0, 2),
      bestTo: bookEntry || !bestUci ? null : bestUci.slice(2, 4),
      bestPromo: bookEntry || !bestUci ? null : bestUci.slice(4, 5) || null,
      bestCpWhite: evalWhite(before.best),       // eval if the best move had been played
      bestMateWhite: before.best ? before.best.mate : null,
      // the engine's principal variation from before the move (UCI), so "Explain"
      // can walk the best line move by move
      bestLine: bookEntry || !before.best ? null : (before.best.pv || null),
      showBetter: !bookEntry && ["inaccuracy", "mistake", "miss", "blunder"].includes(cls),
      motif: bookEntry ? null : motif,
      afterLine,
      sacPiece: cls === "brilliant" && offered ? offered.type : null,
      sacGiven: cls === "brilliant" ? given : null,
      onlyGap: cls === "great" && gap != null ? Math.round(gap) : null,
      // Opening name from the matched position.
      opening: named[i]?.[1] ?? null,
    });
  }

  // Aggregate individual accuracies, excluding Book and Forced for each side/phase.
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const judged = out.filter(m => m.cls !== 'book' && m.cls !== 'forced');
  const accOf = (color: Color, phase?: Phase) => {
    const scores = judged.filter(m => m.color === color && (!phase || m.phase === phase)).map(m => m.moveAccuracy);
    return scores.length ? { acc: r1(accuracy(scores)!), n: scores.length } : null;
  };

  const phases = {} as Review["phases"];
  for (const ph of ["opening", "middlegame", "endgame"] as const) phases[ph] = { w: accOf("w", ph), b: accOf("b", ph) };

  const lossesOf = (color: Color) =>
    judged.filter(m => m.color === color).map(m => m.expectedPointsLoss * 100);

  return {
    scoreModel: EXPECTED_SCORE_MODEL,
    moves: out,
    accWhite: accOf("w")?.acc ?? null,
    accBlack: accOf("b")?.acc ?? null,
    // Accuracy split by game phase, so the report can say WHERE the play leaks.
    // Each entry is { acc, n } or null when the side had no non-book move there.
    phases,
    // Rough per-side game-rating estimate (or null). See estimateElo for the caveats.
    est: { w: estimateElo(lossesOf("w")), b: estimateElo(lossesOf("b")) },
    counts,
    opening,
  };
}
