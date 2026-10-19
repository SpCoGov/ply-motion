import type { Game, Move, Outcome, OutcomeMarker } from './types.ts';
import { Chess, DEFAULT_POSITION } from '../vendor/chess.ts';

export const SAMPLE_PGN = `[Event "PlyMotion · 示例棋局"]
[White "White"]
[Black "Black"]
[Result "1-0"]

1. e4 e5 2. Nc3 Nc6 3. Nf3 Nf6 4. d4 exd4 5. Nxd4 Bb4
6. Nxc6 bxc6 7. Bd3 d5 8. exd5 O-O 9. O-O cxd5 10. Bg5 c6
11. Qf3 Bd6 12. Rae1 Rb8 13. b3 Bb4 14. Qg3 Be6 15. Qh4 h6
16. Bxh6 gxh6 17. Qxh6 Bxc3 18. Rxe6 Ne4 19. Rxe4 dxe4 20. Bxe4 f5 1-0`;

export function gameOutcome(chess: Chess, headers: Record<string, string> = {}): Outcome | null {
  let result = headers.Result;
  if (chess.isCheckmate()) result = chess.turn() === 'w' ? '0-1' : '1-0';
  else if (chess.isStalemate() || chess.isInsufficientMaterial()) result = '1/2-1/2';
  // Claimable draws and incomplete PGNs do not establish a finished result.
  return ['1-0', '0-1', '1/2-1/2'].includes(result) ? { result, winner: result === '1-0' ? 'w' : result === '0-1' ? 'b' : null } : null;
}

export const outcomeLabel = (outcome: Outcome) => outcome.winner === 'w' ? '白方获胜' : outcome.winner === 'b' ? '黑方获胜' : '和棋';

export function outcomeMarkers(outcome: Outcome | null, fen: string): OutcomeMarker[] {
  if (!outcome) return [];
  const chess = new Chess(fen), markers: OutcomeMarker[] = [];
  for (const row of chess.board()) for (const piece of row) {
    if (piece?.type !== 'k') continue;
    const won = outcome.winner === piece.color;
    markers.push({ square: piece.square, icon: won ? 'win' : outcome.winner ? 'loss' : 'draw', side: piece.color,
      title: (piece.color === 'w' ? '白方' : '黑方') + ' · ' + (won ? '获胜' : outcome.winner ? '落败' : '和棋') });
  }
  return markers;
}

// Read only mainline annotations; chess.js remains the authority on SAN and legality.
function readNags(pgn: string) {
  let variation = 0, text = '';
  const stripped = pgn.replace(/\[(?:[^"\]]|"(?:\\.|[^"\\])*")*\]/g, ' ').replace(/\{[^}]*\}|;[^\r\n]*/g, ' ');
  for (const char of stripped) {
    if (char === '(') { variation++; text += ' '; }
    else if (char === ')') { variation--; if (variation < 0) throw new Error('PGN 变例括号不匹配'); }
    else if (!variation) text += char;
  }
  if (variation) throw new Error('PGN 变例括号不匹配');
  const moves: number[][] = [];
  let result = null;
  const symbolic: Record<string, number> = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 };
  for (const token of text.replace(/\d+\.(?:\.\.)?/g, ' ').match(/\$\d+|[^\s$]+/g) || []) {
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) { result = token; continue; }
    if (/^\.+$/.test(token)) continue;
    if (/^\$/.test(token)) {
      const value = Number(token.slice(1));
      if (value > 255) throw new Error('NAG 编号必须为 0–255');
      if (moves.length) moves.at(-1)!.push(value);
    } else if (symbolic[token]) {
      if (moves.length) moves.at(-1)!.push(symbolic[token]);
    } else {
      const suffix = token.match(/[!?]+$/)?.[0];
      moves.push(suffix && symbolic[suffix] ? [symbolic[suffix]] : []);
    }
  }
  return { moves, result };
}

export function parsePgn(text: string): Game {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请粘贴或打开一个 PGN 棋谱。');
  if (text.length > 1_000_000) throw new Error('PGN 文件过大，请选择不超过 1 MB 的单盘棋谱。');
  if ((text.match(/\[Event\s+"/gi) || []).length > 1) throw new Error('请一次导入一盘棋局。');
  const chess = new Chess();
  chess.loadPgn(text);
  const headers = chess.getHeaders();
  if (headers.Variant && !/^(standard|chess|normal)$/i.test(headers.Variant)) throw new Error('当前仅支持标准国际象棋。');
  const history = chess.history({ verbose: true });
  if (!history.length) throw new Error('棋谱中没有可播放的着法。');
  if (history.length > 2000) throw new Error('单盘棋谱最多支持 2000 个半回合。');
  const annotations = readNags(text), nags = annotations.moves;
  if (annotations.result && (!headers.Result || headers.Result === '*')) headers.Result = annotations.result;
  if (nags.length !== history.length) throw new Error('PGN 主线或 NAG 无法对应，请检查棋谱格式。');
  const moves: Move[] = history.map((m, i) => ({ san: m.san, uci: m.from + m.to + (m.promotion || ''), from: m.from, to: m.to,
    promotion: m.promotion, color: m.color, captured: m.captured, flags: m.flags,
    fenBefore: m.before, fenAfter: m.after, moveNo: Number(m.before.split(' ')[5]), nags: nags[i], ply: i + 1 }));
  const replay = new Chess(moves[0].fenBefore);
  for (const move of moves) {
    if (replay.moves().length === 1) {
      move.cls = 'forced';
    }
    replay.move(move.san);
  }
  return { headers, startFen: moves[0]?.fenBefore || headers.FEN || DEFAULT_POSITION, moves, pgn: text, outcome: gameOutcome(replay, headers) };
}
