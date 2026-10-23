import { describe, expect, it } from 'vitest';
import { assertGifSize, gifKilobytes, MAX_WECHAT_GIF_BYTES } from '../src/media/gif-size';

describe('WeChat GIF file budget', () => {
  it('accepts exactly 500000 bytes and rejects even one extra byte', () => {
    expect(MAX_WECHAT_GIF_BYTES).toBe(500_000);
    expect(() => assertGifSize(499_999)).not.toThrow();
    expect(() => assertGifSize(500_000)).not.toThrow();
    expect(() => assertGifSize(500_001)).toThrow('超过 500 KB');
    expect(() => assertGifSize(512_000)).toThrow('没有缩图、减色或抽帧');
    expect(() => assertGifSize(512_000,true)).toThrow('无损优化未完成');
  });

  it('reports decimal kilobytes without changing the file-size decision', () => {
    expect(gifKilobytes(499_900)).toBe('499.9');
    expect(gifKilobytes(499_999)).toBe('500.0');
    expect(gifKilobytes(500_001)).toBe('500.1');
    expect(gifKilobytes(512_000)).toBe('512.0');
    for (const bytes of [0, -1, NaN, Infinity, 1.1]) expect(() => assertGifSize(bytes)).toThrow('无效');
  });
});
