import {fileViewerMenu} from '../../../packages/ui/src/file-menu';
import {createEffect,createSignal,onCleanup,onMount,Show,For} from 'solid-js';
import {loadAsset,assetText,isTextAsset,htmlDocument,markdownDocument,type PreviewAsset,type PreviewRPC} from '../../../packages/ui/src/preview';
import {mountSelectionEditor} from '../../../packages/ui/src/selection-editor';
import type {CodeSelection} from '../../../packages/protocol/src/requests';
import {ContextArea} from './ContextArea';
import {MenuButton} from './controls';
import type {MenuItem} from '../../../packages/ui/src/menu';
import {Icon} from './icons';
export type ChangeRequest={id:string;instruction:string;autoStart?:boolean;selection?:CodeSelection};
function SelectedSource(props:{workerId:string;path:string;source:string;hash:string;request:(request:ChangeRequest)=>Promise<unknown>;copy:(s:string)=>Promise<void>}){
 let pre!:HTMLPreElement,editor:ReturnType<typeof mountSelectionEditor>|undefined;
 const [hasSelection,setHasSelection]=createSignal(false);
 const copySelection=()=>{const text=editor?.selection()?.text;if(text)void props.copy(text);};
 onMount(()=>{editor=mountSelectionEditor(pre,{workerId:props.workerId,path:props.path,content:props.source,hash:props.hash,submit:r=>props.request({...r,autoStart:true})});const update=()=>setHasSelection(!!editor?.selection());document.addEventListener('selectionchange',update);onCleanup(()=>{document.removeEventListener('selectionchange',update);editor?.dispose();});});
 return <ContextArea focusable label="Source code actions" items={[
  {id:'change',label:'Change selected code…',shortcut:'Alt+Enter',disabled:!hasSelection(),run:()=>{editor?.open();}},
  {id:'selection',label:'Copy selected code',disabled:!hasSelection(),run:copySelection},
  {id:'source',label:'Copy entire source',run:()=>{void props.copy(props.source);}},
  {id:'select-all',label:'Select all code',run:()=>{const range=document.createRange();range.selectNodeContents(pre);const selection=document.getSelection();selection?.removeAllRanges();selection?.addRange(range);pre.focus();}}
 ]}><pre ref={pre} tabindex="0" class="file-content selectable-source" aria-label={'Source of '+props.path}>{props.source}</pre></ContextArea>;
}
function SandboxedDocument(props:{html:string}){
 let frame!:HTMLIFrameElement;
 onMount(()=>{const send=(e:MessageEvent)=>{if(e.source===frame.contentWindow&&e.data?.kind==='miter.preview.ready')frame.contentWindow?.postMessage({kind:'miter.preview',html:props.html},'*');};window.addEventListener('message',send);onCleanup(()=>window.removeEventListener('message',send));});
 return <iframe ref={frame} title="Rendered file preview" class="rendered-document" src={chrome.runtime.getURL('/preview-sandbox.html')} sandbox="allow-scripts" referrerPolicy="no-referrer"/>;
}
export function FileViewer(props:{workerId:string;path:string;rpc:PreviewRPC;request:(r:ChangeRequest)=>Promise<unknown>;notice:(s:string)=>void;copy:(s:string)=>Promise<void>;success?:(s:string)=>void;openWindow:()=>void}){
 const [asset,setAsset]=createSignal<PreviewAsset>(),[source,setSource]=createSignal(''),[hash,setHash]=createSignal(''),[html,setHTML]=createSignal(''),[url,setURL]=createSignal(''),[mode,setMode]=createSignal('source'),[error,setError]=createSignal(''),[loading,setLoading]=createSignal(true),[warnings,setWarnings]=createSignal<string[]>([]),[reload,setReload]=createSignal(0);
 let generation=0;let controller:AbortController|undefined;let objectURL='';
 function revoke(){if(objectURL)URL.revokeObjectURL(objectURL);objectURL='';}
 createEffect(()=>{
  const id=props.workerId,path=props.path;reload();const current=++generation;controller?.abort();controller=new AbortController();const signal=controller.signal;revoke();setAsset(undefined);setError('');setLoading(true);setHTML('');setSource('');setHash('');setWarnings([]);
  void(async()=>{
   try{
    const a=await loadAsset(props.rpc,id,path,signal);if(current!==generation)return;
    setAsset(a);objectURL=URL.createObjectURL(new Blob([a.bytes as BlobPart],{type:a.mime}));setURL(objectURL);
    if(isTextAsset(a)){
     const text=assetText(a);setSource(text.slice(0,256000));if(text.length>256000)setWarnings(['Source display is limited to 256,000 characters. Copy/open the file in your editor for the full content.']);
     if(text.length<=120000&&a.size<=120000){const digest=await crypto.subtle.digest('SHA-256',a.bytes as BufferSource);if(current!==generation)return;setHash([...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''));}
     if(a.mime==='text/html'){const p=await htmlDocument(a,p=>loadAsset(props.rpc,id,p,signal));if(current!==generation)return;setHTML(p.html);setWarnings(p.warnings);setMode('preview');}
     else if(a.mime==='text/markdown'){setHTML(markdownDocument(text));setMode('preview');}else setMode(a.mime.startsWith('image/')?'preview':'source');
    }else setMode('preview');
   }catch(e){if(!signal.aborted&&current===generation)setError(e instanceof Error?e.message:String(e));}finally{if(current===generation)setLoading(false);}
  })();
 });
 onCleanup(()=>{generation++;controller?.abort();revoke();});
 const open=(application:'finder'|'vscode')=>{void props.rpc('worker.openFile',{workerId:props.workerId,path:props.path,application}).then(()=>props.success?.(application==='finder'?'Revealed file in file manager.':'Opened file in VS Code.')).catch(e=>props.notice(String(e)));};
 const menu=():MenuItem[]=>fileViewerMenu({openWindow:props.openWindow,reveal:()=>open('finder'),openEditor:()=>open('vscode'),copyPath:()=>void props.copy(props.path),copySource:()=>void props.copy(source()),reload:()=>setReload(v=>v+1),hasSource:!!source(),truncated:!!asset()&&asset()!.size>256000});
 return <ContextArea label="File actions" items={menu()} class="file-viewer">
  <div class="file-caption"><span title={props.path}>{props.path}</span><div class="spacer"/>
   <Show when={asset()&&isTextAsset(asset()!)}><button aria-pressed={mode()==='source'} classList={{selected:mode()==='source'}} onClick={()=>setMode('source')}>Source</button></Show>
   <Show when={html()||asset()?.mime.startsWith('image/')||asset()?.mime.startsWith('audio/')||asset()?.mime.startsWith('video/')||asset()?.mime==='application/pdf'}><button aria-pressed={mode()==='preview'} classList={{selected:mode()==='preview'}} onClick={()=>setMode('preview')}>Preview</button></Show>
   <MenuButton label="File" items={menu()}/>
  </div>
  <Show when={loading()}><p class="preview-hint" role="status">Loading file…</p></Show><Show when={error()}><p class="error" role="alert">{error()}</p></Show>
  <Show when={!loading()&&!error()&&asset()}>
   <Show when={mode()==='source'} fallback={<div class="rendered-preview">
    <Show keyed when={html()}>{value=><SandboxedDocument html={value}/>}</Show>
    <Show when={!html()&&asset()!.mime.startsWith('image/')}><img src={url()} alt={props.path}/></Show>
    <Show when={asset()!.mime.startsWith('video/')}><video controls src={url()} preload="metadata"/></Show>
    <Show when={asset()!.mime.startsWith('audio/')}><audio controls src={url()} preload="metadata"/></Show>
    <Show when={asset()!.mime==='application/pdf'}><iframe class="rendered-document" title="PDF preview" src={url()}/><p class="preview-hint">PDF uses Chrome’s viewer. Use File → Open in new window if the embedded viewer is unavailable.</p></Show>
    <Show when={!html()&&!/^(image|audio|video)\//.test(asset()!.mime)&&asset()!.mime!=='application/pdf'}><p class="preview-hint">No rendered preview for this file. Open it in your editor.</p></Show>
    <Show when={warnings().length}><details class="preview-warnings"><summary>Preview limitations ({warnings().length})</summary><For each={warnings()}>{s=><p>{s}</p>}</For></details></Show>
   </div>}>
    <Show keyed when={hash()&&props.workerId+':'+props.path+':'+hash()} fallback={<pre class="file-content" tabindex="0">{source()}</pre>}>{key=><><p class="selection-hint">Select code to request a change. Alt + Enter also opens the request.</p><SelectedSource workerId={props.workerId} path={props.path} source={source()} hash={hash()} request={props.request} copy={props.copy}/></>}</Show>
   </Show>
  </Show>
 </ContextArea>;
}
