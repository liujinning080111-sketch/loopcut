import { BlobSource, CanvasSink, EncodedPacketSink, Input, Logging, MP4, QTFF, WEBM } from 'mediabunny';
import type { Frame, Rect } from '../types';
import { fitWithinSource, MAX_GIF_FRAMES } from './limits';
import { seekFrame } from './video';

export type SourceSample = { timestamp: number; duration: number };
export type FrameStep = { time: number; sourceTimestamp: number; delayMs: number };
export type SourceTimeline = { samples: SourceSample[]; duration: number; width: number; height: number; fps: number; variable: boolean; hdr: boolean; exactDecoder: boolean };
const createInput = (file: File) => new Input({ source: new BlobSource(file, { maxCacheSize: 4 * 1024 * 1024 }), formats: [MP4, QTFF, WEBM] });

/** Use presentation timestamps, never an assumed or averaged export FPS. */
export function sourceSchedule(samples: SourceSample[], start: number, end: number): FrameStep[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('原帧时间范围无效。');
  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const result: FrameStep[] = [];
  let covered = start;
  for (let i = 0; i < sorted.length; i++) {
    const sample = sorted[i], next = sorted[i + 1];
    if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.duration) || sample.duration <= 0 || (next && next.timestamp <= sample.timestamp)) {
      throw new Error('无法可靠识别原视频逐帧时间，已停止原帧率导出。');
    }
    const finish = next?.timestamp ?? sample.timestamp + sample.duration;
    const from = Math.max(start, sample.timestamp), to = Math.min(end, finish);
    if (to - from < 1e-8) continue;
    if (from > covered + 0.00001) throw new Error('所选片段包含没有视频帧的时间，请调整起点。');
    result.push({ time: (from + to) / 2, sourceTimestamp: sample.timestamp, delayMs: (to - from) * 1000 });
    covered = to;
    if (result.length > MAX_GIF_FRAMES) throw new Error(`原片段超过 ${MAX_GIF_FRAMES} 帧，已停止导出，没有丢帧。请缩短片段。`);
    if (to >= end - 1e-8) break;
  }
  if (!result.length || covered < end - 0.00001) throw new Error('所选片段超出视频帧时间范围，请调整终点。');
  return result;
}

export function fixedSchedule(start: number, end: number, fps: number): FrameStep[] {
  if (![start, end, fps].every(Number.isFinite) || end <= start || fps <= 0) throw new Error('帧率设置无效。');
  const frameCount = (end - start) * fps;
  const nearest = Math.round(frameCount);
  // Decimal times such as 0.1–0.4 can become 6.000000000000001 frames.
  // Account for subtraction/multiplication roundoff, including offset times,
  // without discarding a real partial final frame using a fixed time epsilon.
  const roundoff = 4 * Number.EPSILON * Math.max(1, Math.abs(start) * fps, Math.abs(end) * fps);
  const count = Math.max(1, Math.ceil(Math.abs(frameCount - nearest) <= roundoff ? nearest : frameCount));
  if (count > MAX_GIF_FRAMES) throw new Error('所选片段帧数过多，请缩短片段。');
  return Array.from({ length: count }, (_, i) => {
    const time = start + i / fps;
    return { time, sourceTimestamp: time, delayMs: Math.min(1 / fps, end - time) * 1000 };
  });
}

export async function readSourceTimeline(file: File, signal: AbortSignal): Promise<SourceTimeline> {
  signal.throwIfAborted();
  const input = createInput(file);
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  let unsupported = false;
  // The demuxer warns instead of rejecting complex edit lists. Such files must
  // not be advertised as preserving their original presentation timeline.
  const off = Logging.on('warn', args => { if (args.some(value => /unsupported.*edit list/i.test(String(value)))) unsupported = true; });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('没有找到视频帧时间轴。');
    const samples: SourceSample[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      signal.throwIfAborted();
      samples.push({ timestamp: packet.timestamp, duration: packet.duration });
      if (samples.length > 250_000) throw new Error('录屏帧数过多，请先裁短视频。');
    }
    if (unsupported) throw new Error('视频含暂不支持的剪辑时间轴，无法保证原帧率。请在照片中重新导出。');
    samples.sort((a, b) => a.timestamp - b.timestamp);
    if (!samples.length) throw new Error('视频没有可读取的画面。');
    const deltas = samples.slice(1).map((sample, i) => sample.timestamp - samples[i].timestamp).filter(value => value > 0);
    const median = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? samples[0].duration;
    const [width, height, duration, hdr, exactDecoder] = await Promise.all([
      track.getDisplayWidth(), track.getDisplayHeight(), track.computeDuration(), track.hasHighDynamicRange(), track.canDecode(),
    ]);
    signal.throwIfAborted();
    return { samples, duration, width, height, fps: 1 / median, variable: deltas.some(value => Math.abs(value - median) > 0.0001), hdr, exactDecoder };
  } finally { off(); signal.removeEventListener('abort', abort); input.dispose(); }
}

