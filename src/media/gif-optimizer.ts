import { GifReader, GifWriter, type FrameInfo } from 'omggif';
import { MAX_FRAME_PIXELS, MAX_GIF_FRAMES, MAX_OUTPUT_SIDE } from './limits';

export interface GifOptimizationStats {
  originalBytes: number;
  optimizedBytes: number;
  optimized: boolean;
  reason?: string;
}
export interface GifOptimizationResult { bytes: Uint8Array; stats: GifOptimizationStats }

// Guard peak live image/buffer storage as well as processing work. This stage
// never resizes, requantizes, merges frames, or changes their delays.
const MAX_OPTIMIZER_MEMORY = 256 * 1024 * 1024;
const MAX_FRAME_PIXEL_WORK = 320_000_000;
const MAX_OPTIMIZER_TIME_MS = 20_000;
class BudgetExceeded extends Error {}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function clearRect(canvas: Uint8Array, width: number, rect: Pick<FrameInfo, 'x' | 'y' | 'width' | 'height'>): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) canvas.fill(0, (y * width + rect.x) * 4, (y * width + rect.x + rect.width) * 4);
}

/** Decode displayed images, including disposal at the animation's loop seam. */
function* rendered(reader: GifReader, loops = 1, check = () => {}): Generator<Uint8Array> {
  const canvas = new Uint8Array(reader.width * reader.height * 4);
  let previous: FrameInfo | undefined;
  let restore: Uint8Array | undefined;
  for (let loop = 0; loop < loops; loop++) for (let index = 0; index < reader.numFrames(); index++) {
    check();
    if (previous?.disposal === 2) clearRect(canvas, reader.width, previous);
    else if (previous?.disposal === 3 && restore) canvas.set(restore);
    const info = reader.frameInfo(index);
    restore = info.disposal === 3 ? canvas.slice() : undefined;
    reader.decodeAndBlitFrameRGBA(index, canvas);
    previous = info;
    yield canvas.slice();
  }
}

function validate(reader: GifReader): void {
  const { width, height } = reader;
  if (width < 1 || height < 1 || width > MAX_OUTPUT_SIDE || height > MAX_OUTPUT_SIDE || width * height > MAX_FRAME_PIXELS || reader.numFrames() < 1 || reader.numFrames() > MAX_GIF_FRAMES) throw new Error('GIF 优化数据超出处理范围。');
  for (let i = 0; i < reader.numFrames(); i++) {
    const frame = reader.frameInfo(i);
    if (frame.width < 1 || frame.height < 1 || frame.x + frame.width > width || frame.y + frame.height > height || frame.delay < 1 || frame.disposal > 3) throw new Error('GIF 优化画面参数无效。');
  }
}

/** Exact displayed-pixel check; invisible RGB bytes are zero in both decoders. */
export function equivalentGifAnimation(a: Uint8Array, b: Uint8Array, check = () => {}): boolean {
  try {
    const first = new GifReader(a), second = new GifReader(b);
    validate(first); validate(second);
    if (first.width !== second.width || first.height !== second.height || first.numFrames() !== second.numFrames() || first.loopCount() !== second.loopCount()) return false;
    for (let i = 0; i < first.numFrames(); i++) if (first.frameInfo(i).delay !== second.frameInfo(i).delay) return false;
    const baseline = rendered(first, 2, check), candidate = rendered(second, 2, check);
    for (const frame of baseline) {
      const next = candidate.next();
      if (next.done || !same(frame, next.value)) return false;
    }
    return candidate.next().done === true;
  } catch (error) { if (error instanceof BudgetExceeded) throw error; return false; }
}

type Mode = 'full' | 'rectangle' | 'sparse';

