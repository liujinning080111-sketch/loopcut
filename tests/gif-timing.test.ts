import { describe, expect, it } from 'vitest';
import { planGifTiming } from '../src/media/gif-timing';
import { sourceSchedule } from '../src/media/source-timeline';
import { MAX_GIF_FRAMES } from '../src/media/limits';

function expectPlan(source: number[]) {
  const result = planGifTiming(source);
  expect(result.delaysMs).toHaveLength(source.length);
  expect(result.delaysMs.every(delay => Number.isInteger(delay / 10) && delay >= 10)).toBe(true);
  expect(result.delaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(result.outputDurationMs);
  if (!result.requiresSlowdown) expect(Math.abs(result.durationDeltaMs)).toBeLessThanOrEqual(5 + 1e-7);
  return result;
}

describe('whole-sequence GIF timing allocation', () => {
  it('keeps ordinary 30/60fps frame counts and total duration without slowdown', () => {
    for (const fps of [30, 60]) {
      const result = expectPlan(Array.from({ length: fps }, () => 1000 / fps));
      expect(result.outputDurationMs).toBe(1000);
      expect(result.requiresSlowdown).toBe(false);
      expect(result.retimed).toBe(false);
      expect(result.quantized).toBe(true);
      expect(result.maxBoundaryShiftMs).toBeLessThanOrEqual(5 + 1e-7);
    }
  });

  it('borrows time for a sub-10ms final frame instead of rejecting or lengthening a feasible total', () => {
    const result = expectPlan([1000 / 30, 1000 / 30, 1000 / 30, 1000 / 300]);
    expect(result.outputDurationMs).toBe(100);
    expect(result.delaysMs.at(-1)).toBe(10);
    expect(result.requiresSlowdown).toBe(false);
    expect(result.retimed).toBe(true);
    expectPlan([1, 100, 1]);
    expect(planGifTiming([1, 100, 1]).delaysMs).toEqual([10, 80, 10]);
  });

  it('retains both partial boundary frames for the real 0.20–6.70 second selection', () => {
    // A 30fps recording whose PTS is shifted by 5ms, as can occur in a MOV.
    const samples = Array.from({ length: 212 }, (_, i) => ({ timestamp: .005 + i / 30, duration: 1 / 30 }));
    const source = sourceSchedule(samples, .20, 6.70);
    expect(source[0].delayMs).toBeCloseTo(5, 8);
    expect(source.at(-1)!.delayMs).toBeCloseTo(1000 / 30 - 5, 8);
    const result = expectPlan(source.map(step => step.delayMs));
    expect(result.delaysMs).toHaveLength(196);
    expect(result.outputDurationMs).toBe(6500);
    expect(result.requiresSlowdown).toBe(false);
  });

  it('redistributes a dense VFR cluster across nearby holds without dropping any frame', () => {
    const result = expectPlan([100, 1, 1, 100]);
    expect(result.delaysMs).toEqual([90, 10, 10, 90]);
    expect(result.outputDurationMs).toBe(200);
    expect(result.maxBoundaryShiftMs).toBe(10);
    expect(result.retimed).toBe(true);
    expect(result.requiresSlowdown).toBe(false);
    // An early short-frame cluster must not bias the constrained fit upward.
    expect(expectPlan([.1, 100, .1, .1, 100]).outputDurationMs).toBe(200);
  });

  it('reports the unavoidable 20% duration increase when preserving all 120fps frames', () => {
    const result = expectPlan(Array.from({ length: 120 }, () => 1000 / 120));
    expect(result.delaysMs).toEqual(new Array(120).fill(10));
    expect(result.sourceDurationMs).toBeCloseTo(1000, 8);
    expect(result.outputDurationMs).toBe(1200);
    expect(result.durationDeltaMs).toBeCloseTo(200, 8);
    expect(result.requiresSlowdown).toBe(true);
    expect(result.retimed).toBe(true);
  });

  it('leaves already representable timing unchanged and reports rounding independently of redistribution', () => {
    expect(expectPlan([10, 20, 70])).toMatchObject({ delaysMs: [10, 20, 70], quantized: false, retimed: false, durationDeltaMs: 0 });
    expect(expectPlan([15, 25])).toMatchObject({ delaysMs: [20, 20], quantized: true, retimed: false, requiresSlowdown: false });
    expect(expectPlan([3])).toMatchObject({ delaysMs: [10], requiresSlowdown: true, outputDurationMs: 10 });
  });

  it('keeps count, positivity and total-budget invariants over varied deterministic VFR sequences', () => {
    let seed = 20261022;
    for (let trial = 0; trial < 100; trial++) {
      const source = Array.from({ length: 2 + trial }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return .01 + (seed % 20000) / 100;
      });
      const result = expectPlan(source);
      expect(result.outputDurationMs).toBe(Math.max(source.length, Math.round(source.reduce((a, b) => a + b, 0) / 10)) * 10);
    }
  });

  it('rejects missing, invalid, or excessive timing input before pixel encoding', () => {
    for (const source of [[], [0], [-1], [NaN], [Infinity], [60001], new Array(MAX_GIF_FRAMES + 1).fill(10)]) {
      expect(() => planGifTiming(source)).toThrow();
    }
  });
});
