import type { Background, Frame, LoopResult, Rect, Region } from '../types';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const rgbDistance = (a: ArrayLike<number>, offset: number, color: readonly number[]) =>
  Math.hypot(a[offset] - color[0], a[offset + 1] - color[1], a[offset + 2] - color[2]);

function bounds(frame: Frame, rect: Rect) {
  const normalizedX = clamp(Number.isFinite(rect.x) ? rect.x : 0, 0, 1);
  const normalizedY = clamp(Number.isFinite(rect.y) ? rect.y : 0, 0, 1);
  const normalizedWidth = clamp(Number.isFinite(rect.width) ? rect.width : 1, 0, 1);
  const normalizedHeight = clamp(Number.isFinite(rect.height) ? rect.height : 1, 0, 1);
  const x = Math.floor(normalizedX * frame.width);
  const y = Math.floor(normalizedY * frame.height);
  const left = Math.min(frame.width - 1, x), top = Math.min(frame.height - 1, y);
  const right = clamp(Math.ceil((normalizedX + normalizedWidth) * frame.width), left + 1, frame.width);
  const bottom = clamp(Math.ceil((normalizedY + normalizedHeight) * frame.height), top + 1, frame.height);
  return { left, top, right, bottom };
}

export function cropFrame(frame: Frame, rect: Rect): Frame {
  const { left, top, right, bottom } = bounds(frame, rect);
  const width = right - left, height = bottom - top;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const offset = ((y + top) * frame.width + left) * 4;
    data.set(frame.data.subarray(offset, offset + width * 4), y * width * 4);
  }
  return { width, height, data, time: frame.time };
}

