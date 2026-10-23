import { describe, expect, it } from 'vitest';
import { compositeGif } from './helpers/gif-composite';

// Hand-written GIF89a fixtures; no production encoder or optimizer is involved.
// Clear the LZW dictionary before every literal, keeping every code at 3 bits.
// The deliberate inefficiency makes fixture pixels independently auditable.
const palette = [[19, 21, 23], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
type FixtureFrame = { x?: number; y?: number; width: number; height: number; indices: number[]; dispose?: number; ticks?: number; transparent?: number | null; palette?: number[][] };
function gif(width: number, height: number, frames: FixtureFrame[], repeat: number | null = 0) {
  const data: number[] = Array.from(new TextEncoder().encode('GIF89a'));
  const word = (value: number) => data.push(value & 255, value >>> 8);
  word(width); word(height); data.push(0x81, 0, 0, ...palette.flat());
  if (repeat !== null) {
    data.push(0x21, 0xff, 11, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1);
    word(repeat); data.push(0);
  }
  for (const frame of frames) {
    const transparent = frame.transparent === undefined ? 0 : frame.transparent;
    data.push(0x21, 0xf9, 4, ((frame.dispose ?? 1) << 2) | (transparent === null ? 0 : 1));
    word(frame.ticks ?? 5); data.push(transparent ?? 0, 0, 0x2c);
    word(frame.x ?? 0); word(frame.y ?? 0); word(frame.width); word(frame.height);
    data.push(frame.palette ? 0x81 : 0);
    if (frame.palette) data.push(...frame.palette.flat());
    const codes = frame.indices.flatMap(index => [4, index]); codes.push(5);
    const packed: number[] = [];
    let bits = 0, bitCount = 0;
    for (const code of codes) {
      bits |= code << bitCount; bitCount += 3;
      while (bitCount >= 8) { packed.push(bits & 255); bits >>>= 8; bitCount -= 8; }
    }
    if (bitCount) packed.push(bits & 255);
    data.push(2, packed.length, ...packed, 0);
  }
  data.push(0x3b);
  return new Uint8Array(data);
}
const clear = [0, 0, 0, 0], red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255];
const pixels = (...colors: number[][]) => new Uint8ClampedArray(colors.flat());

