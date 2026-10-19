import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type SerializedDockview } from 'dockview-react';
import { MaterialIcon as Icon } from './ui/material-icon';
import { refreshPreview, openCurrentProject, saveCurrentProject } from '../app.ts';
import { useEditor } from './store';
import { TimelinePanel } from './timeline';
import { Inspector } from './inspector';
import { Assets } from './assets';
import { legacyPanels } from './legacy';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';
import { panelTitles, parseLayout, storageKey } from './workspace-layout';
import { EngineMenu } from './engine-menu';
import { ExportMenu } from './export-menu';
import { openDetachedPreview } from './preview-bridge';
import { CreationPanel } from './creation-panel';
import { CameraPanel } from './camera-panel';
import { CameraPreview } from './camera-preview';
import { McpMenu } from './mcp-menu';

function LegacyContent({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = legacyPanels.get(name)!;
    ref.current!.append(content);
    return () => { document.getElementById('legacy-parking')!.append(content); };
  }, [name]);
  return <div className={`legacy-host host-${name}`} ref={ref} />;
}

function LegacyPanel({ api }: IDockviewPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (api.id !== 'preview') return;
    let previous = '', frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const host = ref.current!;
        if (!api.isVisible || !host.clientWidth) { refreshPreview(); return; }
        const size = Math.max(180, Math.min(host.clientWidth - 36, host.clientHeight - 90));
        const value = `${Math.round(size)}px`;
        if (value !== previous) {
          previous = value;
          (host.querySelector('.board-panel') as HTMLElement).style.width = value;
          refreshPreview();
        }
      });
    };
    const observer = new ResizeObserver(fit); observer.observe(ref.current!);
    const visibility = api.onDidVisibilityChange(() => { previous = ''; fit(); }); fit();
    return () => { observer.disconnect(); visibility.dispose(); cancelAnimationFrame(frame); refreshPreview(); };
  }, [api]);
  return <div ref={ref} className={`panel-body pane-${api.id}`}><LegacyContent name={api.id} /></div>;
}

const components = { creation: CreationPanel, legacy: LegacyPanel, inspector: Inspector, assets: Assets, timeline: TimelinePanel, camera: CameraPanel, 'camera-preview': CameraPreview };
const panelIcons: Record<string, string> = { creation: 'tune', preview: 'image', moves: 'list', assets: 'folder_open', analysis: 'analytics', inspector: 'tune', timeline: 'timeline', camera: 'tune', 'camera-preview': 'image' };
const panelComponent = (id: string) => ['preview', 'moves', 'analysis'].includes(id) ? 'legacy' : id;

