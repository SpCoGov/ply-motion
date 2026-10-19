import { useEffect, useRef, useState } from 'react';
import type { CameraPose } from '../lib/types.ts';
import { addBeatAtPlayhead, clearBeats, clearDirectorOverride, editProject, seekTime } from '../app.ts';
import { CAMERA_DEFAULT, FOLLOW_FOCUS_DEFAULT, alignMovesToBeats, cameraPose, detectBeats, emptyCamera, focusCamera, putCameraKey, resolveCamera } from '../lib/camera-beats.ts';
import { assignMusic, changeMusicTiming, importMedia } from '../lib/assets.ts';
import { soundBuffers } from '../lib/audio.ts';
import { trackState } from '../lib/editing.ts';
import { useEditor } from './store';
import { Button } from './ui/button';
import { NumberField } from './inspector';
import { CameraKeyframes } from './camera-keyframes';

export function CameraPanel() {
  const project = useEditor(s => s.project), time = useEditor(s => s.timeMs), selected = useEditor(s => s.selectedObjectId), ply = useEditor(s => s.ply), game = useEditor(s => s.game);
  const [draft, setDraft] = useState<CameraPose | null>(null), [square, setSquare] = useState('e4'), [travel, setTravel] = useState(500), [zoom, setZoom] = useState(1.8);
  const [shakeDuration, setShakeDuration] = useState(350), [strength, setStrength] = useState(.12), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const input = useRef<HTMLInputElement>(null), epoch = useRef(0);
  const { camera, steps } = resolveCamera(project), music = project.edits.music, beats = project.edits.beats || [];
  const follow = project.edits.camera?.follow, following = !!follow?.enabled;
  const focusStep = steps.filter(s => s.startMs <= time + .0001).at(-1) || steps[0];
  const focusSetting = focusStep && (follow?.moves[focusStep.id] || FOLLOW_FOCUS_DEFAULT);
  const locked = trackState(project, 'camera').locked, musicLocked = trackState(project, 'music').locked, beatsLocked = trackState(project, 'beats').locked;
  const asset = project.edits.assets?.find(a => a.id === music?.assetId);
  const pose = draft || cameraPose(camera, time, false);
  useEffect(() => { if (draft) setDraft(null); }, [camera, time, game]);
  useEffect(() => {
    const segment = project.segments[Math.max(0, ply - 1)];
    const sq = Object.entries(ply ? segment?.after || {} : segment?.before || {}).find(([, id]) => id === selected)?.[0];
    if (sq) setSquare(sq);
  }, [selected, ply, project.pgn]);
  useEffect(() => { ++epoch.current; setBusy(false); setStatus(''); return () => { ++epoch.current; }; }, [game]);
  const apply = (change: Parameters<typeof editProject>[0], message = '') => { const error = editProject(change); setStatus(error || message); };
  const analyzeMusic = async (file?: File) => {
    const token = ++epoch.current, sourceGame = game; setBusy(true); setStatus('正在解码音乐并检测鼓点起音…');
    try {
      const media = file ? await importMedia(file, 'audio', 600000) : asset;
      if (!media) throw new Error('请先导入音乐。');
      const edits = structuredClone(useEditor.getState().project.edits);
      if (file) assignMusic(edits, media);
      const temporary = { ...useEditor.getState().project, edits };
      const buffers = await soundBuffers(new OfflineAudioContext(1, 1, 48000), false, undefined, temporary), buffer = buffers[temporary.edits.music!.assetId];
      if (!buffer) throw new Error('音乐解码结果不可用，请重新导入。');
      const points = detectBeats(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
      if (token !== epoch.current || useEditor.getState().game !== sourceGame) return;
      let count = 0;
      const error = editProject(e => {
        if (file) assignMusic(e, media);
        const music = e.music!;
        e.beats = points.filter(t => t >= music.offsetMs && t < music.offsetMs + music.durationMs).map(t => t - music.offsetMs + music.startMs);
        count = e.beats.length;
      });
      setStatus(error || `检测到 ${count} 个节拍候选。可在时间线上拖动修正，再点击自动卡点。`);
    } catch (error) { if (token === epoch.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { if (token === epoch.current) setBusy(false); }
  };
  const selectedKey = camera?.keys.find(k => Math.abs(k.time - time) < .001);
  return <div className="panel-body camera-panel">
    <h3>镜头</h3><p className="muted">在「面板 → 镜头预览」查看成片画面。镜头关键帧控制平移、推拉和旋转；对焦将指定格子移至画面中心。</p>
    <div className="camera-fields camera-follow">
      <label className="camera-follow-toggle"><input type="checkbox" aria-label="跟随走子自动对焦" checked={following} disabled={locked || !project.segments.length}
        onChange={event => apply(e => { const cam = e.camera ||= emptyCamera(); (cam.follow ||= { enabled: false, moves: {} }).enabled = event.target.checked; })} />跟随走子自动对焦</label>
      {following && focusStep && focusSetting && <>
        <label>调整哪一步<select aria-label="自动对焦步序" value={focusStep.id} onChange={event => seekTime(steps.find(s => s.id === event.target.value)!.startMs)}>
          {steps.map((s, i) => <option key={s.id} value={s.id}>第 {s.ply} 步 · {game.moves[i]?.san} → {s.square}</option>)}
        </select></label>
        <label>本步对焦倍率<NumberField label="本步对焦倍率" value={focusSetting.scale} min={.25} max={8} step={.1} disabled={locked}
          change={value => apply(e => { e.camera!.follow!.moves[focusStep.id] = { ...focusSetting, scale: value }; })} /></label>
        <label>本步运镜时长 / ms<NumberField label="本步运镜时长" value={focusSetting.durationMs} min={1} max={60000} step={50} disabled={locked}
          change={value => apply(e => { e.camera!.follow!.moves[focusStep.id] = { ...focusSetting, durationMs: value }; })} /></label>
        <Button disabled={locked} title="将本步对焦倍率和运镜时长应用到全部走子" onClick={() => apply(e => {
          for (const step of steps) e.camera!.follow!.moves[step.id] = { ...focusSetting };
        }, `已将本步倍率和时长应用到全部 ${steps.length} 步，可撤销。`)}>应用到全部走子</Button>
        <p className="muted">走子开始时转向落点，时长越短运镜越快；下一步开始前收尾。{focusStep.durationMs < focusSetting.durationMs && `本步实际运镜 ${Math.round(focusStep.durationMs)} ms。`}卡点和时序修改会自动跟随。关闭后恢复手动镜头。</p>
      </>}
    </div>
    <CameraKeyframes pose={pose} change={(axis, value) => {
      if (selectedKey) apply(e => putCameraKey(e.camera!, { ...selectedKey, [axis]: value }));
      else setDraft({ ...pose, [axis]: value });
    }} record={() => apply(e => putCameraKey(e.camera ||= emptyCamera(), { ...pose, time, easing: selectedKey?.easing || [.25, .1, .25, 1] }))} />
    <p className="muted">{following ? '下方显示自动生成的镜头关键帧，点击可定位；倍率和速度在上方逐步调整。' : '菱形记录整组镜头参数，拖动任一行会同步移动。点击选择后直接改值；空白时间改值后点 ◆ 记录。方向键微调，Delete 删除，Esc 取消拖动。'}</p>
    <fieldset disabled={locked || following} hidden={following} className="camera-fields">
      <label>到下一关键帧<select aria-label="镜头插值" value={selectedKey?.easing === 'linear' ? 'linear' : selectedKey?.easing === 'hold' ? 'hold' : 'smooth'}
        onChange={event => apply(e => { const cam = e.camera ||= emptyCamera(); putCameraKey(cam, { ...pose, time, easing: event.target.value === 'smooth' ? [.25, .1, .25, 1] : event.target.value === 'hold' ? 'hold' : 'linear' }); })}>
        <option value="smooth">平滑</option><option value="linear">匀速</option><option value="hold">切镜</option></select></label>
      <div className="property-actions"><Button onClick={() => apply(e => putCameraKey(e.camera ||= emptyCamera(), { ...CAMERA_DEFAULT, time, easing: [.25, .1, .25, 1] }))}>回到全景</Button>
        <Button disabled={!selectedKey} onClick={() => apply(e => { e.camera!.keys = e.camera!.keys.filter(k => k.time !== selectedKey!.time); })}>删除镜头关键帧</Button></div>
      <label>对焦格子<input aria-label="对焦格子" value={square} maxLength={2} onChange={e => setSquare(e.target.value.toLowerCase())} /></label>
      <label>运镜时长 / ms<NumberField label="运镜时长" value={travel} min={1} max={60000} step={50} change={setTravel} /></label>
      <label>对焦倍率<NumberField label="对焦倍率" value={zoom} min={.25} max={8} step={.1} change={setZoom} /></label>
      <Button disabled={!/^[a-h][1-8]$/.test(square)} onClick={() => apply(e => focusCamera(e.camera ||= emptyCamera(), time, travel, square, zoom))}>对焦</Button>
    </fieldset>
    <fieldset disabled={locked} className="camera-fields">
      <label>震动时长 / ms<NumberField label="震动时长" value={shakeDuration} min={1} max={10000} step={25} change={setShakeDuration} /></label>
      <label>震动幅度 / 格<NumberField label="震动幅度" value={strength} min={0} max={.5} step={.01} change={setStrength} /></label>
      <Button onClick={() => apply(e => (e.camera ||= emptyCamera()).shakes.push({ id: crypto.randomUUID(), startMs: time, durationMs: shakeDuration, strength }))}>添加镜头震动</Button>
    </fieldset>
    <h3>音乐与自动卡点</h3>
    <p className="muted">优先检测鼓点起音作为节拍候选，可拖动或增删修正。按 B 在播放头添加节拍，播放不中断。自动卡点保留动作时长和曲线，密集节拍允许不同棋子与提示动画重叠；同一棋子及吃子顺序有冲突时跳过该点。</p>
    <div className="property-actions"><Button disabled={busy || musicLocked || beatsLocked} onClick={() => { input.current!.value = ''; input.current!.click(); }}>导入音乐并检测节拍</Button>
      <Button disabled={busy || !music || beatsLocked} onClick={() => void analyzeMusic()}>重新检测节拍</Button></div>
    <input ref={input} type="file" accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.webm" hidden aria-label="导入卡点音乐" onChange={e => { if (e.target.files?.[0]) void analyzeMusic(e.target.files[0]); }} />
    {music && <fieldset disabled={musicLocked || busy} className="camera-fields"><p>{asset?.source.kind === 'embedded' ? asset.source.name : '音乐'}</p>
      <label>音乐起点 / ms<NumberField label="音乐起点" value={music.startMs} min={0} max={120000000 - music.durationMs} step={10} change={value => apply(e => changeMusicTiming(e, { startMs: value }))} /></label>
      <label>素材起点 / ms<NumberField label="音乐素材起点" value={music.offsetMs} min={0} max={asset?.source.kind === 'embedded' ? asset.source.durationMs! - 1 : 0} step={10} change={value => apply(e => changeMusicTiming(e, { offsetMs: value }))} /></label>
      <label>音乐时长 / ms<NumberField label="音乐时长" value={music.durationMs} min={1} max={Math.min(120000000 - music.startMs, asset?.source.kind === 'embedded' ? asset.source.durationMs! - music.offsetMs : 1)} step={100} change={value => apply(e => changeMusicTiming(e, { durationMs: value }))} /></label>
      <label>音乐音量<NumberField label="音乐音量" value={music.volume} min={0} max={1} step={.05} change={value => apply(e => { e.music!.volume = value; })} /></label>
      {(['fadeInMs', 'fadeOutMs'] as const).map(key => <label key={key}>{key === 'fadeInMs' ? '音乐淡入' : '音乐淡出'} / ms<NumberField label={key === 'fadeInMs' ? '音乐淡入' : '音乐淡出'} value={music[key] || 0} min={0} max={600000} step={50} change={value => apply(e => { e.music![key] = value; })} /></label>)}
      <Button onClick={() => apply(e => assignMusic(e, null))}>移除音乐</Button>
    </fieldset>}
    <div className="property-actions"><Button disabled={beatsLocked} aria-keyshortcuts="B" title="在播放头添加节拍（B），播放不中断" onClick={() => setStatus(addBeatAtPlayhead() || '')}>在播放头添加节拍</Button>
      <Button disabled={!beats.length || busy || beatsLocked} onClick={() => setStatus(clearBeats() || '已删除全部节拍，可撤销。')}>删除全部节拍</Button>
      <Button disabled={!beats.length || busy} onClick={() => apply(e => Object.assign(e, alignMovesToBeats(useEditor.getState().project)), '走子已对齐可用节拍，动作速度与曲线保持原样。')}>自动卡点</Button></div>
    <p className="muted">已标记 {beats.length} 个节拍。音乐轨位于时间线底部，可拖动片段移动、拖两端裁剪。移动音乐、修改节拍或裁剪后，请再次点击自动卡点。音乐支持 16 MB、10 分钟以内；导出时长包含音乐，请按需要裁剪尾部。</p>
    <p role="status">{status}</p>
    {!!project.edits.pending?.length && <details><summary>{project.edits.pending.length} 项未匹配的旧动画修改</summary>{project.edits.pending.map(c => <div className="camera-entry" key={c.id}><span>{c.effect}</span><Button onClick={() => clearDirectorOverride('pending', c.id)}>清除此项及副本</Button></div>)}</details>}
  </div>;
}
