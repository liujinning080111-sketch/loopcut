import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { GifFrame } from '../types';

/** Bounded encoder: one pending RGBA frame, its successor, and compressed output. */
export class StreamingGifEncoder {
  private encoder = GIFEncoder();
  private pending?: GifFrame;
  private frames = 0;
  private emittedTime = 0;
  private exactTime = 0;
  private finished = false;
  private width = 0;
  private height = 0;

  push(frame: GifFrame): void {
    if (this.finished) throw new Error('GIF 已结束，不能继续添加画面。');
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 320 || frame.height > 320) throw new Error('GIF 尺寸必须在 1 至 320 像素之间。');
    if (frame.data.length !== frame.width * frame.height * 4) throw new Error('GIF 画面数据不完整。');
    if (!Number.isFinite(frame.delayMs) || frame.delayMs < 10 || frame.delayMs > 60000) throw new Error('GIF 单帧时长必须在 10 至 60000 毫秒之间。');
    if (this.frames && (this.width !== frame.width || this.height !== frame.height)) throw new Error('GIF 的画面尺寸必须保持一致。');
    if (this.frames >= 360) throw new Error('GIF 超过 360 帧，请缩短片段或降低帧率。');
    this.width = frame.width;
    this.height = frame.height;
    this.frames++;
    if (this.pending && this.samePixels(this.pending.data, frame.data) && this.pending.delayMs + frame.delayMs <= 60000) {
      this.pending.delayMs += frame.delayMs;
      return;
    }
    this.flush();
    this.pending = { ...frame, data: frame.data.slice() };
  }

  finish(): Uint8Array {
    if (this.finished) throw new Error('GIF 已完成。');
    if (!this.frames) throw new Error('没有可导出的画面。');
    this.flush();
    this.encoder.finish();
    this.finished = true;
    return this.encoder.bytes();
  }

  private samePixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
    for (let i = 0; i < a.length; i += 4) {
      if ((a[i + 3] < 128) !== (b[i + 3] < 128)) return false;
      if (a[i + 3] >= 128 && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2])) return false;
    }
    return true;
  }

  private flush(): void {
    const frame = this.pending;
    if (!frame) return;
    const opaque = new Uint8Array(frame.data.length);
    let length = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      if (frame.data[i + 3] >= 128) {
        opaque[length++] = frame.data[i];
        opaque[length++] = frame.data[i + 1];
        opaque[length++] = frame.data[i + 2];
        opaque[length++] = 255;
      }
    }
    const colors = length ? quantize(opaque.subarray(0, length), 255, { format: 'rgb565' }) : [[0, 0, 0]];
    const indices = applyPalette(frame.data, colors, 'rgb565');
    for (let p = 0; p < indices.length; p++) {
      indices[p] = frame.data[p * 4 + 3] < 128 ? 0 : indices[p] + 1;
    }
    // Reserving index 0 even for opaque frames avoids accidental transparency
    // in the first/global palette and lets disposal 2 clear moving silhouettes.
    const palette = [[0, 0, 0], ...colors];
    this.exactTime += frame.delayMs;
    const roundedTime = Math.round(this.exactTime / 10) * 10;
    const delay = Math.max(10, roundedTime - this.emittedTime);
    this.emittedTime += delay;
    this.encoder.writeFrame(indices, frame.width, frame.height, {
      palette, transparent: true, transparentIndex: 0, delay, repeat: 0, dispose: 2,
    });
    this.pending = undefined;
  }
}
