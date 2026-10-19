import type { Easing, MotionEdit, MotionFrame, MovingPiece } from './types.ts';
import { sqCR } from './board.ts';

export const MOVE_PRESETS = {
  glide: '轻盈滑行', dash: '蓄势冲刺', hop: '弧线跳跃',
  spin: '旋转一周落位', reverse: '反向旋转落位',
};
export type MovePreset = keyof typeof MOVE_PRESETS;

export function movePreset(preset: MovePreset, piece: Pick<MovingPiece, 'from' | 'to'>): MotionEdit {
  const from = sqCR(piece.from, false), to = sqCR(piece.to, false), x = to.c - from.c, y = to.r - from.r;
  const height = Math.min(.9, .3 + Math.hypot(x, y) * .08);
  const out: Easing = [0, 0, .58, 1], smooth: Easing = [.42, 0, .58, 1];
  const key = (offset: number, progress: number, lift = 0, rotation = 0, scale = 1, easing: Easing = smooth): MotionFrame =>
    ({ offset, x: x * progress || 0, y: y * progress - lift || 0, rotation, scale, opacity: 1, easing });
  let frames: MotionFrame[];
  switch (preset) {
    case 'glide': frames = [key(0, 0, 0, 0, 1, [.2, .8, .2, 1]), key(1, 1)]; break;
    case 'dash': frames = [key(0, 0, 0, 0, 1, out), key(.2, -.05, 0, -20, .96, [.45, 0, .25, 1]),
      key(.82, .9, .03, 8, 1.04, out), key(1, 1)]; break;
    case 'hop': frames = [key(0, 0), key(.2, .1, height * .5, -12, 1.04),
      key(.5, .5, height, 10, 1.08), key(.8, .9, height * .35, 3, 1.02), key(1, 1)]; break;
    case 'spin': case 'reverse': {
      const direction = preset === 'reverse' ? -1 : 1;
      // Finish the full turn before the final descent, retaining 360° for interpolation.
      frames = [key(0, 0), key(.22, .08, height * .55, 90 * direction, 1.04),
        key(.6, .65, height, 270 * direction, 1.08), key(.84, .95, height * .3, 360 * direction, 1.02), key(1, 1, 0, 360 * direction)];
      break;
    }
  }
  return { frames, easing: 'linear' };
}

export function motionPreset(motion: MotionEdit | undefined, piece: Pick<MovingPiece, 'from' | 'to'>): MovePreset | 'default' | 'custom' {
  if (!motion) return 'default';
  if (motion.easing !== 'linear' || Object.keys(motion.tracks || {}).length) return 'custom';
  return (Object.keys(MOVE_PRESETS) as MovePreset[]).find(id => {
    const { frames } = movePreset(id, piece);
    return frames.length === motion.frames.length && frames.every((frame, i) =>
      (['offset', 'x', 'y', 'rotation', 'scale', 'opacity'] as const).every(axis => frame[axis] === motion.frames[i][axis]) &&
      JSON.stringify(frame.easing) === JSON.stringify(motion.frames[i].easing));
  }) || 'custom';
}
