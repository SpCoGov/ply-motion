// Development-only stage-0 acceptance surface. Never loaded by the production app.
import { useMemo, useRef, useState, type ComponentProps } from 'react';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { parsePgn } from '../lib/game.ts';
import { buildAnimationPlan } from '../lib/animation-plan.ts';

const examples = {
  normal: '1. e4 e5 2. Nf3 *',
  capture: '1. e4 d5 2. exd5 *',
  castle: '[SetUp "1"]\n[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]\n\n1. O-O *',
  promotion: '[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=Q+ *',
};
type TimelineRow = ComponentProps<typeof Timeline>['editorData'][number];
export function TimelineProbe() {
  const ref = useRef<TimelineState>(null);
  const [example, setExample] = useState<keyof typeof examples>('normal');
  const [zoom, setZoom] = useState(160), [fold, setFold] = useState(false), [commits, setCommits] = useState(0);
  const [draft, setDraft] = useState<TimelineRow[] | null>(null), [time, setTime] = useState(0);
  const [selected, setSelected] = useState(''), [keyframe, setKeyframe] = useState(false);
  const original = useMemo(() => {
    const game = parsePgn(examples[example]);
    const plan = buildAnimationPlan(game.moves.at(-1)!);
    return [{ id: 'group', actions: [] }, ...plan.pieces.map((p: { from: string; start: number; duration: number }, i: number) => ({ id: `piece-${i}`, actions: [{ id: `move-${i}`, effectId: 'move', start: p.start / 1000, end: (p.start + p.duration) / 1000 }] }))];
  }, [example]);
  const data = draft || original;
  return <div style={{ padding: 24, height: '100vh', overflow: 'auto' }}><h1>阶段 0 · 时间线组件验证</h1>
    <select aria-label="验证棋谱" value={example} onChange={e => { setExample(e.target.value as keyof typeof examples); setDraft(null); }}>{Object.keys(examples).map(key => <option key={key}>{key}</option>)}</select>
    <button onClick={() => setZoom(z => z === 160 ? 320 : 160)}>缩放</button>
    <button onClick={() => setFold(f => !f)}>折叠棋子组</button>
    <button onClick={() => { ref.current!.setTime(.5); setTime(ref.current!.getTime()); }}>外部定位 0.5s</button>
    <button onClick={() => { setDraft(data.map(row => ({ ...row, actions: row.actions.map(a => ({ ...a, start: a.start + .2, end: a.end + .2 })) }))); }}>外部修改</button>
    <button onClick={() => {
      const pgn = Array.from({ length: 1000 }, (_, i) => `${i + 1}. ${i % 2 ? 'Ng1 Ng8' : 'Nf3 Nf6'}`).join(' ') + ' *';
      const game = parsePgn(pgn);
      const rows: TimelineRow[] = Array.from({ length: 40 }, (_, i) => ({ id: `track-${i}`, actions: [] }));
      let start = 0;
      for (const move of game.moves) {
        const plan = buildAnimationPlan(move);
        rows[move.color === 'w' ? 0 : 1].actions.push({ id: `ply-${move.ply}`, effectId: 'move', start, end: start + plan.duration / 1000 });
        start += plan.duration / 1000;
      }
      setDraft(rows);
    }}>长棋谱 2000 手</button>
    <output aria-label="验证状态" style={{ display: 'block', height: 100, overflow: 'auto', overflowWrap: 'anywhere' }}>{JSON.stringify({ example, commits, time, zoom, fold, selected, keyframe, count: data.reduce((n, row) => n + row.actions.length, 0), data: data.slice(0, 3).map(row => ({ ...row, actions: row.actions.slice(0, 2) })) })}</output>
    <Timeline ref={ref} editorData={fold ? data.slice(0, 1) : data} effects={{ move: { id: 'move', name: '走子' } }} scale={1} scaleWidth={zoom} scaleSplitCount={30} gridSnap dragLine autoReRender={false}
      onChange={rows => { setDraft(rows); setCommits(c => c + 1); }} onClickActionOnly={(_, { action }) => setSelected(action.id)} onCursorDragEnd={t => setTime(t)} style={{ width: '100%', height: 350 }}
      getActionRender={action => <span data-probe-action={action.id} style={{ display: 'block', height: '100%' }}>{action.id}<button aria-label={`选择关键帧 ${action.id}`} onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setKeyframe(true); }} style={{ position: 'absolute', left: '50%', top: 0, border: 0, padding: 0, background: 'none' }}>◆</button></span>} />
    <p>此验证页不保存工程，不驱动棋盘，也不使用组件内置播放。</p>
  </div>;
}
