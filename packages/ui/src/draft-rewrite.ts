import {REWRITE_MODES,structureLocally,type RewriteRequest} from '../../protocol/src/rewrite.js';
import {enhanceSelect} from './select.js';
export interface DraftRewriteOptions {
 rewrite?(request:RewriteRequest,signal:AbortSignal):Promise<string>;
 busyChanged?(busy:boolean):void;
}
/** Shared visual language and preview/apply semantics with follow-ups. No task
 * create, start, send or executor capability is passed into this component. */
export function mountDraftRewrite(root:HTMLElement,input:HTMLTextAreaElement,options:DraftRewriteOptions){
 const doc=root.ownerDocument;let alive=true,disabled=false,busy=false,controller:AbortController|undefined,original='',result='';
 const toggle=doc.createElement('button');toggle.type='button';toggle.className='rewrite-toggle';toggle.textContent='Rewrite…';toggle.setAttribute('aria-expanded','false');
 const panel=doc.createElement('section');panel.className='rewrite-panel';panel.hidden=true;panel.setAttribute('aria-label','Rewrite new task');
 const fields=doc.createElement('div');fields.className='rewrite-fields';
 function field(title:string,values:[string,string][]){const label=doc.createElement('label');label.className='field';const text=doc.createElement('span');text.textContent=title;const select=doc.createElement('select');select.setAttribute('aria-label',title);for(const [value,name]of values){const option=doc.createElement('option');option.value=value;option.textContent=name;select.append(option);}label.append(text,select);fields.append(label);return select;}
 const mode=field('Rewrite style',Object.entries(REWRITE_MODES).map(([key,v])=>[key,v.label]));
 const provider=field('Rewrite engine',[['chatgpt','ChatGPT · rewrite the wording'],['local','Local · structure instantly']]);
 const privacy=doc.createElement('p');privacy.className='muted small';
 const preview=doc.createElement('textarea');preview.className='rewrite-preview';preview.rows=5;preview.readOnly=true;preview.hidden=true;preview.setAttribute('aria-label','Rewrite preview');
 const status=doc.createElement('p');status.className='followup-status';status.setAttribute('role','status');status.hidden=true;
 const buttons=doc.createElement('div');buttons.className='button-row end';
 const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='Cancel rewrite';
 const generate=doc.createElement('button');generate.type='button';generate.textContent='Preview rewrite';
 const apply=doc.createElement('button');apply.type='button';apply.className='primary';apply.textContent='Apply to draft';apply.hidden=true;
 buttons.append(cancel,generate,apply);panel.append(fields,privacy,preview,buttons);root.append(toggle,panel,status);
 const controls=[enhanceSelect(mode),enhanceSelect(provider)];
 const help=()=>{privacy.textContent=provider.value==='local'?'Adds a local template without an AI model or network request. Your original wording is retained.':'Shares only this draft in a separate ChatGPT chat. Preview and Apply do not create or start a task.';};provider.addEventListener('change',help);help();
 const message=(text:string)=>{status.textContent=text;status.hidden=false;};
 const update=()=>{toggle.disabled=disabled;generate.disabled=disabled||busy;apply.disabled=disabled||busy;generate.textContent=busy?'Rewriting…':'Preview rewrite';};
 const hide=()=>{controller?.abort();panel.hidden=true;toggle.setAttribute('aria-expanded','false');};
 toggle.onclick=()=>{if(panel.hidden){panel.hidden=false;toggle.setAttribute('aria-expanded','true');}else hide();};cancel.onclick=hide;
 generate.onclick=async()=>{
  if(busy||disabled)return;if(!input.value.trim()){message('Enter a task draft before rewriting.');input.focus();return;}
  original=input.value;result='';preview.hidden=true;apply.hidden=true;status.hidden=true;
  controller=new AbortController();const signal=controller.signal;busy=true;options.busyChanged?.(true);update();
  try{
   const request:RewriteRequest={instruction:original,mode:mode.value as RewriteRequest['mode'],provider:provider.value as RewriteRequest['provider']};
   const rewritten=request.provider==='local'?structureLocally(request):await options.rewrite?.(request,signal);
   if(!alive||signal.aborted)return;
   if(typeof rewritten!=='string'||!rewritten.trim()||rewritten.length>4000||rewritten.includes('\0'))throw Error('The rewrite did not return a valid draft.');
   result=rewritten;preview.value=result;preview.hidden=false;apply.hidden=false;message('Preview ready. Apply it to the draft, then start the task when ready.');
  }catch(e){if(alive&&!signal.aborted)message(e instanceof Error?e.message:String(e));}
  finally{busy=false;if(alive){options.busyChanged?.(false);update();}}
 };
 apply.onclick=()=>{
  if(disabled||busy||!result)return;
  if(input.value!==original){message('Your draft changed while rewriting. Rewrite the current draft or copy useful text from the preview.');return;}
  input.value=result;result='';input.dispatchEvent(new Event('input',{bubbles:true}));hide();message('Rewrite applied. No task has been created or started.');input.focus();
 };
 return {get busy(){return busy;},setDisabled(value:boolean){disabled=value;update();},dispose(){alive=false;controller?.abort();for(const c of controls)c.dispose();root.replaceChildren();}};
}
