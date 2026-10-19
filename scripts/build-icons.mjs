import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = join(root, 'gen');
mkdirSync(generated, { recursive: true });
const work = mkdtempSync(join(generated, 'app-icons-'));
try {
  const source = readFileSync(join(root, 'icon.svg'), 'utf8');
  const [x, y, width, height] = source.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const side = Math.max(width, height);
  // Pad the source viewBox with transparent space, never a window/background color.
  const square = source.replace(/<svg\b[^>]*>/, tag => tag
    .replace(/width="[^"]+"/, `width="${side}"`).replace(/height="[^"]+"/, `height="${side}"`)
    .replace(/viewBox="[^"]+"/, `viewBox="${x - (side - width) / 2} ${y - (side - height) / 2} ${side} ${side}"`));
  const input = join(work, 'source.svg'), output = join(work, 'output');
  writeFileSync(input, square);
  const result = spawnSync('cargo', ['tauri', 'icon', input, '--output', output], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Tauri icon generation failed');
  for (const file of ['icon.ico', 'icon.png']) copyFileSync(join(output, file), join(root, 'icons', file));
  console.log('Updated icons/icon.ico and icons/icon.png from the transparent SVG.');
} finally {
  if (!resolve(work).startsWith(resolve(generated) + sep)) throw new Error('Unexpected icon build directory');
  rmSync(work, { recursive: true, force: true });
}