/** Sequential decoding with a one-canvas pool; native mode visits every PTS. */
export async function* originalFrames(file: File, timeline: SourceTimeline, video: HTMLVideoElement, steps: FrameStep[], crop: Rect, maxSide: number, signal: AbortSignal, verifyTimestamps: boolean): AsyncGenerator<Frame> {
  signal.throwIfAborted();
  const left = Math.min(timeline.width - 1, Math.max(0, Math.round(crop.x * timeline.width)));
  const top = Math.min(timeline.height - 1, Math.max(0, Math.round(crop.y * timeline.height)));
  const width = Math.min(timeline.width - left, Math.max(1, Math.round(crop.width * timeline.width)));
  const height = Math.min(timeline.height - top, Math.max(1, Math.round(crop.height * timeline.height)));
  const output = fitWithinSource(width, height, maxSide);
  if (!timeline.exactDecoder) {
    // Safari versions/codecs without WebCodecs keep the real PTS schedule.
    // The UI identifies this compatibility decoding path explicitly.
    for (const step of steps) yield await seekFrame(video, step.time, crop, maxSide, signal);
    return;
  }
  const input = createInput(file);
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  let resizeCanvas: HTMLCanvasElement | undefined;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('视频轨道无法读取。');
    // Materialize the entire oriented frame first. Some WebKit VideoFrame
    // drawing paths ignore drawImage's source rectangle and squeeze the whole
    // recording into the requested crop size. Canvas pixel reads do not depend
    // on that decoder-specific cropping behavior.
    fitWithinSource(timeline.width, timeline.height);
    const sink = new CanvasSink(track, { alpha: true, poolSize: 1 });
    if (output.width !== width || output.height !== height) {
      resizeCanvas = document.createElement('canvas');
      resizeCanvas.width = output.width; resizeCanvas.height = output.height;
    }
    let i = 0;
    for await (const result of sink.canvasesAtTimestamps(steps.map(step => step.time))) {
      signal.throwIfAborted();
      const step = steps[i++];
      if (!result || !step || (verifyTimestamps && Math.abs(result.timestamp - step.sourceTimestamp) > 0.00001)) {
        throw new Error('逐帧解码未返回对应的原始画面，已停止导出，没有跳过画面。');
      }
      const context = result.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!context) throw new Error('无法读取原始视频像素。');
      if (result.canvas.width !== timeline.width || result.canvas.height !== timeline.height) {
        throw new Error('解码画面尺寸与裁剪坐标不一致，已停止导出，请重新导入录屏。');
      }
      let data: Uint8ClampedArray;
      if (resizeCanvas) {
        const resized = resizeCanvas.getContext('2d', { willReadFrequently: true });
        if (!resized) throw new Error('无法创建裁剪画布。');
        resized.clearRect(0, 0, output.width, output.height);
        resized.imageSmoothingEnabled = true; resized.imageSmoothingQuality = 'high';
        // The source is now a plain canvas, never a VideoFrame.
        resized.drawImage(result.canvas, left, top, width, height, 0, 0, output.width, output.height);
        data = resized.getImageData(0, 0, output.width, output.height).data;
      } else {
        data = context.getImageData(left, top, width, height).data;
      }
      yield { ...output, data, time: step.time };
    }
    if (i !== steps.length) throw new Error('原始画面未完整解码，已停止导出。');
  } finally { signal.removeEventListener('abort', abort); input.dispose(); if (resizeCanvas) resizeCanvas.width = resizeCanvas.height = 1; }
}
