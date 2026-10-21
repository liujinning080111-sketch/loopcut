import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodeApng } from '../src/media/apng';
import { MAX_FRAME_PIXELS, MAX_GIF_BYTES, MAX_GIF_FRAMES, MAX_OUTPUT_SIDE } from '../src/media/limits';
import type { GifFrame } from '../src/types';

async function* iterable(frames: GifFrame[]) { yield* frames; }
function frame(data: number[], delayMs = 1000 / 60): GifFrame {
  return { width: data.length / 4, height: 1, data: new Uint8ClampedArray(data), delayMs };
}

// An independent container parser/inflater checks bytes, not encoder helpers.
async function parse(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const value of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    expect(bytes.readUInt32BE(offset + 8 + length), `${type} CRC`).toBe((crc ^ 0xffffffff) >>> 0);
    chunks.push({ type, data });
    offset += length + 12;
  }
  expect(offset).toBe(bytes.length);
  expect(chunks.at(-1)?.type).toBe('IEND');
  const header = chunks[0].data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  expect([...header.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  const animation = chunks.find(c => c.type === 'acTL')!.data;
  const frames: { numerator: number; denominator: number; compressed: Buffer[]; pixels: Buffer }[] = [];
  let sequence = 0;
  for (const { type, data } of chunks) {
    if (type === 'fcTL') {
      expect(data.readUInt32BE(0)).toBe(sequence++);
      expect([data.readUInt32BE(4), data.readUInt32BE(8)]).toEqual([width, height]);
      expect([data.readUInt32BE(12), data.readUInt32BE(16), data[24], data[25]]).toEqual([0, 0, 0, 0]);
      frames.push({ numerator: data.readUInt16BE(20), denominator: data.readUInt16BE(22), compressed: [], pixels: Buffer.alloc(0) });
    } else if (type === 'IDAT' || type === 'fdAT') {
      if (type === 'fdAT') expect(data.readUInt32BE(0)).toBe(sequence++);
      frames.at(-1)!.compressed.push(type === 'IDAT' ? data : data.subarray(4));
    }
  }
  for (const f of frames) {
    const filtered = inflateSync(Buffer.concat(f.compressed));
    expect(filtered.length).toBe((width * 4 + 1) * height);
    f.pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const start = y * (width * 4 + 1);
      expect(filtered[start]).toBe(0);
      filtered.copy(f.pixels, y * width * 4, start + 1, start + 1 + width * 4);
    }
  }
  return { width, height, count: animation.readUInt32BE(0), plays: animation.readUInt32BE(4), frames, chunks };
}

