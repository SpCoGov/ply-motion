import { useEffect, useRef, useState } from 'react';
import { editProject, refreshPreview } from '../app.ts';
import { PIECE_KEYS, pieceName, configuredAsset, assignPieceAsset, assignBoardStyle, boardSquareStyle, importMedia } from '../lib/assets.ts';
import { pieceSource, renderBoard } from '../lib/board.ts';
import { trackState } from '../lib/editing.ts';
import { soundBuffers, scheduleSound } from '../lib/audio.ts';
import type { PieceKey, PieceAssetField, SoundKind, Asset, BoardTone } from '../lib/types.ts';
import { useEditor } from './store';
import { Button } from './ui/button';
import { MaterialIcon as Icon } from './ui/material-icon';

const labels = { icon: '棋子图标', move: '走子音效', capture: '吃子音效' };
export function Assets() {
  const project = useEditor(s => s.project)!, chesscom = useEditor(s => s.chesscom), fileBusy = useEditor(s => s.fileBusy);
  const [selected, setSelected] = useState<PieceKey | 'board' | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const boardPreview = useRef<HTMLDivElement>(null), boardLocked = trackState(project, 'board').locked;
  const choice = useRef<{ keys: PieceKey[] | BoardTone; field: PieceAssetField; epoch: number; assets: typeof project.assets } | null>(null);
  const epoch = useRef(0), audition = useRef(0), audio = useRef<AudioContext | null>(null), source = useRef<AudioScheduledSourceNode | null>(null);
  const stopAudio = () => {
    ++audition.current;
    try { source.current?.stop(); } catch { /* Already ended. */ }
    source.current = null;
    if (audio.current) void audio.current.close().catch(() => {});
    audio.current = null;
  };
  const close = () => { ++epoch.current; choice.current = null; setPending(false); stopAudio(); dialog.current?.close(); setSelected(null); };
  useEffect(() => {
    if (selected) dialog.current?.showModal();
    if (selected === 'board' && boardPreview.current) renderBoard(boardPreview.current, '8/8/8/8/8/8/8/8 w - - 0 1', { project });
    return stopAudio;
  }, [selected, project, chesscom]);
  useEffect(() => () => { ++epoch.current; stopAudio(); }, []);
  const choose = (keys: PieceKey[] | BoardTone, field: PieceAssetField) => {
    refreshPreview(); stopAudio(); setError('');
    choice.current = { keys, field, epoch: ++epoch.current, assets: project.assets };
    input.current!.accept = field === 'icon' ? '.png,.jpg,.jpeg,.webp,.svg' : '.wav,.mp3,.m4a,.aac,.ogg,.flac,.webm';
    input.current!.value = ''; input.current!.click();
  };
  const apply = (keys: PieceKey[] | BoardTone, field: PieceAssetField, asset: Asset | null) => {
    stopAudio(); setError(editProject(edits => typeof keys === 'string' ? assignBoardStyle(edits, keys, { texture: asset }) : assignPieceAsset(edits, keys, field, asset)) || '');
  };
  const load = async (file: File | undefined) => {
    const request = choice.current; if (!file || !request) return;
    setPending(true);
    try {
      const asset = await importMedia(file, request.field === 'icon' ? 'image' : 'audio');
      if (request.epoch !== epoch.current) return;
      if (useEditor.getState().project!.assets !== request.assets || useEditor.getState().fileBusy) throw new Error('工程已切换，请重新选择素材。');
      apply(request.keys, request.field, asset);
    } catch (caught) { if (request.epoch === epoch.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (request.epoch === epoch.current) { setPending(false); choice.current = null; } }
  };
  const listen = async (kind: SoundKind) => {
    stopAudio(); setError('');
    const token = audition.current, ctx = new AudioContext(); audio.current = ctx;
    try {
      const [, buffers] = await Promise.all([ctx.resume(), soundBuffers(ctx, chesscom, undefined, project)]);
      if (token !== audition.current) return;
      const asset = configuredAsset(project, selected === 'board' ? null : selected, kind), buffer = buffers[asset?.id || kind];
      source.current = scheduleSound(ctx, kind, ctx.currentTime, buffer?.duration || .13, 0, buffer);
    } catch (caught) { if (token === audition.current) { stopAudio(); setError(caught instanceof Error ? caught.message : String(caught)); } }
  };
  return <div className="panel-body assets-panel">
    {(['w', 'b'] as const).map(color => <div className="piece-library" key={color}>{PIECE_KEYS.filter(key => key[0] === color).map(key =>
      <button key={key} disabled={fileBusy || pending} aria-label={`设置${pieceName(key)}`} title={pieceName(key)} onClick={() => { refreshPreview(); setError(''); ++epoch.current; setSelected(key); }}>
        <img src={pieceSource(key[1], color, chesscom, project)} alt={pieceName(key)} />
      </button>)}</div>)}
    <Button className="board-asset-button" disabled={fileBusy || pending} onClick={() => { refreshPreview(); setError(''); ++epoch.current; setSelected('board'); }}><Icon name="tune" />设置棋盘</Button>
    <input ref={input} type="file" hidden aria-label="导入棋子素材" onChange={e => void load(e.target.files?.[0])} />
    <dialog className="piece-settings-dialog" ref={dialog} aria-labelledby="piece-settings-title" onCancel={e => { e.preventDefault(); close(); }} onClose={() => { if (selected) close(); }}>
      <div className="dialog-heading"><h2 id="piece-settings-title">{selected === 'board' ? '棋盘设置' : selected && `${pieceName(selected)}设置`}</h2><Button aria-label={selected === 'board' ? '关闭棋盘设置' : '关闭棋子设置'} onClick={close}><Icon name="close" /></Button></div>
      {selected === 'board' ? <><div className="board-settings-preview" role="img" aria-label="棋盘外观预览" ref={boardPreview} />
        <div className="piece-settings-fields">{(['light', 'dark'] as const).map(tone => {
          const label = tone === 'light' ? '浅色格' : '深色格', style = boardSquareStyle(project, tone);
          const asset = project.edits.assets?.find(a => a.id === project.edits.boardStyle?.[tone]?.texture);
          return <section key={tone}><div className="asset-field-heading"><strong>{label}</strong><span title={asset?.source.kind === 'embedded' ? asset.source.name : ''}>{asset?.source.kind === 'embedded' ? asset.source.name : '纯色'}</span></div>
            <div className="asset-field-actions"><label className="board-color-picker">颜色<input type="color" aria-label={`${label}颜色`} value={style.color} disabled={pending || fileBusy || boardLocked} onChange={e => setError(editProject(edits => assignBoardStyle(edits, tone, { color: e.target.value })) || '')} /></label>
              <Button disabled={pending || fileBusy || boardLocked} aria-label={`选择${label}纹理`} onClick={() => choose(tone, 'icon')}><Icon name="image" />选择纹理</Button>
              <Button disabled={!style.texture || pending || fileBusy || boardLocked} aria-label={`移除${label}纹理`} onClick={() => apply(tone, 'icon', null)}><Icon name="close" />移除纹理</Button>
              <Button disabled={!project.edits.boardStyle?.[tone] || pending || fileBusy || boardLocked} aria-label={`恢复${label}默认`} onClick={() => setError(editProject(edits => assignBoardStyle(edits, tone, null)) || '')}><Icon name="restart_alt" />恢复默认</Button>
            </div></section>;
        })}</div></> : selected && <><img className="piece-settings-preview" src={pieceSource(selected[1], selected[0], chesscom, project)} alt={pieceName(selected)} />
        <div className="piece-settings-fields">{(['icon', 'move', 'capture'] as const).map(field => {
          const asset = configuredAsset(project, selected, field), name = asset?.source.kind === 'embedded' ? asset.source.name : field === 'icon' ? chesscom ? 'NEO' : 'CBURNETT' : '默认音效';
          return <section key={field}><div className="asset-field-heading"><strong>{labels[field]}</strong><span title={name}>{name}</span></div>
            <div className="asset-field-actions"><Button disabled={pending || fileBusy} aria-label={`选择${pieceName(selected)}${labels[field]}`} onClick={() => choose([selected], field)}><Icon name="file_upload" />选择文件</Button>
              {field !== 'icon' && <Button disabled={pending} aria-label={`试听${labels[field]}`} onClick={() => void listen(field)}><Icon name="play_arrow" />试听</Button>}
              <Button disabled={!asset || pending || fileBusy} aria-label={`恢复${pieceName(selected)}${labels[field]}`} onClick={() => apply([selected], field, null)}><Icon name="restart_alt" />恢复默认</Button>
              {field !== 'icon' && <Button disabled={pending || fileBusy} aria-label={`${labels[field]}应用到全部棋子`} onClick={() => apply(PIECE_KEYS, field, asset || null)}><Icon name="swap_horiz" />应用到全部棋子</Button>}
            </div></section>;
        })}</div></>}
      <div className="asset-feedback" role="status">{pending ? '正在导入素材…' : error}</div>
      <div className="dialog-actions"><Button variant="accent" onClick={close}>完成</Button></div>
    </dialog>
  </div>;
}
