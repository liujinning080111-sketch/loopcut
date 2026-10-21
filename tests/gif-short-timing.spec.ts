import { test, expect } from '@playwright/test';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/native-120.mp4', import.meta.url));
const identify = (rgba: ArrayLike<number>, width: number) => {
  let value = 0;
  for (let bit = 0; bit < 6; bit++) if (rgba[(16 * width + 48 + bit * 64) * 4] > 128) value |= 1 << bit;
  return value;
};

test('keeps every 120fps source frame and discloses GIF duration increasing from 0.25 to 0.30 seconds', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#controls')).not.toHaveAttribute('disabled', '');
  await expect(page.locator('#timing-info')).toContainText('120 fps');
  await expect(page.locator('#source-meta')).toContainText('0.25 s');
  // Exercise the ordinary GIF defaults: native dimensions and native frames.
  await expect(page.locator('#format')).toHaveValue('gif');
  await expect(page.locator('#fps')).toHaveValue('0');
  await expect(page.locator('#size')).toHaveValue('0');
  await page.locator('.fine-tune summary').click();
  for (const [id, value] of Object.entries({ 'crop-x': '0', 'crop-y': '0', 'crop-width': '100', 'crop-height': '100', start: '0', end: '0.25' })) {
    await page.locator(`#${id}`).fill(value);
    await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('[data-mode="rectangle"]').click();
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#result-meta')).toContainText('1280 × 32 px · 30 帧');
  await expect(page.locator('#result-meta')).toContainText('0.30 s');
  await expect(page.locator('#status')).toContainText('保留全部画面');
  await expect(page.locator('#status')).toContainText('由 0.25 秒延长为 0.30 秒');
  await expect(page.locator('#status')).toContainText('高帧率播放可能变慢');
  await expect(page.locator('#status')).not.toHaveClass(/error/);

  const bytes = new Uint8Array(await page.locator('#gif-preview').evaluate(async (image: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer()))));
  const parsed = parseGIF(bytes.buffer), frames = decompressFrames(parsed, true);
  expect([parsed.lsd.width, parsed.lsd.height]).toEqual([1280, 32]);
  expect(frames).toHaveLength(30);
  expect(frames.map(frame => identify(frame.patch!, 1280))).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(frames.map(frame => frame.delay)).toEqual(new Array(30).fill(10));
  expect(frames.reduce((duration, frame) => duration + frame.delay, 0)).toBe(300);
  await expect(page.locator('#download')).toHaveAttribute('download', /\.gif$/);
});