/** Motion proposals, not semantic object recognition. All coordinates are normalized. */
export function detectRegions(frames: Frame[]): Region[] {
  if (frames.length < 3 || frames[0].width < 2 || frames[0].height < 2) return [];
  const { width, height } = frames[0];
  if (frames.some(f => f.width !== width || f.height !== height)) return [];
  const count = new Uint16Array(width * height), energy = new Float32Array(count.length);
  let broadChanges = 0;
  for (let i = 1; i < frames.length; i++) {
    let changed = 0;
    const a = frames[i - 1].data, b = frames[i].data;
    for (let p = 0; p < count.length; p++) {
      const j = p * 4;
      const difference = (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2])) / 3;
      if (difference > 14) { count[p]++; changed++; energy[p] += difference; }
    }
    if (changed / count.length > 0.38) broadChanges++;
  }
  // Scrolling/video behind a comment panel must not be called a sticker region.
  if (broadChanges > Math.max(1, (frames.length - 1) * 0.28)) return [];
  const mask = new Uint8Array(count.length), dilated = new Uint8Array(count.length);
  const minimum = Math.max(2, Math.floor((frames.length - 1) * 0.035));
  for (let p = 0; p < count.length; p++) mask[p] = +(count[p] >= minimum && energy[p] / count[p] > 18);
  const radius = Math.max(3, Math.round(Math.min(width, height) / 50));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) dilated[yy * width + xx] = 1;
    }
  }
  const queue = new Int32Array(count.length), proposals: Region[] = [];
  for (let p = 0; p < count.length; p++) {
    if (!dilated[p]) continue;
    let head = 0, tail = 1, motionPixels = 0, recurrence = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    queue[0] = p; dilated[p] = 0;
    while (head < tail) {
      const q = queue[head++], x = q % width, y = Math.floor(q / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (mask[q]) { motionPixels++; recurrence += count[q] / (frames.length - 1); }
      for (const next of [x > 0 ? q - 1 : -1, x < width - 1 ? q + 1 : -1, y > 0 ? q - width : -1, y < height - 1 ? q + width : -1]) {
        if (next >= 0 && dilated[next]) { dilated[next] = 0; queue[tail++] = next; }
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1, ratio = w / h;
    if (motionPixels < Math.max(6, count.length * 0.0006) || w * h > count.length * 0.65 || ratio > 4.5 || ratio < 0.2) continue;
    // Include a margin around moving extremities; the UI lets the user correct the proposal.
    const padding = Math.max(5, Math.round(Math.max(w, h) * 0.16));
    const left = Math.max(0, minX - padding), top = Math.max(0, minY - padding);
    const right = Math.min(width, maxX + 1 + padding), bottom = Math.min(height, maxY + 1 + padding);
    const score = clamp(0.32 + Math.min(0.3, recurrence / motionPixels) + Math.min(0.22, motionPixels / (w * h) * 0.3) - Math.abs(Math.log(ratio)) * 0.08, 0.1, 0.86);
    proposals.push({ rect: { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height }, score, label: '' });
  }
  return proposals.sort((a, b) => b.score - a.score).slice(0, 5).map((proposal, i) => ({ ...proposal, label: `表情候选 ${i + 1}` }));
}

function signature(frame: Frame, crop: Rect): Float32Array {
  const { left, top, right, bottom } = bounds(frame, crop);
  const side = 12, result = new Float32Array(side * side * 3);
  for (let gy = 0; gy < side; gy++) for (let gx = 0; gx < side; gx++) {
    const x0 = Math.floor(left + gx * (right - left) / side), x1 = Math.min(right, Math.max(x0 + 1, Math.floor(left + (gx + 1) * (right - left) / side)));
    const y0 = Math.floor(top + gy * (bottom - top) / side), y1 = Math.min(bottom, Math.max(y0 + 1, Math.floor(top + (gy + 1) * (bottom - top) / side)));
    const output = (gy * side + gx) * 3;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const source = (y * frame.width + x) * 4;
      for (let c = 0; c < 3; c++) result[output + c] += frame.data[source + c];
    }
    for (let c = 0; c < 3; c++) result[output + c] /= (x1 - x0) * (y1 - y0) * 255;
  }
  return result;
}

/** Requires two full matching periods, with time retained for every held frame. */
export function detectLoop(frames: Frame[], crop: Rect): LoopResult {
  const fallback: LoopResult = { start: frames[0]?.time ?? 0, end: frames.at(-1)?.time ?? 0, confidence: 0, detected: false, reason: '未找到两遍完整且一致的循环，请手动调整起止位置。' };
  if (frames.length < 6) return fallback;
  const intervals = frames.slice(1).map((f, i) => f.time - frames[i].time).filter(t => t > 0).sort((a, b) => a - b);
  const step = intervals[Math.floor(intervals.length / 2)];
  if (!step || !Number.isFinite(step)) return fallback;
  const signatures = frames.map(frame => signature(frame, crop));
  const active: number[] = [];
  for (let c = 0; c < signatures[0].length; c++) {
    let low = 1, high = 0;
    for (const s of signatures) { low = Math.min(low, s[c]); high = Math.max(high, s[c]); }
    if (high - low > 0.045) active.push(c);
  }
  if (active.length < 3) return { ...fallback, reason: '所选区域基本静止，不能判断完整动画循环。' };
  const n = frames.length, distances = new Float32Array(n * n);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    let total = 0;
    for (const c of active) total += Math.abs(signatures[a][c] - signatures[b][c]);
    distances[a * n + b] = distances[b * n + a] = total / active.length;
  }
  const candidates: { start: number; period: number; confidence: number; error: number; coverage: number }[] = [];
  const minPeriod = Math.max(3, Math.ceil(0.35 / step)), maxPeriod = Math.min(Math.floor(n / 2), Math.floor(12 / step));
  for (let period = minPeriod; period <= maxPeriod; period++) {
    const sums = new Float64Array(n - period + 1), bad = new Uint16Array(sums.length);
    for (let i = 0; i < n - period; i++) {
      const error = distances[i * n + i + period];
      sums[i + 1] = sums[i] + error;
      bad[i + 1] = bad[i] + +(error > 0.11);
    }
    for (let start = 0; start + 2 * period <= n; start++) {
      const error = (sums[start + period] - sums[start]) / period;
      if (error > 0.045 || bad[start + period] - bad[start] > Math.floor(period * 0.08)) continue;
      let span = 0, movement = 0;
      for (let j = start; j < start + period; j++) {
        span = Math.max(span, distances[start * n + j]);
        if (j > start) movement += distances[(j - 1) * n + j];
      }
      if (span < 0.075 || movement / period < 0.012 || error > span * 0.16) continue;
      let coverage = period;
      while (start + coverage + period < n && distances[(start + coverage) * n + start + coverage + period] < 0.08) coverage++;
      const confidence = clamp(0.63 + 0.22 * (1 - error / 0.045) + Math.min(0.08, coverage / period * 0.025) + Math.min(0.04, span * 0.1), 0, 0.97);
      candidates.push({ start, period, confidence, error, coverage });
    }
  }
  if (!candidates.length) return fallback;
  // Prefer a well-supported fundamental period over its longer multiples.
  candidates.sort((a, b) => (b.confidence + b.coverage / n * 0.03 - b.period / n * 0.05) - (a.confidence + a.coverage / n * 0.03 - a.period / n * 0.05) || a.start - b.start);
  const best = candidates[0];
  return { start: frames[best.start].time, end: frames[best.start + best.period].time, confidence: best.confidence, detected: true, reason: `找到至少两遍相似循环，保留一遍约 ${(frames[best.start + best.period].time - frames[best.start].time).toFixed(2)} 秒；请预览衔接。` };
}

