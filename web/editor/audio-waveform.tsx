import { memo } from 'react';
import { waveformPath } from '../lib/audio.ts';

export const AudioWaveform = memo(function AudioWaveform({ buffer, startMs, durationMs, offsetMs = 0, scale, left, right }:
  { buffer?: AudioBuffer; startMs: number; durationMs: number; offsetMs?: number; scale: number; left: number; right: number }) {
  const from = Math.max(startMs, left), to = Math.min(startMs + durationMs, right);
  if (to <= from) return null;
  const pixelsPerMs = Math.max(scale, 3 / durationMs), width = (to - from) * pixelsPerMs;
  return <svg className="audio-waveform" style={{ left: (from - startMs) * pixelsPerMs, width }} viewBox={`0 0 ${width} 26`} preserveAspectRatio="none" aria-hidden="true">
    <path d={waveformPath(buffer, to - from, width, offsetMs + from - startMs)} />
  </svg>;
});
