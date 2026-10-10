/** Local-only, size-bounded preview assembly. Never executes project source in the extension. */
export interface PreviewAsset {path:string;mime:string;size:number;bytes:Uint8Array;stamp:string;}
export type PreviewRPC=<T>(method:string,params:Record<string,unknown>)=>Promise<T>;
const LIMIT=24*1024*1024;
export async function loadAsset(rpc:PreviewRPC,workerId:string,path:string,signal?:AbortSignal):Promise<PreviewAsset>{
 let offset=0,stamp='',mime='',size=0;const chunks:Uint8Array[]=[];
 do{
  signal?.throwIfAborted();
  const r=await rpc<{path:string;mime:string;size:number;offset:number;stamp:string;data:string;eof:boolean}>('worker.asset',{workerId,path,offset,length:192000,...(stamp?{stamp}:{})});
  signal?.throwIfAborted();
  if(r.size>LIMIT||r.offset!==offset||(stamp&&r.stamp!==stamp))throw new Error('The file changed or exceeded the preview limit. Reload the file.');
  stamp=r.stamp;mime=r.mime;size=r.size;
  const binary=atob(r.data),part=Uint8Array.from(binary,c=>c.charCodeAt(0));chunks.push(part);offset+=part.length;
  if(r.eof)break;if(!part.length)throw new Error('Preview stream ended before the file was complete.');
 }while(offset<LIMIT);
 if(offset!==size)throw new Error('Incomplete preview. Reload the file.');
 const bytes=new Uint8Array(size);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}
 return {path,mime,size,bytes,stamp};
}
export const isTextAsset=(a:PreviewAsset)=>a.mime.startsWith('text/')||['application/json','image/svg+xml'].includes(a.mime);
export const assetText=(a:PreviewAsset)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(a.bytes);
export function assetDataURL(a:PreviewAsset){let binary='';for(let i=0;i<a.bytes.length;i+=32768)binary+=String.fromCharCode(...a.bytes.subarray(i,i+32768));return 'data:'+a.mime+';base64,'+btoa(binary);}
export function localDependency(from:string,reference:string):string|undefined{
 const value=reference.trim();if(!value||/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value))return;
 let name:string;try{name=decodeURIComponent(value.split(/[?#]/)[0]!);}catch{return;}
 if(!name||name.includes('\\')||name.includes('\0'))return;
 const parts=name.startsWith('/')?[]:from.split('/').slice(0,-1);
 for(const part of name.split('/')){if(part==='.'||!part)continue;if(part==='..'){if(!parts.length)return;parts.pop();}else parts.push(part);}
 return parts.join('/')||undefined;
}
function escaped(s:string){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export function markdownDocument(source:string){
 const lines=source.replace(/\r\n?/g,'\n').split('\n');let code=false,html='',list=false;
 const inline=(s:string)=>escaped(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
 for(const line of lines){
  if(/^\s*```/.test(line)){if(list){html+='</ul>';list=false;}html+=code?'</code></pre>':'<pre><code>';code=!code;continue;}
  if(code){html+=escaped(line)+'\n';continue;}
  const heading=/^(#{1,6})\s+(.*)$/.exec(line);if(heading){if(list){html+='</ul>';list=false;}html+=`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`;continue;}
  const item=/^\s*[-*+]\s+(.*)$/.exec(line);if(item){if(!list){html+='<ul>';list=true;}html+='<li>'+inline(item[1]!)+'</li>';continue;}
  if(list){html+='</ul>';list=false;}if(line.trim())html+='<p>'+inline(line)+'</p>';
 }
 if(code)html+='</code></pre>';if(list)html+='</ul>';
 return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{font:15px/1.65 system-ui,sans-serif;margin:24px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.3}pre{overflow:auto;padding:14px;border:1px solid #8886;border-radius:5px}code{font-family:ui-monospace,monospace}p{margin:.65em 0}</style>'+html;
}
export async function htmlDocument(asset:PreviewAsset,read:(path:string)=>Promise<PreviewAsset>):Promise<{html:string;warnings:string[]}>{
 const doc=new DOMParser().parseFromString(assetText(asset),'text/html');let used=asset.size,count=0;const warnings:string[]=[],cache=new Map<string,Promise<PreviewAsset>>();
 const dependency=(path:string)=>{let found=cache.get(path);if(!found){found=(async()=>{if(++count>40)throw new Error('Preview contains more than 40 local resources.');const file=await read(path);used+=file.size;if(used>LIMIT)throw new Error('Preview resources exceed 24 MB.');return file;})();cache.set(path,found);}return found;};
 async function css(source:string,path:string):Promise<string>{
  // CSS imports are not fetched implicitly; every local resource is checked by the host.
  if(/@import\b/i.test(source))warnings.push('CSS @import is disabled in the isolated preview.');
  source=source.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;/gi,'');
  const matches=[...source.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)];
  for(const m of matches){const p=localDependency(path,m[1]!);if(!p)continue;try{const a=await dependency(p);source=source.replace(m[0],`url("${assetDataURL(a)}")`);}catch{source=source.replace(m[0],'url("")');warnings.push('Could not preview '+p);}}
  return source;
 }
 doc.querySelectorAll('base,meta[http-equiv],iframe,object,embed').forEach(n=>n.remove());
 for(const n of Array.from(doc.querySelectorAll<HTMLLinkElement>('link'))){
  const path=localDependency(asset.path,n.getAttribute('href')||'');
  if(n.rel==='stylesheet'&&path){try{const a=await dependency(path),style=doc.createElement('style');style.textContent=await css(assetText(a),path);n.replaceWith(style);}catch{warnings.push('Could not load stylesheet '+path);n.remove();}}else n.remove();
 }
 for(const n of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))){
  const path=localDependency(asset.path,n.getAttribute('src')||'');if(!path){warnings.push('External scripts are disabled.');n.remove();continue;}
  try{const a=await dependency(path);n.removeAttribute('src');n.removeAttribute('integrity');n.textContent=assetText(a).replace(/<\/script/gi,'<\\/script');}catch{warnings.push('Could not load script '+path);n.remove();}
 }
 for(const n of Array.from(doc.querySelectorAll<HTMLElement>('img,source,video,audio'))){
  n.removeAttribute('srcset');for(const key of ['src','poster']){const path=localDependency(asset.path,n.getAttribute(key)||'');if(!path)continue;try{n.setAttribute(key,assetDataURL(await dependency(path)));}catch{n.removeAttribute(key);warnings.push('Could not load '+path);}}
 }
 for(const n of Array.from(doc.querySelectorAll<HTMLStyleElement>('style')))n.textContent=await css(n.textContent||'',asset.path);
 // Modules using imports/fetch and apps needing a server remain desktop-run workflows.
 if(doc.querySelector('script[type="module"]'))warnings.push('Module imports and network requests are disabled; use a local dev server for bundled apps.');
 doc.documentElement.setAttribute('data-miter-preview','isolated');
 return {html:'<!doctype html>'+doc.documentElement.outerHTML,warnings:[...new Set(warnings)]};
}
