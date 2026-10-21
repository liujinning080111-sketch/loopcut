import { describe, expect, it } from 'vitest';
import { cropFrame, detectLoop, detectRegions, inspectBackground, removeBackground } from '../src/core/vision';
import type { Frame, Rect } from '../src/types';

const whole: Rect = { x: 0, y: 0, width: 1, height: 1 };
function solid(width = 48, height = 48, rgb = [245, 245, 245], time = 0): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) data.set([...rgb, 255], p);
  return { width, height, data, time };
}
function box(frame: Frame, x: number, y: number, w: number, h: number, rgb: number[]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) frame.data.set([...rgb, 255], (yy * frame.width + xx) * 4);
  return frame;
}
function sprite(value: number, time: number): Frame {
  return box(solid(48, 48, [245, 245, 245], time), 5 + value * 7, 15, 10, 16, [40, 50, 170]);
}
function sequence(values: number[], offset = 0) { return values.map((value, i) => sprite(value, offset + i / 8)); }

describe('full-loop extraction', () => {
  it('finds one fundamental period with two complete repetitions', () => {
    const result = detectLoop(sequence([0, 1, 2, 3, 0, 1, 2, 3]), whole);
    expect(result.detected).toBe(true);
    expect(result.end - result.start).toBeCloseTo(0.5);
    expect(result.confidence).toBeGreaterThan(0.8);
  });
  it('keeps held-frame time rather than speeding up the animation', () => {
    const held = [0, 0, 1, 1, 2, 2, 3, 3];
    const result = detectLoop(sequence([...held, ...held, ...held], 4), whole);
    expect(result.detected).toBe(true);
    expect(result.end - result.start).toBeCloseTo(1);
    expect(result.start).toBeGreaterThanOrEqual(4);
  });
  it('ignores a stationary intro and tolerates small compression color changes', () => {
    const values = [0, 0, 0, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 3, 3];
    const frames = sequence(values);
    for (let i = 0; i < frames.length; i++) for (let p = 0; p < frames[i].data.length; p += 4) frames[i].data[p] += i % 3;
    const result = detectLoop(frames, whole);
    expect(result.detected).toBe(true);
    expect(result.end - result.start).toBeCloseTo(0.5);
    expect(result.start).toBeGreaterThanOrEqual(0.375);
  });
  it('does not mistake a matching first/last frame for a verified full loop', () => {
    expect(detectLoop(sequence([0, 1, 2, 3, 2, 0]), whole).detected).toBe(false);
  });
  it('does not claim a loop for static frames or slow unrelated color drift', () => {
    expect(detectLoop(sequence(Array(24).fill(1)), whole).detected).toBe(false);
    const drift = Array.from({ length: 24 }, (_, i) => solid(24, 24, [20 + i * 8, 60, 100], i / 8));
    expect(detectLoop(drift, whole).detected).toBe(false);
  });
  it('ignores movement outside the selected crop', () => {
    const frames = sequence([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(detectLoop(frames, { x: 0, y: 0, width: 1, height: 0.2 }).detected).toBe(false);
  });
  it('returns a conservative range for insufficient evidence', () => {
    expect(detectLoop([], whole)).toMatchObject({ start: 0, end: 0, detected: false });
    expect(detectLoop(sequence([0, 1, 2]), whole).detected).toBe(false);
  });
});

describe('motion proposals', () => {
  it('finds a localized moving subject within normalized image bounds', () => {
    const frames = Array.from({ length: 16 }, (_, i) => box(solid(80, 120, [40, 40, 40], i / 8), 20 + i % 4 * 3, 50, 14, 20, [230, 160, 70]));
    const regions = detectRegions(frames);
    expect(regions.length).toBeGreaterThan(0);
    const { rect } = regions[0];
    expect(rect.x).toBeLessThan(20 / 80);
    expect(rect.x + rect.width).toBeGreaterThan(43 / 80);
    expect(rect.y).toBeLessThan(50 / 120);
    for (const { rect } of regions) {
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1); expect(rect.y + rect.height).toBeLessThanOrEqual(1);
    }
  });
  it('rejects full-screen changes and static captures', () => {
    const flashes = Array.from({ length: 10 }, (_, i) => solid(40, 60, i % 2 ? [20, 20, 20] : [200, 200, 200], i / 8));
    expect(detectRegions(flashes)).toEqual([]);
    expect(detectRegions(sequence(Array(10).fill(1)))).toEqual([]);
  });
});

describe('conservative transparency', () => {
  it('suggests transparency only for a consistent border and visible subject', () => {
    const result = inspectBackground(sequence([0, 1, 2, 3]), whole);
    expect(result.recommendation).toBe('transparent');
    expect(result.color).toEqual([245, 245, 245]);
    expect(inspectBackground([solid()], whole).recommendation).toBe('rectangle');
  });
  it('keeps complex or temporally changing borders rectangular', () => {
    const checker = solid(20, 20);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) if ((x + y) % 2) box(checker, x, y, 1, 1, [0, 0, 0]);
    expect(inspectBackground([checker], whole).recommendation).toBe('rectangle');
    expect(inspectBackground([sprite(0, 0), box(solid(48, 48, [30, 30, 30], 1), 5, 15, 10, 16, [90, 30, 140])], whole).recommendation).toBe('rectangle');
  });
  it('removes connected background while preserving an enclosed same-color hole', () => {
    const frame = box(solid(9, 9, [255, 255, 255]), 2, 2, 5, 5, [0, 0, 0]);
    box(frame, 3, 3, 3, 3, [255, 255, 255]);
    const result = removeBackground(frame, [255, 255, 255], 20);
    expect(result.data[3]).toBe(0);
    expect(result.data[(4 * 9 + 4) * 4 + 3]).toBe(255);
    expect(result.data[(2 * 9 + 2) * 4 + 3]).toBe(255);
    expect(frame.data[3]).toBe(255);
  });
  it('uses bounded tolerance and does not erase unrelated foreground', () => {
    const frame = box(solid(12, 12, [248, 248, 248]), 3, 3, 6, 6, [200, 30, 30]);
    const result = removeBackground(frame, [255, 255, 255], 15);
    expect(result.data[3]).toBe(0);
    expect(result.data[(5 * 12 + 5) * 4 + 3]).toBe(255);
  });
});

describe('crop geometry', () => {
  it('clamps bounds and preserves source time and pixels', () => {
    const source = box(solid(10, 10, [200, 200, 200], 4), 5, 5, 5, 5, [10, 20, 30]);
    const crop = cropFrame(source, { x: 0.5, y: 0.5, width: 0.9, height: 0.9 });
    expect(crop.width).toBe(5); expect(crop.height).toBe(5); expect(crop.time).toBe(4);
    expect([...crop.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
  });
});
