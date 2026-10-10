import { enhanceSelects } from '../../ui/src/select.js';
/** The start sheet uses native DOM controls. Solid owns its mount/lifetime.
 * Keeping this small surface framework-independent also lets browser tests run
 * the exact production interactions without a second mock UI implementation.
 */
export interface ChatChoice {id:number;title:string;url:string;newChat?:boolean}
export interface StartSheetDependencies {
  authorize():Promise<boolean>;
  lastChat():Promise<ChatChoice|null>;
  loadChats():Promise<ChatChoice[]>;
  start(options:{consent:true;newChat:boolean;tabId?:number;maxTurns:number;maxMinutes:number}):Promise<unknown>;
  stop():Promise<unknown>;
  close():void;
  started():void;
}
export function mountStartSheet(root:HTMLElement,deps:StartSheetDependencies):()=>void {
  root.innerHTML=`
    <p class="start-intro">Miter uses an empty chat or opens a fresh one, sends your task, and works through the replies.</p>
    <div class="start-destination"><span class="destination-dot" aria-hidden="true"></span><div><strong data-destination>New ChatGPT chat</strong><span data-destination-hint>A separate conversation for this task.</span></div></div>
    <p class="start-disclosure">Starting authorizes Miter to send this task’s prompts, code excerpts, and command results to ChatGPT until it stops. Commands still need your approval.</p>
    <details class="form-advanced start-options"><summary>Options</summary>
      <label class="field"><span>Conversation</span><select data-chat><option value="new">New ChatGPT chat</option></select></label>
      <button type="button" class="text-button" data-find>Choose an open chat…</button>
      <div class="form-row"><label class="field"><span>Turn limit</span><select data-turns><option value="8">8 turns</option><option value="15" selected>15 turns</option><option value="20">20 turns</option></select></label>
      <label class="field"><span>Time limit</span><select data-minutes><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">60 minutes</option></select></label></div>
      <p class="small muted">Stops for your draft, a different conversation, a decision, or a limit. Browser automation may conflict with the service’s terms. Redaction cannot guarantee privacy.</p>
    </details>
    <p class="error" data-error role="alert" hidden></p>
    <div class="button-row end"><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-start>Start task</button></div>`;
  const get=<T extends HTMLElement>(s:string)=>root.querySelector<T>(s)!;
  const start=get<HTMLButtonElement>('[data-start]'),find=get<HTMLButtonElement>('[data-find]'),chat=get<HTMLSelectElement>('[data-chat]'),error=get<HTMLParagraphElement>('[data-error]');
  const destination=get<HTMLElement>('[data-destination]'),hint=get<HTMLElement>('[data-destination-hint]');
  let alive=true,busy=false,chosenByUser=false;
  const tabs=new Map<number,ChatChoice>();
  const selects=enhanceSelects(root);
  const fail=(e:unknown)=>{if(alive){error.textContent=e instanceof Error?e.message:String(e);error.hidden=false;}};
  const title=()=>chat.value==='new'?'Start task':'Resume task';
  const update=()=>{
    const selected=tabs.get(Number(chat.value));
    destination.textContent=selected?'Existing ChatGPT chat':'New ChatGPT chat';
    hint.textContent=selected?selected.title:'A separate conversation for this task.';
    start.textContent=title();
    selects.refresh();
  };
  const add=(t:ChatChoice)=>{
    tabs.set(t.id,t);let option=Array.from(chat.options).find(o=>o.value===String(t.id));
    if(!option){option=document.createElement('option');option.value=String(t.id);chat.add(option);}
    const short=t.url.split('/c/')[1]?.slice(0,8)||'new';
    option.textContent=`${t.title} · ${short} · tab ${t.id}`;
  };
  const setBusy=(value:boolean)=>{busy=value;start.disabled=value;find.disabled=value;chat.disabled=value;if(!value)start.textContent=title();selects.refresh();};
  chat.addEventListener('change',()=>{chosenByUser=true;update();});
  get('[data-cancel]').addEventListener('click',()=>deps.close());
  find.addEventListener('click',async()=>{
    if(busy)return;setBusy(true);error.hidden=true;find.textContent='Finding chats…';
    try{
      if(!await deps.authorize())throw new Error('ChatGPT access was not granted. Nothing was sent.');
      if(!alive)return;const list=await deps.loadChats();if(!alive)return;
      const selected=chat.value;
      for(const option of Array.from(chat.options))if(option.value!=='new')option.remove();tabs.clear();list.forEach(add);
      if(selected==='new'||list.some(t=>String(t.id)===selected))chat.value=selected;else chat.value='new';
      if(!list.length)fail(new Error('No open chat found. Use a new chat instead.'));update();
    }catch(e){fail(e);}finally{if(alive){setBusy(false);find.textContent='Refresh open chats';}}
  });
  start.addEventListener('click',async()=>{
    if(busy)return;setBusy(true);chosenByUser=true;error.hidden=true;start.textContent='Starting…';
    try{
      // This permission request runs directly from the user's Start click.
      if(!await deps.authorize())throw new Error('ChatGPT access was not granted. Nothing was sent.');
      if(!alive)return;
      const selected=tabs.get(Number(chat.value));
      await deps.start({consent:true,newChat:!selected||selected.newChat===true,...(selected?{tabId:selected.id}:{}),maxTurns:Number(get<HTMLSelectElement>('[data-turns]').value),maxMinutes:Number(get<HTMLSelectElement>('[data-minutes]').value)});
      if(!alive){await deps.stop().catch(()=>{});return;}
      deps.started();deps.close();
    }catch(e){fail(e);}finally{if(alive)setBusy(false);}
  });
  // Remember this task's chat without selecting an unrelated tab or asking for
  // permission on mount. Closing the sheet cancels pending continuations.
  void deps.lastChat().then(t=>{if(!alive||chosenByUser||busy||!t)return;add(t);chat.value=String(t.id);update();}).catch(()=>{});
  return()=>{alive=false;selects.dispose();root.replaceChildren();};
}
