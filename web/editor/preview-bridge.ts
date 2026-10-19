import { editorSnapshot, getCurrentProject, subscribeEditor, seekTime, selectObject, stepFrame, togglePlaying } from '../app.ts';
import type { PreviewState } from './detached-preview';

const session = crypto.randomUUID(), channel = new BroadcastChannel(`plymotion-preview:${session}`);
let lastProject: ReturnType<typeof getCurrentProject> | undefined, revision = 0, sequence = 0, active = false;
const publish = (full = false) => {
  if (!active) return;
  const state = editorSnapshot(), project = getCurrentProject(), changed = project !== lastProject;
  if (changed) { revision++; lastProject = project; }
  const value: PreviewState = { revision, sequence: ++sequence, timeMs: state.timeMs, durationMs: state.durationMs, playing: state.playing, selectedObjectId: state.selectedObjectId, chesscom: state.chesscom, ...((full || changed) ? { project } : {}) };
  channel.postMessage(value);
};
const restore = () => { if (active) { active = false; window.dispatchEvent(new Event('plymotion-return-preview')); } };
channel.onmessage = ({ data }) => {
  if (!active || !data) return;
  if (data.action === 'ready') publish(true);
  else if (data.action === 'closed' || data.action === 'return') restore();
  else if (data.action === 'seek' && Number.isFinite(data.value) && data.value >= 0 && data.value <= editorSnapshot().durationMs) seekTime(data.value);
  else if (data.action === 'step' && [-1, 1].includes(data.value)) stepFrame(data.value);
  else if (data.action === 'playing' && typeof data.value === 'boolean' && data.value !== editorSnapshot().playing) togglePlaying();
  else if (data.action === 'select' && getCurrentProject().objects.some(o => o.id === data.value)) selectObject(data.value);
};
const unsubscribe = subscribeEditor(() => publish()), timer = setInterval(() => publish(), 2000);
window.addEventListener('plymotion-preview-closed', restore);
window.addEventListener('pagehide', () => { channel.postMessage({ action: 'close' }); channel.close(); clearInterval(timer); unsubscribe(); }, { once: true });
export async function openDetachedPreview() {
  active = true; lastProject = undefined;
  try {
    if (window.__TAURI__) await window.__TAURI__.core.invoke('open_preview', { session });
    else if (!window.open(`/?preview=${session}`, 'plymotion-preview', 'width=960,height=760')) throw new Error('浏览器阻止了预览窗口，请允许弹出窗口。');
    publish(true);
  } catch (error) { active = false; throw error; }
}
