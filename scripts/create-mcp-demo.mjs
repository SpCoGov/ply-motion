import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { alignMovesToBeats, resolveCamera, cameraPose } from '../web/lib/camera-beats.ts';
import { editedProject } from '../web/lib/editing.ts';
import { projectTimeMap, parseProject } from '../web/lib/project.ts';

const output = path.resolve('artifacts/mcp-demo-2026-10-14');
await mkdir(output, { recursive: true });
const musicFile = 'C:/Users/Administrator/Downloads/MONTAGEM PEGADORA (Slowed).m4a';
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', musicFile], { windowsHide: true, encoding: 'utf8' });
assert.equal(probe.status, 0);
let sourceDuration = Number(JSON.parse(probe.stdout).format.duration) * 1000;
const sourceData = (await readFile(musicFile)).toString('base64');
const beats = JSON.parse(await readFile(path.join(output, 'detected-beats.json'), 'utf8'));
let target = 1000; const selected = [];
for (const gap of [0, 1100, 1500, 650, 1500, 1100, 650, 1400, 950, 1750, 650, 1400, 1200]) {
  target += gap;
  const candidates = beats.filter(beat => beat >= (selected.at(-1) || 0) + 550);
  selected.push(candidates.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a));
}
assert.equal(new Set(selected).size, 13);
const testDir = path.resolve('test-results/mcp-demo'); await mkdir(testDir, { recursive: true });
const executable = path.join(testDir, 'ply-motion.exe'); await copyFile('target/release/ply-motion.exe', executable);
const portProbe = net.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const debugPort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
const app = spawn(executable, [], { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  WEBVIEW2_USER_DATA_FOLDER: path.join(testDir, `profile-${Date.now()}`) } });
let nativeBrowser, renderBrowser, server, client, lines, encoder;
app.stderr.on('data', bytes => console.error('PlyMotion:', bytes.toString()));
const log = [];
try {
  const until = Date.now() + 30000;
  while (true) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() > until) throw new Error('Native WebView2 unavailable');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  nativeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const native = nativeBrowser.contexts()[0].pages().find(page => !page.url().includes('preview='));
  native.on('pageerror', error => console.error('Native page:', error.message));
  native.on('console', message => { if (message.type() === 'error') console.error('Native console:', message.text().slice(0, 300)); });
  await native.getByRole('button', { name: 'MCP：关', exact: true }).waitFor();
  await native.getByRole('button', { name: 'MCP：关', exact: true }).click();
  await native.getByRole('button', { name: 'MCP：开', exact: true }).waitFor();
  sourceDuration = await native.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(bytes.buffer);
    return Math.ceil(buffer.duration * 1000);
  }, sourceData);
  client = spawn(process.execPath, ['scripts/mcp.mjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  lines = createInterface({ input: client.stdout }); let nextId = 0; const pending = new Map();
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
    pending.set(id, response => { clearTimeout(timer); response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result); });
    client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codex-plymotion-demo', version: '1' } });
  client.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal((await rpc('tools/list')).tools.length, 6);
  const call = async (name, args = {}) => {
    const started = Date.now(), response = await rpc('tools/call', { name, arguments: args });
    log.push({ tool: name, ms: Date.now() - started, error: !!response.isError, revision: response.structuredContent?.revision });
    if (response.isError) {
      console.error('Native status:', await native.locator('.workspace-status').textContent(), 'exit:', app.exitCode);
      await native.screenshot({ path: path.join(output, 'mcp-error.png') });
      throw new Error(response.content[0].text);
    }
    return response.structuredContent;
  };
  let snapshot = await call('get_project');
  await call('set_pgn', { revision: snapshot.revision, pgn: '[Event "Legal\'s Trap · Beat Edit"]\n[White "Legal"]\n[Black "Saint Brie"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 $3 Bxd1 $4 6. Bxf7+ $1 Ke7 7. Nd5# $3 1-0' });
  snapshot = await call('get_project', { includeAssetData: true });
  const project = snapshot.project;
  project.edits.beats = selected;
  const timing = alignMovesToBeats(project);
  const camera = { keys: [], shakes: [], follow: { enabled: true, moves: {} } };
  for (const [i, segment] of project.segments.entries()) {
    camera.follow.moves[segment.id] = { scale: i === 12 ? 1.25 : [1.22, 1.32, 1.5, 1.25, 1.4][i % 5], durationMs: [320, 450, 260, 520, 350][i % 5] };
    if ([4, 8, 9, 10, 12].includes(i)) camera.shakes.push({ id: `beat-${i + 1}`, startMs: selected[i] - 35, durationMs: i === 12 ? 380 : 240, strength: i === 12 ? .065 : .035 });
  }
  const asset = { id: 'custom:mcp-demo-bgm', kind: 'audio', source: { kind: 'embedded', name: path.basename(musicFile), data: `data:audio/mp4;base64,${sourceData}`, durationMs: sourceDuration } };
  const music = { assetId: asset.id, startMs: 0, offsetMs: 0, durationMs: 18000, volume: .5, fadeInMs: 180, fadeOutMs: 900 };
  await call('update_animation', { revision: snapshot.revision, edits: { clips: timing.clips, segments: timing.segments, beatStarts: timing.beatStarts, beatSync: timing.beatSync, beats: selected, assets: [asset], music, camera } });
  snapshot = await call('get_project', { includeAssetData: true });
  const edited = snapshot.project, effective = editedProject(edited), map = projectTimeMap(edited);
  const timings = effective.segments.map((segment, i) => {
    const land = effective.clips.find(clip => clip.moveId === segment.id && clip.effect === 'land');
    const at = map.ranges[i].start + land.startMs;
    assert.ok(Math.abs(at - selected[i]) < .01, `Move ${i + 1} missed its beat`);
    assert.equal(edited.edits.beatSync[`sound:${i + 1}`], selected[i]);
    return { ply: i + 1, id: segment.id, landMs: at, intervalMs: i ? at - selected[i - 1] : null, focus: camera.follow.moves[segment.id], shake: camera.shakes.find(shake => shake.id === `beat-${i + 1}`) || null };
  });
  assert.ok(new Set(timings.slice(1).map(row => row.intervalMs)).size > 3);
  const poses = [0, 3000, 6000, 9000, 12000, 15000].map(time => cameraPose(resolveCamera(edited).camera, time));
  assert.ok(new Set(poses.map(pose => `${pose.x},${pose.y}`)).size > 3);
  const undo = await call('undo', { revision: snapshot.revision }); assert.equal(undo.canRedo, true);
  const redo = await call('redo', { revision: undo.revision }); assert.equal(redo.canUndo, true);
  await call('seek_timeline', { timeMs: 12182 });
  const projectFile = path.join(output, 'legal-beat-edit.plymotion');
  // Save through the existing native command; MCP currently exposes editing, not file operations.
  await native.evaluate(async ({ project, target }) => {
    await window.__TAURI__.core.invoke('save_project', { content: JSON.stringify(project), path: target });
  }, { project: edited, target: projectFile });
  const saved = JSON.parse(await readFile(projectFile, 'utf8'));
  assert.equal(saved.edits.assets[0].source.kind, 'relative');
  await writeFile(path.join(output, 'edit-timings.json'), JSON.stringify({ detectedCandidates: beats.length, selected, timings, poses, durationMs: map.duration }, null, 2));
  await writeFile(path.join(output, 'mcp-calls.json'), JSON.stringify(log, null, 2));
  console.log(`MCP editing passed: 13 beat-aligned moves, variable intervals, BGM, focus, follow, 5 shakes, undo/redo. Duration ${map.duration} ms.`);
  // Reuse the application's renderer and soundtrack; FFmpeg is only the encoding sink.
  server = await startServer(0);
  renderBrowser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await renderBrowser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('.move-button').first().waitFor();
  const videoPath = path.join(output, 'legal-beat-edit.mp4'), audioPath = path.join(output, 'mixed-audio.wav');
  let frames = 0, encoderError = '', encoded;
  await page.exposeFunction('encodeDemoData', async (kind, encodedBytes) => {
    const bytes = Buffer.from(encodedBytes, 'base64');
    if (kind === 'audio') { await writeFile(audioPath, bytes); return; }
    assert.equal(kind, 'frame');
    if (!encoder) {
      encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-framerate', '30', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0', '-i', audioPath, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', videoPath], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      encoder.stderr.on('data', bytes => { encoderError += bytes; });
      encoded = new Promise((resolve, reject) => { encoder.once('error', reject); encoder.once('exit', code => code === 0 ? resolve() : reject(new Error(encoderError))); });
    }
    await new Promise((resolve, reject) => encoder.stdin.write(bytes, error => error ? reject(error) : resolve()));
    if (++frames % 90 === 0) console.log(`Export: ${frames} frames`);
  });
  await page.evaluate(async ({ project, videoPath }) => {
    const { exportVideo } = await import('/lib/video.ts');
    const base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
    window.__TAURI__ = { core: { invoke: async (command, args, options) => {
      if (command === 'start_video_export') return 'demo';
      if (command === 'finish_video_export') return videoPath;
      if (command === 'write_video_data') return window.encodeDemoData(options.headers['x-export-kind'], base64(new Uint8Array(args)));
      throw new Error(`Unexpected export command: ${command}`);
    } } };
    const settings = { ...project.output, width: 1080, height: 1080, fps: 30, crf: 19, bitrate: 0, sound: true, showNames: true, showMove: true, showEvaluation: false };
    const chesscom = project.assets.find(asset => asset.id === 'pieces').source.id === 'chesscom-neo';
    await exportVideo({ project, settings, chesscom, signal: new AbortController().signal, onProgress() {} });
    delete window.__TAURI__;
  }, { project: edited, videoPath });
  encoder.stdin.end(); await encoded; encoder = undefined;
  const info = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', videoPath], { windowsHide: true, encoding: 'utf8' });
  assert.equal(info.status, 0); const metadata = JSON.parse(info.stdout);
  assert.ok(metadata.streams.some(stream => stream.codec_name === 'aac'));
  assert.ok(metadata.streams.some(stream => stream.codec_name === 'h264' && stream.width === 1080));
  assert.ok(Math.abs(Number(metadata.format.duration) - 18) < .1);
  await writeFile(path.join(output, 'export-verification.json'), JSON.stringify({ frames, ...metadata }, null, 2));
  const strip = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-vf', "select='eq(n,60)+eq(n,150)+eq(n,240)+eq(n,330)+eq(n,420)+eq(n,510)',scale=360:360,tile=3x2", '-frames:v', '1', path.join(output, 'storyboard.png')], { windowsHide: true });
  assert.equal(strip.status, 0);
  console.log(`Finished: ${videoPath}`);
  await native.getByRole('button', { name: 'MCP：开', exact: true }).click();
} finally {
  lines?.close(); client?.kill(); encoder?.kill();
  await renderBrowser?.close(); await nativeBrowser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (app.exitCode === null) app.kill();
}
