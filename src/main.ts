import './style.css';
import type { Background, BackgroundMode, Frame, GifFrame, Rect, Region } from './types';
import { detectLoop, detectRegions, inspectBackground, removeBackground } from './core/vision';
import { openVideo, sampleFrames, seekFrame } from './media/video';
import { encodeGif } from './media/gif';
import { assertGifSize, gifKilobytes } from './media/gif-size';
import { planGifTiming } from './media/gif-timing';
import { encodeApng } from './media/apng';
import { readSourceTimeline, sourceSchedule, fixedSchedule, originalFrames, type SourceTimeline } from './media/source-timeline';
import { hitTestCrop, moveCrop, normalizeCrop, resizeCrop, type CropCorner, type CropHandle, type Point } from './core/crop';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const video = $<HTMLVideoElement>('video');
// Keep preview decoding independent of analysis/export. A single current ROI
// is retained, rather than a cache of full-resolution frames for the whole clip.
const previewVideo = document.createElement('video');
previewVideo.id='preview-video';previewVideo.className='decoder';previewVideo.muted=true;previewVideo.playsInline=true;previewVideo.preload='auto';
previewVideo.setAttribute('aria-hidden','true');previewVideo.style.left='0';previewVideo.style.top='0';
document.body.append(previewVideo);
const sourceCanvas = $<HTMLCanvasElement>('source-canvas');
const sourceStage = sourceCanvas.parentElement!;
const cropOverlay = document.createElement('div');cropOverlay.id='crop-overlay';cropOverlay.className='crop-overlay';cropOverlay.hidden=true;
cropOverlay.setAttribute('role','group');cropOverlay.setAttribute('aria-label','裁剪区域');
const cropInstruction=document.createElement('span');cropInstruction.id='crop-instructions';cropInstruction.className='crop-sr-only';cropInstruction.textContent='拖动四角调整大小，拖动框内移动。聚焦后用方向键微调，按住 Shift 加速。拖动时按 Escape 取消。';
const moveControl=document.createElement('button');moveControl.type='button';moveControl.id='crop-move';moveControl.className='crop-move';moveControl.dataset.handle='move';moveControl.setAttribute('aria-label','移动裁剪框');moveControl.setAttribute('aria-describedby',cropInstruction.id);
cropOverlay.append(cropInstruction,moveControl);
const cornerLabels:Record<CropCorner,string>={nw:'左上角',ne:'右上角',sw:'左下角',se:'右下角'};
const cropHandles=(Object.keys(cornerLabels) as CropCorner[]).map(corner=>{
  const button=document.createElement('button');button.type='button';button.id=`crop-handle-${corner}`;button.className=`crop-handle crop-handle-${corner}`;button.dataset.handle=corner;button.setAttribute('aria-label',`调整裁剪框${cornerLabels[corner]}`);button.setAttribute('aria-describedby',cropInstruction.id);cropOverlay.append(button);return button;
});
sourceStage.append(cropOverlay);
sourceCanvas.setAttribute('aria-label','原视频裁剪区域，可拖动四角缩放或拖动框内移动');
const sourceBuffer = document.createElement('canvas');
let sourceFrameTime = -1;
const previewCanvas = $<HTMLCanvasElement>('preview');
let frames: Frame[] = [];
let regions: Region[] = [];
let crop: Rect = { x: .15, y: .3, width: .7, height: .4 };
let duration = 0;
let analysisEnd = 0;
let sourceUrl = '';
let sourceFile: File | undefined;
let sourceTimeline: SourceTimeline | undefined;
let sourceTimingError = '';
const PREVIEW_SOURCE_SIDE = 1024;
let previewUrl = '';
let resultUrl = '';
let outputFile: File | undefined;
let background: Background = { color: [255,255,255], confidence: 0, recommendation: 'rectangle', reason: '' };
let mode: BackgroundMode = 'auto';
let controller: AbortController | undefined;
let busy = false;
let playing = true;
let startedAt = performance.now();
let previewDirty = true;
let previewFailed = false;
let previewInFlight = false;
let previewRevision = 0;
let previewController: AbortController | undefined;
let lastPreviewTime = -1;
let lastAnimation = 0;
let shareBusy = false;
const fmt = (n: number) => n.toFixed(2);
// In-app WebViews (WeChat, Douyin, QQ, Weibo…) lack file sharing, and their
// long-press "save image" stores a still snapshot rather than the GIF bytes.
const inAppBrowser = /MicroMessenger|aweme|BytedanceWebview|NewsArticle|\bQQ\/|Weibo|DingTalk|Lark|Feishu|xhsdiscover|FBAN|FBAV|Instagram/i.test(navigator.userAgent);
const IN_APP_MESSAGE = '当前在 App 内置浏览器中，无法把动图存进相册。请点右上角 ··· 选择「在浏览器打开」，用 Safari 打开本页后再保存。';
const clamp = (v:number,lo:number,hi:number) => Math.max(lo,Math.min(hi,v));
const number = (id:string) => Number(input(id).value);
const transparent = () => mode === 'transparent' || (mode === 'auto' && background.recommendation === 'transparent');
function stopPreviewRequest() {
  previewRevision++;previewController?.abort();previewController=undefined;previewInFlight=false;
  previewVideo.pause();
}
function refreshPreview() {stopPreviewRequest();previewDirty=true;previewFailed=false;}
// Replacing button text during an input blur cancels the pending click in WebKit.
function setText(id:string,value:string) {if($(id).textContent!==value)$(id).textContent=value;}
function updateExportInfo() {
  const kind = input('format').value === 'apng' ? 'APNG' : 'GIF';
  setText('export',`生成 ${kind}`);
  setText('share',kind==='GIF'?'保存到相册':`分享 ${kind}`);
  $('save-guide').hidden=kind!=='GIF';
  $('gif-size-policy').hidden=kind!=='GIF';
  const geometry=number('size')===0?'保留原尺寸':`按所选 ${number('size')} px 长边缩小，不放大小图`;
  const cadence=number('fps')===0?'按原时间轴逐帧读取':`按所选 ${number('fps')} fps 采样`;
  let note = `${geometry}，${cadence}。`+(kind === 'GIF' ? 'GIF 仍会限制颜色，帧时间按 0.01 秒取整。' : 'APNG 无损保存解码后的画面，但不保证能作为微信表情。');
  const hasShortFrames=sourceTimeline?.samples.some((sample,i,list)=>i>0&&sample.timestamp-list[i-1].timestamp<.02-.000001);
  if (kind === 'GIF' && (number('fps')>50 || (number('fps')===0 && hasShortFrames))) note += ' 此视频含高帧率片段，GIF 在部分播放器会明显变慢；APNG 更适合保留帧时间。';
  if (kind === 'GIF' && frames.length) {
    try {
      const steps=number('fps')===0&&sourceTimeline?sourceSchedule(sourceTimeline.samples,number('start'),number('end')):number('fps')>0?fixedSchedule(number('start'),number('end'),number('fps')):undefined;
      if(steps){
        const timing=planGifTiming(steps.map(step=>step.delayMs));
        if(timing.requiresSlowdown)note+=` 保留全部 ${steps.length} 帧时，GIF 最短需 ${fmt(timing.outputDurationMs/1000)} 秒（原片段 ${fmt(timing.sourceDurationMs/1000)} 秒）；将延长文件时长，不丢帧。`;
        else if(timing.retimed)note+=' 短帧时间会自动协调到 GIF 精度，保留全部画面；局部节奏可能有轻微变化。';
      }
    } catch { /* Export validation explains invalid or over-budget ranges. */ }
  }
  if (kind === 'APNG' && sourceTimeline && (number('fps') || sourceTimeline.fps) > 90) note += ' 极高帧率的实际播放仍受屏幕与播放器限制。';
  if (sourceTimeline?.hdr) note += ' 此素材是 HDR，浏览器可能映射为 SDR，不能保留原 HDR 色彩。';
  setText('format-note',note);
  setText('timing-info',sourceTimeline ? `${sourceTimeline.variable ? '变帧率' : `${Number(sourceTimeline.fps.toFixed(3))} fps`} · 原时间轴已读取${sourceTimeline.exactDecoder ? '' : ' · 兼容解码，帧定位取决于浏览器'}` : sourceTimingError);
}
function notify(message: string, error = false) { $('status').hidden = false; $('status').textContent = message; $('status').classList.toggle('error', error); }
function progress(message:string,ratio:number) { $('progress-label').textContent = message; $<HTMLProgressElement>('progress').value = ratio; }
function invalidate() {
  if(resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = ''; outputFile = undefined;
  $('result').hidden = true; $('gif-preview').hidden = true;
  $('compression-note').textContent='';
  $<HTMLImageElement>('gif-preview').removeAttribute('src');
  $('download').removeAttribute('href');
  previewCanvas.hidden = false;refreshPreview();$('preview-label').textContent = '高清编辑预览 · 约 8 fps';
  if(frames.length) document.querySelectorAll('.steps li').forEach((el,i)=>el.classList.toggle('active',i===1));
}
function updateAvailability() {
  $<HTMLFieldSetElement>('controls').disabled = busy || !frames.length;
  ['demo','import-empty','replace','analyze','window-start'].forEach(id => ($<HTMLButtonElement>(id).disabled = busy));
  $<HTMLButtonElement>('analyze').disabled = busy || !sourceUrl || !duration;
  document.querySelectorAll<HTMLButtonElement>('#candidates button').forEach(button=>{button.disabled=busy||!frames.length;});
  $<HTMLButtonElement>('play-toggle').disabled = busy || !frames.length;
  sourceCanvas.style.pointerEvents = busy ? 'none' : 'auto';
  syncCropControls();
  $('progress-area').hidden = !busy;
  $<HTMLButtonElement>('share').disabled = busy || shareBusy || !outputFile;
}
async function task(action:(signal:AbortSignal)=>Promise<void>) {
  if(busy) return;
  finishCropDrag(false);
  stopPreviewRequest();
  busy = true; controller = new AbortController(); updateAvailability();
  try { await action(controller.signal); }
  catch(error) {
    if(!frames.length){$('edit-badge').textContent=sourceUrl?'等待分析':'等待导入';$('preview-empty').hidden=false;}
    const cancelled=controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    notify(cancelled ? '处理已取消。可以调整后重试。' : error instanceof Error ? error.message : '处理失败，请重新选择录屏。', !cancelled);
  }
  finally { busy = false; controller = undefined;previewDirty=true;startedAt=performance.now();updateAvailability(); }
}
function draw(canvas:HTMLCanvasElement,frame:Frame) {
  if(canvas.width !== frame.width) canvas.width = frame.width;
  if(canvas.height !== frame.height) canvas.height = frame.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.data),frame.width,frame.height),0,0);
}
function captureSource(source:HTMLVideoElement,time:number) {
  if(source.readyState<2||!source.videoWidth)return;
  const scale=Math.min(1,PREVIEW_SOURCE_SIDE/Math.max(source.videoWidth,source.videoHeight));
  const width=Math.max(1,Math.round(source.videoWidth*scale)),height=Math.max(1,Math.round(source.videoHeight*scale));
  if(sourceBuffer.width!==width)sourceBuffer.width=width;
  if(sourceBuffer.height!==height)sourceBuffer.height=height;
  sourceBuffer.getContext('2d')!.drawImage(source,0,0,width,height);sourceFrameTime=time;
  drawSource();
}
function drawSource() {
  if(sourceFrameTime<0)return;
  const width=sourceBuffer.width,height=sourceBuffer.height;
  if(sourceCanvas.width!==width)sourceCanvas.width=width;
  if(sourceCanvas.height!==height)sourceCanvas.height=height;
  sourceCanvas.getContext('2d')!.drawImage(sourceBuffer,0,0);
  sourceCanvas.dataset.frameTime=String(sourceFrameTime);
  sourceCanvas.style.width=`min(100%, ${400*width/height}px)`;
  const ctx=sourceCanvas.getContext('2d')!;
  const w=sourceCanvas.width,h=sourceCanvas.height,x=crop.x*w,y=crop.y*h,cw=crop.width*w,ch=crop.height*h;
  ctx.fillStyle='#00000066';ctx.beginPath();ctx.rect(0,0,w,h);ctx.rect(x,y,cw,ch);ctx.fill('evenodd');
  ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,w/Math.max(1,sourceCanvas.getBoundingClientRect().width));ctx.strokeRect(x,y,cw,ch);
  syncCropControls();
}
function syncCropControls() {
  cropOverlay.hidden=!frames.length||sourceFrameTime<0;
  const box=sourceCanvas.getBoundingClientRect(),stage=sourceStage.getBoundingClientRect();
  cropOverlay.style.left=`${box.left-stage.left+sourceStage.scrollLeft}px`;cropOverlay.style.top=`${box.top-stage.top+sourceStage.scrollTop}px`;
  cropOverlay.style.width=`${box.width}px`;cropOverlay.style.height=`${box.height}px`;
  moveControl.style.left=`${crop.x*100}%`;moveControl.style.top=`${crop.y*100}%`;moveControl.style.width=`${crop.width*100}%`;moveControl.style.height=`${crop.height*100}%`;
  for(const button of cropHandles){const corner=button.dataset.handle as CropCorner;button.style.left=`${(crop.x+(corner.endsWith('e')?crop.width:0))*100}%`;button.style.top=`${(crop.y+(corner.startsWith('s')?crop.height:0))*100}%`;button.disabled=busy||!frames.length;}
  moveControl.disabled=busy||!frames.length;
}
new ResizeObserver(syncCropControls).observe(sourceCanvas);
new ResizeObserver(syncCropControls).observe(sourceStage);
function syncCropFields() { for(const key of ['x','y','width','height'] as const) input(`crop-${key}`).value=(crop[key]*100).toFixed(1); }
function inspect() {
  if(!frames.length) return;
  const selected=frames.filter(frame=>frame.time>=number('start')-.001&&frame.time<number('end'));
  background = inspectBackground(selected.length?selected:frames,crop);
  $('background-badge').textContent = transparent() ? '当前：透明' : '当前：矩形';
  $('background-reason').textContent = mode === 'auto' ? background.reason : mode === 'rectangle' ? '保留录屏中的原始背景，不改动表情内部颜色。' : '从边缘连通区域去底。检查白色身体和边缘是否完整；不满意可降低强度或保留矩形。';
  $('tolerance-row').hidden = !transparent();previewDirty=true;
}
function setRange(start:number,end:number) {
  const low=frames[0]?.time??0, high=Math.min(analysisEnd||duration,sourceTimeline?.duration??duration), minLength=Math.min(.05,high-low);
  // Keep ordinary two-decimal values, but never round outside the actual clip.
  const roundedStart=Number(fmt(clamp(start,low,Math.max(low,high-minLength))));
  input('start').value=String(clamp(roundedStart,low,Math.max(low,high-minLength)));
  const roundedEnd=Number(fmt(clamp(end,number('start')+minLength,high)));
  input('end').value=String(clamp(roundedEnd,number('start')+minLength,high));
  input('start').min=fmt(low);input('end').min=fmt(low+minLength);
  input('start').max=fmt(Math.max(low,high-minLength));input('end').max=fmt(high);
  input('scrub').min=fmt(low);input('scrub').max=String(Math.max(low,high-.001));input('scrub').step='0.01';
  input('scrub').value=String(clamp(number('start'),low,high));
  startedAt=performance.now();refreshPreview();updateExportInfo();
}
function findLoop() {
  if(!frames.length)return;
  const loop=detectLoop(frames,crop);
  setRange(loop.start,Math.min(loop.end,loop.start+12,duration));
  $('loop-badge').textContent=loop.detected ? `候选 · ${Math.round(loop.confidence*100)}%` : '请手动选段';
  $('loop-reason').textContent=loop.reason + (loop.end-loop.start>12?' 已将待导出片段限制为 12 秒，请手动确认范围。':'');
  inspect(); invalidate();
}
function candidates() {
  $('candidates').replaceChildren();
  regions.slice(0,4).forEach((r,i)=>{const b=document.createElement('button');b.textContent=`候选 ${i+1} · ${Math.round(r.score*100)}%`;b.disabled=busy||!frames.length;b.addEventListener('click',()=>{if(busy||!frames.length)return;crop={...r.rect};syncCropFields();drawSource();findLoop();});$('candidates').append(b);});
}
async function analyze(signal:AbortSignal) {
  const from=clamp(number('window-start')||0,0,Math.max(0,duration-.25)); input('window-start').value=fmt(from);
  const to=Math.min(duration,from+24);
  progress('正在读取录屏画面…',0);
  const sampled=await sampleFrames(video,from,to,8,192,signal,r=>progress(`正在读取录屏画面 ${Math.round(r*100)}%`,r*.85));
  signal.throwIfAborted(); progress('正在寻找表情和完整循环…',.9);
  // Give the UI a paint before the bounded analysis pass.
  await new Promise(resolve=>setTimeout(resolve,0)); signal.throwIfAborted();
  const detected=detectRegions(sampled);signal.throwIfAborted();
  frames=sampled;analysisEnd=to;regions=detected;invalidate();
  crop=regions[0]?.rect ?? {x:.1,y:.2,width:.8,height:.6};
  syncCropFields();drawSource();candidates();findLoop();
  $('preview-empty').hidden=true; $('edit-badge').textContent='可手动调整';
  $('source-meta').textContent=`${video.videoWidth} × ${video.videoHeight} · ${fmt(duration)} s`;
  document.querySelectorAll('.steps li').forEach((el,i)=>el.classList.toggle('active',i===1));
  playing=true; $('play-toggle').textContent='Ⅱ'; $('play-toggle').setAttribute('aria-label','暂停预览');
  notify(regions.length ? '已找到表情候选。请检查裁剪是否包含完整身体，并预览动作衔接。' : '未能可靠定位表情。请拖动裁剪框四角调整大小，再点击「在当前裁剪区重新找循环」。');
  progress('分析完成',1);
}
async function load(file:File,signal:AbortSignal) {
  frames=[];regions=[];analysisEnd=0;duration=0;sourceFile=undefined;sourceTimeline=undefined;sourceTimingError='';updateExportInfo();invalidate();candidates();
  previewVideo.pause();previewVideo.removeAttribute('src');previewVideo.load();
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';lastPreviewTime=-1;
  sourceFrameTime=-1;sourceBuffer.width=sourceBuffer.height=1;delete sourceCanvas.dataset.frameTime;
  if(sourceUrl) URL.revokeObjectURL(sourceUrl); sourceUrl='';
  video.pause();video.removeAttribute('src');video.load();
  sourceCanvas.getContext('2d')?.clearRect(0,0,sourceCanvas.width,sourceCanvas.height);
  previewCanvas.getContext('2d')?.clearRect(0,0,previewCanvas.width,previewCanvas.height);
  $('source-meta').textContent='MP4 / MOV';$('filename').textContent='';
  $('edit-badge').textContent='正在读取';$('preview-empty').hidden=false;
  $('source-loaded').hidden=true;$('upload-zone').hidden=false;
  progress('正在打开本地视频…',0);
  const meta=await openVideo(file,video,signal);sourceUrl=meta.url;duration=meta.duration;
  const previewMeta=await openVideo(file,previewVideo,signal);previewUrl=previewMeta.url;
  sourceFile=file;
  progress('正在读取原视频每一帧的时间…',0);
  try {
    const timeline=await readSourceTimeline(file,signal);
    if(timeline.width!==meta.width||timeline.height!==meta.height)throw new Error('视频旋转或像素比例与浏览器读取结果不一致，无法保证原帧导出。');
    sourceTimeline=timeline;
  } catch(error) {
    signal.throwIfAborted();
    sourceTimingError=`原帧率不可用：${error instanceof Error?error.message:'无法读取时间轴。'} 可手动指定帧率，但不代表原帧率。`;
  }
  updateExportInfo();
  $('filename').textContent=file.name; input('window-start').value='0';input('window-start').max=fmt(Math.max(0,duration-.25));
  $('upload-zone').hidden=true; $('source-loaded').hidden=false;
  await seekFrame(previewVideo,0,undefined,PREVIEW_SOURCE_SIDE,signal);captureSource(previewVideo,0);
  await analyze(signal);
}
input('file').addEventListener('change',()=>{const file=input('file').files?.[0];input('file').value='';if(file)void task(signal=>load(file,signal));});
for(const id of ['import-empty','replace'])$(id).addEventListener('click',()=>input('file').click());
$('demo').addEventListener('click',()=>void task(async signal=>{progress('打开内置合成示例…',0);const r=await fetch(`${import.meta.env.BASE_URL}demo.mp4`,{signal});if(!r.ok)throw new Error('示例暂不可用，请选择自己的录屏。');await load(new File([await r.blob()],'合成示例.mp4',{type:'video/mp4'}),signal);}));
$('analyze').addEventListener('click',()=>void task(analyze));
$('cancel').addEventListener('click',()=>controller?.abort());
$('help-toggle').addEventListener('click',()=>{$('help').hidden=!$('help').hidden;});
$('help-close').addEventListener('click',()=>{$('help').hidden=true;});
$('refind-loop').addEventListener('click',findLoop);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.addEventListener('click',()=>{
  mode=b.dataset.mode as BackgroundMode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});
  inspect();invalidate();
}));
input('tolerance').addEventListener('input',()=>{$('tolerance-value').textContent=input('tolerance').value;invalidate();});
for(const id of ['start','end'])input(id).addEventListener('change',()=>{
  if(busy||!frames.length)return;
  let start=number('start'),end=number('end');
  if(!Number.isFinite(start)||!Number.isFinite(end)) {start=frames[0]?.time??0;end=Math.min(duration,start+2);}
  const outside=start<frames[0].time-.005||end>analysisEnd+.005||start>=analysisEnd;
  setRange(start,end);$('loop-badge').textContent='手动选择';$('loop-reason').textContent='将按你选定的起止导出。请检查动作是否完整，首尾衔接是否自然。';inspect();invalidate();
  if(outside)notify(`起止已限制在当前已分析的 ${fmt(frames[0].time)}–${fmt(analysisEnd)} 秒内。若要处理其他位置，请修改「分析从」并重新自动识别。`);
});
for(const id of ['size','fps','format'])$(id).addEventListener('change',()=>{invalidate();updateExportInfo();});
for(const key of ['x','y','width','height'] as const)input(`crop-${key}`).addEventListener('change',()=>{
  const values = ['x','y','width','height'].map(k=>number(`crop-${k}`)/100);
  if(values.some(v=>!Number.isFinite(v))){syncCropFields();return;}
  crop=normalizeCrop({x:values[0],y:values[1],width:values[2],height:values[3]});
  cropChanged();
});
function cropChanged() { syncCropFields();drawSource();inspect();invalidate();$('loop-badge').textContent='裁剪已修改';$('loop-reason').textContent='裁剪区域已改变，建议重新寻找循环或手动确认起止。'; }
let cropDrag:{pointerId:number;handle:CropHandle;start:Point;original:Rect;previousPlaying:boolean}|undefined;
function cropPointer(e:PointerEvent):Point {const box=sourceCanvas.getBoundingClientRect();return{x:(e.clientX-box.left)/Math.max(1,box.width),y:(e.clientY-box.top)/Math.max(1,box.height)};}
function cropPlayback(value:boolean){playing=value;$('play-toggle').textContent=value?'Ⅱ':'▶';$('play-toggle').setAttribute('aria-label',value?'暂停预览':'播放预览');}
function finishCropDrag(commit:boolean) {
  const drag=cropDrag;if(!drag)return;cropDrag=undefined;delete cropOverlay.dataset.dragging;
  if(sourceStage.hasPointerCapture(drag.pointerId))sourceStage.releasePointerCapture(drag.pointerId);
  const changed=(['x','y','width','height'] as const).some(key=>Math.abs(crop[key]-drag.original[key])>.000001);
  if(commit&&changed){cropChanged();return;}
  crop={...drag.original};syncCropFields();drawSource();cropPlayback(drag.previousPlaying);previewDirty=true;
}
function updateCropDrag(e:PointerEvent) {
  const drag=cropDrag;if(!drag||drag.pointerId!==e.pointerId||busy)return;
  const point=cropPointer(e),delta={x:point.x-drag.start.x,y:point.y-drag.start.y};
  crop=drag.handle==='move'?moveCrop(drag.original,delta):resizeCrop(drag.original,drag.handle,delta);
  syncCropFields();drawSource();e.preventDefault();
}
sourceStage.addEventListener('pointerdown',e=>{
  if(busy||!frames.length||cropDrag||e.button!==0)return;
  const box=sourceCanvas.getBoundingClientRect();if(!box.width||!box.height)return;
  const point=cropPointer(e),handle=hitTestCrop(crop,point,{x:22/box.width,y:22/box.height});
  if(!handle)return;
  cropDrag={pointerId:e.pointerId,handle,start:point,original:{...crop},previousPlaying:playing};
  cropOverlay.dataset.dragging=handle;cropPlayback(false);stopPreviewRequest();sourceStage.setPointerCapture(e.pointerId);e.preventDefault();
});
sourceStage.addEventListener('pointermove',updateCropDrag);
sourceStage.addEventListener('pointerup',e=>{if(cropDrag?.pointerId===e.pointerId){updateCropDrag(e);finishCropDrag(true);}});
sourceStage.addEventListener('pointercancel',e=>{if(cropDrag?.pointerId===e.pointerId)finishCropDrag(false);});
sourceStage.addEventListener('lostpointercapture',e=>{if(cropDrag?.pointerId===e.pointerId)finishCropDrag(false);});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&cropDrag){finishCropDrag(false);e.preventDefault();}});
cropOverlay.addEventListener('keydown',e=>{
  const target=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-handle]');
  const direction:Record<string,Point>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}};
  if(!target||busy||!frames.length||!direction[e.key])return;e.preventDefault();finishCropDrag(false);
  const box=sourceCanvas.getBoundingClientRect(),step=e.shiftKey?10:1,delta={x:direction[e.key].x*step/Math.max(1,box.width),y:direction[e.key].y*step/Math.max(1,box.height)};
  const handle=target.dataset.handle as CropHandle;crop=handle==='move'?moveCrop(crop,delta):resizeCrop(crop,handle,delta);
  cropPlayback(false);cropChanged();
});
function renderPreview(frame:Frame) {
  let f=frame;if(transparent())f=removeBackground(f,background.color,number('tolerance'));
  draw(previewCanvas,f);
}
input('scrub').addEventListener('input',()=>{
  if(busy||!frames.length)return;
  playing=false;$('play-toggle').textContent='▶';$('play-toggle').setAttribute('aria-label','播放预览');
  refreshPreview();previewCanvas.hidden=false;$('gif-preview').hidden=true;$('preview-label').textContent='原视频高清画面';$('scrub-time').textContent='读取中…';
});
$('play-toggle').addEventListener('click',()=>{if(busy||!frames.length)return;playing=!playing;startedAt=performance.now();refreshPreview();$('play-toggle').textContent=playing?'Ⅱ':'▶';$('play-toggle').setAttribute('aria-label',playing?'暂停预览':'播放预览');if(resultUrl){$('gif-preview').hidden=!playing;previewCanvas.hidden=playing;$('preview-label').textContent=playing?`实际 ${input('format').value==='apng'?'APNG':'GIF'} 预览`:'暂停查看 · 原视频高清帧';}});
async function updatePreview(time:number) {
  const revision=++previewRevision,localController=new AbortController();
  previewController=localController;previewInFlight=true;previewDirty=false;
  try {
    const frame=await seekFrame(previewVideo,time,{...crop},960,localController.signal);
    if(revision!==previewRevision||busy||document.hidden)return;
    renderPreview(frame);captureSource(previewVideo,frame.time);lastPreviewTime=time;
    input('scrub').value=String(time);$('scrub-time').textContent=`${fmt(time)} s`;
  } catch(error) {
    if(revision!==previewRevision||localController.signal.aborted)return;
    previewFailed=true;playing=false;$('play-toggle').textContent='▶';$('play-toggle').setAttribute('aria-label','重试高清预览');
    $('preview-label').textContent='预览读取失败 · 点击播放重试';
    notify(error instanceof Error?`高清预览未能读取：${error.message}`:'高清预览未能读取，请调整位置或点击播放重试。',true);
  } finally {
    if(revision===previewRevision){previewInFlight=false;previewController=undefined;}
  }
}
function animate(now:number) {
  requestAnimationFrame(animate);if(busy||cropDrag||!frames.length||!previewUrl||previewFailed||previewInFlight||(resultUrl&&!$('gif-preview').hidden)||document.hidden||now-lastAnimation<125)return;
  lastAnimation=now;
  const start=number('start'),end=number('end');const time=playing ? start+((now-startedAt)/1000)%Math.max(.05,end-start) : number('scrub');
  const bounded=clamp(time,frames[0].time,Math.min(analysisEnd,duration)-.001);
  if(!playing&&!previewDirty&&Math.abs(bounded-lastPreviewTime)<.002)return;
  void updatePreview(bounded);
}
requestAnimationFrame(animate);
$('export').addEventListener('click',()=>void task(async signal=>{
  const start=number('start'),end=number('end'),fps=number('fps'),size=number('size');
  const native=fps===0,kind=input('format').value==='apng'?'APNG':'GIF';
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.005)throw new Error('请设置有效的起点和终点。');
  if(end-start<.01)throw new Error('所选片段太短，请选择至少 0.01 秒的画面。');
  if(end-start>12.005)throw new Error('每次最多导出 12 秒。请缩短起止范围；不会自动丢帧。');
  if(native&&!sourceTimeline)throw new Error(sourceTimingError||'无法读取原帧时间轴，已停止导出。');
  const plan=native?sourceSchedule(sourceTimeline!.samples,start,end):fixedSchedule(start,end,fps);
  const gifTiming=kind==='GIF'?planGifTiming(plan.map(step=>step.delayMs)):undefined;
  const count=plan.length,isTransparent=transparent(),selectedCrop={...crop},color=background.color,tolerance=number('tolerance');
  let outputWidth=0,outputHeight=0;
  invalidate();progress(`正在生成 ${kind}…`,0);
  async function* decodedFrames():AsyncGenerator<Frame> {
    if(sourceFile&&sourceTimeline)yield* originalFrames(sourceFile,sourceTimeline,video,plan,selectedCrop,size,signal,native);
    else for(const step of plan)yield await seekFrame(video,step.time,selectedCrop,size,signal);
  }
  async function* exportFrames():AsyncGenerator<GifFrame> {
    let i=0;
    for await(let frame of decodedFrames()){
      signal.throwIfAborted();outputWidth=frame.width;outputHeight=frame.height;
      if(isTransparent)frame=removeBackground(frame,color,tolerance);
      const delayMs=gifTiming?.delaysMs[i]??plan[i].delayMs;i++;
      yield {...frame,delayMs};
    }
    if(i!==count)throw new Error('原始帧未完整导出。');
  }
  const onProgress=(n:number)=>progress(`正在生成 ${kind} ${n}/${count} 帧`,n/count);
  let compression: { originalBytes:number; optimizedBytes:number; optimized?:boolean; reason?:string } | undefined;
  const blob=kind==='APNG'?await encodeApng(exportFrames(),{frameCount:count,signal,onProgress}):await encodeGif(exportFrames(),{
    signal,onProgress,mergeDuplicates:false,
    onPhase:()=>progress('正在无损压缩 GIF，保留画面与全部帧…',1),
    onOptimization:stats=>{compression=stats;},
  });
  // Validate the finished, optimized bytes before creating any save/share link.
  // Never meet the ceiling by silently changing dimensions, colors or frames.
  if(kind==='GIF')assertGifSize(blob.size,Boolean(compression?.reason));
  signal.throwIfAborted();outputFile=new File([blob],`loopcut-${new Date().toISOString().slice(0,10)}.${kind==='APNG'?'png':'gif'}`,{type:blob.type});resultUrl=URL.createObjectURL(outputFile);
  const img=$<HTMLImageElement>('gif-preview');img.src=resultUrl;img.alt=`已生成的 ${kind} 预览`;img.hidden=false;previewCanvas.hidden=true;
  $('preview-label').textContent=`实际 ${kind} 预览`;playing=true;$('play-toggle').textContent='Ⅱ';$('play-toggle').setAttribute('aria-label','暂停预览');
  $<HTMLAnchorElement>('download').href=resultUrl;
  $<HTMLAnchorElement>('download').download=outputFile.name;
  $('result-title').textContent=`${kind} 已准备好`;
  const outputSeconds=gifTiming?gifTiming.outputDurationMs/1000:end-start;
  $('result-meta').textContent=`${outputWidth} × ${outputHeight} px · ${count} 帧 · ${gifKilobytes(blob.size)} KB · ${fmt(outputSeconds)} s · ${isTransparent?'透明':'矩形'}`;
  $('compression-note').textContent=kind==='GIF'&&compression
    ? compression.reason
      ? `无损优化未全部完成：${gifKilobytes(compression.originalBytes)} → ${gifKilobytes(blob.size)} KB。已保留验证一致的文件，仍在 500 KB 内。`
      : `无损优化：${gifKilobytes(compression.originalBytes)} → ${gifKilobytes(blob.size)} KB，减少 ${Math.max(0,100*(1-blob.size/compression.originalBytes)).toFixed(1)}%。尺寸、画面与帧时间未因压缩改变。`
    : '';
  $('result').hidden=false;
  let canShare=false;try{canShare=!!navigator.canShare?.({files:[outputFile]});}catch{/* downloads remain available */}
  $('share-note').textContent=inAppBrowser?'当前 App 内置浏览器存不了会动的 GIF，请用右上角菜单「在浏览器打开」。':canShare?'请勿长按预览图保存，那样只能存下静止的一帧。':'此浏览器不能直接存到相册，将以文件下载。请勿长按预览图保存。';
  requestAnimationFrame(()=>$('result').scrollIntoView({behavior:'smooth',block:'nearest'}));
  document.querySelectorAll('.steps li').forEach((el,i)=>el.classList.toggle('active',i===2));
  const timingNotice=gifTiming?.requiresSlowdown?`保留全部画面，文件时长已由 ${fmt(end-start)} 秒延长为 ${fmt(outputSeconds)} 秒。`:gifTiming?.retimed?'短帧时间已自动协调，没有丢帧。':'';
  notify(`${kind} 已生成，${native?'按原时间轴生成':'按所选帧率采样'} ${count} 帧。${timingNotice}${kind==='GIF'&&plan.some(step=>step.delayMs<20)?'GIF 的高帧率播放可能变慢，详见格式说明。':(kind==='GIF'?'检查预览后，点「保存到相册」。':'检查预览后，点击分享或下载。')}`);
}));
$('share').addEventListener('click',()=>{
  if(busy||!outputFile||shareBusy)return;
  let canShare=false;try{canShare=!!navigator.share&&!!navigator.canShare?.({files:[outputFile]});}catch{/* Fall back to download when capability probing throws. */}
  if(!canShare){
    if(inAppBrowser){notify(IN_APP_MESSAGE,true);$('inapp-banner').scrollIntoView({behavior:'smooth',block:'center'});return;}
    $<HTMLAnchorElement>('download').click();
    notify('此浏览器不能直接存到相册，已改为下载文件。在 iPhone 上请用 Safari 打开本页再保存。');return;
  }
  // Call directly within the user gesture; never await encoding before sharing.
  shareBusy=true;updateAvailability();
  // Share only the file: adding text/url makes iOS drop "Save Image" or share a link instead.
  navigator.share({files:[outputFile]}).then(()=>notify(outputFile?.type==='image/gif'?'已交给系统。若选择了「存储图像」，可在「照片 → 媒体类型 → 动图」中找到这张会动的 GIF。':'系统分享操作已完成，请在所选位置确认文件。')).catch((error:Error)=>notify(error.name==='AbortError'?'已取消分享，动画仍保留，可再次分享或下载。':'系统未能分享这个文件，请改用下载文件或打开动画。',error.name!=='AbortError')).finally(()=>{shareBusy=false;updateAvailability();});
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){finishCropDrag(false);stopPreviewRequest();if(busy){controller?.abort();notify('页面进入后台，已停止处理。回到页面后可重新分析或生成 GIF。');}}else{previewDirty=true;}startedAt=performance.now();});
window.addEventListener('pagehide',()=>{finishCropDrag(false);controller?.abort();stopPreviewRequest();});
if('serviceWorker' in navigator && import.meta.env.PROD){
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`,{scope:import.meta.env.BASE_URL}).then(()=>navigator.serviceWorker.ready).then(()=>{$('offline-status').textContent='应用已缓存 · 可离线打开';}).catch(()=>{$('offline-status').textContent='离线缓存不可用 · 需联网打开';});
}
if(!window.isSecureContext)$('offline-status').textContent='当前非 HTTPS · 分享与离线可能不可用';
$('inapp-banner').hidden=!inAppBrowser;
// Long-press saving from <img> stores only a still frame on iOS; point users to the save button instead.
{
  const gifPreview=$<HTMLImageElement>('gif-preview');let pressTimer=0;
  const warn=()=>notify(input('format').value==='apng'?'长按保存可能丢失动画，请使用下方的分享或下载按钮。':'长按保存只会存下静止的一帧。请点下方「保存到相册」，再选择「存储图像」。',true);
  gifPreview.addEventListener('contextmenu',e=>{e.preventDefault();warn();});
  gifPreview.addEventListener('touchstart',()=>{clearTimeout(pressTimer);pressTimer=window.setTimeout(warn,500);},{passive:true});
  for(const type of ['touchend','touchmove','touchcancel'])gifPreview.addEventListener(type,()=>clearTimeout(pressTimer),{passive:true});
}
updateAvailability();
updateExportInfo();
