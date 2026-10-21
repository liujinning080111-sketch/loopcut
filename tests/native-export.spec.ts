import { test, expect } from '@playwright/test';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const fixture = fileURLToPath(new URL('./fixtures/native-60.mp4', import.meta.url));
const identify = (rgba: ArrayLike<number>, width: number) => {
  let value = 0;
  for (let bit = 0; bit < 6; bit++) if (rgba[(16 * width + 48 + bit * 64) * 4] > 128) value |= 1 << bit;
  return value;
};

test('preserves 1280 native pixels and every 60fps source frame in GIF and APNG', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#controls')).toBeEnabled();
  await expect(page.locator('#timing-info')).toContainText('60 fps');
  await expect(page.locator('#format')).toHaveValue('gif');
  await expect(page.locator('#fps')).toHaveValue('0');
  await expect(page.locator('#size')).toHaveValue('0');
  await expect(page.locator('#format-note')).toContainText('明显变慢');
  await page.locator('.fine-tune summary').click();
  for (const [id, value] of Object.entries({ 'crop-x': '0', 'crop-y': '0', 'crop-width': '100', 'crop-height': '100', start: '0', end: '0.5' })) {
    await page.locator(`#${id}`).fill(value);
    await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('[data-mode="rectangle"]').click();
  const exportBytes = async () => {
    await page.locator('#export').click();
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result-meta')).toContainText('1280 × 32 px · 30 帧');
    return Buffer.from(await page.locator('#gif-preview').evaluate(async (image: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer()))));
  };
  const gifBytes = await exportBytes();
  const gif = parseGIF(gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength));
  const gifFrames = decompressFrames(gif, true);
  expect([gif.lsd.width, gif.lsd.height]).toEqual([1280, 32]);
  expect(gifFrames).toHaveLength(30);
  expect(gifFrames.map(frame => identify(frame.patch!, 1280))).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(gifFrames.reduce((n, frame) => n + frame.delay, 0)).toBe(500);

  await page.locator('#format').selectOption('apng');
  await expect(page.locator('#result')).toBeHidden();
  const png = await exportBytes();
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const frames: { duration: number; data: Buffer[] }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'fcTL') frames.push({ duration: data.readUInt16BE(20) / data.readUInt16BE(22), data: [] });
    if (type === 'IDAT' || type === 'fdAT') frames.at(-1)!.data.push(type === 'IDAT' ? data : data.subarray(4));
    offset += length + 12;
  }
  expect(frames).toHaveLength(30);
  expect(frames.every(frame => frame.duration === 1 / 60)).toBe(true);
  expect(frames.map(frame => {
    const filtered = inflateSync(Buffer.concat(frame.data));
    const pixels = Buffer.concat(Array.from({ length: 32 }, (_, y) => filtered.subarray(y * (1280 * 4 + 1) + 1, (y + 1) * (1280 * 4 + 1))));
    return identify(pixels, 1280);
  })).toEqual(Array.from({ length: 30 }, (_, i) => i));
  await expect(page.locator('#download')).toHaveAttribute('download', /\.png$/);

  // A partial source frame cannot be silently discarded to fit GIF's clock.
  await page.locator('#format').selectOption('gif');
  await page.locator('#end').fill('0.12');
  await page.locator('#end').dispatchEvent('change');
  await page.locator('#export').click();
  await expect(page.locator('#status')).toContainText('GIF 无法准确保存');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#controls')).toBeEnabled();
});

test('compatibility decoder follows all source timestamps without WebCodecs', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'VideoDecoder', { value: undefined, configurable: true }));
  await page.goto('/');
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#controls')).toBeEnabled();
  await expect(page.locator('#timing-info')).toContainText('兼容解码');
  await page.locator('.fine-tune summary').click();
  for (const [id, value] of Object.entries({ 'crop-x': '0', 'crop-y': '0', 'crop-width': '100', 'crop-height': '100', start: '0', end: '0.5' })) {
    await page.locator(`#${id}`).fill(value);
    await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('[data-mode="rectangle"]').click();
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible();
  const bytes = new Uint8Array(await page.locator('#gif-preview').evaluate(async (image: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer()))));
  const gif = parseGIF(bytes.buffer), frames = decompressFrames(gif, true);
  expect([gif.lsd.width, gif.lsd.height]).toEqual([1280, 32]);
  expect(frames.map(frame => identify(frame.patch!, 1280))).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(frames.reduce((n, frame) => n + frame.delay, 0)).toBe(500);
});
