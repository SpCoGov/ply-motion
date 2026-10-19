import { createRoot } from 'react-dom/client';
import '../style.css';
import '../animation.css';
import '../video.css';
import 'dockview-react/dist/styles/dockview.css';
import './editor.css';

const previewSession = new URLSearchParams(location.search).get('preview');
if (previewSession && /^[a-f0-9-]{36}$/.test(previewSession)) {
  await (await import('./detached-preview')).startDetachedPreview(previewSession);
} else {
  const { prepareLegacy, legacyPanels } = await import('./legacy');
  const { initializeApp } = await import('../app.ts');
  const { App } = await import('./workspace');
  prepareLegacy();
  await initializeApp([...legacyPanels.values()]);
  const root = createRoot(document.getElementById('root')!);
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('timeline-probe')) {
    const { TimelineProbe } = await import('./timeline-probe');
    root.render(<TimelineProbe />);
  } else root.render(<App />);
}
