import type {ReplyPreview} from './reply-recovery.js';
export interface ReplySheetDependencies {
  workerId:string;
  preview(params:{workerId:string;source:'chat'|'clipboard';text?:string}):Promise<ReplyPreview>;
  apply(params:{workerId:string;ticket:string;confirm:true}):Promise<unknown>;
  readClipboard():Promise<string>;
  close():void;
  applied():void;
}
/** Actual production recovery UI. All reply content uses textContent. */
export function mountReplySheet(root:HTMLElement,deps:ReplySheetDependencies):()=>void {
  root.innerHTML=`<div class="reply-sheet">
    <p class="reply-intro">Use the existing JSON reply. Your task, files and turn count stay in place.</p>
    <div class="reply-status" role="status" aria-live="polite"></div>
    <section class="reply-preview" hidden><p class="reply-task"></p><p class="reply-summary"></p><ul class="reply-actions"></ul><p class="muted small">These actions will run locally. Command approvals and file checks still apply.</p></section>
    <details class="reply-paste"><summary>Paste instead</summary><label class="field"><span>Copied Miter JSON</span><textarea class="code-input" rows="5" spellcheck="false" aria-label="Copied Miter JSON"></textarea></label><button type="button" data-reply="validate">Preview pasted reply</button></details>
    <div class="button-row reply-footer"><button type="button" data-reply="clipboard">Use copied reply</button><div class="spacer"></div><button type="button" data-reply="cancel">Cancel</button><button type="button" class="primary" data-reply="apply" disabled>Apply &amp; continue</button></div>
  </div>`;
  const get=<T extends HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const status=get<HTMLDivElement>('.reply-status'),panel=get<HTMLElement>('.reply-preview'),summary=get<HTMLParagraphElement>('.reply-summary'),task=get<HTMLParagraphElement>('.reply-task'),actions=get<HTMLUListElement>('.reply-actions'),paste=get<HTMLTextAreaElement>('textarea');
  const apply=get<HTMLButtonElement>('[data-reply="apply"]'),clip=get<HTMLButtonElement>('[data-reply="clipboard"]'),cancel=get<HTMLButtonElement>('[data-reply="cancel"]'),validate=get<HTMLButtonElement>('[data-reply="validate"]');
  let chosen:ReplyPreview|undefined,working=false,disposed=false,sequence=0;
  const state=(message:string,error=false)=>{status.textContent=message;status.classList.toggle('error',error);};
  const controls=(busy:boolean)=>{working=busy;apply.disabled=busy||!chosen;clip.disabled=busy;validate.disabled=busy;cancel.disabled=busy&&!!chosen;};
  const show=(preview:ReplyPreview)=>{
    chosen=preview;task.textContent=preview.taskName;summary.textContent=preview.summary;
    actions.replaceChildren(...preview.actions.map(label=>{const li=document.createElement('li');li.textContent=label;return li;}));
    panel.hidden=false;
    state(preview.source==='chat'?'Read directly from the linked chat. Review, then continue.':'Read from your clipboard or pasted text. Review, then continue.');
  };
  const read=async(source:'chat'|'clipboard',text?:string)=>{
    const generation=++sequence;chosen=undefined;panel.hidden=true;controls(true);state(source==='chat'?'Reading the code reply…':'Validating the copied reply…');
    try{
      if(source==='clipboard'&&text===undefined)text=await deps.readClipboard();
      const result=await deps.preview({workerId:deps.workerId,source,...(text===undefined?{}:{text})});
      if(!disposed&&generation===sequence)show(result);
    }catch(error){if(!disposed&&generation===sequence)state(error instanceof Error?error.message:String(error),true);}
    finally{if(!disposed&&generation===sequence)controls(false);}
  };
  clip.onclick=()=>{if(!working)void read('clipboard');};
  validate.onclick=()=>{if(!working)void read('clipboard',paste.value);};
  cancel.onclick=()=>{if(!cancel.disabled)deps.close();};
  apply.onclick=()=>{
    if(working||!chosen)return;
    if(Date.now()>chosen.expiresAt){chosen=undefined;controls(false);state('The preview expired. Use copied reply to select it again.',true);return;}
    const ticket=chosen.ticket;controls(true);state('Applying the selected reply…');
    void deps.apply({workerId:deps.workerId,ticket,confirm:true}).then(()=>{if(!disposed)deps.applied();}).catch(error=>{
      if(disposed)return;chosen=undefined;panel.hidden=true;state(error instanceof Error?error.message:String(error),true);controls(false);
    });
  };
  void read('chat');
  return ()=>{disposed=true;sequence++;root.replaceChildren();};
}
