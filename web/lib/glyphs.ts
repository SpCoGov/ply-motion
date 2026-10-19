// Selected SVGs copied unchanged from svg-extracted/svg into web/assets/icons.
// Runtime never reads the extraction directory. See THIRD_PARTY.md.
const MOVE_ICONS: Record<string, string> = {
  brilliant: '013-Brilliant', great: '027-great_find', best: '010-best',
  excellent: '023-excellent', good: '029-good', forced: '028-forced',
  book: '012-book', inaccuracy: '030-inaccuracy', mistake: '034-mistake',
  miss: '064-_jt', blunder: '011-blunder',
};
// White, black. Results only distinguish victory, defeat and draw.
const STATUS_ICONS: Record<string, [string, string]> = {
  win: ['046-winner-white', '045-winner'],
  loss: ['020-defeat_white', '019-defeat_black'],
  draw: ['022-draw_white', '021-draw_black'],
};
function iconImage(file: string | null) {
  return file ? `<img class="clsglyph original-icon" src="assets/icons/${file}.svg" alt="" aria-hidden="true">` : '';
}
export function glyphSvg(cls: string) {
  return iconImage(Object.hasOwn(MOVE_ICONS, cls) ? MOVE_ICONS[cls] : null);
}
export function statusGlyph(icon: string, side = 'w') {
  return iconImage(Object.hasOwn(STATUS_ICONS, icon) ? STATUS_ICONS[icon][side === 'b' ? 1 : 0] : null);
}
export function tacticGlyph(kind: string) {
  return kind === 'free_piece' ? iconImage('025-free_piece') : '';
}
