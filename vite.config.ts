import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';

// Keep the existing asset/Worker URLs in development and packaged Tauri builds.
export default defineConfig({
  root: 'web',
  // Prebundle the development-only timeline from the pnpm-patched dependency.
  optimizeDeps: { include: ['@xzdarcy/react-timeline-editor'] },
  resolve: { alias: { '@': resolve('web/editor') } },
  plugins: [react(), tailwindcss(), {
    name: 'local-chess-assets',
    async closeBundle() {
      for (const name of ['vendor', 'assets', 'icon.svg'])
        await cp(resolve('web', name), resolve('dist', name), { recursive: true, filter: source => !source.endsWith('.ts') });
      for (const name of ['LICENSE', 'LICENSE-GPL-3.0', 'THIRD_PARTY.md']) await cp(resolve(name), resolve('dist', name));
    },
  }],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', license: { fileName: 'dependency-licenses.md' } },
});
