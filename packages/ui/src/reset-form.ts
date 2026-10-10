import type {DataResetState} from '../../bridge/src/data-reset.js';
export function mountResetForm(root:HTMLElement,options:{clear(confirmation:string):Promise<unknown>;close():void}){
 root.innerHTML=`<form class="data-reset-form">
  <p class="notice reset-warning"><strong>This permanently deletes all Miter application data from this computer. Your project folders and project files will not be deleted.</strong></p>
  <p>Removes all project registrations, tasks, goals and build briefs, activity, chat links and receipts, queues, approvals, journals, snapshots, Miter state backups, terminal imports, notification preferences, and model settings.</p>
  <p class="muted small">Applies to this Miter installation and Chrome profile. Running workers, local models, and terminal sessions will stop. Isolated Git worktree files stay in their current folders. ChatGPT conversations, external model files, and your operating system’s shell history are not deleted.</p>
  <label class="field"><span>Type exactly CLEAR to confirm</span><input data-confirm aria-label="Type CLEAR to confirm" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="5"/></label>
  <p class="reset-connection muted small" role="status" hidden>Reconnecting to the reset coordinator. No reset request will be replayed.</p>
  <p class="reset-progress" role="status" aria-live="polite" hidden></p><pre class="reset-failure error" role="alert" hidden></pre>
  <div class="button-row end"><button type="button" data-copy hidden>Copy error details</button><button type="button" data-cancel>Cancel</button><button type="submit" class="danger" data-clear disabled>Clear all Miter data</button></div>
 </form>`;
 const form=root.querySelector('form')!,input=root.querySelector<HTMLInputElement>('[data-confirm]')!,clear=root.querySelector<HTMLButtonElement>('[data-clear]')!,cancel=root.querySelector<HTMLButtonElement>('[data-cancel]')!,progress=root.querySelector<HTMLElement>('.reset-progress')!,error=root.querySelector<HTMLElement>('.reset-failure')!;
 const connection=root.querySelector<HTMLElement>('.reset-connection')!,copy=root.querySelector<HTMLButtonElement>('[data-copy]')!;
 let alive=true,busy=false,connected=true,requestPending=false,state:DataResetState={phase:'idle'};
 const refresh=()=>{busy=requestPending||['stopping','clearing'].includes(state.phase);form.setAttribute('aria-busy',String(busy));clear.disabled=!connected||busy||state.phase==='complete'||input.value!=='CLEAR';input.disabled=busy||state.phase==='complete';cancel.disabled=busy||state.phase!=='idle';clear.textContent=state.phase==='complete'?'Data cleared':state.phase==='failed'?'Retry clearing all data':busy?'Clearing…':'Clear all Miter data';};
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(error.textContent||'');if(alive)copy.textContent='Details copied';}catch{if(alive)copy.textContent='Select and copy the details above';}};
 input.oninput=refresh;cancel.onclick=()=>{if(!cancel.disabled)options.close();};
 function update(next:DataResetState){state=next;copy.hidden=!next.error;copy.textContent='Copy error details';error.hidden=!next.error;error.textContent=next.error||'';progress.hidden=next.phase==='idle';progress.textContent=next.phase==='complete'?'Miter data cleared. Restarting into first-run state…':next.phase==='failed'?'Reset incomplete. Miter stays locked. Resolve the failures below and retry.':next.phase==='clearing'?(next.step==='native'?'All writers stopped. Removing and verifying native application data…':next.step==='commit'?'Verifying both stores and preparing the first-run restart…':'Removing and verifying browser-local data…'):'Stopping workers, terminals, and open views… No native records are deleted until all writers confirm.';refresh();}
 form.onsubmit=async event=>{event.preventDefault();if(clear.disabled)return;requestPending=true;error.hidden=true;copy.hidden=true;refresh();try{await options.clear(input.value);}catch(e){if(alive)update({phase:'failed',error:e instanceof Error?e.message:String(e)});}finally{requestPending=false;if(alive)refresh();}};
 queueMicrotask(()=>{if(alive)input.focus();});
 return {update,setConnected(value:boolean){connected=value;connection.hidden=value;refresh();},dispose(){alive=false;root.replaceChildren();}};
}
