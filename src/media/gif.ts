import type { GifFrame } from '../types';

type Reply = { id: number; type: 'ack' | 'done' | 'error'; bytes?: Uint8Array; message?: string };

export async function encodeGif(frames: AsyncIterable<GifFrame>, options: { signal?: AbortSignal; onProgress?: (count: number) => void } = {}): Promise<Blob> {
  const { signal, onProgress } = options;
  const check = () => { if (signal?.aborted) throw new DOMException('已取消处理', 'AbortError'); };
  check();
  if (typeof Worker === 'undefined') throw new Error('此浏览器不支持后台编码，请使用新版 Safari。');
  const worker = new Worker(new URL('./gif.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  function request(payload: { type: 'frame'; frame: GifFrame } | { type: 'finish' }, transfer: Transferable[] = []): Promise<Reply> {
    check();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', message);
        worker.removeEventListener('error', error);
        worker.removeEventListener('messageerror', error);
        signal?.removeEventListener('abort', abort);
      };
      const message = (event: MessageEvent<Reply>) => {
        if (event.data.id !== id) return;
        cleanup();
        if (event.data.type === 'error') reject(new Error(event.data.message ?? 'GIF 编码失败。'));
        else resolve(event.data);
      };
      const error = () => { cleanup(); reject(new Error('GIF 编码器无法启动。请刷新页面或降低输出尺寸后再试。')); };
      const abort = () => { cleanup(); reject(new DOMException('已取消处理', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('GIF 编码超时。请保持页面在前台，缩短片段后重试。')); }, 30000);
      worker.addEventListener('message', message);
      worker.addEventListener('error', error);
      worker.addEventListener('messageerror', error);
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ ...payload, id }, transfer);
    });
  }
  try {
    let count = 0;
    for await (const frame of frames) {
      check();
      // Own this transferable; callers can keep their preview pixels intact.
      const data = frame.data.slice();
      await request({ type: 'frame', frame: { ...frame, data } }, [data.buffer]);
      onProgress?.(++count);
    }
    check();
    const result = await request({ type: 'finish' });
    if (!result.bytes) throw new Error('GIF 编码没有返回文件。');
    // The worker transfers an owned, exact-length buffer; avoid another full
    // GIF-sized JavaScript copy at high resolution before Blob snapshots it.
    const { buffer, byteOffset, byteLength } = result.bytes;
    const owned = byteOffset === 0 && byteLength === buffer.byteLength
      ? buffer as ArrayBuffer
      : buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
    return new Blob([owned], { type: 'image/gif' });
  } finally {
    worker.terminate();
  }
}
