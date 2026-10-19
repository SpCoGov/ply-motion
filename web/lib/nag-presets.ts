import type { MotionEdit, MotionFrame } from './types.ts';

export type NagPhase = 'nag' | 'nag-exit';
export const NAG_PRESETS = {
  nag: { pop: '弹跳出现', spin: '旋转出现', rise: '上浮显现', impact: '冲击放大' },
  'nag-exit': { fade: '柔和淡出', shrink: '缩小消失', rise: '上浮消散', spin: '旋转飞散' },
};
export const NAG_PARTICLES = { burst: '光点爆发', dust: '上扬星尘', orbit: '环绕光点' };
export type NagParticle = keyof typeof NAG_PARTICLES;
export const NAG_PARTICLE_PREFIX = 'nag-particle:';
export const nagExitFrames = (): Keyframe[] => [{ transform: 'rotate(0deg) scale(1)' },
  { transform: 'rotate(25deg) scale(.8)', offset: .35 }, { transform: 'rotate(75deg) scale(0)' }];

const key = (offset: number, scale = 1, rotation = 0, y = 0, opacity = 1, x = 0): MotionFrame =>
  ({ offset, x: x || 0, y: y || 0, rotation, scale, opacity, easing: 'linear' });

export function nagPreset(phase: NagPhase, id: string): MotionEdit {
  const frames = phase === 'nag' ? {
    pop: [key(0, 0), key(.55, 1.35), key(.8, .93), key(1)],
    spin: [key(0, 0, -300), key(.65, 1.25, 12), key(.85, .96, -3), key(1)],
    rise: [key(0, .7, -8, .3, 0), key(.7, 1.08, 3, -.04), key(1)],
    impact: [key(0, 2.2, 0, 0, 0), key(.45, .92), key(.7, 1.12), key(1)],
  } : {
    fade: [key(0), key(1, 1, 0, 0, 0)],
    shrink: [key(0), key(.3, 1.12), key(1, 0, 0, 0, 0)],
    rise: [key(0), key(1, .75, -12, -.4, 0)],
    spin: [key(0), key(.35, 1.12, 75, -.06), key(1, 0, 360, -.35, 0, .25)],
  };
  if (!Object.hasOwn(frames, id)) throw new Error('未知的 NAG 动效预设。');
  return { frames: frames[id as keyof typeof frames]!, easing: 'linear' };
}

function matches(motion: MotionEdit, preset: MotionEdit) {
  return motion.easing === preset.easing && !Object.keys(motion.tracks || {}).length && motion.frames.length === preset.frames.length &&
    preset.frames.every((frame, i) => (['offset', 'x', 'y', 'rotation', 'scale', 'opacity'] as const).every(axis => frame[axis] === motion.frames[i][axis]) &&
      JSON.stringify(frame.easing) === JSON.stringify(motion.frames[i].easing));
}

export function nagPresetId(phase: NagPhase, motion?: MotionEdit) {
  return !motion ? 'default' : Object.keys(NAG_PRESETS[phase]).find(id => matches(motion, nagPreset(phase, id))) || 'custom';
}

export function nagParticles(style: NagParticle): Record<string, MotionEdit> {
  // Fixed angles and stagger make every seek and export reproduce the same burst.
  return Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
    const angle = i * 2.3999632297, radius = .35 + i % 4 * .1, size = .65 + i % 3 * .25, delay = i % 4 * .035;
    const frames = Array.from({ length: 9 }, (_, j) => {
      const offset = j / 8, t = Math.max(0, Math.min(1, (offset - delay) / (1 - delay)));
      const turn = angle + t * Math.PI * 1.5;
      const x = style === 'orbit' ? Math.cos(turn) * (.16 + t * .24) : Math.cos(angle) * radius * t;
      const y = style === 'orbit' ? Math.sin(turn) * (.16 + t * .24)
        : style === 'dust' ? -.12 - radius * t + .08 * t * t : Math.sin(angle) * radius * t + .12 * t * t;
      return key(offset, size * (1 - t * .65), 0, y, Math.min(1, t / .15) * (1 - t) ** .8, x);
    });
    return [`${NAG_PARTICLE_PREFIX}${style}-${i}`, { frames, easing: 'linear' }];
  }));
}

export function nagParticleId(motions: Record<string, MotionEdit>) {
  const particles = Object.entries(motions).filter(([id]) => id.startsWith(NAG_PARTICLE_PREFIX));
  if (!particles.length) return 'none';
  return (Object.keys(NAG_PARTICLES) as NagParticle[]).find(style => {
    const preset = nagParticles(style);
    return particles.length === Object.keys(preset).length && particles.every(([id, motion]) => preset[id] && matches(motion, preset[id]));
  }) || 'custom';
}
