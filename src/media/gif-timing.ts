import { MAX_GIF_FRAMES } from './limits';

export interface GifTimingPlan {
  delaysMs: number[];
  sourceDurationMs: number;
  outputDurationMs: number;
  durationDeltaMs: number;
  /** The source cannot fit all frames within the nearest GIF total duration. */
  requiresSlowdown: boolean;
  /** Any individual duration changes, including ordinary 10ms rounding. */
  quantized: boolean;
  /** Minimum frame duration forces redistribution beyond cumulative rounding. */
  retimed: boolean;
  maxBoundaryShiftMs: number;
}

const TICK_MS = 10;
const EPSILON_MS = 1e-7;

/**
 * Allocate GIF delays before encoding pixels. Every input frame gets at least
 * one centisecond. When feasible, the total is the nearest centisecond to the
 * original total; otherwise the minimum N*10ms total is reported as slower.
 *
 * For cumulative boundary i, subtract its mandatory i ticks, then use pooled
 * adjacent violators (isotonic regression) to fit nondecreasing boundaries.
 * This shares the cost of a short-frame cluster on both sides rather than
 * letting a greedy per-frame clamp accumulate an avoidable trailing delay.
 * Fitting only timing numbers keeps RGBA encoding fully streaming.
 */
export function planGifTiming(sourceDelaysMs: readonly number[]): GifTimingPlan {
  const count = sourceDelaysMs.length;
  if (!count || count > MAX_GIF_FRAMES) throw new Error(`GIF 帧数必须在 1 至 ${MAX_GIF_FRAMES} 之间。`);
  const boundariesMs: number[] = [];
  let sourceDurationMs = 0;
  for (const delay of sourceDelaysMs) {
    if (!Number.isFinite(delay) || delay <= 0 || delay > 60000) throw new Error('GIF 原始单帧时长必须大于 0 且不超过 60000 毫秒。');
    sourceDurationMs += delay;
    boundariesMs.push(sourceDurationMs);
  }
  const roundedTotalTicks = Math.round(sourceDurationMs / TICK_MS);
  const totalTicks = Math.max(count, roundedTotalTicks);
  const extraTicks = totalTicks - count;
  const blocks: { first: number; last: number; sum: number; weight: number }[] = [];
  for (let boundary = 1; boundary < count; boundary++) {
    blocks.push({ first: boundary, last: boundary, sum: boundariesMs[boundary - 1] / TICK_MS - boundary, weight: 1 });
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1], left = blocks[blocks.length - 2];
      if (left.sum / left.weight <= right.sum / right.weight) break;
      left.last = right.last;
      left.sum += right.sum;
      left.weight += right.weight;
      blocks.pop();
    }
  }
  const boundaryTicks = new Array<number>(count);
  for (const block of blocks) {
    // Clamp the fitted block mean, not the raw values before regression.
    const extra = Math.round(Math.max(0, Math.min(extraTicks, block.sum / block.weight)));
    for (let boundary = block.first; boundary <= block.last; boundary++) boundaryTicks[boundary - 1] = boundary + extra;
  }
  boundaryTicks[count - 1] = totalTicks;
  const delaysMs = boundaryTicks.map((ticks, i) => (ticks - (boundaryTicks[i - 1] ?? 0)) * TICK_MS);
  const outputDurationMs = totalTicks * TICK_MS;
  return {
    delaysMs,
    sourceDurationMs,
    outputDurationMs,
    durationDeltaMs: outputDurationMs - sourceDurationMs,
    requiresSlowdown: count > roundedTotalTicks,
    quantized: delaysMs.some((delay, i) => Math.abs(delay - sourceDelaysMs[i]) > EPSILON_MS),
    retimed: boundaryTicks.some((ticks, i) => ticks !== Math.round(boundariesMs[i] / TICK_MS)),
    maxBoundaryShiftMs: Math.max(...boundaryTicks.map((ticks, i) => Math.abs(ticks * TICK_MS - boundariesMs[i]))),
  };
}
