import { readdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
async function walk(dir){const entries=await readdir(dir,{withFileTypes:true});const out=[];for(const f of entries){const p=path.join(dir,f.name);out.push(...(f.isDirectory()?await walk(p):[p]));}return out;}
const files=(await walk('dist')).filter(p=>!p.endsWith('sw.js')).sort();
const hash=createHash('sha256');for(const p of files)hash.update(await readFile(p));
const version=hash.digest('hex').slice(0,12);
const assets=files.map(p=>'./'+p.replace(/^dist\//,''));
await writeFile('dist/sw.js',`const VERSION=${JSON.stringify(version)};
const SCOPE=new URL(self.registration.scope).pathname;
const PREFIX='loopcut:'+SCOPE+':';
const CACHE=PREFIX+VERSION;
const ASSETS=${JSON.stringify(assets)};
const PRECACHED=new Set(ASSETS.map(asset=>new URL(asset,self.registration.scope).href));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
// No skipWaiting: the next launch updates without interrupting an export.
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys()){if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);}await self.clients.claim();})()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith(SCOPE))return;
if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(async()=>{const cache=await caches.open(CACHE);return cache.match(new URL('./index.html',self.registration.scope),{ignoreVary:true});}));return;}
// Only these immutable app assets may ignore Vary: Origin: preload requests
// omit Origin while crossorigin script/style requests include it. User files
// and arbitrary URLs never enter this cache or receive this matching policy.
event.respondWith((async()=>{const cache=await caches.open(CACHE);const hit=PRECACHED.has(url.href)?await cache.match(event.request,{ignoreVary:true}):undefined;return hit||fetch(event.request);})());
});
`);
await writeFile('dist/.nojekyll','');
console.log('Offline shell built:',version,assets.length,'assets');
