import type { Frame, Rect } from '../types';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const WAIT_MS = 18000;
const abortError = () => new DOMException('已取消处理', 'AbortError');

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function mediaError(video: HTMLVideoElement): Error {
  if (video.error?.code === 3) return new Error('录屏解码失败。请在照片中重新导出，或改用 H.264 / MP4 录屏。');
  if (video.error?.code === 4) return new Error('此浏览器无法读取这个视频编码。请尝试 Safari，或转换为 H.264 / MP4 后导入。');
  return new Error('无法读取录屏。请确认文件已完整下载到本机，再重新选择。');
}

function waitForMedia(video: HTMLVideoElement, event: string, signal?: AbortSignal, ready?: () => boolean, trigger?: () => void): Promise<void> {
  assertActive(signal);
  if (video.error) return Promise.reject(mediaError(video));
  if (ready?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', abort);
    };
    const success = () => { cleanup(); resolve(); };
    const failure = () => { cleanup(); reject(mediaError(video)); };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('视频读取超时。请保持页面在前台，确认录屏已下载，或尝试较短的 H.264 录屏。'));
    }, WAIT_MS);
    video.addEventListener(event, success, { once: true });
    video.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    try { trigger?.(); } catch (error) { cleanup(); reject(error); }
  });
}

/**
 * `seeked` is a media-timeline signal, not a promise that canvas can already
 * read the new compositor frame. Arm the frame callback before seeking, then
 * allow a paint boundary before snapshotting. Paused/occluded videos may never
 * produce rVFC, so two animation frames and a 100ms ceiling bound the fallback.
 */
function presentationBarrier(video: HTMLVideoElement, signal?: AbortSignal): { wait: () => Promise<void>; cancel: () => void } {
  let completed = false;
  let seekComplete = false;
  let videoCallback: number | undefined;
  let animationCallback: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  const finish = () => {
    if (completed) return;
    completed = true;
    if (videoCallback !== undefined) video.cancelVideoFrameCallback?.(videoCallback);
    if (animationCallback !== undefined) cancelAnimationFrame(animationCallback);
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  };
  const registerFrame = () => {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    videoCallback = video.requestVideoFrameCallback(() => {
      if (completed) return;
      if (seekComplete) finish();
      else registerFrame();
    });
  };
  registerFrame();
  signal?.addEventListener('abort', finish, { once: true });
  return {
    wait: () => {
      if (!completed) {
        seekComplete = true;
        animationCallback = requestAnimationFrame(() => {
          animationCallback = requestAnimationFrame(finish);
        });
        timer = setTimeout(finish, 100);
      }
      return ready;
    },
    cancel: finish,
  };
}

export async function openVideo(file: File, video: HTMLVideoElement, signal?: AbortSignal): Promise<{ width: number; height: number; duration: number; url: string }> {
  assertActive(signal);
  if (!file.size) throw new Error('这个视频文件是空的，请重新选择。');
  if (file.size > MAX_FILE_BYTES) throw new Error('录屏超过 256 MB。请先在照片中裁短后再导入。');
  const url = URL.createObjectURL(file);
  video.pause();
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.src = url;
  video.load();
  try {
    await waitForMedia(video, 'loadedmetadata', signal, () => video.readyState >= 1);
    const { videoWidth: width, videoHeight: height, duration } = video;
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('无法取得视频尺寸或时长。请用照片 App 重新导出这段录屏。');
    }
    await waitForMedia(video, 'loadeddata', signal, () => video.readyState >= 2);
    assertActive(signal);
    return { width, height, duration, url };
  } catch (error) {
    if (video.src === url) {
      video.removeAttribute('src');
      video.load();
    }
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function seekFrame(video: HTMLVideoElement, time: number, crop: Rect = { x: 0, y: 0, width: 1, height: 1 }, maxSide = 320, signal?: AbortSignal): Promise<Frame> {
  assertActive(signal);
  if (!Number.isFinite(video.duration) || !video.videoWidth) throw new Error('请先导入可播放的视频。');
  if (!Number.isFinite(time) || !Number.isFinite(maxSide) || maxSide < 1 || maxSide > 320) throw new Error('帧时间或输出尺寸无效。');
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) throw new Error('裁剪区域无效，请重新框选。');
  video.pause();
  const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.001)));
  const presentation = presentationBarrier(video, signal);
  try {
    if (Math.abs(video.currentTime - target) > 0.0001 || video.seeking) {
      await waitForMedia(video, 'seeked', signal, undefined, () => { video.currentTime = target; });
    }
    await waitForMedia(video, 'loadeddata', signal, () => video.readyState >= 2);
    await presentation.wait();
  } finally {
    presentation.cancel();
  }
  assertActive(signal);
  const sx = Math.min(video.videoWidth - 1, Math.max(0, Math.round(crop.x * video.videoWidth)));
  const sy = Math.min(video.videoHeight - 1, Math.max(0, Math.round(crop.y * video.videoHeight)));
  const sw = Math.min(video.videoWidth - sx, Math.max(1, Math.round(crop.width * video.videoWidth)));
  const sh = Math.min(video.videoHeight - sy, Math.max(1, Math.round(crop.height * video.videoHeight)));
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('此浏览器无法创建画布，请重新打开 Safari。');
  context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 1;
  return { width, height, data, time: target };
}

export async function sampleFrames(video: HTMLVideoElement, start: number, end: number, fps: number, maxSide: number, signal?: AbortSignal, onProgress?: (ratio: number) => void): Promise<Frame[]> {
  assertActive(signal);
  if (![start, end, fps, maxSide].every(Number.isFinite) || fps <= 0 || start < 0 || end <= start || end > video.duration + 0.01) {
    throw new Error('分析时间范围无效，请重新选择。');
  }
  const count = Math.min(192, Math.max(2, Math.ceil((end - start) * fps)));
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    assertActive(signal);
    const time = start + (end - start) * i / count;
    frames.push(await seekFrame(video, time, undefined, Math.min(192, maxSide), signal));
    onProgress?.((i + 1) / count);
  }
  return frames;
}
