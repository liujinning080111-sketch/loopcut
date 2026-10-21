import { describe, expect, it } from 'vitest';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { StreamingGifEncoder } from '../src/media/gif-core';
import type { GifFrame } from '../src/types';

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
    expect(() => encoder.push({ ...frame([red]), width: 321 })).toThrow('320');
    const bounded = new StreamingGifEncoder();
    for (let i = 0; i < 360; i++) bounded.push(frame([red]));
    expect(() => bounded.push(frame([red]))).toThrow('360');
  });
});
