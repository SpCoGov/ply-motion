import markup from '../legacy.html?raw';
import { materialIconUrl } from '../lib/material-icons.ts';

// Retain the existing DOM and handlers across Dockview mounts, moves and closes.
// This bridge can disappear as each legacy panel migrates to React.
export const legacyPanels = new Map<string, HTMLElement>();
export function prepareLegacy() {
  const parking = document.getElementById('legacy-parking')!;
  parking.innerHTML = markup;
  for (const icon of parking.querySelectorAll<HTMLElement>('[data-material-icon]')) icon.style.maskImage = `url('${materialIconUrl(icon.dataset.materialIcon!)}')`;
  const collect = (id: string, selectors: string[]) => {
    const panel = document.createElement('div');
    panel.className = `legacy-content legacy-${id}`;
    for (const selector of selectors) {
      const node = parking.querySelector(selector);
      if (!node) throw new Error(`缺少原界面元素：${selector}`);
      panel.append(node);
    }
    parking.append(panel); legacyPanels.set(id, panel);
  };
  collect('preview', ['.board-panel']);
  collect('moves', ['.move-table-heading', '#moves']);
  collect('analysis', ['.engine-controls', '.status-row', '#progress', '.game-details', '.game-players', '.game-score', '#reviewStats', '.panel-foot']);
  collect('actions', ['.header-actions']);
  // Dialogs and live notifications must remain accessible when panels are closed.
  for (const node of [...parking.querySelectorAll('dialog, #message')]) document.body.append(node);
  parking.querySelector('.workspace')!.classList.remove('workspace');
  document.getElementById('root')!.classList.add('workspace');
}
