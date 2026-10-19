import { useRef, useState } from 'react';
import { editProject, seekTime, setOutputSize } from '../app.ts';
import { COMPOSITION, newOverlay } from '../lib/creation.ts';
import { cleanAssets, importMedia } from '../lib/assets.ts';
import { properties, trackState } from '../lib/editing.ts';
import type { Overlay } from '../lib/types.ts';
import { useEditor } from './store';
import { Button } from './ui/button';
import { NumberField } from './inspector';

export function CreationPanel() {
  const project = useEditor(s => s.project), time = useEditor(s => s.timeMs), fileBusy = useEditor(s => s.fileBusy);
  const [selected, setSelected] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const composition = project.edits.composition || COMPOSITION, overlays = project.edits.overlays || [], overlay = overlays.find(o => o.id === selected);
  const apply = (change: Parameters<typeof editProject>[0]) => setStatus(editProject(change) || '');
  const change = (key: keyof Overlay, value: unknown) => apply(e => { Object.assign(e.overlays!.find(o => o.id === selected)!, { [key]: value }); });
  const numeric = (key: keyof Overlay, label: string, min: number, max: number, step = 1) => <label key={key}>{label}<NumberField label={label} value={overlay![key] as number} min={min} max={max} step={step} change={value => change(key, value)} /></label>;
  return <div className="panel-body creation-panel camera-panel">
    <h3>画面构图</h3>
    <fieldset disabled={fileBusy || trackState(project, 'board').locked} className="camera-fields">
      <label>画面比例<select aria-label="构图预设" value={`${project.output.width}:${project.output.height}`} onChange={e => { const [w, h] = e.target.value.split(':').map(Number); setOutputSize(w, h); }}>
        <option value={`${project.output.width}:${project.output.height}`}>当前 {project.output.width} × {project.output.height}</option>
        <option value="1080:1080">1:1 方形</option><option value="1920:1080">16:9 横屏</option><option value="1080:1920">9:16 竖屏</option>
      </select></label>
      {(['x', 'y', 'scale', 'rotation'] as const).map(key => <label key={key}>{{ x: '构图横移', y: '构图纵移', scale: '构图缩放', rotation: '构图旋转' }[key]}<NumberField label={{ x: '构图横移', y: '构图纵移', scale: '构图缩放', rotation: '构图旋转' }[key]} value={composition[key]} min={key === 'scale' ? .1 : -2000} max={key === 'scale' ? 3 : 2000} step={key === 'scale' ? .01 : 1} change={value => apply(e => { e.composition = { ...composition, [key]: value }; })} /></label>)}
      <label>画面背景<input type="color" aria-label="画面背景" value={composition.background} onChange={e => apply(edits => { edits.composition = { ...composition, background: e.target.value }; })} /></label>
      <label><input type="checkbox" checked={composition.coordinates} onChange={e => apply(edits => { edits.composition = { ...composition, coordinates: e.target.checked }; })} />显示棋盘坐标</label>
      <details><summary>棋盘坐标层</summary>{Object.entries(properties).filter(([key]) => key !== 'stretch').map(([key, p]) => <label key={key}>{p.label}<NumberField label={`坐标层${p.label}`} value={project.edits.coordinates?.[key as 'x'] ?? p.value} min={key === 'scale' ? .1 : p.min} max={p.max} step={p.step} change={value => apply(e => { e.coordinates = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...e.coordinates, [key]: value }; })} /></label>)}<Button onClick={() => apply(e => { delete e.coordinates; })}>重置坐标层</Button></details>
      <Button onClick={() => apply(e => { delete e.composition; })}>重置构图</Button>
    </fieldset>
    <h3>文字与图片叠加</h3><p className="muted">位置按画面宽高各 1000 单位；字号与宽度按画面宽度计算。在镜头预览查看成片。列表顺序即叠放顺序，后者在上。</p>
    <div className="property-actions"><Button disabled={fileBusy} onClick={() => { const o = newOverlay(time); apply(e => { (e.overlays ||= []).push(o); }); setSelected(o.id); }}>添加文字</Button>
      <Button disabled={fileBusy || busy} onClick={() => { input.current!.value = ''; input.current!.click(); }}>添加图片</Button></div>
    <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp,.svg" aria-label="导入叠加图片" hidden onChange={async event => {
      const file = event.target.files?.[0]; if (!file) return;
      const before = useEditor.getState().project; setBusy(true);
      try {
        const asset = await importMedia(file, 'image');
        if (useEditor.getState().project !== before) throw new Error('工程已改变，请重新导入。');
        const o = newOverlay(time, asset.id);
        apply(e => { (e.assets ||= []).push(asset); (e.overlays ||= []).push(o); }); setSelected(o.id);
      } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
    }} />
    <label>叠加元素<select aria-label="叠加元素" value={overlay?.id || ''} onChange={e => setSelected(e.target.value)}><option value="">选择元素</option>{overlays.map((o, i) => <option key={o.id} value={o.id}>{i + 1}. {o.kind === 'text' ? o.text.slice(0, 24) || '文字' : '图片'}</option>)}</select></label>
    {overlay && <>
      <label><input type="checkbox" aria-label="锁定叠加元素" checked={overlay.locked} disabled={fileBusy} onChange={e => change('locked', e.target.checked)} />锁定</label>
      <fieldset disabled={overlay.locked || fileBusy} className="camera-fields">
        {overlay.kind === 'text' && <><label>文字内容<textarea aria-label="文字内容" maxLength={2000} value={overlay.text} onChange={e => change('text', e.target.value)} /></label>
          {numeric('fontSize', '文字字号', 1, 300)}<label>文字颜色<input type="color" aria-label="文字颜色" value={overlay.color} onChange={e => change('color', e.target.value)} /></label></>}
        {numeric('startMs', '叠加起点', 0, 120000000 - overlay.durationMs)}{numeric('durationMs', '叠加时长', 1, Math.min(600000, 120000000 - overlay.startMs))}
        {numeric('x', '叠加横坐标', -2000, 3000)}{numeric('y', '叠加纵坐标', -2000, 3000)}{numeric('width', '叠加宽度', 1, 3000)}
        {numeric('rotation', '叠加旋转', -3600, 3600)}{numeric('opacity', '叠加透明度', 0, 1, .05)}
        {numeric('fadeInMs', '叠加淡入', 0, 600000)}{numeric('fadeOutMs', '叠加淡出', 0, 600000)}
        <label>对齐<select aria-label="叠加对齐" value={overlay.align} onChange={e => change('align', e.target.value)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
        <label><input type="checkbox" checked={overlay.hidden} onChange={e => change('hidden', e.target.checked)} />隐藏元素</label>
        <div className="property-actions"><Button onClick={() => apply(e => { e.overlays!.push({ ...overlay, id: crypto.randomUUID() }); })}>复制元素</Button>
          <Button onClick={() => apply(e => { e.overlays = e.overlays!.filter(o => o.id !== overlay.id); cleanAssets(e); })}>删除元素</Button></div>
      </fieldset><Button onClick={() => seekTime(overlay.startMs)}>定位元素起点</Button>
    </>}
    <p role="status">{status}</p>
  </div>;
}
