import { StreamingGifEncoder, type GifEncodingOptions } from './gif-core';
import type { GifFrame } from '../types';
import { optimizeGifLosslessly } from './gif-optimizer';

let encoder: StreamingGifEncoder | undefined;
type Request = { id: number; type: 'init'; options: GifEncodingOptions } | { id: number; type: 'frame'; frame: GifFrame } | { id: number; type: 'finish' };

self.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      if (encoder) throw new Error('GIF 编码器已经初始化。');
      encoder = new StreamingGifEncoder(message.options);
      self.postMessage({ id: message.id, type: 'ack' });
    } else if (!encoder) {
      throw new Error('GIF 编码器尚未初始化。');
    } else if (message.type === 'frame') {
      encoder.push(message.frame);
      self.postMessage({ id: message.id, type: 'ack' });
    } else {
      const original = encoder.finish();
      encoder = undefined;
      self.postMessage({ id: message.id, type: 'phase' });
      const { bytes, stats } = optimizeGifLosslessly(original);
      self.postMessage({ id: message.id, type: 'done', bytes, stats }, { transfer: [bytes.buffer] });
    }
  } catch (error) {
    self.postMessage({ id: message.id, type: 'error', message: error instanceof Error ? error.message : 'GIF 编码失败。' });
  }
};
