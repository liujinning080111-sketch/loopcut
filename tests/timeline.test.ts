import { describe, expect, it } from 'vitest';
import { fixedSchedule, sourceSchedule } from '../src/media/source-timeline';
import { fitWithinSource, MAX_GIF_FRAMES } from '../src/media/limits';
import { planGifTiming } from '../src/media/gif-timing';

describe('native source timing and dimensions', () => {
  it('keeps all 60fps frames and the exact source duration', () => {
    const plan = sourceSchedule(Array.from({ length: 120 }, (_, i) => ({ timestamp: i / 60, duration: 1 / 60 })), 0, 2);
    expect(plan).toHaveLength(120);
    expect(plan.reduce((n, frame) => n + frame.delayMs, 0)).toBeCloseTo(2000, 7);
    expect(plan[119].sourceTimestamp).toBeCloseTo(119 / 60, 9);
  });
  it('sorts B-frame presentation order, preserves VFR holds, and trims partial frames', () => {
    const plan = sourceSchedule([{ timestamp: .07, duration: .09 }, { timestamp: -.02, duration: .04 }, { timestamp: .02, duration: .05 }], 0, .14);
    expect(plan.map(f => f.sourceTimestamp)).toEqual([-.02, .02, .07]);
    expect(plan.map(f => Math.round(f.delayMs))).toEqual([20, 50, 70]);
    expect(plan.map(f => f.time)).toEqual([.01, .045000000000000005, .10500000000000001]);
  });
  it('does not invent missing, duplicate, or excess source frames', () => {
    expect(() => sourceSchedule([{ timestamp: 1, duration: 1 }], 0, 2)).toThrow('没有视频帧');
    expect(() => sourceSchedule([{ timestamp: 0, duration: 1 }, { timestamp: 0, duration: 1 }], 0, 1)).toThrow('原视频逐帧');
    expect(() => sourceSchedule([{ timestamp: 0, duration: .5 }], 0, 1)).toThrow('超出');
    expect(() => sourceSchedule(Array.from({ length: MAX_GIF_FRAMES + 1 }, (_, i) => ({ timestamp: i / 120, duration: 1 / 120 })), 0, (MAX_GIF_FRAMES + 1) / 120)).toThrow('没有丢帧');
  });
  it('only reduces resolution or cadence when explicitly requested', () => {
    expect(fitWithinSource(2160, 3840)).toEqual({ width: 2160, height: 3840 });
    expect(fitWithinSource(1280, 32, 0)).toEqual({ width: 1280, height: 32 });
    expect(fitWithinSource(1280, 32, 640)).toEqual({ width: 640, height: 16 });
    expect(() => fitWithinSource(8192, 8192)).toThrow('没有缩图');
    const selected = fixedSchedule(0, 1.07, 20);
    expect(selected).toHaveLength(22);
    expect(selected[1].time).toBe(.05);
    expect(selected.at(-1)!.delayMs).toBeCloseTo(20, 8);
  });
});

describe('fixed cadence at decimal range boundaries', () => {
  it.each([
    { start: .1, end: .4, fps: 20, count: 6 },
    { start: .2, end: .8, fps: 20, count: 12 },
    { start: .5, end: .8, fps: 30, count: 9 },
    { start: 3600.1, end: 3600.4, fps: 20, count: 6 },
  ])('exports $start–$end seconds at $fps fps without an empty extra frame', ({ start, end, fps, count }) => {
    const steps = fixedSchedule(start, end, fps);
    expect(steps).toHaveLength(count);
    expect(steps.every(step => step.time < end && step.delayMs > 0)).toBe(true);
    expect(steps.map(step => step.time)).toEqual(Array.from({ length: count }, (_, i) => start + i / fps));
    expect(steps.reduce((sum, step) => sum + step.delayMs, 0)).toBeCloseTo((end - start) * 1000, 6);
    const timing = planGifTiming(steps.map(step => step.delayMs));
    expect(timing.outputDurationMs).toBe(Math.round((end - start) * 100) * 10);
    expect(timing.requiresSlowdown).toBe(false);
  });

  it('retains a genuinely partial final frame instead of rounding it away', () => {
    const steps = fixedSchedule(.1, .400001, 20);
    expect(steps).toHaveLength(7);
    expect(steps.at(-1)!.time).toBe(.4);
    expect(steps.at(-1)!.delayMs).toBeCloseTo(.001, 9);
    expect(steps.reduce((sum, step) => sum + step.delayMs, 0)).toBeCloseTo(300.001, 8);
    expect(planGifTiming(steps.map(step => step.delayMs)).delaysMs).toHaveLength(7);
  });

  it('keeps one frame for a positive interval shorter than the selected frame period', () => {
    const steps = fixedSchedule(.1, .100000001, 20);
    expect(steps).toHaveLength(1);
    expect(steps[0].delayMs).toBeGreaterThan(0);
    expect(steps[0].delayMs).toBeCloseTo(.000001, 10);
  });
});
