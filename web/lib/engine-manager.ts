import type { EngineSource, EngineSettings } from './types.ts';
import type { UciOption } from './engine.ts';
type Profile = EngineSource & { id: string; settings: EngineSettings };
type EngineInfo = { name: string; author: string; options: Record<string, UciOption>; path: string; type: string };
type EngineSnapshot = { entries: Profile[]; selected: string; settings: EngineSettings; busy: boolean; analyzing: boolean; info: EngineInfo | null; error: string; ready: boolean };
import { Engine, BUILTIN_ENGINE_URL, DEFAULT_ENGINE_SETTINGS, engineSettings } from './engine.ts';

const key = 'plymotion.engines.v1';
const builtin: Profile = { id: 'builtin', name: 'Stockfish 18 Lite', url: BUILTIN_ENGINE_URL, settings: { ...DEFAULT_ENGINE_SETTINGS } };
let entries: Profile[] = [builtin], selected = builtin.id, instance: Engine | null = null, booting: Promise<Engine> | null = null, busy = false, analyzing = false, info: EngineInfo | null = null, error = '';
try {
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  if (saved && Array.isArray(saved.entries)) {
    for (const entry of saved.entries.slice(0, 32)) {
      try {
        const settings = engineSettings(entry.settings);
        if (entry.id === 'builtin') builtin.settings = settings;
        else if (typeof entry.id === 'string' && typeof entry.name === 'string' && entry.name.length <= 200 && typeof entry.path === 'string' && entry.path.length <= 4096 && !entries.some(e => e.id === entry.id)) {
          entries.push({ id: entry.id, name: entry.name, path: entry.path, settings });
        }
      } catch { /* Ignore only the invalid profile. */ }
    }
    if (entries.some(e => e.id === saved.selected)) selected = saved.selected;
  }
} catch { /* First launch or unavailable storage uses the bundled engine. */ }
const listeners = new Set<() => void>();
export const currentEngineProfile = () => entries.find(e => e.id === selected) || builtin;
let snapshot: EngineSnapshot;
function publish() {
  snapshot = { entries, selected, settings: currentEngineProfile().settings, busy, analyzing, info, error, ready: !!instance?.worker };
  for (const listener of listeners) listener();
}
function persist() {
  try { localStorage.setItem(key, JSON.stringify({ entries, selected })); }
  catch { error = '设置仅在本次会话生效：无法写入本地存储'; }
  publish();
}
publish();
export const engineSnapshot = () => snapshot;
export function subscribeEngine(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function setEngineAnalyzing(value: boolean) { analyzing = value; publish(); }
export function stopEngine() { instance?.quit(); instance = null; publish(); }
export async function readyEngine(): Promise<Engine> {
  if (booting) return booting;
  if (instance?.worker) return instance;
  const profile = currentEngineProfile();
  const engine = instance = new Engine(profile, profile.settings);
  busy = true; error = ''; publish();
  booting = (async () => {
    try {
      await engine.boot();
      if (instance !== engine) { engine.quit(); throw new DOMException('引擎已切换', 'AbortError'); }
      profile.name = engine.name;
      profile.settings = { ...engine.settings };
      info = { name: engine.name, author: engine.author, options: engine.options, path: profile.path || '', type: profile.path ? '本机 UCI' : '内置 WASM' };
      persist(); return engine;
    } catch (e) {
      engine.quit();
      if (instance === engine) {
        // Keep discovered ranges editable when applying a setting (e.g. Hash) failed.
        if (Object.keys(engine.options).length) info = { name: engine.name, author: engine.author, options: engine.options, path: profile.path || '', type: profile.path ? '本机 UCI' : '内置 WASM' };
        instance = null;
      }
      error = e instanceof Error ? e.message : String(e); throw e;
    }
    finally { booting = null; busy = false; publish(); }
  })();
  return booting;
}
function editable() { if (busy || analyzing) throw new Error('请先取消当前分析，再修改引擎'); }
export async function selectEngine(id: string) {
  editable();
  if (!entries.some(e => e.id === id)) throw new Error('引擎不存在');
  stopEngine(); selected = id; info = null; error = ''; persist();
  return readyEngine();
}
export async function restartEngine() { editable(); stopEngine(); return readyEngine(); }
export async function addEngine() {
  editable();
  if (!globalThis.window?.__TAURI__) throw new Error('添加本机引擎请使用 PlyMotion 桌面程序');
  busy = true; publish();
  let path: string | null;
  try { path = await window.__TAURI__!.core.invoke<string | null>('pick_engine'); }
  finally { busy = false; publish(); }
  if (!path) return;
  let profile = entries.find(e => e.path?.toLowerCase() === path.toLowerCase());
  if (!profile) {
    if (entries.length >= 32) throw new Error('最多添加 31 个本机引擎');
    profile = { id: crypto.randomUUID(), name: path.split(/[\\/]/).at(-1)!, path, settings: { ...DEFAULT_ENGINE_SETTINGS } };
    entries = [...entries, profile];
  }
  return selectEngine(profile.id);
}
export async function saveEngineSettings(settings: Partial<EngineSettings>) {
  editable(); currentEngineProfile().settings = engineSettings(settings); persist();
  return restartEngine();
}
export function setEngineDepth(depth: number) {
  editable(); currentEngineProfile().settings = engineSettings({ ...currentEngineProfile().settings, depth });
  if (instance) instance.settings.depth = depth;
  persist();
}
