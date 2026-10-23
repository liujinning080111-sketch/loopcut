import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { MAX_WECHAT_GIF_BYTES } from '../src/media/gif-size';
import { compositeGif } from './helpers/gif-composite';

const native = fileURLToPath(new URL('./fixtures/native-60.mp4', import.meta.url));
const entropy = fileURLToPath(new URL('./fixtures/gif-budget.mp4', import.meta.url));

async function wholeFrame(page: Page, end: string) {
  await expect(page.locator('#controls')).not.toHaveAttribute('disabled', '');
  const details=page.locator('.fine-tune');
  if(await details.getAttribute('open')===null)await details.locator('summary').click();
  await expect(details).toHaveAttribute('open','');
  for(const [key,value] of Object.entries({'crop-x':'0','crop-y':'0','crop-width':'100','crop-height':'100',start:'0',end})) {
    await page.locator(`#${key}`).fill(value);
    await page.locator(`#${key}`).dispatchEvent('change');
  }
  await page.locator('[data-mode="rectangle"]').click();
  await expect(page.locator('#fps')).toHaveValue('0');
  await expect(page.locator('#size')).toHaveValue('0');
}

test('saves only files within 500000 bytes and rejects an actual high-entropy animation without lowering quality', async({page})=>{
  await page.goto('/');
  await page.locator('#file').setInputFiles(native);
  await wholeFrame(page,'0.5');
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#compression-note')).toContainText('无损优化：');
  const saved=new Uint8Array(await page.locator('#gif-preview').evaluate(async(image:HTMLImageElement)=>Array.from(new Uint8Array(await(await fetch(image.src)).arrayBuffer()))));
  expect(saved.length).toBeLessThanOrEqual(MAX_WECHAT_GIF_BYTES);
  const decoded=compositeGif(saved,{loops:1});
  expect([decoded.width,decoded.height,decoded.frameCount]).toEqual([1280,32,30]);
  expect(decoded.delaysMs.reduce((a,b)=>a+b,0)).toBe(500);

  // Real decoded video and actual output bytes exercise the complete limit.
  // There is no mocked file size, Worker response or error notification here.
  await page.locator('#file').setInputFiles(entropy);
  await wholeFrame(page,'0.5');
  await page.locator('#export').click();
  await expect(page.locator('#status')).toContainText('超过 500 KB', {timeout:60_000});
  await expect(page.locator('#status')).toContainText('没有缩图、减色或抽帧');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#download')).not.toHaveAttribute('href');
  await expect(page.locator('#gif-preview')).not.toHaveAttribute('src');
  await expect(page.locator('#controls')).not.toHaveAttribute('disabled','');
  await expect(page.locator('#fps')).toHaveValue('0');
  await expect(page.locator('#size')).toHaveValue('0');
  await expect(page.locator('#end')).toHaveValue('0.5');
});