describe('lossless streaming APNG', () => {
  it('preserves more than 256 native colors, one-pixel detail, and all alpha values', async () => {
    const width = 600, height = 32;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([x & 255, x >> 8, (x + y) & 255, (x + y * 7) & 255], i);
    }
    const second = data.slice();
    second.set([17, 19, 21, 0], 0);
    const sources = [data, second].map(pixels => ({ width, height, data: pixels, delayMs: 1000 / 60 }));
    const blob = await encodeApng(iterable(sources), { frameCount: 2 });
    expect(blob.type).toBe('image/png');
    const decoded = await parse(blob);
    expect([decoded.width, decoded.height, decoded.count, decoded.plays]).toEqual([600, 32, 2, 0]);
    expect(decoded.frames).toHaveLength(2);
    decoded.frames.forEach((f, i) => expect(f.pixels.equals(Buffer.from(sources[i].data))).toBe(true));
    expect(data[3]).toBe(0); // Even RGB under transparent alpha survives unchanged.
    expect(decoded.chunks.some(c => c.type === 'PLTE')).toBe(false);
  });

  it('keeps duplicate source frames and rational 29.97/60fps and sub-10ms tail durations', async () => {
    const durations = [1001 / 30, 1000 / 60, 1000 / 300];
    const counts: number[] = [];
    const decoded = await parse(await encodeApng(iterable(durations.map(delay => frame([17, 18, 19, 128], delay))), { frameCount: 3, onProgress: n => counts.push(n) }));
    expect(decoded.frames.map(f => [f.numerator, f.denominator])).toEqual([[1001, 30000], [1, 60], [1, 300]]);
    expect(decoded.frames.reduce((sum, f) => sum + 1000 * f.numerator / f.denominator, 0)).toBeCloseTo(durations.reduce((a, b) => a + b), 10);
    expect(counts).toEqual([1, 2, 3]);
    expect(decoded.frames.every(f => f.pixels.equals(Buffer.from([17, 18, 19, 128])))).toBe(true);
  });

  it('compresses each yielded frame before requesting and reusing the next raw buffer', async () => {
    const data = new Uint8ClampedArray([12, 34, 56, 78]);
    const progress: number[] = [];
    async function* reused() {
      yield { width: 1, height: 1, data, delayMs: 50 };
      expect(progress).toEqual([1]);
      data.set([90, 87, 65, 43]);
      yield { width: 1, height: 1, data, delayMs: 50 };
    }
    const decoded = await parse(await encodeApng(reused(), { frameCount: 2, onProgress: n => progress.push(n) }));
    expect([...decoded.frames[0].pixels]).toEqual([12, 34, 56, 78]);
    expect([...decoded.frames[1].pixels]).toEqual([90, 87, 65, 43]);
  });

  it('rejects incorrect counts and invalid pixels or dimensions without returning a partial PNG', async () => {
    const source = frame([1, 2, 3, 255]);
    await expect(encodeApng(iterable([]), { frameCount: 1 })).rejects.toThrow('少于');
    await expect(encodeApng(iterable([source, source]), { frameCount: 1 })).rejects.toThrow('超过');
    await expect(encodeApng(iterable([source]), { frameCount: MAX_GIF_FRAMES + 1 })).rejects.toThrow('帧数');
    await expect(encodeApng(iterable([{ ...source, data: new Uint8ClampedArray(0) }]), { frameCount: 1 })).rejects.toThrow('不完整');
    await expect(encodeApng(iterable([{ ...source, width: MAX_OUTPUT_SIDE + 1 }]), { frameCount: 1 })).rejects.toThrow('没有缩图');
    await expect(encodeApng(iterable([{ ...source, width: MAX_OUTPUT_SIDE, height: Math.floor(MAX_FRAME_PIXELS / MAX_OUTPUT_SIDE) + 1 }]), { frameCount: 1 })).rejects.toThrow('没有缩图');
    await expect(encodeApng(iterable([source, frame([1, 2, 3, 255, 4, 5, 6, 255])]), { frameCount: 2 })).rejects.toThrow('一致');
    await expect(encodeApng(iterable([{ ...source, delayMs: 0 }]), { frameCount: 1 })).rejects.toThrow('时长');
  });

  it('enforces the compressed-byte budget and cancels without reading subsequent source frames', async () => {
    const source = frame([1, 2, 3, 255]);
    await expect(encodeApng(iterable([source, source]), { frameCount: 2, maxBytes: 128 })).rejects.toThrow('文件过大');
    await expect(encodeApng(iterable([source]), { frameCount: 1, maxBytes: MAX_GIF_BYTES + 1 })).rejects.toThrow('上限无效');
    const controller = new AbortController();
    let requestedSecond = false;
    async function* sources() {
      yield source;
      requestedSecond = true;
      yield source;
    }
    await expect(encodeApng(sources(), { frameCount: 2, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestedSecond).toBe(false);
    await expect(encodeApng(iterable([source]), { frameCount: 1, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels during a large frame and closes the source iterator', async () => {
    const controller = new AbortController();
    let closed = false;
    async function* source() {
      try {
        yield { width: 1024, height: 1024, data: new Uint8ClampedArray(1024 * 1024 * 4), delayMs: 20 };
      } finally { closed = true; }
    }
    const result = encodeApng(source(), { frameCount: 1, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(closed).toBe(true);
    } finally { clearTimeout(timer); }
  });
});
