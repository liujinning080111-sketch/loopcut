import { describe, expect, it } from 'vitest';
import { fixedSchedule, sourceSchedule } from '../src/media/source-timeline';
import { fitWithinSource, MAX_GIF_FRAMES } from '../src/media/limits';

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
