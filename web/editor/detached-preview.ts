import type { Project } from '../lib/types.ts';
import { createVideoRenderer } from '../lib/video.ts';

export type PreviewState = { revision: number; sequence: number; timeMs: number; durationMs: number; playing: boolean; selectedObjectId: string | null; project?: Project; chesscom: boolean };
export async function startDetachedPreview(session: string) {
  const channel = new BroadcastChannel(`plymotion-preview:${session}`), root = document.getElementById('root')!;
  root.innerHTML = `<main class="detached-preview camera-preview"><h1>独立镜头预览</h1><div class="camera-preview-frame"></div><p role="status">正在连接主窗口…</p><div class="camera-preview-transport"><button id="detachedPlay" disabled>播放</button><button id="detachedPrevious" disabled>上一帧</button><button id="detachedNext" disabled>下一帧</button><label>播放位置<input id="detachedSeek" type="range" min="0" step="1" value="0" disabled></label><output></output><label>选中对象<select id="detachedObject" disabled><option value="">无</option></select></label><button id="detachedReturn">返回主窗口</button></div></main>`;
  const frame = root.querySelector<HTMLElement>('.camera-preview-frame')!, status = root.querySelector<HTMLElement>('[role=status]')!, play = root.querySelector<HTMLButtonElement>('#detachedPlay')!, seek = root.querySelector<HTMLInputElement>('#detachedSeek')!, object = root.querySelector<HTMLSelectElement>('#detachedObject')!;
  let state: PreviewState | null = null, project: Project | undefined, renderer: Awaited<ReturnType<typeof createVideoRenderer>> | undefined, job: AbortController | undefined, revision = -1, sequence = -1, seen = performance.now();
  const send = (action: string, value?: unknown) => channel.postMessage({ action, value });
  const draw = () => {
    if (!renderer || !state || !project) return;
    try { const t = state.timeMs / project.output.speed; renderer.render(Math.floor(t * project.output.fps / 1000) * 1000 / project.output.fps); renderer.canvas.dataset.timeMs = String(state.timeMs); }
    catch (error) { status.textContent = String(error); }
  };
  channel.onmessage = async ({ data }) => {
    if (data?.action === 'close') { window.close(); return; }
    if (!data || !Number.isInteger(data.sequence) || data.sequence <= sequence) return;
    seen = performance.now(); sequence = data.sequence; state = data;
    play.disabled = seek.disabled = object.disabled = false;
    root.querySelector<HTMLButtonElement>('#detachedPrevious')!.disabled = root.querySelector<HTMLButtonElement>('#detachedNext')!.disabled = false;
    play.textContent = data.playing ? '暂停' : '播放'; seek.max = String(data.durationMs); seek.value = String(data.timeMs);
    root.querySelector('output')!.textContent = `${(data.timeMs / 1000).toFixed(3)} s`;
    if (data.project && data.revision !== revision) {
      revision = data.revision; project = data.project;
      job?.abort(); renderer?.dispose(); renderer = undefined; frame.replaceChildren();
      const active = new AbortController(); job = active; status.textContent = '正在准备画面…';
      object.replaceChildren(new Option('无', ''), ...project!.objects.filter(o => o.kind !== 'audio').map(o => new Option(o.id, o.id)));
      object.value = data.selectedObjectId || '';
      try {
        const view = await createVideoRenderer(project!, project!.output, data.chesscom, active.signal);
        if (active.signal.aborted) { view.dispose(); return; }
        renderer = view; view.canvas.setAttribute('aria-label', '独立成片画面'); frame.replaceChildren(view.canvas); status.textContent = '音频由主窗口播放'; draw();
      } catch (error) { if (!active.signal.aborted) status.textContent = `独立预览失败：${String(error)}`; }
    } else { object.value = data.selectedObjectId || ''; draw(); }
  };
  play.onclick = () => send('playing', !state?.playing);
  seek.oninput = () => send('seek', seek.valueAsNumber);
  object.onchange = () => send('select', object.value);
  root.querySelector<HTMLButtonElement>('#detachedPrevious')!.onclick = () => send('step', -1);
  root.querySelector<HTMLButtonElement>('#detachedNext')!.onclick = () => send('step', 1);
  root.querySelector<HTMLButtonElement>('#detachedReturn')!.onclick = () => { send('return'); if (window.__TAURI__) void window.__TAURI__.core.invoke('close_preview').catch(error => { status.textContent = String(error); }); else window.close(); };
  const timer = setInterval(() => {
    if (!state) send('ready');
    if (performance.now() - seen > 6000) { status.textContent = '主窗口连接中断，请返回主窗口重新打开预览。'; play.disabled = seek.disabled = object.disabled = true; }
  }, 2000);
  window.addEventListener('pagehide', () => { send('closed'); clearInterval(timer); job?.abort(); renderer?.dispose(); channel.close(); }, { once: true });
  send('ready');
}
