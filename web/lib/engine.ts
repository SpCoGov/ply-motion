import type { EngineSource, EngineSettings, EngineNode, Evaluation, SearchOptions } from './types.ts';
export type UciOption = { name: string; type: string; min: number | null; max: number | null; default: number | null };
type Transport = Pick<Worker, 'terminate'> & Partial<Pick<Worker, 'postMessage' | 'onerror' | 'onmessage' | 'onmessageerror'>>;
type Pending = { handle: (line: string) => unknown; resolve: (value: unknown) => void; reject: (error: Error) => void };
// Adapted from Barabosik/chess-analyzer @ b89cbf1 (GPL-3.0). See THIRD_PARTY.md.
// One UCI engine (WASM worker or native process), one request at a time.
function parseInfo(line: string, stm: string): Evaluation | null {
  const tokens = line.split(/\s+/);
  const score = tokens.indexOf('score'), pv = tokens.indexOf('pv');
  if (score < 0 || pv < 0 || tokens.includes('lowerbound') || tokens.includes('upperbound')) return null;
  const value = Number(tokens[score + 2]) * (stm === 'w' ? 1 : -1);
  if (!Number.isFinite(value)) return null;
  const number = (key: string, fallback: number) => tokens.includes(key) ? Number(tokens[tokens.indexOf(key) + 1]) : fallback;
  const wdlIndex = tokens.indexOf('wdl');
  // UCI WDL stays in the root side-to-move POV; cp/mate are converted to White's POV.
  const wdl = wdlIndex < 0 ? null : tokens.slice(wdlIndex + 1, wdlIndex + 4).map(Number);
  return { cp: tokens[score + 1] === 'cp' ? value : null, mate: tokens[score + 1] === 'mate' ? value : null,
    wdl, depth: number('depth', 0), multipv: number('multipv', 1), pv: tokens.slice(pv + 1), move: tokens[pv + 1] };
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = { threads: 1, hash: 64, depth: 12, movetime: 0, multipv: 2 };
export const BUILTIN_ENGINE_URL = 'vendor/stockfish/stockfish-18-lite-single.ts';
export function engineSettings(value: Partial<EngineSettings> = {}): EngineSettings {
  const s = { ...DEFAULT_ENGINE_SETTINGS, ...value };
  for (const [key, min, max] of [['threads', 1, 256], ['hash', 1, 65536], ['depth', 0, 128], ['movetime', 0, 300000], ['multipv', 1, 16]] as const) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`引擎参数 ${key} 超出范围`);
  }
  if (!s.depth && !s.movetime) throw new Error('深度和最长时间至少启用一项');
  return s;
}

export function parseOption(line: string): UciOption | null {
  const match = /^option name (.+?) type (spin|check|combo|button|string)(?: |$)/.exec(line);
  if (!match) return null;
  const number = (key: string) => { const m = new RegExp(`(?:^| )${key} (-?\\d+)(?: |$)`).exec(line.slice(match[0].length)); return m ? Number(m[1]) : null; };
  return { name: match[1], type: match[2], min: number('min'), max: number('max'), default: number('default') };
}

export class Engine {
  source: EngineSource;
  settings: EngineSettings;
  worker: Transport | null;
  pending: Pending | null;
  name: string;
  author: string;
  options: Record<string, UciOption>;
  nativeId: number | null;
  generation: number;