function encodeCandidate(reader: GifReader, maxBytes: number, mode: Mode, check: () => void): Uint8Array | undefined {
  // omggif does not grow a typed buffer. Stop as soon as its cursor passes this
  // exact capacity; an oversized candidate can never win against the baseline.
  const output = new Uint8Array(maxBytes);
  const repeat = reader.loopCount();
  let writer: GifWriter | undefined;
  let globalColors = new Map<number, number>();
  const iterator = rendered(reader, 1, check);
  let current = iterator.next().value!;
  const first = current.slice();
  const base = new Uint8Array(current.length);
  const width = reader.width, height = reader.height;
  for (let index = 0; index < reader.numFrames(); index++) {
    const next = index + 1 < reader.numFrames() ? iterator.next().value! : first;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, mustClear = false;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const clearNext = current[p + 3] !== 0 && next[p + 3] === 0;
      const changed = current[p] !== base[p] || current[p + 1] !== base[p + 1] || current[p + 2] !== base[p + 2] || current[p + 3] !== base[p + 3];
      if (clearNext) mustClear = true;
      if (changed || clearNext) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    if (index === 0 || mode === 'full') { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
    const empty = x1 < x0;
    if (empty) { x0 = y0 = x1 = y1 = 0; }
    const rectWidth = x1 - x0 + 1, rectHeight = y1 - y0 + 1;
    const pixels = new Uint8Array(rectWidth * rectHeight);
    const palette = [0];
    const colors = new Map<number, number>();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const p = (y * width + x) * 4;
      if (empty || current[p + 3] === 0) continue;
      if (mode === 'sparse' && current[p] === base[p] && current[p + 1] === base[p + 1] && current[p + 2] === base[p + 2] && current[p + 3] === base[p + 3]) continue;
      const color = (current[p] << 16) | (current[p + 1] << 8) | current[p + 2];
      let value = colors.get(color);
      if (value === undefined) {
        if (palette.length === 256) return undefined; // Never requantize.
        value = palette.length; colors.set(color, value); palette.push(color);
      }
      pixels[(y - y0) * rectWidth + x - x0] = value;
    }
    let paletteSize = 2;
    while (paletteSize < palette.length) paletteSize *= 2;
    while (palette.length < paletteSize) palette.push(0);
    const disposal = mode === 'full' || mustClear ? 2 : 1;
    const options = { delay: reader.frameInfo(index).delay, disposal, transparent: 0 };
    if (!writer) {
      globalColors = colors;
      writer = new GifWriter(output, width, height, { palette, ...(repeat === null ? {} : { loop: repeat }) });
      writer.addFrame(x0, y0, rectWidth, rectHeight, pixels, options);
    } else {
      const start = writer.getOutputBufferPosition();
      writer.addFrame(x0, y0, rectWidth, rectHeight, pixels, { ...options, palette });
      const localEnd = writer.getOutputBufferPosition();
      // Reuse the first palette only by exact RGB membership. Compare real
      // encoded bytes: a tiny local palette can beat a large global palette.
      if ([...colors.keys()].every(color => globalColors.has(color))) {
        const local = localEnd <= maxBytes ? output.slice(start, localEnd) : undefined;
        const map = new Uint8Array(256);
        for (const [color, localIndex] of colors) map[localIndex] = globalColors.get(color)!;
        const remapped = pixels.map(value => map[value]);
        writer.setOutputBufferPosition(start);
        writer.addFrame(x0, y0, rectWidth, rectHeight, remapped, options);
        if (local && writer.getOutputBufferPosition() > localEnd) {
          output.set(local, start);
          writer.setOutputBufferPosition(localEnd);
        }
      }
    }
    if (writer.getOutputBufferPosition() + 1 > maxBytes) return undefined;
    base.set(current);
    if (disposal === 2) clearRect(base, width, { x: x0, y: y0, width: rectWidth, height: rectHeight });
    current = next;
  }
  const length = writer!.end();
  return length <= maxBytes ? output.slice(0, length) : undefined;
}

export function optimizeGifLosslessly(bytes: Uint8Array, options: { timeBudgetMs?: number } = {}): GifOptimizationResult {
  const fallback = (reason: string): GifOptimizationResult => ({ bytes, stats: { originalBytes: bytes.length, optimizedBytes: bytes.length, optimized: false, reason } });
  let best = bytes;
  try {
    const reader = new GifReader(bytes);
    validate(reader);
    const pixels = reader.width * reader.height;
    if (pixels * 24 + bytes.length * 4 + 16 * 1024 * 1024 > MAX_OPTIMIZER_MEMORY || pixels * reader.numFrames() > MAX_FRAME_PIXEL_WORK) return fallback('原尺寸动画超出本次无损优化预算，已保留原 GIF。');
    const deadline = performance.now() + Math.min(MAX_OPTIMIZER_TIME_MS, Math.max(0, options.timeBudgetMs ?? MAX_OPTIMIZER_TIME_MS));
    const check = () => { if (performance.now() >= deadline) throw new BudgetExceeded(); };
    for (const mode of ['full', 'rectangle', 'sparse'] as const) {
      const candidate = encodeCandidate(reader, best.length - 1, mode, check);
      if (candidate && candidate.length < best.length && equivalentGifAnimation(bytes, candidate, check)) best = candidate;
    }
    return { bytes: best, stats: { originalBytes: bytes.length, optimizedBytes: best.length, optimized: best !== bytes } };
  } catch (error) {
    const reason = error instanceof BudgetExceeded ? '无损优化达到处理时限' : '无损优化未完成';
    return { bytes: best, stats: { originalBytes: bytes.length, optimizedBytes: best.length, optimized: best !== bytes, reason: `${reason}，${best === bytes ? '已保留原 GIF' : '使用已核验的较小 GIF'}。` } };
  }
}
