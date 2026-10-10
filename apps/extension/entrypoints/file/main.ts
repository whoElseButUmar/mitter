import {connectResetView} from '../../src/data-view';
import { mountFileWindow } from '../../../../packages/ui/src/file-window';
import { parseFileTarget } from '../../../../packages/ui/src/file-target';
import { FilePreviewClient } from '../../src/file-preview-client';
import './style.css';
const root=document.getElementById('file-root')!;
const client=new FilePreviewClient();
let unmount:(()=>void)|undefined;
try{unmount=mountFileWindow(root,{target:parseFileTarget(location.href),rpc:client.request,sandboxURL:chrome.runtime.getURL('/preview-sandbox.html'),onTitle:title=>{document.title=title;}});}
catch(error){root.setAttribute('role','alert');root.textContent=error instanceof Error?error.message:String(error);}
const reset=connectResetView(state=>{if(state.phase!=='idle')root.textContent=state.phase==='complete'?'Miter data cleared.':state.error||'Miter data reset in progress. This file view has been closed.';},()=>{unmount?.();unmount=undefined;client.close();root.replaceChildren();document.title='Miter · Data reset';});
window.addEventListener('pagehide',()=>{unmount?.();client.close();reset.close();},{once:true});
