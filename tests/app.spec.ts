import { test, expect, type Page } from '@playwright/test';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const demoPath = fileURLToPath(new URL('../public/demo.mp4', import.meta.url));

async function importDemo(page: Page) {
  await page.goto('/');
  await page.locator('#file').setInputFiles(demoPath);
  await expect(page.locator('#controls')).toBeEnabled();
  await expect(page.locator('#preview-empty')).toBeHidden();
  await expect(page.locator('#status')).toContainText('已找到表情候选');
}

async function exported(page: Page) {
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible();
  const file = await page.locator('#gif-preview').evaluate(async (image: HTMLImageElement) => {
    const response = await fetch(image.src);
    const blob = await response.blob();
    return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
  expect(file.type).toBe('image/gif');
  const bytes = new Uint8Array(file.bytes);
  const gif = parseGIF(bytes.buffer);
  const frames = decompressFrames(gif, true);
  expect(frames.length).toBeGreaterThan(1);
  return { bytes, gif, frames };
}

test('imports MP4, detects the loop, supports corrections and exports both GIF backgrounds', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await importDemo(page);
  await expect(page.locator('#candidates button').first()).toBeVisible();
  const interval = await page.evaluate(() => Number((document.querySelector('#end') as HTMLInputElement).value) - Number((document.querySelector('#start') as HTMLInputElement).value));
  expect(interval).toBeGreaterThanOrEqual(1.75);
  expect(interval).toBeLessThanOrEqual(2.25);
  // Check actual decoded pixels at known fixture times. Merely advancing
  // currentTime/receiving seeked can still leave a stale canvas on some ports.
  const sampledPixels: number[][] = [];
  for (const time of ['0', '0.5', '2']) {
    await page.locator('#scrub').evaluate((input: HTMLInputElement, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, time);
    await expect.poll(() => page.locator('#source-canvas').getAttribute('data-frame-time')).toBe(time);
    sampledPixels.push(await page.locator('#source-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const x = Math.round(canvas.width * 80 / 360);
      const y = Math.round(canvas.height * 260 / 640);
      return Array.from(canvas.getContext('2d')!.getImageData(x, y, Math.round(canvas.width * 200 / 360), Math.round(canvas.height * 200 / 640)).data);
    }));
  }
  const pixelDistance = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - b[i])), 0) / (a.length * .75);
  const motionDistance = pixelDistance(sampledPixels[0], sampledPixels[1]);
  expect(motionDistance).toBeGreaterThan(2);
  expect(pixelDistance(sampledPixels[0], sampledPixels[2])).toBeLessThan(motionDistance * .3);
  await expect.poll(() => page.locator('#preview').evaluate((canvas: HTMLCanvasElement) => {
    // A 600px native sticker must retain enough pixels for a sharp preview.
    if (canvas.width < 500 || canvas.height < 500) return 0;
    return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.filter((_, i) => i % 4 === 3 && _ > 0).length;
  })).toBeGreaterThan(10);

  // Independently known source coordinates exercise manual correction instead
  // of treating the detector's own crop as test ground truth.
  await page.locator('.fine-tune summary').click();
  for (const [id, value] of Object.entries({ 'crop-x': '22.2', 'crop-y': '40.6', 'crop-width': '55.6', 'crop-height': '31.3', start: '0', end: '2' })) {
    await page.locator(`#${id}`).fill(value);
    await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('[data-mode="rectangle"]').click();
  const rectangle = await exported(page);
  expect(rectangle.frames.reduce((total, frame) => total + frame.delay, 0)).toBe(2000);
  expect(rectangle.gif.lsd.width).toBeGreaterThanOrEqual(599);
  expect(rectangle.gif.lsd.width).toBeLessThanOrEqual(601);
  expect(rectangle.frames[0].patch!.filter((value, index) => index % 4 === 3 && value === 0).length).toBe(0);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.gif$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect((await readFile(path!)).equals(Buffer.from(rectangle.bytes))).toBe(true);

  await page.locator('[data-mode="transparent"]').click();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#gif-preview')).toHaveAttribute('hidden', '');
  await expect(page.locator('#download')).not.toHaveAttribute('href');
  const transparent = await exported(page);
  const alpha = transparent.frames[0].patch!.filter((_, i) => i % 4 === 3);
  expect(alpha.filter(a => a === 0).length).toBeGreaterThan(100);
  expect(alpha.filter(a => a === 255).length).toBeGreaterThan(100);
  expect(transparent.frames.every(frame => frame.disposalType === 2)).toBe(true);
  expect(transparent.frames.reduce((total, frame) => total + frame.delay, 0)).toBe(2000);
  // A valid manual endpoint need not land on the selected frame-rate grid.
  // This previously could create a sub-10ms last frame and reject export.
  await page.locator('#end').fill('1.07');
  await page.locator('#end').dispatchEvent('change');
  await expect(page.locator('#result')).toBeHidden();
  const fractional = await exported(page);
  expect(fractional.frames.reduce((total, frame) => total + frame.delay, 0)).toBe(1070);
  // Smaller files are an explicit choice, never the default silent reduction.
  await page.locator('#size').selectOption('320');
  const compact = await exported(page);
  expect(Math.max(compact.gif.lsd.width, compact.gif.lsd.height)).toBe(320);
  expect(errors).toEqual([]);
});

test('cancels decoding, recovers after invalid files and never leaves controls stuck', async ({ page }) => {
  await page.goto('/');
  // Keep media readiness pending so cancellation is deterministic even on a
  // fast computer; restore load() before testing a real import.
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.load;
    (window as unknown as { restoreLoad: () => void }).restoreLoad = () => { HTMLMediaElement.prototype.load = original; };
    HTMLMediaElement.prototype.load = function () { this.preload = 'none'; };
  });
  await page.locator('#file').setInputFiles(demoPath);
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toContainText('已取消');
  await expect(page.locator('#progress-area')).toBeHidden();
  await expect(page.locator('#import-empty')).toBeEnabled();
  await page.evaluate(() => (window as unknown as { restoreLoad: () => void }).restoreLoad());

  await page.locator('#file').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('This is not a video') });
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('#progress-area')).toBeHidden();
  await expect(page.locator('#import-empty')).toBeEnabled();
  await page.locator('#file').setInputFiles(demoPath);
  await expect(page.locator('#controls')).toBeEnabled();
  await expect(page.locator('#preview-empty')).toBeHidden();
  // Hold the encoder's acknowledgement to exercise a deterministic in-flight
  // export cancellation, rather than racing a very small fixture on fast CPUs.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    (window as unknown as { restoreWorker: () => void }).restoreWorker = () => { Worker.prototype.postMessage = original; };
    Worker.prototype.postMessage = function () {};
  });
  await page.locator('#export').click();
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toContainText('已取消');
  await expect(page.locator('#controls')).toBeEnabled();
  await expect(page.locator('#result')).toBeHidden();
  await page.evaluate(() => (window as unknown as { restoreWorker: () => void }).restoreWorker());
});

test('fits a narrow screen and has a working offline application shell', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('录屏转 GIF');
  await expect(page.locator('#offline-status')).toContainText('已缓存');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('h1')).toContainText('录屏转 GIF');
  await page.locator('#demo').click();
  await expect(page.locator('#controls')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.setOffline(false);
});
