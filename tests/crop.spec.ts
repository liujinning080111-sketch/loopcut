import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const demoPath=fileURLToPath(new URL('../public/demo.mp4',import.meta.url));
type Crop={x:number;y:number;width:number;height:number};
const baseline:Crop={x:.2,y:.3,width:.4,height:.4};
async function readCrop(page:Page):Promise<Crop>{
  return page.locator('#crop-move').evaluate(element=>({x:parseFloat(element.style.left)/100,y:parseFloat(element.style.top)/100,width:parseFloat(element.style.width)/100,height:parseFloat(element.style.height)/100}));
}
function expectCrop(actual:Crop,expected:Crop){for(const key of ['x','y','width','height'] as const)expect(actual[key]).toBeCloseTo(expected[key],4);}
async function resetCrop(page:Page){
  await page.locator('.fine-tune').evaluate((element:HTMLDetailsElement)=>{element.open=true;});
  for(const [key,value] of Object.entries(baseline)){
    await page.locator(`#crop-${key}`).fill(String(value*100));
    await page.locator(`#crop-${key}`).dispatchEvent('change');
  }
  await page.locator('#source-canvas').scrollIntoViewIfNeeded();
  await expect(page.locator('#crop-overlay')).toBeVisible();
}
async function importDemo(page:Page){
  await page.goto('/');await page.locator('#file').setInputFiles(demoPath);
  await expect(page.locator('#controls')).not.toHaveAttribute('disabled', '');await resetCrop(page);
}
async function imageBox(page:Page){const box=await page.locator('#source-canvas').boundingBox();expect(box).not.toBeNull();return box!;}

test('four crop corners preserve their opposite anchors and the interior moves without resizing',async({page})=>{
  await importDemo(page);
  for(const corner of ['nw','ne','sw','se']){
    await resetCrop(page);const image=await imageBox(page),button=await page.locator(`#crop-handle-${corner}`).boundingBox();
    expect(button).not.toBeNull();expect(button!.width).toBeGreaterThanOrEqual(44);expect(button!.height).toBeGreaterThanOrEqual(44);
    const x=button!.x+button!.width/2,y=button!.y+button!.height/2,dx=12/image.width,dy=-14/image.height;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y-14,{steps:5});await page.mouse.up();
    const west=corner.endsWith('w'),north=corner.startsWith('n');
    expectCrop(await readCrop(page),{x:baseline.x+(west?dx:0),y:baseline.y+(north?dy:0),width:baseline.width+(west?-dx:dx),height:baseline.height+(north?-dy:dy)});
  }
  await resetCrop(page);const image=await imageBox(page);
  const x=image.x+(baseline.x+baseline.width/2)*image.width,y=image.y+(baseline.y+baseline.height/2)*image.height;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+25,y+28,{steps:5});await page.mouse.up();
  expectCrop(await readCrop(page),{...baseline,x:baseline.x+25/image.width,y:baseline.y+28/image.height});
  await expect(page.locator('#loop-badge')).toContainText('裁剪已修改');
});

test('crop movement stays inside the image, blank areas do not replace it, and keyboard controls work',async({page})=>{
  await importDemo(page);let image=await imageBox(page);
  const center=()=>({x:image.x+(baseline.x+baseline.width/2)*image.width,y:image.y+(baseline.y+baseline.height/2)*image.height});
  let point=center();await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(image.x-20,image.y-20,{steps:5});await page.mouse.up();
  expectCrop(await readCrop(page),{...baseline,x:0,y:0});
  const topLeftCenter={x:image.x+baseline.width/2*image.width,y:image.y+baseline.height/2*image.height};
  await page.mouse.move(topLeftCenter.x,topLeftCenter.y);await page.mouse.down();await page.mouse.move(image.x+image.width+20,image.y+image.height+20,{steps:5});await page.mouse.up();
  expectCrop(await readCrop(page),{...baseline,x:1-baseline.width,y:1-baseline.height});
  await resetCrop(page);image=await imageBox(page);
  await page.mouse.click(image.x+image.width*.95,image.y+image.height*.05);
  await page.mouse.move(image.x+image.width*.95,image.y+image.height*.05);await page.mouse.down();await page.mouse.move(image.x+image.width*.85,image.y+image.height*.12,{steps:3});await page.mouse.up();
  expectCrop(await readCrop(page),baseline);
  await page.locator('#crop-handle-nw').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowDown');
  expectCrop(await readCrop(page),{x:baseline.x+1/image.width,y:baseline.y+1/image.height,width:baseline.width-1/image.width,height:baseline.height-1/image.height});
  await resetCrop(page);image=await imageBox(page);
  await page.locator('#crop-move').focus();await page.keyboard.press('Shift+ArrowRight');
  expectCrop(await readCrop(page),{...baseline,x:baseline.x+10/image.width});
});

test('cancelled touch or pointer gestures restore the crop and release pointer capture',async({page,context,browserName})=>{
  await importDemo(page);
  await page.locator('.source-stage').evaluate(stage=>stage.addEventListener('pointerdown',event=>{stage.setAttribute('data-last-pointer-id',String((event as PointerEvent).pointerId));}));
  const button=await page.locator('#crop-handle-se').boundingBox();expect(button).not.toBeNull();const x=button!.x+22,y=button!.y+22;
  if(browserName==='chromium'){
    // Real protocol touch cancellation exercises Pointer Events and capture,
    // including on a non-touch desktop viewport.
    const client=await context.newCDPSession(page);
    await client.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+18,y:y+20,id:1}]});
    await expect.poll(async()=>(await readCrop(page)).width).toBeGreaterThan(baseline.width);
    await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await client.detach();
  }else{
    // WebKit exposes no touch-drag protocol here. Start a real captured pointer,
    // then deliver its cancellation event with that browser-provided pointer ID.
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+18,y+20,{steps:3});
    await expect.poll(async()=>(await readCrop(page)).width).toBeGreaterThan(baseline.width);
    const pointerId=Number(await page.locator('.source-stage').getAttribute('data-last-pointer-id'));
    await page.locator('.source-stage').dispatchEvent('pointercancel',{pointerId,pointerType:'mouse',bubbles:true});await page.mouse.up();
  }
  expectCrop(await readCrop(page),baseline);
  expect(await page.locator('.source-stage').evaluate(stage=>stage.hasPointerCapture(Number(stage.getAttribute('data-last-pointer-id'))))).toBe(false);
  await expect(page.locator('#crop-overlay')).not.toHaveAttribute('data-dragging');
  // Escape provides the same recoverable cancellation for keyboard users.
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-15,y-15,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();
  expectCrop(await readCrop(page),baseline);await expect(page.locator('#crop-overlay')).not.toHaveAttribute('data-dragging');
});
