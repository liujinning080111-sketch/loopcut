/** Resource guards reject oversized work; they never silently resize it. */
export const MAX_OUTPUT_SIDE = 8192;
export const MAX_FRAME_PIXELS = 16_777_216;
export const MAX_GIF_FRAMES = 1440;
/** Bound accumulated compressed bytes as well as the live RGBA frames. */
export const MAX_GIF_BYTES = 128 * 1024 * 1024;

export function fitWithinSource(width: number, height: number, maxSide = 0): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('原始画面尺寸无效。');
  }
  if (!Number.isInteger(maxSide) || maxSide < 0 || maxSide > MAX_OUTPUT_SIDE) {
    throw new Error(`输出长边必须为原尺寸或 1 至 ${MAX_OUTPUT_SIDE} 像素。`);
  }
  const scale = maxSide === 0 ? 1 : Math.min(1, maxSide / Math.max(width, height));
  const result = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  if (result.width > MAX_OUTPUT_SIDE || result.height > MAX_OUTPUT_SIDE || result.width * result.height > MAX_FRAME_PIXELS) {
    throw new Error('原尺寸超出当前设备处理预算，已停止导出，没有缩图。请缩小裁剪区域，或自行选择较小尺寸。');
  }
  return result;
}
