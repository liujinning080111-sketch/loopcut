import type { GifFrame } from '../types';
import { MAX_FRAME_PIXELS, MAX_GIF_BYTES, MAX_GIF_FRAMES, MAX_OUTPUT_SIDE } from './limits';

export interface ApngEncodingOptions {
  frameCount: number;
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
  maxBytes?: number;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

/** Closest fraction with both fields fitting APNG's unsigned 16-bit delay. */
function delayFraction(delayMs: number): [number, number] {
  const seconds = delayMs / 1000;
  if (!Number.isFinite(seconds) || seconds < 1 / 65535 || seconds > 65535) {
    throw new Error('APNG 单帧时长超出可表达范围，请调整片段起止。');
  }
  let p0 = 0, q0 = 1, p1 = 1, q1 = 0, remainder = seconds;
  for (;;) {
    const a = Math.floor(remainder);
    const p2 = a * p1 + p0, q2 = a * q1 + q0;
    if (p2 > 65535 || q2 > 65535) break;
    [p0, p1] = [p1, p2];
    [q0, q1] = [q1, q2];
    if (Math.abs(p1 / q1 - seconds) < 1e-12) return [p1, q1];
    remainder = 1 / (remainder - a);
  }
  const k = Math.min(p1 ? Math.floor((65535 - p0) / p1) : Infinity, q1 ? Math.floor((65535 - q0) / q1) : Infinity);
  const p = p0 + k * p1, q = q0 + k * q1;
  return p > 0 && Math.abs(p / q - seconds) <= Math.abs(p1 / q1 - seconds) ? [p, q] : [p1, q1];
}

/**
 * RGBA8 APNG: one raw source frame and small scanline/compressor buffers at a
 * time. Only compressed PNG chunks survive to the next frame. Full-canvas
 * SOURCE blending preserves partial alpha and replaces old transparent areas.
 */
export async function encodeApng(frames: AsyncIterable<GifFrame>, options: ApngEncodingOptions): Promise<Blob> {
  const { frameCount, signal, onProgress } = options;
  const maxBytes = options.maxBytes ?? MAX_GIF_BYTES;
  const check = () => { if (signal?.aborted) throw new DOMException('已取消处理', 'AbortError'); };
  check();
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_GIF_FRAMES) throw new Error(`APNG 帧数必须在 1 至 ${MAX_GIF_FRAMES} 之间。`);
  if (!Number.isInteger(maxBytes) || maxBytes < 128 || maxBytes > MAX_GIF_BYTES) throw new Error('APNG 文件大小上限无效。');
  if (typeof CompressionStream === 'undefined') throw new Error('此浏览器不支持无损动画编码，请使用 iOS 17 或更新的 Safari。');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let byteLength = 0, count = 0, sequence = 0, width = 0, height = 0;
  const append = (part: Uint8Array<ArrayBuffer>) => {
    if (byteLength + part.length > maxBytes) throw new Error('APNG 文件过大，已达到本次导出大小上限。请缩短片段或自行选择较小尺寸。');
    byteLength += part.length;
    parts.push(part);
  };
  append(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  for await (const frame of frames) {
    check();
    if (count >= frameCount) throw new Error('实际画面数超过声明的 APNG 帧数，请重新导出。');
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > MAX_OUTPUT_SIDE || frame.height > MAX_OUTPUT_SIDE || frame.width * frame.height > MAX_FRAME_PIXELS) throw new Error('APNG 原尺寸超出当前处理预算，已停止导出，没有缩图。请缩小裁剪区域或自行选择较小尺寸。');
    if (frame.data.length !== frame.width * frame.height * 4) throw new Error('APNG 画面数据不完整。');
    if (count && (frame.width !== width || frame.height !== height)) throw new Error('APNG 的画面尺寸必须保持一致。');
    const [numerator, denominator] = delayFraction(frame.delayMs);
    if (!count) {
      width = frame.width;
      height = frame.height;
      const header = new Uint8Array(13);
      const headerView = new DataView(header.buffer);
      headerView.setUint32(0, width);
      headerView.setUint32(4, height);
      header[8] = 8;
      header[9] = 6; // 8-bit RGBA, no palette reduction or alpha threshold.
      append(chunk('IHDR', header));
      const animation = new Uint8Array(8);
      new DataView(animation.buffer).setUint32(0, frameCount); // num_plays=0: loop forever.
      append(chunk('acTL', animation));
    }
    const control = new Uint8Array(26);
    const controlView = new DataView(control.buffer);
    controlView.setUint32(0, sequence++);
    controlView.setUint32(4, width);
    controlView.setUint32(8, height);
    controlView.setUint16(20, numerator);
    controlView.setUint16(22, denominator);
    // offsets=0, dispose=NONE, blend=SOURCE. Every frame replaces the canvas.
    append(chunk('fcTL', control));

    let row = 0;
    const rowBytes = width * 4;
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        check();
        if (row === height) { controller.close(); return; }
        const rows = Math.min(16, height - row);
        const data = new Uint8Array((rowBytes + 1) * rows);
        for (let y = 0; y < rows; y++, row++) {
          // PNG filter NONE keeps encoding bounded and preserves every channel.
          data.set(frame.data.subarray(row * rowBytes, (row + 1) * rowBytes), y * (rowBytes + 1) + 1);
        }
        controller.enqueue(data);
      },
    });
    // 'deflate' includes the zlib wrapper required by PNG, unlike deflate-raw.
    const reader = source.pipeThrough(new CompressionStream('deflate')).getReader();
    const abort = () => { void reader.cancel(new DOMException('已取消处理', 'AbortError')).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        check();
        const result = await reader.read();
        check();
        if (result.done) break;
        if (count === 0) append(chunk('IDAT', result.value));
        else {
          const data = new Uint8Array(result.value.length + 4);
          new DataView(data.buffer).setUint32(0, sequence++);
          data.set(result.value, 4);
          append(chunk('fdAT', data));
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    count++;
    onProgress?.(count);
    check();
  }
  check();
  if (count !== frameCount) throw new Error('实际画面数少于声明的 APNG 帧数，请重新导出。');
  append(chunk('IEND', new Uint8Array()));
  return new Blob(parts, { type: 'image/png' });
}