  constructor(source: string | EngineSource = BUILTIN_ENGINE_URL, settings: Partial<EngineSettings> = {}) {
    this.source = typeof source === 'string' ? { url: source, name: 'Stockfish 18 Lite' } : source;
    this.settings = engineSettings(settings);
    this.worker = null;
    this.pending = null;
    this.name = this.source.name;
    this.author = '';
    this.options = {};
    this.nativeId = null;
    this.generation = 0;
  }
  request<T>(commands: string[], handle: (line: string) => T | undefined, timeout = 90000): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('引擎未启动'));
    if (this.pending) return Promise.reject(new Error('引擎正在处理另一项任务'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.quit(new Error('引擎响应超时，请降低分析深度后重试。')), timeout);
      this.pending = { handle, resolve: value => { clearTimeout(timer); this.pending = null; resolve(value as T); },
        reject: error => { clearTimeout(timer); this.pending = null; reject(error); } };
      try {
        if (this.nativeId !== null) {
          const pending = this.pending;
          window.__TAURI__!.core.invoke<string[]>('engine_exchange', { id: this.nativeId, commands }).then(lines => {
            for (const line of lines) { if (this.pending !== pending) break; this.receive(line); }
          }).catch(error => { if (this.pending === pending) this.quit(new Error(String(error))); });
        } else for (const command of commands) this.worker!.postMessage!(command);
      }
      catch (error) { this.quit(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  receive(line: string) {
    if (!line || !this.pending) return;
    if (line.startsWith('id name ')) this.name = line.slice(8).slice(0, 200);
    if (line.startsWith('id author ')) this.author = line.slice(10).slice(0, 500);
    const option = parseOption(line);
    if (option) this.options[option.name] = option;
    const value = this.pending.handle(line);
    if (value !== undefined) this.pending.resolve(value);
  }
  range(name: string, fallback = 1) {
    const o = this.options[name];
    return o?.type === 'spin' && o.min !== null && o.max !== null ? { min: o.min, max: o.max } : { min: fallback, max: fallback };
  }
  bounded(name: string, value: number) {
    const { min, max } = this.range(name);
    return Math.max(min, Math.min(max, value));
  }
  async boot() {
    const generation = ++this.generation;
    if (this.source.path) {
      if (!window.__TAURI__) throw new Error('本机 UCI 引擎需要在桌面程序中运行');
      const id = await window.__TAURI__!.core.invoke<number>('start_engine', { path: this.source.path });
      if (generation !== this.generation) { await window.__TAURI__!.core.invoke('stop_engine', { id }); throw new DOMException('分析已取消', 'AbortError'); }
      this.nativeId = id;
      this.worker = { terminate: () => { void window.__TAURI__!.core.invoke('stop_engine', { id }).catch(() => {}); } };
    } else {
      // The hash gives the generated runtime a stable WASM URL in dev and packaged builds.
      this.worker = this.source.url === BUILTIN_ENGINE_URL
        ? new Worker(new URL('../vendor/stockfish/stockfish-18-lite-single.ts', import.meta.url).href + '#/vendor/stockfish/stockfish-18-lite-single.wasm')
        : new Worker(this.source.url!);
      this.worker.onerror = () => this.quit(new Error('Stockfish 加载失败，请检查本地 WASM 文件。'));
      this.worker.onmessageerror = () => this.quit(new Error('Stockfish 消息读取失败。'));
      this.worker.onmessage = ({ data }) => {
        const line = typeof data === 'string' ? data : data?.data;
        this.receive(line);
      };
    }
    try {
      await this.request(['uci'], line => line === 'uciok' ? true : undefined, 20000);
      const commands = [];
      for (const [name, key] of [['Threads', 'threads'], ['Hash', 'hash']] as const) if (this.options[name]) {
        this.settings[key] = this.bounded(name, this.settings[key]);
        commands.push(`setoption name ${name} value ${this.settings[key]}`);
      }
      if (!this.options.Threads) this.settings.threads = 1;
      this.settings.multipv = this.bounded('MultiPV', this.settings.multipv);
      if (this.options.UCI_LimitStrength) commands.push('setoption name UCI_LimitStrength value false');
      if (this.options.UCI_ShowWDL) commands.push('setoption name UCI_ShowWDL value true');
      if (this.options['Skill Level']) commands.push(`setoption name Skill Level value ${this.range('Skill Level').max}`);
      await this.request([...commands, 'isready'], line => line === 'readyok' ? true : undefined, 20000);
      await this.newGame();
      return this;
    } catch (error) { this.quit(); throw error; }
  }
  newGame() {
    return this.request(['ucinewgame', 'isready'], line => line === 'readyok' ? true : undefined, 10000);
  }
  analyse(fen: string, { depth = this.settings.depth, movetime = this.settings.movetime, multipv = this.settings.multipv, startFen = fen, moves = [], searchmoves = [] }: SearchOptions = {}): Promise<EngineNode> {
    engineSettings({ ...this.settings, depth, movetime, multipv });
    if (!Array.isArray(searchmoves) || !searchmoves.every(move => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) throw new Error('无效的限定着法');
    multipv = this.bounded('MultiPV', multipv);
    const stm = fen.split(' ')[1];
    let lines: Record<number, Evaluation> = {}, round = 0, complete: Record<number, Evaluation> | null = null;
    const latest = new Map<string, Evaluation>();
    return this.request([
      ...(this.options.MultiPV ? [`setoption name MultiPV value ${multipv}`] : []),
      `position fen ${startFen}${moves.length ? ' moves ' + moves.join(' ') : ''}`, `go${depth ? ` depth ${depth}` : ''}${movetime ? ` movetime ${movetime}` : ''}${searchmoves.length ? ` searchmoves ${searchmoves.join(' ')}` : ''}`,
    ], line => {
      if (line.startsWith('info ')) {
        const info = parseInfo(line, stm);
        if (info) latest.set(info.move!, info);
        if (info && info.depth! >= round) {
          if (info.depth! > round) { round = info.depth!; lines = {}; }
          lines[info.multipv!] = info;
          if (Object.keys(lines).length === multipv) complete = { ...lines };
        }
      }
      if (line.startsWith('bestmove ')) {
        const bestmove = line.split(' ')[1];
        // A timed search can stop halfway through a MultiPV iteration. Never mix depths.
        const selected = complete?.[1]?.move === bestmove ? complete : lines;
        const ordered = Object.values(selected).sort((a, b) => a.multipv! - b.multipv!);
        const best = ordered.find(info => info.move === bestmove) || latest.get(bestmove) || null;
        const coherent = best && best === ordered[0];
        return { stm, bestmove: bestmove === '(none)' ? null : bestmove, best, lines: coherent ? ordered : best ? [best] : [] };
      }
    }, movetime ? Math.max(20000, movetime + 15000) : 300000);
  }
  quit(error: Error = new DOMException('分析已取消', 'AbortError')) {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    this.nativeId = null;
    this.pending?.reject(error);
  }
}
