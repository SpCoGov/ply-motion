// Explicit local download only. Chess.com files are NOT covered by this project's Apache-2.0 license.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = new URL('../web/assets/chesscom/', import.meta.url);
const manifest = { source: 'https://images.chesscomfiles.com/chess-themes/', terms: 'https://www.chess.com/legal/user-agreement', license: 'Proprietary; no open redistribution license verified. Excluded from Git.', files: [] };
for (const dir of ['pieces', 'sounds']) await mkdir(new URL(dir + '/', base), { recursive: true });
const files = [
  ...['w', 'b'].flatMap(color => [...'pnbrqk'].map(piece => [`pieces/${color}${piece}.png`, `pieces/neo/150/${color}${piece}.png`])),
  ['sounds/move.mp3', 'sounds/_MP3_/default/move-self.mp3'],
  ['sounds/capture.mp3', 'sounds/_MP3_/default/capture.mp3'],
];
for (const [file, remote] of files) {
  const url = remote.startsWith('https://') ? remote : manifest.source + remote;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (file.endsWith('.png') && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${url}`);
  if (file.endsWith('.mp3') && !/audio|octet-stream/.test(response.headers.get('content-type') || '')) throw new Error(`Invalid audio: ${url}`);
  await writeFile(new URL(file, base), bytes);
  manifest.files.push({ file, url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(file, bytes.length);
}
await writeFile(new URL('manifest.json', base), JSON.stringify(manifest, null, 2));
