import './style.css';
import type { Background, BackgroundMode, Frame, GifFrame, Rect, Region } from './types';
import { detectLoop, detectRegions, inspectBackground, removeBackground } from './core/vision';
import { openVideo, sampleFrames, seekFrame } from './media/video';
import { encodeGif } from './media/gif';
import { MAX_OUTPUT_SIDE } from './media/limits';

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
const sourceBuffer = document.createElement('canvas');
let sourceFrameTime = -1;
const previewCanvas = $<HTMLCanvasElement>('preview');
let frames: Frame[] = [];
let regions: Region[] = [];
let crop: Rect = { x: .15, y: .3, width: .7, height: .4 };
let duration = 0;
let analysisEnd = 0;
let sourceUrl = '';
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
const clamp = (v:number,lo:number,hi:number) => Math.max(lo,Math.min(hi,v));
const number = (id:string) => Number(input(id).value);
const transparent = () => mode === 'transparent' || (mode === 'auto' && background.recommendation === 'transparent');
function stopPreviewRequest() {
  previewRevision++;previewController?.abort();previewController=undefined;previewInFlight=false;
  previewVideo.pause();
}
function refreshPreview() {stopPreviewRequest();previewDirty=true;previewFailed=false;}
function notify(message: string, error = false) { $('status').hidden = false; $('status').textContent = message; $('status').classList.toggle('error', error); }
function progress(message:string,ratio:number) { $('progress-label').textContent = message; $<HTMLProgressElement>('progress').value = ratio; }
function invalidate() {
  if(resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = ''; outputFile = undefined;
  $('result').hidden = true; $('gif-preview').hidden = true;
  $<HTMLImageElement>('gif-preview').removeAttribute('src');
  ['download','open-gif'].forEach(id => $(id).removeAttribute('href'));
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
  $('progress-area').hidden = !busy;
  $<HTMLButtonElement>('share').disabled = busy || shareBusy || !outputFile;
}
async function task(action:(signal:AbortSignal)=>Promise<void>) {
  if(busy) return;
  dragStart=undefined;
  stopPreviewRequest();
  busy = true; controller = new AbortController(); updateAvailability();
  try { await action(controller.signal); }
  catch(error) {
    if(!frames.length){$('edit-badge').textContent=sourceUrl?'等待分析':'等待导入';$('preview-empty').hidden=false;}
    notify(error instanceof DOMException && error.name === 'AbortError' ? '处理已取消。可以调整后重试。' : error instanceof Error ? error.message : '处理失败，请重新选择录屏。', !(error instanceof DOMException && error.name === 'AbortError'));
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
  const scale=Math.min(1,MAX_OUTPUT_SIDE/Math.max(source.videoWidth,source.videoHeight));
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
  ctx.fillStyle='#12281f66';ctx.beginPath();ctx.rect(0,0,w,h);ctx.rect(x,y,cw,ch);ctx.fill('evenodd');
  ctx.strokeStyle='#de6c43';ctx.lineWidth=Math.max(1,w/200);ctx.strokeRect(x,y,cw,ch);
  ctx.fillStyle='#fff';const s=Math.max(3,w/65);for(const [px,py] of [[x,y],[x+cw,y],[x,y+ch],[x+cw,y+ch]])ctx.fillRect(px-s/2,py-s/2,s,s);
}
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
  const low=frames[0]?.time??0, high=analysisEnd||duration, minLength=Math.min(.05,high-low);
  input('start').value=fmt(clamp(start,low,Math.max(low,high-minLength)));
  input('end').value=fmt(clamp(end,number('start')+minLength,high));
  input('start').min=fmt(low);input('end').min=fmt(low+minLength);
  input('start').max=fmt(Math.max(low,high-minLength));input('end').max=fmt(high);
  input('scrub').min=fmt(low);input('scrub').max=String(Math.max(low,high-.001));input('scrub').step='0.01';
  input('scrub').value=String(clamp(number('start'),low,high));
  startedAt=performance.now();refreshPreview();
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
  notify(regions.length ? '已找到表情候选。请检查裁剪是否包含完整身体，并预览动作衔接。' : '未能可靠定位表情。请在左侧画面拖动框选，再点击「在当前裁剪区重新找循环」。');
  progress('分析完成',1);
}
async function load(file:File,signal:AbortSignal) {
  frames=[];regions=[];analysisEnd=0;duration=0;invalidate();candidates();
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
  $('filename').textContent=file.name; input('window-start').value='0';input('window-start').max=fmt(Math.max(0,duration-.25));
  $('upload-zone').hidden=true; $('source-loaded').hidden=false;
  await seekFrame(previewVideo,0,undefined,MAX_OUTPUT_SIDE,signal);captureSource(previewVideo,0);
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
for(const id of ['size','fps'])$(id).addEventListener('change',invalidate);
for(const key of ['x','y','width','height'] as const)input(`crop-${key}`).addEventListener('change',()=>{
  const values = ['x','y','width','height'].map(k=>number(`crop-${k}`)/100);
  if(values.some(v=>!Number.isFinite(v))){syncCropFields();return;}
  crop.x=clamp(values[0],0,.99);crop.y=clamp(values[1],0,.99);crop.width=clamp(values[2],.01,1-crop.x);crop.height=clamp(values[3],.01,1-crop.y);
  cropChanged();
});
function cropChanged() { syncCropFields();drawSource();inspect();invalidate();$('loop-badge').textContent='裁剪已修改';$('loop-reason').textContent='裁剪区域已改变，建议重新寻找循环或手动确认起止。'; }
let dragStart: {x:number;y:number}|undefined;
function pointer(e:PointerEvent) {const r=sourceCanvas.getBoundingClientRect();return{x:clamp((e.clientX-r.left)/r.width,0,1),y:clamp((e.clientY-r.top)/r.height,0,1)};}
sourceCanvas.addEventListener('pointerdown',e=>{if(busy||!frames.length)return;playing=false;$('play-toggle').textContent='▶';$('play-toggle').setAttribute('aria-label','播放预览');stopPreviewRequest();dragStart=pointer(e);sourceCanvas.setPointerCapture(e.pointerId);});
sourceCanvas.addEventListener('pointermove',e=>{if(busy||!frames.length||!dragStart)return;const p=pointer(e);const w=Math.abs(p.x-dragStart.x),h=Math.abs(p.y-dragStart.y);if(w>.01&&h>.01){crop={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),width:w,height:h};syncCropFields();drawSource();}});
const endDrag=()=>{if(dragStart){dragStart=undefined;cropChanged();}};
sourceCanvas.addEventListener('pointerup',endDrag);sourceCanvas.addEventListener('pointercancel',endDrag);
function renderPreview(frame:Frame) {
  let f=frame;if(transparent())f=removeBackground(f,background.color,number('tolerance'));
  draw(previewCanvas,f);
}
input('scrub').addEventListener('input',()=>{
  if(busy||!frames.length)return;
  playing=false;$('play-toggle').textContent='▶';$('play-toggle').setAttribute('aria-label','播放预览');
  refreshPreview();previewCanvas.hidden=false;$('gif-preview').hidden=true;$('preview-label').textContent='原视频高清画面';$('scrub-time').textContent='读取中…';
});
$('play-toggle').addEventListener('click',()=>{if(busy||!frames.length)return;playing=!playing;startedAt=performance.now();refreshPreview();$('play-toggle').textContent=playing?'Ⅱ':'▶';$('play-toggle').setAttribute('aria-label',playing?'暂停预览':'播放预览');if(resultUrl){$('gif-preview').hidden=!playing;previewCanvas.hidden=playing;$('preview-label').textContent=playing?'实际 GIF 预览':'暂停查看 · 原视频高清帧';}});
async function updatePreview(time:number) {
  const revision=++previewRevision,localController=new AbortController();
  previewController=localController;previewInFlight=true;previewDirty=false;
  try {
    const frame=await seekFrame(previewVideo,time,{...crop},Math.min(960,MAX_OUTPUT_SIDE),localController.signal);
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
  requestAnimationFrame(animate);if(busy||!frames.length||!previewUrl||previewFailed||previewInFlight||(resultUrl&&!$('gif-preview').hidden)||document.hidden||now-lastAnimation<125)return;
  lastAnimation=now;
  const start=number('start'),end=number('end');const time=playing ? start+((now-startedAt)/1000)%Math.max(.05,end-start) : number('scrub');
  const bounded=clamp(time,frames[0].time,Math.min(analysisEnd,duration)-.001);
  if(!playing&&!previewDirty&&Math.abs(bounded-lastPreviewTime)<.002)return;
  void updatePreview(bounded);
}
requestAnimationFrame(animate);
$('export').addEventListener('click',()=>void task(async signal=>{
  const start=number('start'),end=number('end'),fps=number('fps'),size=number('size')||MAX_OUTPUT_SIDE;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.005)throw new Error('请设置有效的起点和终点。');
  if(end-start<.01)throw new Error('所选片段太短，请选择至少 0.01 秒的画面。');
  if(end-start>12.005)throw new Error('为控制 iPhone 内存，每次最多导出 12 秒。请缩短起止范围。');
  const count=Math.ceil((end-start)*fps),frameDuration=(end-start)/count;const isTransparent=transparent();const selectedCrop={...crop};const color=background.color;const tolerance=number('tolerance');
  let outputWidth=0,outputHeight=0;
  invalidate();progress('正在生成 GIF…',0);
  async function* exportFrames():AsyncGenerator<GifFrame> {
    for(let i=0;i<count;i++){
      signal.throwIfAborted();const time=start+i*frameDuration;let frame=await seekFrame(video,time,selectedCrop,size,signal);
      outputWidth=frame.width;outputHeight=frame.height;
      if(isTransparent)frame=removeBackground(frame,color,tolerance);
      // Spread the full selected duration across frames; do not emit a sub-10ms remainder.
      yield {...frame,delayMs:frameDuration*1000};
    }
  }
  const blob=await encodeGif(exportFrames(),{signal,onProgress:n=>progress(`正在生成 GIF ${Math.round(n/count*100)}%`,n/count)});
  signal.throwIfAborted();outputFile=new File([blob],`loopcut-${new Date().toISOString().slice(0,10)}.gif`,{type:'image/gif'});resultUrl=URL.createObjectURL(outputFile);
  const img=$<HTMLImageElement>('gif-preview');img.src=resultUrl;img.hidden=false;previewCanvas.hidden=true;
  $('preview-label').textContent='实际 GIF 预览';playing=true;$('play-toggle').textContent='Ⅱ';$('play-toggle').setAttribute('aria-label','暂停预览');
  for(const id of ['download','open-gif'])$<HTMLAnchorElement>(id).href=resultUrl;
  $<HTMLAnchorElement>('download').download=outputFile.name;
  $('result-meta').textContent=`${outputWidth} × ${outputHeight} px · ${(blob.size/1024).toFixed(0)} KB · ${fmt(end-start)} s · ${isTransparent?'透明':'矩形'}`;
  $('result').hidden=false;
  let canShare=false;try{canShare=!!navigator.canShare?.({files:[outputFile]});}catch{/* downloads remain available */}
  $('share-note').textContent=canShare?'点击分享后，由系统面板选择保存或接收应用。完成分享不代表已保存到照片。':'此环境不能分享 GIF 文件。请下载文件或打开 GIF，使用浏览器提供的保存方式。';
  document.querySelectorAll('.steps li').forEach((el,i)=>el.classList.toggle('active',i===2));
  notify(blob.size>1024*1024?'GIF 已生成，文件较大。若微信拒绝，可降低长边尺寸或帧率后重试。':'GIF 已生成。检查预览后，点击分享或下载。');
}));
$('share').addEventListener('click',()=>{
  if(busy||!outputFile||shareBusy)return;
  let canShare=false;try{canShare=!!navigator.share&&!!navigator.canShare?.({files:[outputFile]});}catch{/* Fall back to download when capability probing throws. */}
  if(!canShare){notify('当前浏览器无法分享这个 GIF 文件，请使用下载文件或打开 GIF。');return;}
  // Call directly within the user gesture; never await encoding before sharing.
  shareBusy=true;updateAvailability();
  navigator.share({files:[outputFile]}).then(()=>notify('系统分享操作已完成。请在所选位置确认文件；网页无法确认照片保存结果。')).catch((error:Error)=>notify(error.name==='AbortError'?'已取消分享，GIF 仍保留，可再次分享或下载。':'系统未能分享这个文件，请改用下载文件或打开 GIF。',error.name!=='AbortError')).finally(()=>{shareBusy=false;updateAvailability();});
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPreviewRequest();if(busy){controller?.abort();notify('页面进入后台，已停止处理。回到页面后可重新分析或生成 GIF。');}}else{previewDirty=true;}startedAt=performance.now();});
window.addEventListener('pagehide',()=>{controller?.abort();stopPreviewRequest();});
if('serviceWorker' in navigator && import.meta.env.PROD){
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`,{scope:import.meta.env.BASE_URL}).then(()=>navigator.serviceWorker.ready).then(()=>{$('offline-status').textContent='应用已缓存 · 可离线打开';}).catch(()=>{$('offline-status').textContent='离线缓存不可用 · 需联网打开';});
}
if(!window.isSecureContext)$('offline-status').textContent='当前非 HTTPS · 分享与离线可能不可用';
updateAvailability();
