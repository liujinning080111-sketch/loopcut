/** Preserve native sticker pixels; only larger sources need downscaling. */
export const MAX_OUTPUT_SIDE = 1024;
export const MAX_GIF_FRAMES = 360;
/** Bound accumulated compressed bytes as well as the live RGBA frames. */
export const MAX_GIF_BYTES = 16 * 1024 * 1024;

export function fitWithinSource(width: number, height: number, maxSide = MAX_OUTPUT_SIDE): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('原始画面尺寸无效。');
  }
  if (!Number.isInteger(maxSide) || maxSide < 1 || maxSide > MAX_OUTPUT_SIDE) {
    throw new Error(`输出长边必须在 1 至 ${MAX_OUTPUT_SIDE} 像素之间。`);
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
