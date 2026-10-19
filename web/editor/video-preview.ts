import type { Project, VideoSettings } from '../lib/types.ts';
import { createVideoRenderer } from '../lib/video.ts';
import { createPlayback } from '../lib/playback.ts';
import { soundBuffers, scheduleSounds, type SoundBuffers } from '../lib/audio.ts';
import { projectSounds } from '../lib/project.ts';
import { materialIcon } from '../lib/material-icons.ts';

export function createVideoPreview(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>('.video-preview-frame')!;
  const play = root.querySelector<HTMLButtonElement>('#videoPreviewPlay')!;
  const replay = root.querySelector<HTMLButtonElement>('#videoPreviewReplay')!;
  const seek = root.querySelector<HTMLInputElement>('#videoPreviewSeek')!;
  const clock = root.querySelector<HTMLOutputElement>('#videoPreviewTime')!;
  const status = root.querySelector<HTMLElement>('.video-preview-status')!;
  let job: AbortController | null = null, renderer: Awaited<ReturnType<typeof createVideoRenderer>> | null = null;
  let playback: ReturnType<typeof createPlayback> | null = null, audio: AudioContext | null = null;
  let sources: AudioScheduledSourceNode[] = [], buffers: SoundBuffers | null = null;
  let currentProject: Project | null = null;
  let settings: VideoSettings, chesscom = false, pending = false, epoch = 0;
  const stopSources = () => { for (const source of sources) { try { source.stop(); } catch { /* Already ended. */ } } sources = []; };
  const playLabel = () => {
    const active = pending || !!playback?.playing;
    play.innerHTML = materialIcon(active ? 'pause' : 'play_arrow');
    play.title = play.ariaLabel = active ? '暂停视频预览' : '播放视频预览'; play.setAttribute('aria-pressed', String(active));
  };
  const stop = () => { ++epoch; pending = false; stopSources(); playback?.pause(); playLabel(); };
  const dispose = (message = '') => {
    stop(); job?.abort(); job = null; renderer?.dispose(); renderer = null; playback = null; currentProject = null;
    if (audio) void audio.close().catch(() => {}); audio = null; buffers = null;
    frame.replaceChildren(); play.disabled = replay.disabled = seek.disabled = true;
    root.setAttribute('aria-busy', 'false'); status.hidden = !message; status.textContent = message;
  };
  seek.oninput = () => { stop(); playback?.seek(seek.valueAsNumber); };
  replay.onclick = () => { stop(); playback?.seek(0); };
  play.onclick = async () => {
    if (pending || playback?.playing) { stop(); return; }
    if (!playback || !renderer || !job) return;
    const active = job, token = ++epoch;
    if (playback.time >= renderer.schedule.duration) playback.seek(0);
    pending = true; playLabel();
    try {
      if (settings.sound) {
        audio ||= new AudioContext();
        const [, loaded] = await Promise.all([audio.resume(), buffers || soundBuffers(audio, chesscom, active.signal, renderer.project)]);
        if (active.signal.aborted || token !== epoch) return;
        buffers = loaded;
      }
      if (active.signal.aborted || token !== epoch) return;
      playback.play();
    } catch (error) {
      if (!active.signal.aborted && token === epoch) { status.hidden = false; status.textContent = `预览播放失败：${error instanceof Error ? error.message : error}`; }
    } finally { if (token === epoch) { pending = false; playLabel(); } }
  };
  return { dispose, async update(project: Project, output: VideoSettings, useChesscom: boolean, initialTime?: number) {
    if (initialTime === undefined && project === currentProject && useChesscom === chesscom && JSON.stringify(output) === JSON.stringify(settings)) return;
    const time = initialTime ?? playback?.time ?? Number(seek.value);
    dispose(); currentProject = project; settings = { ...output }; chesscom = useChesscom;
    const active = new AbortController(); job = active;
    root.setAttribute('aria-busy', 'true'); status.hidden = false; status.textContent = '正在准备预览…';
    try {
      const view = await createVideoRenderer(project, settings, chesscom, active.signal);
      if (active.signal.aborted) { view.dispose(); return; }
      renderer = view; view.canvas.setAttribute('role', 'img'); view.canvas.setAttribute('aria-label', '导出视频画面');
      frame.replaceChildren(view.canvas); seek.max = String(view.schedule.duration);
      playback = createPlayback({ duration: view.schedule.duration,
        now: () => audio?.state === 'running' ? audio.currentTime * 1000 : performance.now(),
        sample(at) {
          const sampled = at >= view.schedule.duration ? view.schedule.duration : Math.floor(at * settings.fps / 1000) * 1000 / settings.fps;
          view.render(sampled); seek.value = String(at);
          clock.value = `${(at / 1000).toFixed(3)} / ${(view.schedule.duration / 1000).toFixed(3)} s`;
        },
        onStart(from, until, speed, anchor) {
          stopSources();
          if (settings.sound && audio) sources = scheduleSounds(audio, projectSounds(view.project), from * settings.speed, until * settings.speed, buffers || {}, speed * settings.speed, anchor / 1000);
        },
        onState(playing) { if (!playing) stopSources(); playLabel(); },
      });
      playback.seek(time / (initialTime !== undefined ? settings.speed : 1));
      play.disabled = replay.disabled = seek.disabled = false; status.hidden = true;
    } catch (error) {
      if (!active.signal.aborted) dispose(`预览失败：${error instanceof Error ? error.message : error}`);
    } finally { if (job === active) root.setAttribute('aria-busy', 'false'); }
  } };
}
