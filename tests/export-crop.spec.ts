import { test, expect, type Page } from '@playwright/test';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { fileURLToPath } from 'node:url';

const demo = fileURLToPath(new URL('../public/demo.mp4', import.meta.url));
const gridColumns = 17, gridRows = 19;

function sampleGrid(pixels: ArrayLike<number>, width: number, height: number) {
  const grid: number[] = [];
  for (let row = 0; row < gridRows; row++) for (let column = 0; column < gridColumns; column++) {
    const x = Math.floor((column + .5) * width / gridColumns);
    const y = Math.floor((row + .5) * height / gridRows);
    const offset = (y * width + x) * 4;
    grid.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
  }
  return grid;
}

function colorCoverage(pixels: ArrayLike<number>) {
  let yellow = 0, outsideMarkers = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
    if (r > 220 && g > 145 && g < 230 && b < 130) yellow++;
    // Purple and green avatars exist only OUTSIDE this sticker's source ROI.
    // Detecting them catches an entire portrait recording squeezed into the
    // requested output dimensions, even if the output dimensions are correct.
    if (r > 160 && g > 160 && b > 160 && ((b > r + 10 && b > g + 15) || (g > r + 20 && g > b + 5))) outsideMarkers++;
  }
  return { yellow: yellow / (pixels.length / 4), outsideMarkers: outsideMarkers / (pixels.length / 4) };
}

async function prepareCrop(page: Page) {
  await page.goto('/');
  await page.locator('#file').setInputFiles(demo);
  await expect(page.locator('#controls')).toBeEnabled();
  await page.locator('.fine-tune summary').click();
  // Fixture source is 1080×1920; this OFF-CENTER selection is 432×384,
  // x=270, y=864, inside the independently known white sticker rectangle.
  // Different source/crop aspect ratios expose a squeezed full-frame export.
  for (const [id, value] of Object.entries({ 'crop-x': '25', 'crop-y': '45', 'crop-width': '40', 'crop-height': '20', start: '0', end: '0.1' })) {
    await page.locator(`#${id}`).fill(value);
    await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('[data-mode="rectangle"]').click();
  // Wait for the completed source capture, not just a currentTime assignment.
  // The preview uses HTMLVideoElement, independent of the native VideoFrame
  // export path and of the deliberately injected bug below.
  await page.locator('#scrub').evaluate((input: HTMLInputElement) => {
    document.querySelector('#source-canvas')?.removeAttribute('data-frame-time');
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#source-canvas')).toHaveAttribute('data-frame-time', '0');
  const preview = await page.locator('#preview').evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width, height: canvas.height,
    pixels: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data),
  }));
  expect([preview.width, preview.height]).toEqual([432, 384]);
  const coverage = colorCoverage(preview.pixels);
  expect(coverage.yellow).toBeGreaterThan(.3);
  expect(coverage.outsideMarkers).toBeLessThan(.001);
  return sampleGrid(preview.pixels, preview.width, preview.height);
}

async function checkExport(page: Page, expectedGrid: number[], dimensions: [number, number]) {
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible();
  const bytes = new Uint8Array(await page.locator('#gif-preview').evaluate(async (image: HTMLImageElement) =>
    Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer()))));
  const gif = parseGIF(bytes.buffer), frames = decompressFrames(gif, true);
  expect([gif.lsd.width, gif.lsd.height]).toEqual(dimensions);
  expect(frames).toHaveLength(3);
  for (const frame of frames) {
    const coverage = colorCoverage(frame.patch!);
    expect(coverage.yellow, 'The selected face must fill the crop, not shrink to the full-screen recording ratio').toBeGreaterThan(.3);
    expect(coverage.outsideMarkers, 'Avatars outside the crop must never appear in the exported GIF').toBeLessThan(.001);
  }
  const actualGrid = sampleGrid(frames[0].patch!, ...dimensions);
  const difference = actualGrid.reduce((sum, value, i) => sum + Math.abs(value - expectedGrid[i]), 0) / actualGrid.length;
  expect(difference, 'The exported crop must match the independent high-resolution editing preview').toBeLessThan(12);
}

for (const decoder of ['native', 'VideoFrame source rectangle ignored', 'compatibility'] as const) {
  test(`${decoder}: exports only the selected non-square source pixels, also when resized`, async ({ page }) => {
    if (decoder === 'compatibility') {
      await page.addInitScript(() => Object.defineProperty(window, 'VideoDecoder', { value: undefined, configurable: true }));
    }
    if (decoder === 'VideoFrame source rectangle ignored') {
      await page.addInitScript(() => {
        const state = { videoFrameDraws: 0, ignoredSourceRects: 0 };
        Object.assign(window, { videoFrameCropFault: state });
        const patch = (prototype: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
          const drawImage = prototype.drawImage;
          prototype.drawImage = function (source: CanvasImageSource, ...coordinates: number[]) {
            if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
              state.videoFrameDraws++;
              if (coordinates.length === 8) {
                state.ignoredSourceRects++;
                // Mirror WebKit's VideoFrame drawImage overload ignoring srcRect.
                // Plain canvases and HTMLVideoElement are intentionally untouched.
                return Reflect.apply(drawImage, this, [source, ...coordinates.slice(4)]);
              }
            }
            return Reflect.apply(drawImage, this, [source, ...coordinates]);
          } as typeof drawImage;
        };
        patch(CanvasRenderingContext2D.prototype);
        if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') patch(OffscreenCanvasRenderingContext2D.prototype);
      });
    }
    const expectedGrid = await prepareCrop(page);
    if (decoder === 'compatibility') await expect(page.locator('#timing-info')).toContainText('兼容解码');
    else await expect(page.locator('#timing-info')).not.toContainText('兼容解码');
    await checkExport(page, expectedGrid, [432, 384]);
    await page.locator('#size').selectOption('320');
    await expect(page.locator('#result')).toBeHidden();
    await checkExport(page, expectedGrid, [320, 284]);
    if (decoder === 'VideoFrame source rectangle ignored') {
      const fault = await page.evaluate(() => (window as unknown as { videoFrameCropFault: { videoFrameDraws: number; ignoredSourceRects: number } }).videoFrameCropFault);
      expect(fault.videoFrameDraws, 'The test must exercise native VideoFrame drawing').toBeGreaterThanOrEqual(6);
      expect(fault.ignoredSourceRects, 'The simulated Safari defect must actually be triggered').toBeGreaterThanOrEqual(6);
    }
  });
}