function edgePixels(frame: Frame): number[][] {
  const result: number[][] = [];
  const stride = Math.max(1, Math.floor(Math.max(frame.width, frame.height) / 100));
  const push = (x: number, y: number) => { const i = (y * frame.width + x) * 4; result.push([frame.data[i], frame.data[i + 1], frame.data[i + 2]]); };
  for (let x = 0; x < frame.width; x += stride) { push(x, 0); if (frame.height > 1) push(x, frame.height - 1); }
  for (let y = 1; y < frame.height - 1; y += stride) { push(0, y); if (frame.width > 1) push(frame.width - 1, y); }
  return result;
}

export function inspectBackground(frames: Frame[], crop: Rect): Background {
  if (!frames.length) return { color: [255, 255, 255], confidence: 0, recommendation: 'rectangle', reason: '没有可分析画面，保留原背景。' };
  const sampleCount = Math.min(7, frames.length);
  const samples = Array.from({ length: sampleCount }, (_, i) => cropFrame(frames[Math.round(i * (frames.length - 1) / Math.max(1, sampleCount - 1))], crop));
  const edges = samples.flatMap(edgePixels), buckets = new Map<string, number[][]>();
  for (const color of edges) {
    const key = color.map(c => Math.round(c / 24)).join(',');
    const bucket = buckets.get(key) ?? []; bucket.push(color); buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((a, b) => b.length - a.length)[0];
  const color = [0, 1, 2].map(c => { const sorted = dominant.map(rgb => rgb[c]).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }) as [number, number, number];
  const perFrameUniformity = samples.map(frame => { const pixels = edgePixels(frame); return pixels.filter(pixel => rgbDistance(pixel, 0, color) < 30).length / pixels.length; });
  const uniformity = Math.min(...perFrameUniformity);
  const foregroundShares = samples.map(frame => {
    let foreground = 0;
    for (let p = 0; p < frame.data.length; p += 4) if (rgbDistance(frame.data, p, color) > 40) foreground++;
    return foreground / (frame.width * frame.height);
  });
  const hasSubject = Math.max(...foregroundShares) > 0.025 && Math.max(...foregroundShares) < 0.88;
  const confidence = clamp(uniformity * (hasSubject ? 0.97 : 0.4), 0, 1);
  const recommendation = uniformity >= 0.89 && hasSubject ? 'transparent' : 'rectangle';
  return { color, confidence, recommendation, reason: recommendation === 'transparent' ? '裁剪边缘颜色稳定，建议透明；请检查浅色细节和动画边缘。' : '边缘有复杂颜色或主体贴边，建议保留矩形背景。' };
}

/** Removes only similar-color pixels connected to the edge. Tolerance is RGB Euclidean distance (0–160). */
export function removeBackground(frame: Frame, color: [number, number, number], tolerance: number): Frame {
  const { width, height } = frame, data = new Uint8ClampedArray(frame.data);
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  const limit = clamp(Number.isFinite(tolerance) ? tolerance : 30, 0, 160);
  const enqueue = (p: number) => {
    if (visited[p]) return;
    visited[p] = 1;
    if (data[p * 4 + 3] === 0 || rgbDistance(data, p * 4, color) <= limit) queue[tail++] = p;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width, y = Math.floor(p / width);
    data[p * 4 + 3] = 0;
    if (x > 0) enqueue(p - 1); if (x + 1 < width) enqueue(p + 1);
    if (y > 0) enqueue(p - width); if (y + 1 < height) enqueue(p + width);
  }
  return { width, height, data, time: frame.time };
}
