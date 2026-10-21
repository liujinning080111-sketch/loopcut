import { StreamingGifEncoder } from './gif-core';
import type { GifFrame } from '../types';

const encoder = new StreamingGifEncoder();
type Request = { id: number; type: 'frame'; frame: GifFrame } | { id: number; type: 'finish' };

self.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if (message.type === 'frame') {
      encoder.push(message.frame);
      self.postMessage({ id: message.id, type: 'ack' });
    } else {
      const bytes = encoder.finish();
      self.postMessage({ id: message.id, type: 'done', bytes }, { transfer: [bytes.buffer] });
    }
  } catch (error) {
    self.postMessage({ id: message.id, type: 'error', message: error instanceof Error ? error.message : 'GIF 编码失败。' });
  }
};
