const revision = { type: 'integer', minimum: 0, description: 'Revision returned by get_project; read again after any edit.' };
const animationFields = ['objects', 'clips', 'segments', 'camera', 'composition', 'music', 'beatStarts', 'beatSync', 'beatOffsets'];
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const MCP_TOOLS = [
  { name: 'get_project', description: 'Read project metadata, effective scene, editor state and revision. All times are milliseconds. Embedded asset data is omitted by default to keep model context small; includeAssetData=true returns the complete project for export. Omitted asset data must not be written back through update_animation.', inputSchema: schema({ includeAssetData: { type: 'boolean' } }), annotations: { readOnlyHint: true } },
  { name: 'set_pgn', description: 'Import a standard chess PGN as a new unsaved project. Resets animation, analysis and undo history. Set replaceUnsaved=true only when the user wants to discard unsaved work.', inputSchema: schema({ revision, pgn: { type: 'string', minLength: 1, maxLength: 1000000 }, replaceUnsaved: { type: 'boolean' } }, ['revision', 'pgn']), annotations: { destructiveHint: true } },
  { name: 'update_animation', description: 'Update project.edits using the existing PlyMotion format. Each supplied top-level field replaces that field; other fields remain. Read get_project first and retain existing entries in supplied maps. Supports animation, camera, music, embedded assets and beatStarts/beatSync for independent move timing. Music references an embedded audio asset; beatStarts must contain every segment ID. Validated and undoable; locked tracks cannot change.', inputSchema: schema({ revision, edits: { type: 'object', minProperties: 1, properties: Object.fromEntries(animationFields.map(key => [key, { type: 'object' }]).concat(['copies', 'beats', 'assets'].map(key => [key, { type: 'array' }]))), additionalProperties: false } }, ['revision', 'edits']), annotations: { destructiveHint: false } },
  { name: 'seek_timeline', description: 'Pause and seek the preview to a time in milliseconds within the current duration.', inputSchema: schema({ timeMs: { type: 'number', minimum: 0 } }, ['timeMs']), annotations: { destructiveHint: false } },
  { name: 'undo', description: 'Undo the last editor change, including an MCP animation edit.', inputSchema: schema({ revision }, ['revision']), annotations: { destructiveHint: false } },
  { name: 'redo', description: 'Redo the last undone editor change.', inputSchema: schema({ revision }, ['revision']), annotations: { destructiveHint: false } },
];

export function validateMcpArguments(name: string, value: unknown): Record<string, unknown> {
  const tool = MCP_TOOLS.find(tool => tool.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be an object');
  const args = value as Record<string, unknown>, { properties, required } = tool.inputSchema;
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(args, key))) throw new Error('Missing or unsupported arguments');
  if ('revision' in args && (!Number.isSafeInteger(args.revision) || (args.revision as number) < 0)) throw new Error('Invalid revision');
  if (name === 'get_project' && 'includeAssetData' in args && typeof args.includeAssetData !== 'boolean') throw new Error('Invalid includeAssetData');
  if (name === 'set_pgn' && (typeof args.pgn !== 'string' || !args.pgn.trim() || args.pgn.length > 1000000 || ('replaceUnsaved' in args && typeof args.replaceUnsaved !== 'boolean'))) throw new Error('Invalid PGN arguments');
  if (name === 'seek_timeline' && (typeof args.timeMs !== 'number' || !Number.isFinite(args.timeMs) || args.timeMs < 0)) throw new Error('Invalid timeline time');
  if (name === 'update_animation') {
    if (!args.edits || typeof args.edits !== 'object' || Array.isArray(args.edits)) throw new Error('Edits must be an object');
    const keys = Object.keys(args.edits);
    if (!keys.length || keys.some(key => ![...animationFields, 'copies', 'beats', 'assets'].includes(key))) throw new Error('Unsupported animation edit field');
  }
  return args;
}
