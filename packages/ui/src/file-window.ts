import { loadAsset,assetText,isTextAsset,htmlDocument,markdownDocument,type PreviewRPC } from './preview.js';
import { validateFileTarget,type FileTarget } from './file-target.js';
export interface FileWindowDependencies { target:FileTarget; rpc:PreviewRPC; sandboxURL:string; onTitle?:(title:string)=>void }
/** The selected file takes the whole viewport. No project tabs, controls or
 * workspace state are mounted here. All project HTML stays in the same opaque
 * two-level sandbox as the inline preview; it never gets native-host APIs. */
export function mountFileWindow(root:HTMLElement,deps:FileWindowDependencies):()=>void {
 const doc=root.ownerDocument,win=doc.defaultView!;
 const target=validateFileTarget(deps.target),abort=new AbortController();
 let blob='',alive=true,removeReady:(()=>void)|undefined;
 deps.onTitle?.(target.path.split('/').at(-1)||target.path);
 const status=doc.createElement('p');status.className='file-window-status';status.setAttribute('role','status');status.textContent='Opening file…';root.replaceChildren(status);
 const makeBlob=(bytes:Uint8Array,mime:string)=>{blob=win.URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime}));return blob;};
 const showDocument=(html:string,warnings:string[])=>{
  const frame=doc.createElement('iframe');frame.className='file-window-document';frame.title=target.path;frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
  const ready=(event:MessageEvent)=>{if(alive&&event.source===frame.contentWindow&&event.data?.kind==='miter.preview.ready'){frame.contentWindow?.postMessage({kind:'miter.preview',html},'*');win.removeEventListener('message',ready);}};
  win.addEventListener('message',ready);removeReady=()=>win.removeEventListener('message',ready);
  frame.src=deps.sandboxURL;root.replaceChildren(frame);
  if(warnings.length){const details=doc.createElement('details');details.className='file-window-limits';const summary=doc.createElement('summary');summary.textContent='Preview limitations';details.append(summary);for(const warning of warnings){const p=doc.createElement('p');p.textContent=warning;details.append(p);}root.append(details);}
 };
 void(async()=>{
  try{
   const asset=await loadAsset(deps.rpc,target.workerId,target.path,abort.signal);
   if(!alive)return;
   if(asset.mime==='text/html'){
    const result=await htmlDocument(asset,p=>loadAsset(deps.rpc,target.workerId,p,abort.signal));if(alive)showDocument(result.html,result.warnings);
   }else if(asset.mime==='text/markdown')showDocument(markdownDocument(assetText(asset)),[]);
   else if(asset.mime.startsWith('image/')){const image=doc.createElement('img');image.className='file-window-image';image.alt=target.path;image.src=makeBlob(asset.bytes,asset.mime);image.onerror=()=>{if(alive)statusError('This browser could not decode the image.');};root.replaceChildren(image);}
   else if(asset.mime.startsWith('video/')||asset.mime.startsWith('audio/')){const media=doc.createElement(asset.mime.startsWith('video/')?'video':'audio');media.className='file-window-media';media.controls=true;media.preload='metadata';media.src=makeBlob(asset.bytes,asset.mime);root.replaceChildren(media);}
   else if(asset.mime==='application/pdf'){const pdf=doc.createElement('iframe');pdf.title=target.path;pdf.className='file-window-document';pdf.src=makeBlob(asset.bytes,asset.mime);root.replaceChildren(pdf);}
   else if(isTextAsset(asset)){const pre=doc.createElement('pre');pre.className='file-window-source';pre.tabIndex=0;pre.textContent=assetText(asset);root.replaceChildren(pre);}
   else statusError('This file has no browser preview. Open it with its associated app.');
  }catch(error){if(alive&&!abort.signal.aborted)statusError(error instanceof Error?error.message:String(error));}
 })();
 function statusError(message:string){const p=doc.createElement('p');p.className='file-window-status error';p.setAttribute('role','alert');p.textContent=message;root.replaceChildren(p);}
 return()=>{alive=false;abort.abort();removeReady?.();for(const media of Array.from(root.querySelectorAll('audio,video'))) (media as HTMLMediaElement).pause();root.replaceChildren();if(blob)win.URL.revokeObjectURL(blob);};
}
