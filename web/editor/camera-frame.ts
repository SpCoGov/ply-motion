import type { Project } from '../lib/types.ts';
import { cameraPose, resolveCamera } from '../lib/camera-beats.ts';
import { trackState } from '../lib/editing.ts';

export function updateCameraFrame(board: HTMLElement, project: Project, time: number, reduced: boolean) {
  const frame = board.parentElement!.querySelector<SVGSVGElement>('.camera-viewport')!;
  if (!board.clientWidth) return;
  frame.style.left = `${board.offsetLeft}px`; frame.style.top = `${board.offsetTop}px`;
  frame.style.width = `${board.clientWidth}px`; frame.style.height = `${board.clientHeight}px`;
  const camera = trackState(project, 'camera').hidden ? undefined : resolveCamera(project).camera;
  const pose = cameraPose(camera, reduced ? camera?.keys.filter(key => key.time <= time).at(-1)?.time ?? 0 : time, !reduced);
  const direction = project.output.flip ? -1 : 1, unit = board.clientWidth / 8;
  const style = getComputedStyle(board), translation = style.translate.split(' ').map(parseFloat);
  const origin = style.transformOrigin.split(' ').map(value => parseFloat(value) / unit);
  const scale = style.scale.split(' ').map(Number);
  const base = new DOMMatrix().translate((translation[0] || 0) / unit, (translation[1] || 0) / unit)
    .translate(origin[0], origin[1]).rotate(parseFloat(style.rotate) || 0)
    .scale(scale[0] || 1, scale[1] || scale[0] || 1).translate(-origin[0], -origin[1]);
  const lens = new DOMMatrix().translate(4, 4).scale(pose.scale).rotate(-pose.rotation)
    .translate(-pose.x * direction, -pose.y * direction).translate(-4, -4);
  // Project the camera's crop back onto the full-board editor, preserving board transforms.
  const projection = base.multiply(lens.inverse()).multiply(base.inverse());
  const points = [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(projection));
  for (const outline of frame.querySelectorAll('polygon')) outline.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
  frame.removeAttribute('hidden');
}
