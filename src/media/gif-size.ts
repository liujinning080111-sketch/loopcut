/** A conservative decimal 500 KB ceiling, including every byte of the file. */
export const MAX_WECHAT_GIF_BYTES = 500_000;

export function gifKilobytes(bytes: number): string {
  return (Math.ceil(bytes / 100) / 10).toFixed(1);
}

export function assertGifSize(bytes: number, optimizationIncomplete = false): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('GIF 文件大小无效。');
  if (bytes > MAX_WECHAT_GIF_BYTES) {
    const stage=optimizationIncomplete?'本次无损优化未完成，当前 GIF 为':'无损优化后仍为';
    throw new Error(`${stage} ${gifKilobytes(bytes)} KB，超过 500 KB，已停止保存。没有缩图、减色或抽帧。请缩短循环片段或收紧裁剪范围后重试；保持画质和全部帧时，不能保证所有素材都能压到 500 KB。`);
  }
}
