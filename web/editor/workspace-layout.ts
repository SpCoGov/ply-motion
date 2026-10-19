export const storageKey = 'plymotion.workspace.v1';
export const panelTitles: Record<string, string> = {
  creation: '构图与叠加', preview: '棋盘预览', moves: '步序', assets: '素材', analysis: '棋局',
  inspector: '属性', timeline: '时间线', camera: '镜头与卡点', 'camera-preview': '镜头预览',
};

export function parseLayout(raw: string | null) {
  if (!raw || raw.length > 200_000) throw new Error('布局为空或过大');
  const value = JSON.parse(raw);
  if (value.version !== 1 || !value.layout?.grid || !value.layout.panels || typeof value.layout.panels !== 'object') throw new Error('布局版本或结构无效');
  for (const [id, panel] of Object.entries(value.layout.panels) as [string, { id: string; contentComponent: string; title: string; params?: unknown; tabComponent?: string }][]) {
    const component = ['preview', 'moves', 'analysis'].includes(id) ? 'legacy' : id;
    if (!Object.hasOwn(panelTitles, id) || panel.id !== id || panel.contentComponent !== component || panel.tabComponent) throw new Error('布局包含未知面板');
    panel.title = panelTitles[id]; delete panel.params;
  }
  // Native preview geometry is restored by Rust, never from Dockview browser popouts.
  if (value.layout.popoutGroups?.length) throw new Error('不支持独立窗口布局');
  return value.layout;
}
