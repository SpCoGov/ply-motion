import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.json': 'application/json' };
export function startServer(port = 4173) {
  if (process.env.TEST_DIST !== '1') return import('vite').then(async ({ createServer }) => {
    const vite = await createServer({ server: { port, strictPort: true, host: '127.0.0.1' } });
    await vite.listen();
    return { address: () => vite.httpServer.address(), close: callback => vite.close().then(callback) };
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const name = decodeURIComponent(url.pathname);
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || name.includes('\\')) { res.writeHead(403).end(); return; }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    } catch { res.writeHead(404).end('Not found'); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT || 4173));
  console.log(`PlyMotion: http://127.0.0.1:${server.address().port}`);
}