export function App() {
  const projectName = useEditor(s => s.projectName), dirty = useEditor(s => s.dirty), fileBusy = useEditor(s => s.fileBusy);
  const apiRef = useRef<DockviewApi | null>(null), saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState('工作区已就绪');
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [layoutName, setLayoutName] = useState('我的工作区');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const notify = (message: string) => setStatus(message);
  const write = (key: string, value: unknown) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { notify('无法保存布局，本次会话仍可使用'); return false; }
  };
  const openPanel = (id: string) => {
    const api = apiRef.current!;
    const existing = api.getPanel(id);
    if (existing) { existing.api.setActive(); return existing; }
    return api.addPanel({ id, component: panelComponent(id), title: panelTitles[id], renderer: 'always',
      ...(api.activePanel ? { position: { referencePanel: api.activePanel.id, direction: 'within' as const } } : {}) });
  };
  const resetWorkspace = () => {
    const api = apiRef.current!; api.clear();
    api.addPanel({ id: 'preview', title: panelTitles.preview, component: 'legacy', renderer: 'always' });
    api.addPanel({ id: 'camera-preview', title: panelTitles['camera-preview'], component: 'camera-preview', renderer: 'always', inactive: true,
      position: { referencePanel: 'preview', direction: 'within' } });
    const compact = window.innerWidth < 900;
    api.addPanel({ id: 'moves', title: panelTitles.moves, component: 'legacy', renderer: 'always', initialWidth: 310,
      position: { referencePanel: 'preview', direction: compact ? 'within' : 'left' } });
    api.addPanel({ id: 'assets', title: panelTitles.assets, component: 'assets', renderer: 'always', inactive: true, position: { referencePanel: 'moves', direction: 'within' } });
    api.addPanel({ id: 'analysis', title: panelTitles.analysis, component: 'legacy', renderer: 'always', initialWidth: 305,
      position: { referencePanel: 'preview', direction: compact ? 'within' : 'right' } });
    for (const id of ['inspector', 'camera']) api.addPanel({ id, title: panelTitles[id], component: panelComponent(id), renderer: 'always', inactive: true,
      position: { referencePanel: 'analysis', direction: 'within' } });
    api.addPanel({ id: 'timeline', title: panelTitles.timeline, component: 'timeline', initialHeight: 205,
      position: { direction: 'below' } });
    api.getPanel('preview')!.api.setActive();
    notify('默认工作区');
  };
  const restore = (key: string) => {
    try {
      const layout = parseLayout(localStorage.getItem(key));
      apiRef.current!.fromJSON(layout as SerializedDockview);
      notify('布局已恢复'); return true;
    } catch { notify('布局不可用，已恢复默认工作区'); return false; }
  };
  const ready = ({ api }: DockviewReadyEvent) => {
    apiRef.current = api;
    if (!restore(storageKey)) resetWorkspace();
    try { setCustomNames(Object.keys(localStorage).filter(k => k.startsWith(`${storageKey}:`)).map(k => k.slice(storageKey.length + 1))); } catch { /* Defaults remain available. */ }
    const persist = () => write(storageKey, { version: 1, layout: api.toJSON() });
    const subscription = api.onDidLayoutChange(() => { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(persist, 250); });
    window.addEventListener('pagehide', persist);
    cleanup.current = () => { clearTimeout(saveTimer.current); subscription.dispose(); window.removeEventListener('pagehide', persist); };
  };
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => { const restorePreview = () => openPanel('camera-preview'); window.addEventListener('plymotion-return-preview', restorePreview); return () => window.removeEventListener('plymotion-return-preview', restorePreview); }, []);
  useEffect(() => { document.title = `${dirty ? '● ' : ''}${projectName} · PlyMotion`; }, [projectName, dirty]);
  return <div className="editor-shell workspace"><header className="editor-topbar"><a className="editor-brand" href="#" aria-label="PlyMotion"><img src="/icon.svg" alt="" /><span>PlyMotion</span></a>
    <DropdownMenu><DropdownMenuTrigger asChild><Button disabled={fileBusy}><Icon name="folder_open" />工程<Icon name="expand_more" size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuLabel>{projectName}{dirty ? ' · 未保存' : ''}</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => void openCurrentProject()}><Icon name="folder_open" />打开工程… <span>Ctrl+O</span></DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void saveCurrentProject()}><Icon name="save" />保存工程 <span>Ctrl+S</span></DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void saveCurrentProject(true)}><Icon name="save_as" />工程另存为…</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <EngineMenu /><McpMenu notify={notify} />
    <DropdownMenu><DropdownMenuTrigger asChild><Button><Icon name="dashboard" />工作区<Icon name="expand_more" size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuItem onSelect={() => dialogRef.current!.showModal()}><Icon name="save" />保存为自定义布局…</DropdownMenuItem>
      {customNames.map(name => <DropdownMenuItem key={name} onSelect={() => { if (!restore(`${storageKey}:${name}`)) resetWorkspace(); }}><Icon name="dashboard" />{name}</DropdownMenuItem>)}
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={resetWorkspace}><Icon name="restart_alt" />重置工作区</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <DropdownMenu><DropdownMenuTrigger asChild><Button><Icon name="view_quilt" />面板<Icon name="expand_more" size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuLabel>打开或定位面板</DropdownMenuLabel>{Object.entries(panelTitles).map(([id, title]) => <DropdownMenuItem key={id} onSelect={() => openPanel(id)}><Icon name={panelIcons[id]} />{title}</DropdownMenuItem>)}
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { const api = apiRef.current!; if (api.activePanel) api.addFloatingGroup(api.activePanel, { x: 90, y: 65, width: 580, height: 480 }); }}><Icon name="open_in_new" />浮动当前面板</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { void openDetachedPreview().then(() => apiRef.current?.getPanel('camera-preview')?.api.close()).catch(error => notify(String(error))); }}><Icon name="open_in_new" />独立镜头预览</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => apiRef.current?.activePanel?.api.close()}><Icon name="close" />关闭当前面板</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <ExportMenu disabled={fileBusy} /><span className="workspace-status" role="status">{status}</span><LegacyContent name="actions" />
  </header><div className="dock-container"><DockviewReact components={components} theme={themeDark} onReady={ready}
    watermarkComponent={() => <div className="empty-state">从“面板”菜单重新打开工作区，或选择“重置工作区”。</div>} /></div>
    <dialog ref={dialogRef} aria-labelledby="layout-title"><form onSubmit={e => { e.preventDefault(); const name = layoutName.trim(); if (!name) return;
      if (write(`${storageKey}:${name}`, { version: 1, layout: apiRef.current!.toJSON() })) { setCustomNames(names => [...new Set([...names, name])]); notify(`已保存布局：${name}`); dialogRef.current!.close(); }
    }}><h2 id="layout-title">保存工作区布局</h2><p>只保存面板位置和大小，不修改棋谱。</p><label>布局名称<input autoFocus required maxLength={40} value={layoutName} onChange={e => setLayoutName(e.target.value)} /></label><div className="dialog-actions"><Button type="button" onClick={() => dialogRef.current!.close()}>取消</Button><Button variant="accent" type="submit">保存布局</Button></div></form></dialog>
  </div>;
}
