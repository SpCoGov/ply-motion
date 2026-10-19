import net from 'node:net';
import { MCP_TOOLS, validateMcpArguments } from '../web/lib/mcp.ts';

// shortcut: embedded media must fit a 4 MiB request; add file import for larger assets.
const MAX_BYTES = 4 * 1024 * 1024;
function callEditor(name, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 4174 });
    let data = '', bytes = 0, connected = false;
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(12000, () => fail(new Error('PlyMotion request timed out')));
    socket.on('error', error => fail(new Error(connected ? `PlyMotion connection failed: ${error.code} (${bytes} bytes received)` : 'Open the PlyMotion desktop app and enable MCP in the toolbar')));
    socket.on('connect', () => { connected = true; socket.write(JSON.stringify({ name, arguments: args }) + '\n'); });
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024 * 1024) return fail(new Error('PlyMotion response is too large'));
      data += chunk;
      if (data.includes('\n')) {
        try { const result = JSON.parse(data.slice(0, data.indexOf('\n'))); socket.destroy(); resolve(result); }
        catch { fail(new Error('Invalid PlyMotion response')); }
      }
    });
    socket.on('end', () => fail(new Error(`PlyMotion closed the connection before a complete response (${bytes} bytes received)`)));
  });
}

let initialized = false, ready = false;
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
async function handle(line) {
  let message;
  try { message = JSON.parse(line); }
  catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const id = message?.id ?? null;
  const error = (code, text) => write({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || ('id' in message && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id)))) return error(-32600, 'Invalid request');
  if (!('id' in message)) { if (message.method === 'notifications/initialized' && initialized) ready = true; return; }
  let result;
  if (message.method === 'ping') result = {};
  else if (message.method === 'initialize') {
    if (initialized) return error(-32600, 'Already initialized');
    const { protocolVersion, clientInfo, capabilities } = message.params || {};
    if (typeof protocolVersion !== 'string' || typeof clientInfo?.name !== 'string' || typeof clientInfo?.version !== 'string' || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return error(-32602, 'Invalid initialization parameters');
    initialized = true;
    const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    result = { protocolVersion: versions.includes(message.params.protocolVersion) ? message.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'plymotion', version: '0.1.0' }, instructions: 'Enable MCP in the running PlyMotion desktop editor. Read get_project before editing and use its revision. Changes remain unsaved until the user saves in the app.' };
  } else if (!ready) return error(-32600, 'Initialize the MCP session first');
  else if (message.method === 'tools/list') result = { tools: MCP_TOOLS };
  else if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params || {};
    try { validateMcpArguments(name, args); }
    catch (caught) { return error(-32602, caught.message); }
    try {
      const response = await callEditor(name, args);
      result = response.error ? { isError: true, content: [{ type: 'text', text: response.error }] } : { content: [{ type: 'text', text: JSON.stringify(response.result) }], structuredContent: response.result };
    } catch (caught) { result = { isError: true, content: [{ type: 'text', text: caught.message }] }; }
  } else return error(-32601, 'Method not found');
  write({ jsonrpc: '2.0', id, result });
}

// Bound both lines and outstanding calls; stdout contains only MCP messages.
let input = '', pending = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (Buffer.byteLength(line) > MAX_BYTES || pending >= 8) { process.stderr.write('MCP input limit exceeded\n'); process.exit(1); }
    if (!line.trim()) continue;
    pending++;
    void handle(line).catch(() => { process.stderr.write('MCP request failed\n'); process.exit(1); }).finally(() => pending--);
  }
  if (Buffer.byteLength(input) > MAX_BYTES) { process.stderr.write('MCP input limit exceeded\n'); process.exit(1); }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
