import { describe, expect, it } from 'vitest';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { StreamingGifEncoder } from '../src/media/gif-core';
import type { GifFrame } from '../src/types';
import { fitWithinSource, MAX_GIF_BYTES, MAX_OUTPUT_SIDE } from '../src/media/limits';

function frame(pixels: number[][], delayMs = 100): GifFrame {
  return { width: pixels.length, height: 1, data: new Uint8ClampedArray(pixels.flat()), delayMs };
}
const red = [255, 0, 0, 255];
const clear = [0, 0, 0, 0];

function encode(frames: GifFrame[]) {
  const encoder = new StreamingGifEncoder();
  frames.forEach(f => encoder.push(f));
  const bytes = encoder.finish();
  const parsed = parseGIF(bytes.slice().buffer);
  return { bytes, parsed, decoded: decompressFrames(parsed, true) };
}

describe('GIF interoperability and timing', () => {
  it('creates a valid infinite-loop GIF and retains a repeated-frame hold', () => {
    const { bytes, parsed, decoded } = encode([frame([red, clear], 100), frame([red, clear], 200), frame([clear, red], 100)]);
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a');
    expect(bytes.at(-1)).toBe(0x3b);
    expect(parsed.lsd.width).toBe(2);
    expect(decoded).toHaveLength(2);
    expect(decoded.map(f => f.delay)).toEqual([300, 100]);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('NETSCAPE2.0');
    const marker = text.indexOf('NETSCAPE2.0') + 11;
    expect(Array.from(bytes.slice(marker, marker + 5))).toEqual([3, 1, 0, 0, 0]);
  });

  it('reserves transparency independently of opaque black and clears moving images', () => {
    const black = [0, 0, 0, 255];
    const { decoded } = encode([frame([black, clear]), frame([clear, black])]);
    expect(decoded.map(f => f.disposalType)).toEqual([2, 2]);
    expect(Array.from(decoded[0].patch!)).toEqual([...black, ...clear]);
    expect(Array.from(decoded[1].patch!)).toEqual([...clear, ...black]);
    expect(decoded.every(f => f.transparentIndex === 0)).toBe(true);
  });

  it('quantizes delay cumulatively so 15 fps stays one second', () => {
    const { decoded } = encode(Array.from({ length: 15 }, (_, i) => frame(i % 2 ? [red, clear] : [clear, red], 1000 / 15)));
    expect(decoded.reduce((sum, f) => sum + f.delay, 0)).toBe(1000);
    expect(new Set(decoded.map(f => f.delay))).toEqual(new Set([60, 70]));
  });

  it('handles fully transparent frames and does not alter caller data', () => {
    const source = frame([clear, clear]);
    const { decoded } = encode([source]);
    expect(Array.from(decoded[0].patch!)).toEqual([...clear, ...clear]);
    expect(source.data.byteLength).toBe(8);
  });

  it('rejects mismatched dimensions, invalid buffers, empty output, and excess frames', () => {
    expect(() => new StreamingGifEncoder().finish()).toThrow('没有');
    const encoder = new StreamingGifEncoder();
    encoder.push(frame([red]));
    expect(() => encoder.push(frame([red, clear]))).toThrow('一致');
    expect(() => encoder.push({ ...frame([red]), data: new Uint8ClampedArray(0) })).toThrow('不完整');
    expect(() => encoder.push({ ...frame([red]), width: MAX_OUTPUT_SIDE + 1 })).toThrow(String(MAX_OUTPUT_SIDE));
    const bounded = new StreamingGifEncoder();
    for (let i = 0; i < 360; i++) bounded.push(frame([red]));
    expect(() => bounded.push(frame([red]))).toThrow('360');
  });

  it('preserves real 640x480 source pixels, including one-pixel details, without resizing', () => {
    const width = 640, height = 480;
    const nativeFrames = [0, 1].map(phase => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // Generated at native resolution, not enlarged from a thumbnail.
        const value = (x + y + phase) % 2 === 0 ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
      return { width, height, data, delayMs: 50 };
    });
    const { parsed, decoded } = encode(nativeFrames);
    expect([parsed.lsd.width, parsed.lsd.height]).toEqual([640, 480]);
    expect(decoded).toHaveLength(2);
    for (let i = 0; i < decoded.length; i++) {
      expect(Buffer.from(decoded[i].patch!).equals(Buffer.from(nativeFrames[i].data))).toBe(true);
    }
  });

  it('keeps native small images small and only scales down beyond the chosen bound', () => {
    expect(fitWithinSource(200, 150)).toEqual({ width: 200, height: 150 });
    expect(fitWithinSource(600, 600)).toEqual({ width: 600, height: 600 });
    expect(fitWithinSource(1440, 1080)).toEqual({ width: 1024, height: 768 });
    expect(fitWithinSource(600, 450, 320)).toEqual({ width: 320, height: 240 });
    expect(() => fitWithinSource(600, 450, MAX_OUTPUT_SIDE + 1)).toThrow('输出长边');
  });

  it('stops on a compressed-output budget instead of accumulating frames or lowering resolution', () => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    let seed = 1234567;
    for (let i = 0; i < data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed & 255;
      data[i + 1] = (seed >>> 8) & 255;
      data[i + 2] = (seed >>> 16) & 255;
      data[i + 3] = 255;
    }
    // A smaller injectable budget tests real encoded-byte accounting quickly.
    const encoder = new StreamingGifEncoder({ maxBytes: 1024 });
    encoder.push({ width: 64, height: 64, data, delayMs: 50 });
    expect(() => encoder.finish()).toThrow('GIF 文件过大');
    expect(() => new StreamingGifEncoder({ maxBytes: MAX_GIF_BYTES + 1 })).toThrow('大小上限无效');
  });
});
