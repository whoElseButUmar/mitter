import {REWRITE_MODES,structureLocally,type RewriteRequest} from '../../protocol/src/rewrite.js';
import {enhanceSelect} from './select.js';
export interface FollowupComposerOptions {
  workerId:string;running:boolean;disabled?:boolean;
  send(request:{id:string;instruction:string;autoStart:boolean}):Promise<unknown>;
  steer?(request:{id:string;instruction:string;autoStart:boolean}):Promise<unknown>;
  rewrite?(request:RewriteRequest,signal:AbortSignal):Promise<string>;
}
/** One draft, explicit preview/apply, then a separate Send. Rewriting never calls
 * send/steer and an async result cannot replace a subsequently edited draft. */
export function mountFollowupComposer(root:HTMLElement,options:FollowupComposerOptions){
 const doc=root.ownerDocument;let busy=false,alive=true,key='',id='',rewriting=false,abort:AbortController|undefined,original='',previewText='';
 const form=doc.createElement('form');form.className='followup-composer';
 const label=doc.createElement('label');label.className='followup-label';label.textContent='Follow up';
 const input=doc.createElement('textarea');input.placeholder='What would you like to change next?';input.rows=2;input.maxLength=4000;input.required=true;input.setAttribute('aria-label','Follow-up instruction');label.append(input);
 const footer=doc.createElement('div');footer.className='followup-footer';
 const hint=doc.createElement('small'),send=doc.createElement('button');send.type='submit';send.className='primary';
 const status=doc.createElement('p');status.className='followup-status';status.hidden=true;status.setAttribute('role','status');
 const steer=doc.createElement('button');steer.type='button';steer.className='steer-button';steer.textContent='Steer';steer.title='Stop the pending plan and use this instruction now. Completed work stays.';
 const rewriteToggle=doc.createElement('button');rewriteToggle.type='button';rewriteToggle.textContent='Rewrite…';rewriteToggle.className='rewrite-toggle';rewriteToggle.setAttribute('aria-expanded','false');
 const panel=doc.createElement('section');panel.className='rewrite-panel';panel.hidden=true;panel.setAttribute('aria-label','Rewrite follow-up');
 function selectField(title:string,entries:[string,string][]){const label=doc.createElement('label');label.className='field';const name=doc.createElement('span');name.textContent=title;const select=doc.createElement('select');select.setAttribute('aria-label',title);for(const [value,text] of entries){const option=doc.createElement('option');option.value=value;option.textContent=text;select.append(option);}label.append(name,select);return {label,select};}
 const mode=selectField('Rewrite style',Object.entries(REWRITE_MODES).map(([key,value])=>[key,value.label]));
 const provider=selectField('Rewrite engine',[['chatgpt','ChatGPT · rewrite the wording'],['local','Local · structure instantly']]);
 const fields=doc.createElement('div');fields.className='rewrite-fields';fields.append(mode.label,provider.label);
 const privacy=doc.createElement('p');privacy.className='muted small';
 const preview=doc.createElement('textarea');preview.className='rewrite-preview';preview.rows=5;preview.readOnly=true;preview.hidden=true;preview.setAttribute('aria-label','Rewrite preview');
 const buttons=doc.createElement('div');buttons.className='button-row end';
 const generate=doc.createElement('button');generate.type='button';generate.textContent='Preview rewrite';
 const apply=doc.createElement('button');apply.type='button';apply.className='primary';apply.textContent='Apply to draft';apply.hidden=true;
 const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='Cancel';
 buttons.append(cancel,generate,apply);panel.append(fields,privacy,preview,buttons);
 footer.append(hint,rewriteToggle,steer,send);form.append(label,panel,footer,status);root.append(form);
 const modeControl=enhanceSelect(mode.select),providerControl=enhanceSelect(provider.select);
 const help=()=>{privacy.textContent=provider.select.value==='chatgpt'?'Shares only this draft in a separate ChatGPT chat. The result is a preview; nothing is executed.':'Adds a local instruction template, without an AI model or network request. Your original wording is retained.';};provider.select.addEventListener('change',help);help();
 function update(next:FollowupComposerOptions){if(next.workerId!==options.workerId){abort?.abort();previewText='';preview.hidden=true;apply.hidden=true;}options=next;input.disabled=!!next.disabled||busy;send.disabled=!!next.disabled||busy||rewriting;steer.hidden=!next.steer;steer.disabled=!!next.disabled||busy||rewriting;rewriteToggle.disabled=!!next.disabled||busy;generate.disabled=!!next.disabled||busy||rewriting;generate.textContent=rewriting?'Rewriting…':'Preview rewrite';send.textContent=busy?'Sending…':next.running?'Queue follow-up':'Send';hint.textContent=next.running?(next.steer?'Queue later · Steer now':'Runs after the current work.'):'Same task and chat · up to 15 more turns';}
 const showError=(e:unknown)=>{status.textContent=e instanceof Error?e.message:String(e);status.hidden=false;};
 const hideRewrite=()=>{abort?.abort();panel.hidden=true;rewriteToggle.setAttribute('aria-expanded','false');};
 rewriteToggle.onclick=()=>{if(panel.hidden){panel.hidden=false;rewriteToggle.setAttribute('aria-expanded','true');}else hideRewrite();};cancel.onclick=hideRewrite;
 generate.onclick=async()=>{
   if(rewriting||busy||!input.value.trim()||options.disabled)return;
   original=input.value;previewText='';preview.hidden=true;apply.hidden=true;status.hidden=true;rewriting=true;abort=new AbortController();const controller=abort,workerId=options.workerId;update(options);
   try{const request:RewriteRequest={instruction:original,mode:mode.select.value as RewriteRequest['mode'],provider:provider.select.value as RewriteRequest['provider']};
    const result=request.provider==='local'?structureLocally(request):await options.rewrite?.(request,controller.signal);
    if(!alive||controller.signal.aborted||options.workerId!==workerId)return;
    if(typeof result!=='string'||!result.trim()||result.length>4000)throw Error('The rewrite did not return a valid draft.');
    previewText=result;preview.value=result;preview.hidden=false;apply.hidden=false;status.textContent='Rewrite ready. Apply it to your draft, then Send when ready.';status.hidden=false;
   }catch(e){if(alive&&!controller.signal.aborted)showError(e);}finally{rewriting=false;if(alive)update(options);}
 };
 apply.onclick=()=>{if(input.value!==original){showError(Error('Your draft changed while rewriting. Copy any useful text from the preview or rewrite the current draft.'));return;}if(!previewText)return;input.value=previewText;key='';previewText='';hideRewrite();status.textContent='Rewrite applied to the draft. Nothing has been sent.';status.hidden=false;input.focus();};
 const submit=async(e:Event,kind:'queue'|'steer'='queue')=>{e.preventDefault();if(busy||rewriting||options.disabled||!input.value.trim())return;const instruction=input.value.trim(),requestKey=kind+':'+instruction;if(key!==requestKey){key=requestKey;id=crypto.randomUUID();}busy=true;status.hidden=true;update(options);try{const action=kind==='steer'?options.steer:options.send;if(!action)throw Error('Steering is unavailable.');await action({id,instruction,autoStart:true});if(alive){input.value='';key='';hideRewrite();status.textContent=kind==='steer'?'Steering instruction saved. Continuing from completed work.':'Follow-up saved in this task.';status.hidden=false;}}catch(e){if(alive)showError(e);}finally{busy=false;if(alive)update(options);}};
 const steerClick=(e:Event)=>void submit(e,'steer');steer.addEventListener('click',steerClick);
 const keydown=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();form.requestSubmit();}};
 const changed=()=>{status.hidden=true;};
 form.addEventListener('submit',submit);input.addEventListener('keydown',keydown);input.addEventListener('input',changed);update(options);
 return {update,focus(text?:string){if(text)input.value=text;input.focus();},dispose(){alive=false;abort?.abort();modeControl.dispose();providerControl.dispose();form.removeEventListener('submit',submit);steer.removeEventListener('click',steerClick);input.removeEventListener('keydown',keydown);input.removeEventListener('input',changed);root.replaceChildren();}};
}