describe('independent GIF composition oracle', () => {
  it('places offset rectangles and skips transparent pixels instead of clearing old pixels', () => {
    const result = compositeGif(gif(3, 2, [
      { width: 3, height: 2, indices: [1, 1, 1, 1, 1, 1] },
      { x: 1, width: 2, height: 2, indices: [0, 2, 3, 0] },
    ]), { loops: 1 });
    expect(result.frames[1].rgba).toEqual(pixels(red, red, green, red, blue, red));
    expect(result.frames[0].rgba).toEqual(pixels(red, red, red, red, red, red));
    expect(result).toMatchObject({ width: 3, height: 2, frameCount: 2, delaysMs: [50, 50], durationMs: 100, loopCount: 0 });
  });

  it('disposal 2 clears only the previous image rectangle to transparent, retaining surrounding content', () => {
    const result = compositeGif(gif(3, 2, [
      { width: 3, height: 2, indices: [1, 1, 1, 1, 1, 1] },
      { x: 1, width: 1, height: 2, indices: [2, 2], dispose: 2 },
      { x: 2, y: 1, width: 1, height: 1, indices: [3] },
    ]), { loops: 1 });
    expect(result.frames[1].rgba).toEqual(pixels(red, green, red, red, green, red));
    expect(result.frames[2].rgba).toEqual(pixels(red, clear, red, red, clear, blue));
  });

  it('disposal 3 restores the state before each frame, including consecutive restore-previous frames', () => {
    const result = compositeGif(gif(3, 1, [
      { width: 3, height: 1, indices: [1, 1, 1] },
      { width: 2, height: 1, indices: [2, 0], dispose: 3 },
      { x: 1, width: 1, height: 1, indices: [3], dispose: 3 },
      { x: 2, width: 1, height: 1, indices: [2] },
    ]), { loops: 1 });
    expect(result.frames[1].rgba).toEqual(pixels(green, red, red));
    expect(result.frames[2].rgba).toEqual(pixels(red, blue, red));
    expect(result.frames[3].rgba).toEqual(pixels(red, red, green));
  });

  it('executes final-frame disposal at the loop seam and exposes residual pixels when disposal is wrong', () => {
    const frames: FixtureFrame[] = [
      { width: 1, height: 1, indices: [1], ticks: 2 },
      { x: 1, width: 1, height: 1, indices: [2], dispose: 2, ticks: 7 },
    ];
    const correct = compositeGif(gif(2, 1, frames));
    expect(correct.frames).toHaveLength(4);
    expect(correct.frames.map(frame => frame.delayMs)).toEqual([20, 70, 20, 70]);
    expect(correct.frames[0].rgba).toEqual(pixels(red, clear));
    expect(correct.frames[2].rgba).toEqual(correct.frames[0].rgba);
    expect(correct.frames[3].rgba).toEqual(correct.frames[1].rgba);
    const broken = compositeGif(gif(2, 1, [frames[0], { ...frames[1], dispose: 1 }]));
    expect(broken.frames[2].rgba).toEqual(pixels(red, green));
    expect(broken.frames[2].rgba).not.toEqual(broken.frames[0].rgba);
  });

  it('uses local palettes and arbitrary transparency indices and retains a raw zero delay', () => {
    const local = [[8, 9, 10], [255, 100, 0], [90, 80, 70], [1, 2, 3]];
    const result = compositeGif(gif(2, 1, [
      { width: 2, height: 1, indices: [1, 2], transparent: 1, ticks: 0, palette: local },
    ], 3), { loops: 1 });
    expect(result.frames[0].rgba).toEqual(pixels(clear, [90, 80, 70, 255]));
    expect(result.delaysMs).toEqual([0]);
    expect(result.loopCount).toBe(3);
  });

  it('respects byte-array offsets and an explicit opaque background', () => {
    const bytes = gif(2, 1, [
      { width: 1, height: 1, indices: [1], dispose: 2 },
      { x: 1, width: 1, height: 1, indices: [3] },
    ], null);
    const padded = new Uint8Array(bytes.length + 9); padded.set(bytes, 4);
    const background = [17, 34, 51, 255] as const;
    const result = compositeGif(padded.subarray(4, 4 + bytes.length), { loops: 1, background });
    expect(result.frames[0].rgba).toEqual(pixels(red, [...background]));
    expect(result.frames[1].rgba).toEqual(pixels([...background], blue));
    expect(result.loopCount).toBeNull();
  });

  it('recognizes equivalent full frames and reordered-palette rectangles, retained no-op frames, and complete disappearance', () => {
    const full = compositeGif(gif(3, 2, [
      { width: 3, height: 2, indices: [1, 0, 0, 0, 0, 0], dispose: 2, ticks: 2 },
      { width: 3, height: 2, indices: [1, 0, 0, 0, 0, 0], dispose: 2, ticks: 7 },
      { width: 3, height: 2, indices: [0, 0, 0, 0, 0, 0], dispose: 2, ticks: 4 },
    ]));
    const reordered = [[0, 0, 255], [0, 255, 0], [255, 0, 0], [127, 128, 129]];
    const partial = compositeGif(gif(3, 2, [
      { width: 1, height: 1, indices: [2], dispose: 1, ticks: 2, transparent: 3, palette: reordered },
      // This frame deliberately draws nothing but retains its own duration.
      { width: 1, height: 1, indices: [3], dispose: 2, ticks: 7, transparent: 3, palette: reordered },
      { width: 1, height: 1, indices: [3], dispose: 2, ticks: 4, transparent: 3, palette: reordered },
    ]));
    expect(partial).toEqual(full);
    expect(partial.frameCount).toBe(3);
    expect(partial.frames[2].rgba).toEqual(new Uint8ClampedArray(3 * 2 * 4));
  });
});
