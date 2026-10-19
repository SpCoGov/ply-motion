import { useRef, useState, useSyncExternalStore } from 'react';
import { MaterialIcon as Icon } from './ui/material-icon';
import { engineSnapshot, subscribeEngine, currentEngineProfile, readyEngine, selectEngine, addEngine, restartEngine, saveEngineSettings } from '../lib/engine-manager.ts';
import { cancelEngineAnalysis } from '../app.ts';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';

export function EngineMenu() {
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState('settings');
  const [draft, setDraft] = useState(state.settings);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setError(''); setWorking(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  };
  const show = (mode: string) => {
    setView(mode); setError(''); setDraft({ ...engineSnapshot().settings }); dialog.current!.showModal();
    if (mode !== 'select') void run(async () => { await readyEngine(); setDraft({ ...engineSnapshot().settings }); });
  };
  const limits = (name: string, cap: number) => {
    const o = state.info?.options[name];
    return o?.type === 'spin' ? { min: Math.max(1, o.min ?? 1), max: Math.min(cap, o.max ?? 1), disabled: (o.max ?? 1) <= 1 } : { min: 1, max: 1, disabled: true };
  };
  const locked = working || state.busy;
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild><Button><Icon name="memory" />引擎<Icon name="expand_more" size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuLabel>{currentEngineProfile().name}{state.analyzing ? ' · 分析中' : state.ready ? ' · 已就绪' : ' · 未启动'}</DropdownMenuLabel>
      <DropdownMenuItem disabled={locked || state.analyzing} onSelect={() => show('select')}><Icon name="memory" />选择引擎…</DropdownMenuItem>
      <DropdownMenuItem disabled={locked || state.analyzing} onSelect={() => { setView('select'); dialog.current!.showModal(); void run(addEngine); }}><Icon name="add" />添加引擎…</DropdownMenuItem>
      <DropdownMenuItem disabled={locked} onSelect={() => { setView('info'); dialog.current!.showModal(); void run(async () => { await cancelEngineAnalysis(); await restartEngine(); }); }}><Icon name="restart_alt" />重启引擎</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={locked} onSelect={() => show('info')}><Icon name="info" />当前引擎信息…</DropdownMenuItem>
      <DropdownMenuItem disabled={locked || state.analyzing} onSelect={() => show('settings')}><Icon name="settings" />引擎设置…</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <dialog ref={dialog} className="engine-dialog" aria-labelledby="engine-dialog-title" onCancel={e => { if (locked) e.preventDefault(); }}>
      <form onChange={() => setError('')} onSubmit={e => { e.preventDefault(); if (view === 'settings') void run(async () => { await saveEngineSettings(draft); dialog.current!.close(); }); }}>
        <h2 id="engine-dialog-title">{view === 'settings' ? '引擎设置' : view === 'select' ? '选择引擎' : '当前引擎信息'}</h2>
        <p>{currentEngineProfile().name}</p>
        {view === 'select' && <>
          <label>当前引擎<select value={state.selected} disabled={locked || state.analyzing} onChange={e => void run(() => selectEngine(e.target.value))}>
            {state.entries.map((entry: { id: string; name: string }) => <option key={entry.id} value={entry.id}>{entry.name}{entry.id === 'builtin' ? '（内置）' : ''}</option>)}
          </select></label>
          <p>添加本机 UCI 引擎的 .exe 文件；添加后会启动引擎并读取支持的参数。</p>
          <Button type="button" disabled={locked || state.analyzing} onClick={() => void run(addEngine)}>添加引擎…</Button>
        </>}
        {view === 'settings' && <>
          <fieldset disabled={locked || state.analyzing} className="engine-fields">
            <label>线程<input aria-label="线程" type="number" required {...limits('Threads', 256)} value={draft.threads} onChange={e => setDraft({ ...draft, threads: Number(e.target.value) })} /></label>
            <label>哈希（MB）<input aria-label="哈希（MB）" type="number" required {...limits('Hash', 65536)} value={draft.hash} onChange={e => setDraft({ ...draft, hash: Number(e.target.value) })} /></label>
            <label>最长时间（秒／局面）<input aria-label="最长时间（秒／局面）" type="number" required min={0} max={300} step={0.1} value={draft.movetime / 1000} onChange={e => setDraft({ ...draft, movetime: Math.round(Number(e.target.value) * 1000) })} /></label>
            <label>深度<input aria-label="深度" type="number" required min={0} max={128} value={draft.depth} onChange={e => setDraft({ ...draft, depth: Number(e.target.value) })} /></label>
            <label>候选线路<input aria-label="候选线路" type="number" required {...limits('MultiPV', 16)} value={draft.multipv} onChange={e => setDraft({ ...draft, multipv: Number(e.target.value) })} /></label>
          </fieldset>
          <p>时间或深度填 0 表示不限制该项，至少启用一项；同时启用时先达到的限制生效。每步分别搜索最佳着和实战着，两次使用相同限制、分别计时。分类和准确率使用统一的平滑评分模型。</p>
          <p>灰色参数表示引擎不支持调整。候选线路为 1 时无法比较第二候选来识别关键着。保存后重启引擎，下次分析生效。</p>
        </>}
        {view === 'info' && <dl className="engine-info">
          <dt>状态</dt><dd>{locked ? '正在启动…' : state.analyzing ? '分析中' : state.ready ? '已就绪' : '未启动'}</dd>
          <dt>名称</dt><dd>{state.info?.name || currentEngineProfile().name}</dd>
          <dt>作者</dt><dd>{state.info?.author || '—'}</dd>
          <dt>类型</dt><dd>{state.info?.type || '—'}</dd>
          <dt>位置</dt><dd>{state.info?.path || '随应用内置'}</dd>
          <dt>参数</dt><dd>{state.settings.threads} 线程 · {state.info?.options.Hash ? `${state.settings.hash} MB 哈希` : '哈希不可调'} · {state.settings.multipv} 条候选</dd>
          <dt>搜索限制</dt><dd>深度 {state.settings.depth || '不限'} · {state.settings.movetime ? `${state.settings.movetime / 1000} 秒／局面` : '时间不限'}</dd>
        </dl>}
        {(error || state.error) && <p role="alert" className="engine-error">{error || state.error}</p>}
        <div className="dialog-actions"><Button type="button" disabled={locked} onClick={() => dialog.current!.close()}>关闭</Button>{view === 'settings' && <Button type="submit" variant="accent" disabled={locked || state.analyzing}>保存设置</Button>}</div>
      </form>
    </dialog>
  </>;
}
