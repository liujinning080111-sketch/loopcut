import { describe, expect, it } from 'vitest';
import { GifReader, GifWriter } from 'omggif';
import { StreamingGifEncoder } from '../src/media/gif-core';
import { equivalentGifAnimation, optimizeGifLosslessly } from '../src/media/gif-optimizer';
import type { GifFrame } from '../src/types';
import { compositeGif } from './helpers/gif-composite';

const frame = (width: number, height: number, paint: (x: number, y: number) => number[], delayMs = 50): GifFrame => ({
  width, height, delayMs,
  data: new Uint8ClampedArray(Array.from({ length: width * height }, (_, p) => paint(p % width, Math.floor(p / width))).flat()),
});
function encode(frames: GifFrame[]) {
  const encoder = new StreamingGifEncoder({ mergeDuplicates: false });
  frames.forEach(value => encoder.push(value));
  return encoder.finish();
}
function assertIdentical(before: Uint8Array, after: Uint8Array) {
  // gifuct-js oracle is independent of the optimizer's omggif decoder and
  // covers two successive loops, partial disposal rectangles and all delays.
  const a = compositeGif(before), b = compositeGif(after);
  expect([b.width, b.height, b.frameCount, b.loopCount, b.delaysMs]).toEqual([a.width, a.height, a.frameCount, a.loopCount, a.delaysMs]);
  expect(b.frames).toHaveLength(a.frames.length);
  for (let i = 0; i < a.frames.length; i++) expect(Buffer.from(b.frames[i].rgba)).toEqual(Buffer.from(a.frames[i].rgba));
  expect(equivalentGifAnimation(before, after)).toBe(true);
}

describe('lossless GIF byte optimization', () => {
  it('compresses a static opaque scene with moving details without dropping any frames', () => {
    const source = encode(Array.from({ length: 24 }, (_, i) => frame(96, 64, (x, y) => x === 12 + i && y === 30 ? [255, 0, 0, 255] : [17, 18, (x + y) % 16, 255], i % 3 ? 20 : 10)));
    const result = optimizeGifLosslessly(source);
    assertIdentical(source, result.bytes);
    expect(result.stats.optimized).toBe(true);
    expect(result.bytes.length).toBeLessThan(source.length / 2);
    expect(result.stats).toMatchObject({ originalBytes: source.length, optimizedBytes: result.bytes.length });
  });

  it('keeps every identical frame and its original pause using tiny no-op frames', () => {
    const source = encode([10, 20, 150, 10, 20, 200].map(delay => frame(80, 60, () => [17, 18, 19, 255], delay)));
    const result = optimizeGifLosslessly(source);
    assertIdentical(source, result.bytes);
    expect(compositeGif(result.bytes).delaysMs).toEqual([10, 20, 150, 10, 20, 200]);
    expect(result.bytes.length).toBeLessThan(source.length);
    const decoded = new GifReader(result.bytes);
    expect(Array.from({ length: decoded.numFrames() }, (_, i) => decoded.frameInfo(i).has_local_palette)).toEqual([false, false, false, false, false, false]);
  });

  it('clears moving transparent silhouettes, disappeared objects and the final-to-first loop seam', () => {
    const source = encode(Array.from({ length: 10 }, (_, i) => frame(96, 64, (x, y) => {
      if (i !== 5 && x >= i * 7 && x < i * 7 + 12 && y > 12 && y < 40) return [20, 60, 200, 255];
      if (i !== 9 && x > 45 && x < 50 && y > 52) return [0, 0, 0, 255];
      return [197, 11, 201, 0];
    })));
    const result = optimizeGifLosslessly(source);
    assertIdentical(source, result.bytes);
    expect(result.bytes.length).toBeLessThan(source.length);
  });

  it('does not requantize subtle colors or a sequence using more than 255 total colors', () => {
    const source = encode(Array.from({ length: 6 }, (_, phase) => frame(48, 24, (x, y) => [16 + phase, 18, (x + y) % 48, 255])));
    const result = optimizeGifLosslessly(source);
    assertIdentical(source, result.bytes);
    for (const [i, image] of compositeGif(result.bytes, { loops: 1 }).frames.entries()) expect(Array.from(image.rgba.slice(0, 4))).toEqual([16 + i, 18, 0, 255]);
  });

  it('preserves fully transparent frames, dimensions, delays and frame count', () => {
    const source = encode([10, 80, 10].map(delay => frame(37, 19, () => [250, 99, 12, 0], delay)));
    const result = optimizeGifLosslessly(source);
    assertIdentical(source, result.bytes);
    expect(compositeGif(result.bytes).frameCount).toBe(3);
    expect(result.bytes.length).toBeLessThanOrEqual(source.length);
  });

  it('never returns an oversized candidate or damages the input buffer', () => {
    const buffer = new Uint8Array(128);
    const writer = new GifWriter(buffer, 1, 1, { palette: [0x111213, 0] });
    writer.addFrame(0, 0, 1, 1, new Uint8Array([0]), { delay: 1, disposal: 1 });
    const source = buffer.slice(0, writer.end()), copy = source.slice();
    const result = optimizeGifLosslessly(source);
    expect(result.bytes.length).toBeLessThanOrEqual(source.length);
    expect(source).toEqual(copy);
    assertIdentical(source, result.bytes);
  });

  it('returns a clear unchanged fallback before allocating an over-budget canvas', () => {
    const buffer = new Uint8Array(128);
    const writer = new GifWriter(buffer, 4096, 4096, { palette: [0, 0xffffff], loop: 0 });
    writer.addFrame(0, 0, 1, 1, new Uint8Array([1]), { delay: 1, disposal: 2 });
    const source = buffer.slice(0, writer.end());
    const result = optimizeGifLosslessly(source);
    expect(result.bytes).toBe(source);
    expect(result.stats.optimized).toBe(false);
    expect(result.stats.reason).toContain('预算');
  });

  it('does not claim a malformed input was optimized', () => {
    const source = new Uint8Array([1, 2, 3]);
    const result = optimizeGifLosslessly(source);
    expect(result.bytes).toBe(source);
    expect(result.stats.optimized).toBe(false);
    expect(result.stats.reason).toContain('未完成');
    expect(equivalentGifAnimation(source, source)).toBe(false);
  });

  it('uses a bounded processing deadline without modifying or mislabelling the fallback', () => {
    const source = encode([frame(10, 10, () => [20, 40, 60, 255])]);
    const result = optimizeGifLosslessly(source, { timeBudgetMs: 0 });
    expect(result.bytes).toBe(source);
    expect(result.stats).toMatchObject({ originalBytes: source.length, optimizedBytes: source.length, optimized: false });
    expect(result.stats.reason).toContain('时限');
  });
});
