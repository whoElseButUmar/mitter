import { readReplyJSON, isReadOnlyReply, isIncompleteReplyJSON, utf8Bytes, exceedsHandoffBytes, MAX_HANDOFF_BYTES } from '../../protocol/src/reply-json.js';
/** DOM-only adapter with a versioned content-script endpoint. Operations return
 * structured success/error messages; the coordinator never depends on page UI
 * labels as proof that a send happened. See page-transport.ts.
 */
import { decodeRenderedMessage, decodeFlatRenderedMessages, messagePayload, sameMessage, matchesReceipt, parseReceipt, type OutboundReceipt } from './message-wire.js';
export const ASSISTANT_READER_VERSION='logical-pre/4-user-turn/6-discovery/3-code-reply/5-send/2-control/1' as const;
export interface DomRequest {
  op:'control'|'probe'|'reply'|'inspect'|'prepare'|'commit'|'send'|'stop'|'interrupt'; token:string; url:string;
  workerId?:string; projectId?:string; replyId?:string; replyTo?:string;
  text?:string; messageId?:string; composerSession?:string; receipt?:OutboundReceipt; expiresAt:number; allowConversationBind?:boolean; includeHistory?:boolean;
}
/** Diagnostic observations of the newest visible payload, including fragments.
 * These fields never authorize an import or an edit. No source text is logged. */
export interface CodeReadObservation {
  characters:number; fingerprint:string; issue:string;
  replyId?:string; replyTo?:string; incomplete?:boolean;
}
export interface ChatView {
  url:string; count:number; userCount:number; lastRole:string; assistantId:string;
  assistantText:string; lastUserText:string; busy:boolean; complete:boolean;
  draft:boolean; draftText:string; stopped:boolean; renderedDraftText?:string;
  ready?:boolean; readiness?:string; lastUserId?:string; userIds?:string[];
  transcript?:TranscriptStats;
  codeReply?:CodeReply; codeReplyIssue?:string; codeReplyCount?:number;
  codeRead?:CodeReadObservation;
  interruptOutcome?:'requested'|'idle'|'unavailable';
  // Observations only: unlinked code is NEVER promoted into assistantText or
  // imported. The coordinator can request a bounded transport correction.
  unlinkedReply?:CodeReply; codeReplyIds?:string[]; codeReplyTotal?:number;
  // Added only by the coordinator after strict validation / explicit approval.
  replyEvidence?:'exchange'|'user';
  lastUserCollapsed?:boolean; disclosure?:{state:'none'|'available'|'expanded'|'pending'|'unavailable'|'ambiguous';attempts:number};
  lastUserTruncated?:boolean; userReader?:string; lastUserCandidates?:string[]; lastUserReadStats?:UserReadStats; observedTaskTurns?:Array<{workerId:string;projectId:string;count:number}>;
  assistantFormat?:'code'|'plain'|'rendered'; assistantReadIssue?:string;
  assistantReadStats?:AssistantReadStats;
  // Document-local proof allows a lost commit response to be reconciled, never replayed in a new document.
  composerSession?:string; visibility?:'visible'|'hidden'|'prerender';
  outcome?:'pending'|'prepared'|'clicked'|'already_clicked'|'already_sent';
}
export async function chatDom(request:DomRequest):Promise<ChatView> {
  const key='__mitterSessionV4';
  const scope=globalThis as typeof globalThis & {[key:string]:any};
  const fail=(code:string,message:string):never=>{throw Object.assign(new Error(message),{code});};
  const canonical=(raw:string)=>{const u=new URL(raw);return u.origin+u.pathname.replace(/\/$/,'');};
  const conversation=(raw:string)=>{try{const u=new URL(raw);return ['https://chatgpt.com','https://chat.openai.com'].includes(u.origin)&&/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname);}catch{return false;}};
  const normalize=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim();
  const empty=():ChatView=>({url:canonical(location.href),count:0,userCount:0,lastRole:'',assistantId:'',assistantText:'',lastUserText:'',busy:false,complete:false,draft:false,draftText:'',stopped:true,ready:false});
  if(request.op==='interrupt') {
    // Only stop generation in this runner's exact linked document. A stale
    // token, ambiguous control or a navigated tab cannot affect another chat.
    if(scope[key]?.token!==request.token||canonical(location.href)!==canonical(request.url))return {...empty(),interruptOutcome:'unavailable'};
    const controls=generationStopControls();
    if(controls.length===1){controls[0]!.click();return {...empty(),interruptOutcome:'requested'};}
    return {...empty(),interruptOutcome:controls.length?'unavailable':'idle'};
  }
  if(request.op==='stop') {
    if(scope[key]?.token===request.token){scope[key].stopped=true;document.getElementById('mitter-automation-control')?.remove();}
    return empty();
  }
  const current=canonical(location.href),expected=canonical(request.url);
  // Inspection may observe the new conversation while its route is settling.
  // Preparing/committing text still requires exact URL equality below. A route
  // match alone never authorizes adopting or executing a reply: the runner must
  // prove the task's message/IDs. Probe is read-only and cannot adopt a session.
  const locationOK=()=>{
    const here=new URL(location.href),wanted=new URL(request.url);
    if(canonical(location.href)===expected)return true;
    const chatRoute=here.pathname==='/'||/^\/(?:g\/[^/]+\/)?c(?:\/[^?#]*)?\/?$/.test(here.pathname);
    if(request.allowConversationBind===true&&here.origin===wanted.origin&&chatRoute)return true;
    // A reload of a saved /c URL can briefly display the root/loading shell.
    return request.op==='inspect'&&here.origin===wanted.origin&&here.pathname==='/'&&conversation(expected);
  };
  if(!['https://chatgpt.com','https://chat.openai.com'].includes(location.origin))fail('UNSUPPORTED_ORIGIN','This page is not a supported ChatGPT page.');
  if(!locationOK())fail('NAVIGATED',`The linked tab changed conversation. Expected ${expected}; observed ${current}. Nothing was sent.`);
  if(Date.now()>request.expiresAt)fail('SESSION_EXPIRED','The automatic session has reached its time limit.');
  if(request.op==='control'){
    // Independent read-only Pause channel while a previously accepted local
    // batch runs. Never scan the transcript or create/replace a session here.
    const owned=scope[key]?.token===request.token;
    return {...empty(),stopped:owned&&scope[key].stopped===true,ready:owned};
  }
  if(request.op==='reply'){
    const scan=readCodeReply(request.workerId||'',request.projectId||'',request.replyId,request.replyTo);
    const els=pageElements().elements;
    const visible=(el:HTMLElement)=>!contentHidden(el);
    const field=els.find(el=>el.matches('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,[data-testid="composer-input"],form [contenteditable="true"][role="textbox"]')&&visible(el));
    const busy=generationActive();
    const draftText=field?(field instanceof HTMLTextAreaElement?field.value:editableText(field)):'';
    return {...empty(),stopped:false,ready:!!field,busy,draft:!!draftText.trim(),draftText,codeRead:scan.read,codeReply:scan.reply,codeReplyIssue:scan.issue,codeReplyCount:scan.count,unlinkedReply:scan.unlinked,codeReplyIds:scan.ids,codeReplyTotal:scan.total};
  }
  if(request.op==='commit'&&request.composerSession!==undefined&&
     (!scope[key]||scope[key].token!==request.token||scope[key].composerSession!==request.composerSession))
    fail('COMMIT_DOCUMENT_CHANGED','The document that prepared this message is no longer available. Checking the sent message without clicking again.');
  if(request.op!=='probe'&&(!scope[key]||scope[key].token!==request.token)) {
    if(scope[key])scope[key].stopped=true;
    scope[key]={token:request.token,composerSession:crypto.randomUUID(),stopped:false,prepared:null,committed:new Map<string,any>(),reveals:new Map<string,{control:HTMLElement;attempts:number;at:number}>()};
    document.getElementById('mitter-automation-control')?.remove();
    const host=document.createElement('div');host.id='mitter-automation-control';
    Object.assign(host.style,{position:'fixed',bottom:'12px',left:'12px',zIndex:'2147483647'});
    const shadow=host.attachShadow({mode:'closed'}),button=document.createElement('button');
    button.textContent='Miter is working · Pause';button.setAttribute('aria-label','Pause Miter');
    Object.assign(button.style,{font:'12px -apple-system, sans-serif',color:'#f3dbad',background:'linear-gradient(#4c4942,#292825)',border:'1px solid #111',borderRadius:'4px',padding:'8px 12px',boxShadow:'inset 0 1px #777, 0 2px 8px #0007',cursor:'pointer'});
    button.onclick=()=>{scope[key].stopped=true;button.textContent='Mitter stopped';};shadow.append(button);document.documentElement.append(host);
  }
  const state=request.op==='probe'?{stopped:false}:scope[key];
  const check=()=>{if(state.stopped||request.op!=='probe'&&scope[key]!==state)fail('STOPPED','Stopped from the chat page.');if(Date.now()>request.expiresAt)fail('SESSION_EXPIRED','The automatic session expired.');if(!locationOK())fail('NAVIGATED','The chat changed before the operation finished.');};
  const visible=(el:Element|null):el is HTMLElement=>!!el&&el instanceof HTMLElement&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
  const one=(selector:string):HTMLElement|undefined=>pageElements().elements.find(el=>el.matches(selector)&&visible(el));
  const editor=()=>one('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,textarea[data-testid="composer-input"],[contenteditable="true"][data-testid="composer-input"],form [contenteditable="true"][role="textbox"]');
  const editorText=(el:HTMLElement)=>el instanceof HTMLTextAreaElement?el.value:editableText(el);
  const busy=()=>generationActive();
  const sendControl=(input:HTMLElement)=>{
    const form=input.closest('form');
    const candidates:HTMLButtonElement[]=[...pageElements().elements.filter((el):el is HTMLButtonElement=>el instanceof HTMLButtonElement&&el.matches('button[data-testid="send-button"],button#composer-submit-button,button[aria-label="Send prompt"],button[aria-label="Send message"]')), ...Array.from(form?form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'):[])];
    return candidates.find(button=>(!form||form.contains(button))&&visible(button)&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&!/stop|voice|dictat|microphone/i.test(button.getAttribute('aria-label')||''));
  };
  // The fallback is bound to a saved send receipt, not global selectors or
  // arbitrary JSON on the page. Keep the prior verified receipt available while
  // preparing the next message; the new receipt arrives on the next inspect.
  const receivedReceipt=parseReceipt(request.receipt);
  if(request.op==='inspect'&&receivedReceipt)state.discoveryReceipt=receivedReceipt;
  let lastDiscovery:MessageDiscovery|undefined;
  const collect=async():Promise<ChatView>=>{
    let discovery:MessageDiscovery=discoverMessages();
    const receipt=receivedReceipt||parseReceipt(state.discoveryReceipt);
    const direct=request.workerId&&request.projectId?readCodeReply(request.workerId,request.projectId,request.replyId,request.replyTo):undefined;
    // A pending nonce must not disable discovery of its own sent message.
    // Direct, correlated code remains the fast lane; otherwise independently
    // recover the FULL user receipt and its adjacent response. This lets us
    // distinguish a vanished response from an unconfirmed send in roleless UI.
    // The receipt fallback never promotes an unlinked code candidate.
    if(request.op!=='probe'&&receipt&&!request.replyId&&!direct?.reply&&!discovery.stats.scanLimited&&discovery.stats.users===0){
      discovery=await discoverReceiptMessages(receipt,discovery);
      check();
    }
    lastDiscovery=discovery;
    const messages=discovery.messages;
    const last=messages.at(-1),users=messages.filter(el=>messageRole(el)==='user'),user=users.at(-1);
    const assistant=messageRole(last)==='assistant'?last:undefined;
    const body=assistant?.querySelector<HTMLElement>('.markdown')||assistant;
    const extracted:AssistantReadResult=discovery.assistantRead||(body?readAssistantMessage(body):{text:'',format:'plain'});
    const text=extracted.text;
    const userRead=discovery.userRead||(user?readUserMessageVariants(user):undefined);
    const userText=userRead?.texts[0]||'';
    const disclosure=user?messageDisclosure(user,discovery.stats.strategy==='receipt'):{controls:[],collapsed:false};
    const alternatives=userRead?.texts.slice(1).filter(text=>text.length<=160000);
    const streaming=busy();
    const input=editor(),draftText=input?editorText(input).slice(0,160001):'';
    return {composerSession:state.composerSession,visibility:document.visibilityState,codeRead:direct?.read,codeReply:direct?.reply,codeReplyIssue:direct?.issue,codeReplyCount:direct?.count,unlinkedReply:direct?.unlinked,codeReplyIds:direct?.ids,codeReplyTotal:direct?.total,url:canonical(location.href),count:messages.length,userCount:users.length,lastRole:messageRole(last),assistantId:messageIdentity(assistant)||String(messages.length),assistantText:text.slice(0,400001),assistantFormat:extracted.format,assistantReadIssue:extracted.issue,assistantReadStats:extracted.stats,lastUserText:userText.slice(0,160001),lastUserCandidates:alternatives,lastUserId:messageIdentity(user),userIds:users.map(messageIdentity).filter(Boolean).slice(-256),lastUserTruncated:userText.length>160000,userReader:'user-turn/6',lastUserCollapsed:disclosure.collapsed,disclosure:{state:disclosure.collapsed?(disclosure.controls.length===1?'available':disclosure.controls.length>1?'ambiguous':'unavailable'):'none',attempts:0},lastUserReadStats:userRead?.stats,observedTaskTurns:request.includeHistory?countTaskTurns(users):undefined,busy:streaming,complete:!!assistant&&!!text.trim()&&!streaming,draft:!!draftText.trim(),draftText,renderedDraftText:input?(input instanceof HTMLTextAreaElement?input.value:input.innerText).slice(0,160001):'',stopped:!!state.stopped,transcript:discovery.stats,ready:!!input,readiness:input?'ready':document.readyState==='loading'?'loading':'composer_missing'};
  };
  check();
  if(request.op==='probe')return collect(); // Probe is read-only, including disclosure UI.
  if(request.op==='inspect'){
    let view=await collect();
    const receipt=parseReceipt(request.receipt);
    // Only expand the latest USER message of the explicitly connected task.
    // This reveals presentation; it does NOT send, acknowledge, import, accept
    // partial content, or touch an assistant's controls. Full receipt checks
    // still run in the coordinator after expansion (including after a restart).
    if(receipt&&!request.replyId&&view.lastUserCollapsed&&!view.draft&&(!request.replyTo||!!view.transcript?.users)){
      const variants=[view.lastUserText,...(view.lastUserCandidates||[])];
      const exact=(await Promise.all(variants.map(text=>matchesReceipt(text,receipt)))).some(Boolean);
      check();
      if(!exact){
        const user=lastDiscovery?.messages.filter(el=>messageRole(el)==='user').at(-1);
        const belongs=!!user&&(!!receipt.acknowledgedUserId&&messageIdentity(user)===receipt.acknowledgedUserId||
          variants.some(text=>!!receipt.exchangeId&&text.includes(receipt.exchangeId)||text.includes('You are collaborating with Mitter,')));
        if(user&&belongs&&messageIdentity(user)===(view.lastUserId||'')&&readUserMessageVariants(user).texts[0]===view.lastUserText){
          const currentDisclosure=messageDisclosure(user,lastDiscovery?.stats.strategy==='receipt');
          const identity=messageIdentity(user)||receipt.messageId||receipt.exchangeId||receipt.textHash;
          const reveals:Map<string,{control:HTMLElement;attempts:number;at:number}>=state.reveals??(state.reveals=new Map());
          const prior=reveals.get(identity);
          if(currentDisclosure.controls.length===1){
            const control=currentDisclosure.controls[0]!;
            // One click per DOM control, at most three replacements. A slow
            // hydration must not toggle the same control closed again.
            if((!prior||prior.control!==control&&prior.attempts<3&&Date.now()-prior.at>=500)&&
               control.isConnected&&!contentHidden(control)){
              check();
              reveals.set(identity,{control,attempts:(prior?.attempts??0)+1,at:Date.now()});
              while(reveals.size>24)reveals.delete(reveals.keys().next().value!);
              control.click();
              // Return promptly: asynchronous content can finish on a later
              // read. Never block Stop or run a speculative second click.
              // No page timer: hidden tabs may defer it for a minute. The next
              // background inspection will observe asynchronous expansion.
              check();
              view=await collect();
              view.disclosure={state:view.lastUserCollapsed?'pending':'expanded',attempts:reveals.get(identity)!.attempts};
            }else view.disclosure={state:'pending',attempts:prior?.attempts??0};
          }
        }
      }
    }
    return view;
  }
  const text=request.text,messageId=request.messageId||'legacy-'+request.token;
  if(typeof text!=='string'||!text.trim()||text.length>160000)fail('INVALID_MESSAGE','The outgoing message is empty or too large.');
  const desired=text as string;
  const prior=state.committed.get(messageId);
  if(prior){if(prior.text!==desired)fail('MESSAGE_CONFLICT','A send ID was reused with different content.');return {...await collect(),outcome:'already_clicked'};}
  if(request.op==='prepare'||request.op==='send') {
    if(canonical(location.href)!==expected)fail('NAVIGATED','The conversation changed before preparing the task. No text was changed.');
    // Each request does bounded work, then yields to the BACKGROUND scheduler.
    // No readiness timer or animation frame runs in a hidden chat document.
    const before=await collect();check();
    const prepared=state.prepared?.id===messageId?state.prepared:undefined;
    if(prepared&&prepared.text!==desired)fail('MESSAGE_CONFLICT','A prepared message ID was reused with different content.');
    if(prepared){
      const changed=before.userCount>prepared.userCount||before.lastUserText!==prepared.lastUserText||!!before.lastUserId&&before.lastUserId!==prepared.lastUserId;
      if(!before.draft&&changed&&(sameMessage(before.lastUserText,desired)||typeof prepared.renderedText==='string'&&sameMessage(before.lastUserText,prepared.renderedText))){
        state.committed.set(messageId,{text:desired,time:Date.now()});
        return {...before,outcome:'already_sent'};
      }
      if(before.lastUserText!==prepared.lastUserText||before.lastUserId&&prepared.lastUserId&&before.lastUserId!==prepared.lastUserId)
        fail('USER_TURN_CHANGED','A user message changed during preparation. The draft was left untouched.');
    }
    if(before.busy)return {...before,outcome:'pending',readiness:'generating'};
    const input=editor();if(!input)fail('COMPOSER_MISSING','ChatGPT’s composer is not ready. Check that you are signed in.');
    const field=input!;
    if(normalize(editorText(field))&&normalize(editorText(field))!==normalize(desired))fail('DRAFT_CONFLICT','Your draft is safe. Send or move it before resuming Mitter.');
    if(!normalize(editorText(field))) {
      // An empty field AFTER a verified insertion could mean a manual send or
      // deletion. Never refill it merely because the echo is not visible yet.
      if(prepared)fail('DRAFT_CHANGED','The prepared draft was cleared. Checking it requires your review; nothing was inserted again.');
      field.focus();check();
      if(field instanceof HTMLTextAreaElement){
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,desired);
        field.dispatchEvent(new Event('input',{bubbles:true}));
      }else{
        const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(field);selection?.removeAllRanges();selection?.addRange(range);
        if(!document.execCommand('insertText',false,desired))fail('INSERT_REJECTED','ChatGPT did not accept the task text. Nothing was sent.');
        field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:desired}));
      }
    }
    check();
    if(canonical(location.href)!==expected)fail('NAVIGATED','The conversation changed during preparation. The draft was left untouched.');
    const fresh=editor();
    if(!fresh)fail('EDITOR_REPLACED','ChatGPT replaced its editor while preparing the task. Your draft was left in place.');
    if(normalize(editorText(fresh!))!==normalize(desired))fail('DRAFT_CHANGED','The draft changed before sending. Miter left it untouched.');
    const observed=await collect();check();
    if(!prepared)state.prepared={id:messageId,text:desired,renderedText:observed.renderedDraftText,userCount:before.userCount,lastUserText:before.lastUserText,lastUserId:before.lastUserId};
    if(!sendControl(fresh!))return {...observed,outcome:'pending',readiness:'send_not_ready'};
    if(request.op==='prepare')return {...observed,outcome:'prepared'};
  }
  check();
  if(state.prepared?.id!==messageId||state.prepared.text!==desired)fail('NOT_PREPARED','The task was not prepared in this page. No send was attempted.');
  const before=await collect();check();
  // If the user sent our prepared text themselves, observe it instead of clicking again.
  if(!before.draft&&(before.userCount>state.prepared.userCount||before.lastUserText!==state.prepared.lastUserText||!!before.lastUserId&&before.lastUserId!==state.prepared.lastUserId)&&(sameMessage(before.lastUserText,desired)||typeof state.prepared.renderedText==='string'&&sameMessage(before.lastUserText,state.prepared.renderedText)))return {...before,outcome:'already_sent'};
  if(before.lastUserText!==state.prepared.lastUserText||before.lastUserId&&state.prepared.lastUserId&&before.lastUserId!==state.prepared.lastUserId)fail('USER_TURN_CHANGED','The chat changed while the message was being prepared. The draft is safe; nothing was sent.');
  if(canonical(location.href)!==expected)fail('NAVIGATED','The conversation changed before sending. No send was attempted.');
  if(before.busy)return {...before,outcome:'pending',readiness:'generating'};
  const input=editor();
  if(!input||normalize(editorText(input))!==normalize(desired))fail('DRAFT_CHANGED','The draft changed before sending. Mitter did not click Send.');
  const send=sendControl(input!);if(!send)return {...before,outcome:'pending',readiness:'send_not_ready'};
  check();
  state.committed.set(messageId,{text:desired,time:Date.now()});
  while(state.committed.size>20)state.committed.delete(state.committed.keys().next().value);
  // Record before clicking, then return immediately. A navigation cannot cause a
  // second click. Observing the actual user message is the background's next step.
  send!.click();
  return {...before,outcome:'clicked'};
}

/** innerText is a layout API: Chromium adds an extra newline around an empty
 * block after insertText. Serialize the editor's logical lines instead. This
 * does not collapse spaces or blank lines in the actual task/code. */
export function editableText(root:HTMLElement):string {
  const blocks=new Set(['DIV','P','LI','PRE','BLOCKQUOTE','H1','H2','H3','H4','H5','H6']);
  const read=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return node.nodeValue||'';
    if(!(node instanceof HTMLElement))return '';
    if(node.tagName==='BR')return node.classList.contains('ProseMirror-trailingBreak')?'':'\n';
    const children=Array.from(node.childNodes).filter(child=>!(child instanceof HTMLElement&&child.classList.contains('ProseMirror-trailingBreak')));
    if(children.length===1&&children[0] instanceof HTMLElement&&children[0].tagName==='BR')return '';
    let output='',previousBlock=false,seen=false;
    for(const child of children){
      const block=child instanceof HTMLElement&&blocks.has(child.tagName);
      if(seen&&(previousBlock||block))output+='\n';
      output+=read(child);previousBlock=block;seen=true;
    }
    return output;
  };
  return read(root);
}


/** Structural diagnostics only: never include HTML, message bodies or file paths. */
export interface AssistantReadStats {
  extractor:typeof ASSISTANT_READER_VERSION;
  preElements:number;
  visiblePreElements:number;
  nestedWrappers:number;
  ignoredHiddenBlocks:number;
  emptyBlocks:number;
  logicalBlocks:number;
  payloadCharacters:number[];
}
export interface AssistantReadResult {
  text:string;format:'code'|'plain'|'rendered';issue?:string;stats?:AssistantReadStats;
  /** Internal DOM pointer; never included in ChatView or sent to the host. */
  source?:HTMLElement;
}

/** Read one logical fenced payload, not one HTML PRE element.
 * A code component may use an outer PRE for its toolbar and an inner PRE for
 * its highlighter. Ancestor/descendant wrappers are not separate proposals.
 * Distinct sibling payloads remain ambiguous, even when their text is equal.
 * Nothing here repairs JSON or reconstructs source from rendered Markdown.
 */
export function readAssistantMessage(body:HTMLElement):AssistantReadResult {
  const allPre=[...(body.tagName==='PRE'?[body]:[]),...Array.from(body.querySelectorAll<HTMLElement>('pre'))];
  const hiddenCache=new Map<Element,boolean>();
  const hidden=(element:Element):boolean=>{
    const cached=hiddenCache.get(element);if(cached!==undefined)return cached;
    let absent=false;
    // Do not use viewport intersection: offscreen/horizontally scrolled code
    // is still content. aria-hidden alone is not visual hiding either.
    const ownStyle=getComputedStyle(element);
    if(ownStyle.visibility==='hidden'||ownStyle.visibility==='collapse')absent=true;
    for(let node:Element|null=element;node&&!absent;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.display==='none'||style.contentVisibility==='hidden')absent=true;
    }
    hiddenCache.set(element,absent);return absent;
  };
  const visiblePre=allPre.filter(node=>!hidden(node));
  // Only leaf PREs can be payloads. Keep each sibling leaf separate, including
  // siblings under the same outer PRE; never select the first/last arbitrarily.
  const leaves=visiblePre.filter(node=>!visiblePre.some(other=>other!==node&&node.contains(other)));
  const candidates:Array<{source:HTMLElement;text:string}>=[];
  let emptyBlocks=0;
  for(const pre of leaves){
    const allCodes=Array.from(pre.querySelectorAll<HTMLElement>('code'));
    const codes=allCodes.filter(node=>!hidden(node));
    if(allCodes.length&&!codes.length){emptyBlocks++;continue;}
    const roots=codes.filter(node=>!codes.some(other=>other!==node&&other.contains(node)));
    const sources=roots.length?roots:[pre];
    for(const source of sources){
      // textContent preserves backticks, escapes and whitespace; innerText
      // measures layout and must never supply code that will be written to disk.
      const text=source.textContent||'';
      if(text.trim())candidates.push({source,text});else emptyBlocks++;
    }
  }
  // Some fenced highlighters use a block CODE inside a DIV, without PRE.
  // Inline Markdown CODE is still rejected. This changes only container
  // discovery: payload bytes always come from textContent, never reconstructed
  // from visible prose, an editor model, the clipboard or private app state.
  if(!allPre.length){
    const codes=Array.from(body.querySelectorAll<HTMLElement>('code')).filter(node=>!hidden(node));
    for(const source of codes.filter(node=>!codes.some(other=>other!==node&&other.contains(node)))){
      const style=getComputedStyle(source);
      const block=source.matches('[class*="language-"]')||!!source.closest('[data-testid="code-block"],.code-block')||
        (['block','flex','grid'].includes(style.display)&&/^pre/.test(style.whiteSpace));
      if(!block)continue;
      const text=source.textContent||'';if(text.trim())candidates.push({source,text});else emptyBlocks++;
    }
  }
  const stats:AssistantReadStats={extractor:ASSISTANT_READER_VERSION,preElements:allPre.length,
    visiblePreElements:visiblePre.length,nestedWrappers:visiblePre.length-leaves.length,
    ignoredHiddenBlocks:allPre.length-visiblePre.length,emptyBlocks,
    logicalBlocks:candidates.length,payloadCharacters:candidates.slice(0,8).map(c=>c.text.length)};
  const rejected=(issue:string):AssistantReadResult=>({text:body.innerText||body.textContent||'',format:'rendered',issue,stats});
  if(candidates.length>1)return rejected('MULTIPLE_BLOCKS');
  if(candidates.length===1){
    const {source,text}=candidates[0]!;
    // Inspect residual text in the ORIGINAL tree so ancestor CSS visibility is
    // meaningful. Removing an entire outer PRE would hide surrounding prose.
    const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
    let rest='';
    while(walker.nextNode()){
      const node=walker.currentNode,parent=node.parentElement;
      if(source.contains(node)||!parent||hidden(parent))continue;
      if(parent.closest('button,[role="button"],svg,script,style,template,[aria-hidden="true"]'))continue;
      const label=parent.closest<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]');
      if(label&&headingRole(label)&&!label.closest('pre,code,.markdown,[data-message-content]'))continue;
      rest+=node.nodeValue||'';
    }
    rest=rest.trim();
    // Permit the code-language label, not arbitrary prose or another proposal.
    if(rest&&!/^(json|application\/json)$/i.test(rest))return {...rejected('EXTRA_CONTENT'),source};
    return {text,format:'code',stats,source};
  }
  if(allPre.length)return rejected(visiblePre.length?'EMPTY_CODE_BLOCK':'CODE_NOT_VISIBLE');
  const text=body.innerText||body.textContent||'';
  if(body.querySelector('code,em,strong,del,s,a,table,ul,ol,blockquote'))return {text,format:'rendered',issue:'MARKDOWN_TRANSFORMED',stats};
  const plain=readPlainReplyText(body);
  return {text:plain.text,format:plain.issue?'rendered':'plain',issue:plain.issue,stats,source:body};
}

/** Plain JSON is read from text nodes, not innerText (which collapses string
 * whitespace). Only layout separators OUTSIDE strings may be reconstructed.
 * A paragraph/BR inside a quoted value is ambiguous and requires fenced code.
 * This reader does not turn Markdown markup back into source characters.
 */
function readPlainReplyText(body:HTMLElement):{text:string;issue?:string} {
  let text='',quoted=false,escaped=false,issue:string|undefined;
  const append=(value:string)=>{
    if(utf8Bytes(text)+utf8Bytes(value)>MAX_HANDOFF_BYTES){issue='PAYLOAD_TOO_LARGE';return;}
    text+=value;
    for(const c of value){
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;
    }
  };
  const separator=()=>{
    if(!text||text.endsWith('\n'))return;
    if(quoted){issue='PLAIN_STRING_LAYOUT';return;}
    append('\n');
  };
  const walk=(node:Node)=>{
    if(issue)return;
    if(node.nodeType===Node.TEXT_NODE){append(node.nodeValue||'');return;}
    if(!(node instanceof HTMLElement))return;
    if(node.matches('button,[role="button"],svg,script,style,template,[data-mitter-ui],#mitter-automation-control'))return;
    if(contentHidden(node)){if(node.textContent?.trim())issue='PLAIN_HIDDEN_CONTENT';return;}
    const block=node!==body&&node.matches('p,div,section,article,br');
    if(block)separator();
    for(const child of Array.from(node.childNodes))walk(child);
    if(block)separator();
  };
  walk(body);return {text,issue};
}


/** Visibility is about CSS, not intersection with the scroll viewport. An older
 * message scrolled offscreen may still be a real message; a hidden mirror is not.
 */
function contentHidden(el:Element):boolean {
  const own=getComputedStyle(el);
  if(own.visibility==='hidden'||own.visibility==='collapse')return true;
  for(let n:Element|null=el;n;n=parentAcrossShadow(n)){const s=getComputedStyle(n);if(n.hasAttribute('hidden')||s.display==='none'||s.contentVisibility==='hidden')return true;}
  return false;
}
/** Message discovery is intentionally separate from reading a message's text.
 * A successful script handshake is NOT proof that a transcript was found.
 * Attribute variants are combined per turn, never guessed from code contents
 * or alternating positions. Unknown turn containers remain barriers, so a
 * human message cannot disappear between a confirmed send and a reply.
 */
type MessageRole='user'|'assistant'|'unknown'|'';
let discoveredRoles=new WeakMap<HTMLElement,MessageRole>();
let receiptIdentities=new WeakMap<HTMLElement,string>();
const roleAttributes=['data-message-author-role','data-turn','data-message-role','data-author-role','data-role'] as const;
const turnSelector='article[data-testid^="conversation-turn"],article[data-turn],article[data-turn-id],[data-message-id],[data-turn-id],[data-testid^="conversation-turn-"]';
const roleSelector=roleAttributes.map(a=>'['+a+']').join(',')+',[data-testid="user-message"],[data-testid="assistant-message"],[data-testid="user-message-content"],[data-testid="assistant-message-content"]';
export interface TranscriptStats {
  version:'message-discovery/1'|'message-discovery/2'; state:'ready'|'empty'|'unrecognized'|'partial';
  roleAttributes:number; alternativeRoles:number; semanticRoles:number;
  turnContainers:number; unknownTurns:number; unclassifiedTail:boolean; users:number; assistants:number;
  codeBlocks:number; openShadowRoots:number; frames:number; scanLimited:boolean;
  strategy?:'attributes'|'receipt'; receiptDiscovery?:ReceiptDiscoveryStats;
  // Tag/attribute names only, never class values, IDs, labels or message text.
  codeAncestry?:Array<Array<{tag:string;attributes:string[]}>>;
}
function parentAcrossShadow(element:Element):Element|null {
  if(element.parentElement)return element.parentElement;
  const root=element.getRootNode();return root instanceof ShadowRoot?root.host:null;
}
/** A bounded, read-only composed-tree scan. Open shadow roots are inspectable;
 * closed roots and iframe documents are not bypassed. No page-private state,
 * network requests, clipboard reads, or executable source are involved.
 */
function pageElements():{elements:HTMLElement[];shadows:number;limited:boolean} {
  const elements:HTMLElement[]=[],stack:Element[]=[];let shadows=0,limited=false;
  if(document.documentElement)stack.push(document.documentElement);
  while(stack.length){
    const el=stack.pop()!;
    if(elements.length>=24000){limited=true;break;}
    if(el instanceof HTMLElement)elements.push(el);
    if(el.matches('script,style,template,svg,iframe,pre,code,#mitter-automation-control,[data-mitter-ui]'))continue;
    const shadow=el.shadowRoot;
    if(shadow){
      if(shadows>=24){limited=true;continue;}
      shadows++;stack.push(...Array.from(shadow.children).reverse());
    }else stack.push(...Array.from(el.children).reverse());
  }
  return {elements,shadows,limited};
}
function transcriptExcluded(el:HTMLElement):boolean {
  for(let p:Element|null=el;p;p=parentAcrossShadow(p)){
    if(p.matches('form,nav,aside,[role="navigation"],[role="dialog"],dialog,textarea,[contenteditable="true"],pre,code,script,style,template,#mitter-automation-control,[data-mitter-ui]'))return true;
  }
  return contentHidden(el);
}
function explicitRole(el:HTMLElement):MessageRole {
  const found=new Set<MessageRole>();
  for(const attribute of roleAttributes){const value=el.getAttribute(attribute)?.toLowerCase();if(value==='user'||value==='assistant')found.add(value);}
  const test=el.getAttribute('data-testid');
  if(test==='user-message'||test==='user-message-content')found.add('user');
  if(test==='assistant-message'||test==='assistant-message-content')found.add('assistant');
  return found.size===1?[...found][0]!:found.size>1?'unknown':'';
}
function headingRole(el:HTMLElement):MessageRole {
  if(!el.matches('h1,h2,h3,h4,h5,h6,[role="heading"]'))return '';
  const text=(el.textContent||'').replace(/\s+/g,' ').trim();
  if(/^(?:You said|You|Vous avez dit|Tú dijiste|Has dicho|Du hast gesagt|Você disse|أنت قلت|قلت)[：:]?$/i.test(text))return 'user';
  if(/^(?:ChatGPT said|ChatGPT|Assistant|ChatGPT a dit|ChatGPT dijo|ChatGPT hat gesagt|ChatGPT disse|قال ChatGPT)[：:]?$/i.test(text))return 'assistant';
  return '';
}
export function messageRole(el:HTMLElement|undefined):MessageRole {return el?(discoveredRoles.get(el)||explicitRole(el)):'';}
export function messageIdentity(el:HTMLElement|undefined):string {
  if(el&&receiptIdentities.has(el))return receiptIdentities.get(el)!;
  for(let node:Element|null=el||null;node;node=parentAcrossShadow(node)){
    const value=node.getAttribute('data-message-id')||node.getAttribute('data-turn-id');
    if(value&&value.length<=200)return value;
    if(node.matches('main,body,html,[role="main"]'))break;
  }
  // A turn's DOM id is more useful than a shifting transcript array index.
  return el?.id&&el.id.length<=200?el.id:'';
}
export function discoverMessages():{messages:HTMLElement[];stats:TranscriptStats} {
  const scan=pageElements();
  const eligible=scan.elements.filter(el=>el.matches(roleSelector+',article,'+turnSelector)&&!transcriptExcluded(el));
  const candidates=new Map<HTMLElement,MessageRole>();let explicit=0,alternative=0,semantic=0;
  for(const el of eligible){
    const role=explicitRole(el);
    if(role){candidates.set(el,role);if(el.hasAttribute('data-message-author-role'))explicit++;else alternative++;}
  }
  const containers=eligible.filter(el=>el.matches(turnSelector)||el.tagName==='ARTICLE');
  for(const el of containers){
    if(candidates.has(el))continue;
    // Only the outer turn heading is role metadata; headings embedded inside
    // the message/code are ordinary content and never relabel a message.
    const heading=Array.from(el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]')).find(h=>
      !h.closest('pre,code,.markdown,[data-message-content]')&&
      h.closest('article,[data-testid^="conversation-turn-"]')===el);
    const role=heading?headingRole(heading):'';
    if(role){candidates.set(el,role);semantic++;}
  }
  const nodes=[...candidates.keys()];
  const leaves=nodes.filter(el=>!nodes.some(other=>other!==el&&el.contains(other)));
  const roots=leaves.map(leaf=>{
    const role=candidates.get(leaf)!;let root=leaf;
    for(let parent=leaf.parentElement;parent;parent=parent.parentElement){
      if(!candidates.has(parent))continue;
      const outer=candidates.get(parent),outerId=messageIdentity(parent),innerId=messageIdentity(root);
      if(outer!==role){candidates.set(leaf,'unknown');break;}
      if(leaves.filter(node=>parent.contains(node)).length!==1||outerId&&innerId&&outerId!==innerId)break;
      root=parent;
    }
    return {root,role:candidates.get(leaf)!};
  });
  const messages:HTMLElement[]=[];
  for(const {root,role} of roots){discoveredRoles.set(root,role);if(!messages.includes(root))messages.push(root);}
  // Preserve unclassified turn containers as barriers, rather than ignoring a
  // human intervention simply because its renderer has unfamiliar attributes.
  for(const el of containers){
    const peer=messages.some(m=>(m.closest('article')||m).parentElement===el.parentElement);
    if(!(el.matches(turnSelector)||el.tagName==='ARTICLE'&&peer)||messages.some(m=>m===el||m.contains(el)||el.contains(m)))continue;
    if(containers.some(child=>child!==el&&el.contains(child)&&child.matches(turnSelector)))continue;
    if(!(el.textContent||'').trim())continue;
    discoveredRoles.set(el,'unknown');messages.push(el);
  }
  const order=new Map(scan.elements.map((el,i)=>[el,i]));messages.sort((a,b)=>order.get(a)!-order.get(b)!);
  const users=messages.filter(el=>messageRole(el)==='user').length,assistants=messages.filter(el=>messageRole(el)==='assistant').length;
  const unknown=messages.filter(el=>messageRole(el)==='unknown').length;
  const codeBlocks=scan.elements.filter(el=>el.tagName==='PRE'&&!el.closest('form,nav,aside,[data-mitter-ui]')&&!contentHidden(el)).length;
  const stats:TranscriptStats={version:'message-discovery/1',state:scan.limited?'partial':users+assistants?'ready':unknown||containers.length||codeBlocks?'unrecognized':'empty',
    roleAttributes:explicit,alternativeRoles:alternative,semanticRoles:semantic,turnContainers:containers.length,unknownTurns:unknown,unclassifiedTail:messages.some((el,i)=>messageRole(el)==='unknown'&&i>messages.findLastIndex(m=>messageRole(m)==='user')),users,assistants,codeBlocks,
    openShadowRoots:scan.shadows,frames:scan.elements.filter(el=>el.tagName==='IFRAME').length,scanLimited:scan.limited};
  return {messages,stats};
}
export function logicalMessages():HTMLElement[] {return discoverMessages().messages;}

/** A narrow presentation-only disclosure detector. Never click Copy, Edit,
 * Regenerate, Send, a link, an assistant control, or a button embedded in code.
 * We do not synthesize shortcuts or invoke private page endpoints.
 */
export function messageDisclosure(message:HTMLElement,bounded=false):{controls:HTMLElement[];collapsed:boolean} {
  let root=message;
  // Some renderers put Show more next to the role node rather than inside it.
  // Climb only within a container that holds exactly this user message.
  for(let p=message.parentElement,depth=0;!bounded&&p&&depth<5;p=p.parentElement,depth++){
    if(['MAIN','BODY','HTML','FORM'].includes(p.tagName))break;
    const roles=Array.from(p.querySelectorAll<HTMLElement>(roleSelector)).filter(el=>!contentHidden(el));
    if(roles.some(el=>messageRole(el)==='assistant'||
      messageRole(el)==='user'&&!message.contains(el)&&!el.contains(message)))break;
    root=p;
    if(p.matches('article,[data-testid^="conversation-turn-"]'))break;
  }
  const more=/^(?:show more|read more|expand(?: (?:message|text))?|view (?:full|entire) message|afficher (?:plus|la suite)|voir plus|mostrar m[aá]s|ver m[aá]s|mehr anzeigen|mostrar mais|عرض المزيد)(?:[.\u2026]*)$/i;
  const disclosures=Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"],summary')).filter(el=>{
    if(contentHidden(el)||el.closest('pre,code')||el.getAttribute('aria-expanded')==='true'||
       el.closest('[data-message-author-role="assistant"]'))return false;
    const copy=el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('svg,[aria-hidden="true"]').forEach(icon=>icon.remove());
    const label=(el.getAttribute('aria-label')||copy.textContent||'').replace(/\s+/g,' ').trim();
    if(!more.test(label))return false;
    if(el.tagName==='SUMMARY'&&(!(el.parentElement instanceof HTMLDetailsElement)||el.parentElement.open))return false;
    return true;
  });
  // Labels are sufficient to detect a supported disclosure; clipping alone is
  // not evidence that underlying text is missing. The reader tries full text
  // first and only uses expansion when the saved receipt does not match.
  return {controls:disclosures.filter(el=>el.getAttribute('aria-disabled')!=='true'&&!el.matches(':disabled')),collapsed:disclosures.length>0};
}

/** Candidate texts are complete alternative DOM serializations, never repaired
 * source. Only the runner's exact known receipt may select an alternative.
 * No code, names, IDs, or paths are included in these structural statistics. */
export interface UserReadStats {
  serializer:'user-turn/6'; roleElements:number; preElements:number; codeElements:number;
  candidates:number; candidateCharacters:number[]; framedCandidates:number;
}
export function readUserMessageVariants(message:HTMLElement):{texts:string[];stats:UserReadStats} {
  const texts=[readUserMessage(message),readUserMessage(message,true)];
  // A literal bubble need not use semantic PRE/CODE tags. Read the whole
  // sanitized bubble, never just a matching marker or a convenient substring.
  // Candidates are inert until the runner verifies the entire saved receipt.
  const copy=userContentClone(message);
  if(!copy.matches('pre,code')&&!copy.querySelector('pre,code')){
    for(const full of [editableText(copy),copy.textContent||''])texts.push(...decodeFlatRenderedMessages(full));
  }
  const unique=[...new Set(texts)].slice(0,6);
  return {texts:unique,stats:{serializer:'user-turn/6',roleElements:1+message.querySelectorAll('[data-message-author-role]').length,
    preElements:message.querySelectorAll('pre').length,codeElements:message.querySelectorAll('code').length,
    candidates:unique.length,candidateCharacters:unique.map(text=>text.length),framedCandidates:unique.filter(text=>messagePayload(text)!==text).length}};
}
function userContentClone(message:HTMLElement):HTMLElement {
  // Prefer the bubble's actual text over the role wrapper containing Edit/Copy,
  // branch controls and accessibility-only labels.
  const bodies=Array.from(message.querySelectorAll<HTMLElement>('[data-message-content],.whitespace-pre-wrap,.markdown')).filter(el=>!contentHidden(el));
  // .whitespace-pre-wrap is also used INSIDE a fenced code renderer. A match
  // is not necessarily the message bubble. Prefer it only when no substantive
  // message text exists outside it (e.g. exchange header/footer). Otherwise
  // parse the complete role container, excluding its controls below.
  const coversMessage=(candidate:HTMLElement):boolean=>{
    const walker=document.createTreeWalker(message,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const n=walker.currentNode,p=n.parentElement;
      if(candidate.contains(n)||!p||contentHidden(p)||p.closest('button,[role="button"],summary,svg,script,style,template,[data-message-toolbar],[data-mitter-ui]'))continue;
      if((n.nodeValue||'').trim())return false;
    }
    return true;
  };
  const body=bodies.find(el=>!bodies.some(other=>other!==el&&other.contains(el))&&coversMessage(el))||message;
  const copy=body.cloneNode(true) as HTMLElement;
  const original=[body,...Array.from(body.querySelectorAll<HTMLElement>('*'))];
  const clones=[copy,...Array.from(copy.querySelectorAll<HTMLElement>('*'))];
  for(let i=1;i<original.length;i++){
    const el=original[i]!;
    if(contentHidden(el)||(el.matches('button,[role="button"],summary,svg,script,style,template,[data-message-toolbar],[data-mitter-ui]')||!!headingRole(el)&&!el.closest('pre,code,.markdown,[data-message-content]')))clones[i]?.remove();
  }
  return copy;
}

export function readUserMessage(message:HTMLElement,logicalCodeLines=false):string {
  const copy=userContentClone(message);
  const pres=[...(copy.tagName==='PRE'?[copy]:[]),...Array.from(copy.querySelectorAll<HTMLElement>('pre'))];
  const leaves=pres.filter(p=>!pres.some(q=>q!==p&&p.contains(q)));
  const sources:HTMLElement[]=[];
  for(const pre of leaves){const codes=Array.from(pre.querySelectorAll<HTMLElement>('code'));sources.push(...(codes.length?codes.filter(c=>!codes.some(other=>other!==c&&other.contains(c))):[pre]));}
  // Some code components use a DIV around CODE, not PRE. It is a candidate
  // only when the *entire* surrounding message has the exact known framing.
  if(!pres.length){
    const codes=[...(copy.tagName==='CODE'?[copy]:[]),...Array.from(copy.querySelectorAll<HTMLElement>('code'))];
    sources.push(...codes.filter(c=>!codes.some(other=>other!==c&&other.contains(c))));
  }
  if(sources.length===1){
    const source=sources[0]!;
    const payload=logicalCodeLines?editableText(source):source.textContent||'';
    // Preserve inline text-node adjacency. Adding spaces after every text node
    // corrupts a UUID or word split across SPANs. Introduce boundaries only at
    // actual block elements/BRs, using the existing logical-text serializer.
    let marker='\uE000MITTER_PAYLOAD\uE001';
    while((copy.textContent||'').includes(marker))marker+='\uE002';
    const token=document.createTextNode(marker);
    source.replaceWith(token);
    const shell=editableText(copy);
    const at=shell.indexOf(marker);
    const framed=at<0?undefined:decodeRenderedMessage(shell.slice(0,at),payload,shell.slice(at+marker.length));
    token.replaceWith(source);
    if(framed!==undefined)return framed;
  }
  return editableText(copy);
}

/** One-time legacy recovery lower bound, not a global DOM-count progress bar.
 * Only task-shaped user messages are counted; hidden mirrors are removed by
 * logicalMessages, and duplicate rendered copies collapse by complete content.
 * Returning counts instead of historical bodies keeps the bridge payload small. */
function countTaskTurns(users:HTMLElement[]):Array<{workerId:string;projectId:string;count:number}> {
  const groups=new Map<string,{workerId:string;projectId:string;texts:Set<string>}>();
  for(const user of users.slice(-256)){
    const raw=readUserMessage(user);if(raw.length>160000)continue;
    const text=messagePayload(raw);
    if(!text.startsWith('You are collaborating with Mitter,')||!text.includes('GOAL: ')||!text.includes('For THIS ChatGPT handoff'))continue;
    const workerId=/"workerId"\s*:\s*"([a-zA-Z0-9_-]{1,100})"/.exec(text)?.[1];
    const projectId=/"projectId"\s*:\s*"([a-zA-Z0-9_-]{1,100})"/.exec(text)?.[1];
    if(!workerId||!projectId)continue;
    const key=workerId+':'+projectId,group=groups.get(key)||{workerId,projectId,texts:new Set<string>()};
    group.texts.add(raw);groups.set(key,group);
  }
  return [...groups.values()].map(({workerId,projectId,texts})=>({workerId,projectId,count:texts.size}));
}

/** Fallback for a transcript whose messages have no role/test-id metadata.
 * The user message is discovered by an EXACT saved receipt, never by its text
 * merely looking like a prompt. The following reply must occupy the adjacent
 * content branch and have response-only controls (not just a Copy button).
 * Unknown intervening/later content is a barrier. No whole-page JSON search,
 * alternating-role guess, private app state, or remote endpoint is used.
 */
export interface ReceiptDiscoveryStats {
  state:'searching'|'missing'|'mismatch'|'ambiguous'|'collapsed'|'matched'|'waiting_reply'|'unknown_tail'|'limit';
  candidates:number;matches:number;tailBranches:number;responseControls:number;
}
interface MessageDiscovery {
  messages:HTMLElement[];stats:TranscriptStats;
  assistantRead?:AssistantReadResult;
  userRead?:ReturnType<typeof readUserMessageVariants>;
}
function structuralAncestry(elements:HTMLElement[]):TranscriptStats['codeAncestry'] {
  return elements.filter(el=>el.matches('pre,code')&&!contentHidden(el)).slice(0,2).map(el=>{
    const result:Array<{tag:string;attributes:string[]}>=[];
    for(let node:Element|null=el;node&&result.length<7;node=parentAcrossShadow(node)){
      result.push({tag:/^[A-Z][A-Z0-9]*$/.test(node.tagName)?node.tagName.toLowerCase():'custom-element',attributes:node.getAttributeNames().filter(n=>
        ['id','class','role','aria-label','aria-labelledby','aria-hidden','hidden','data-testid','data-message-author-role','data-message-id','data-message-role','data-message-key','data-message-content','data-turn','data-turn-id','data-turn-role','data-author','data-author-role','data-role'].includes(n)).slice(0,12)});
      if(node.matches('body,html'))break;
    }
    return result;
  });
}
/** A branch has content if it contains non-UI text or a real rendered media
 * object. Empty layout spacers and toolbars are not additional messages. */
function substantiveBranch(node:Node):boolean {
  if(node.nodeType===Node.TEXT_NODE)return !!node.nodeValue?.trim();
  if(!(node instanceof HTMLElement)||contentHidden(node))return false;
  if(node.matches('form,nav,aside,button,[role="button"],summary,svg,script,style,template,textarea,[contenteditable="true"],#mitter-automation-control,[data-mitter-ui]'))return false;
  if(node.matches('pre,code,img,video,audio,canvas,iframe'))return true;
  return Array.from(node.childNodes).some(substantiveBranch);
}
function responseControls(root:HTMLElement):{positive:number;negative:number;other:number;userEdit:boolean} {
  const result={positive:0,negative:0,other:0,userEdit:false};
  for(const control of Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"]'))){
    if(contentHidden(control)||control.closest('pre,code,[contenteditable="true"],blockquote'))continue;
    const label=(control.getAttribute('aria-label')||control.getAttribute('title')||control.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
    const test=(control.getAttribute('data-testid')||'').toLowerCase();
    if(/^(?:good response|like response|thumbs up|bonne réponse|buena respuesta)$/.test(label)||/^(?:good-response|thumb-up)-turn-action-button$/.test(test))result.positive++;
    if(/^(?:bad response|dislike response|thumbs down|mauvaise réponse|mala respuesta)$/.test(label)||/^(?:bad-response|thumb-down)-turn-action-button$/.test(test))result.negative++;
    if(/^(?:read aloud|regenerate response|regenerate|retry response|lire à voix haute)$/.test(label)||/^(?:read-aloud|regenerate)-turn-action-button$/.test(test))result.other++;
    if(/^(?:edit|edit message|edit prompt|modifier le message)$/.test(label)||test==='edit-message-button')result.userEdit=true;
  }
  return result;
}
/** Read exactly one code payload. The only extra text accepted on the outer
 * response row is a known duration label such as "Worked for 59s" and the
 * language label. Arbitrary prose/other payloads are NOT removed. */
function readAnchoredAssistant(root:HTMLElement):AssistantReadResult {
  const read=readAssistantMessage(root);
  if(read.issue!=='EXTRA_CONTENT'||!read.source||read.stats?.logicalBlocks!==1)return read;
  const texts:string[]=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
    const node=walker.currentNode,p=node.parentElement;
    if(!p||read.source.contains(node)||contentHidden(p)||p.closest('button,[role="button"],summary,svg,script,style,template,[aria-hidden="true"]'))continue;
    if(node.nodeValue?.trim())texts.push(node.nodeValue.trim());
  }
  const rest=texts.join(' ').replace(/\s+/g,' ').trim();
  if(!/^(?:(?:Worked|Thought|Reasoned) for \d+(?:\s*(?:h|m|s|hours?|minutes?|seconds?)\b)(?:\s*\d+\s*(?:h|m|s|hours?|minutes?|seconds?)\b)*\s*)?(?:JSON|application\/json)$/i.test(rest))return read;
  return {text:read.source.textContent||'',format:'code',stats:read.stats,source:read.source};
}
function receiptRoleConflict(node:HTMLElement):boolean {
  for(let p:Element|null=node;p&&!p.matches('main,body,html,[role="main"]');p=parentAcrossShadow(p)){
    if(p instanceof HTMLElement&&['assistant','unknown'].includes(explicitRole(p)))return true;
  }
  return false;
}
function setReceiptRole(node:HTMLElement,role:'user'|'assistant',identity:string):void {
  discoveredRoles.set(node,role);
  // Synthetic identities are correlation hints only. Content/receipt and
  // proposal validation still run before each import in BridgeRunner.
  receiptIdentities.set(node,identity);
}
export async function discoverReceiptMessages(receipt:OutboundReceipt,base:MessageDiscovery=discoverMessages()):Promise<MessageDiscovery> {
  // Parse even when called outside chatDom by tests or future callers.
  const valid=parseReceipt(receipt);if(!valid)return base;
  const scan=pageElements();
  const evidence:ReceiptDiscoveryStats={state:'searching',candidates:0,matches:0,tailBranches:0,responseControls:0};
  const stats:TranscriptStats={...base.stats,version:'message-discovery/2',strategy:'receipt',receiptDiscovery:evidence,
    codeAncestry:structuralAncestry(scan.elements)};
  const unchanged=():MessageDiscovery=>({messages:base.messages,stats});
  if(scan.limited){stats.state='partial';stats.scanLimited=true;evidence.state='limit';return unchanged();}
  // Only DOM ancestors containing the known send marker can be candidate
  // message bubbles. Legacy receipts may instead require the bootstrap prefix;
  // they still need an exact full-body hash match, never prefix acceptance.
  const needle=valid.exchangeId||'You are collaborating with Mitter,';
  const candidates=scan.elements.filter(el=>!el.matches('html,body,main,[role="main"]')&&!transcriptExcluded(el)&&
    (el.textContent||'').length<=180000&&(el.textContent||'').includes(needle));
  evidence.candidates=candidates.length;
  if(candidates.length>96){evidence.state='limit';stats.scanLimited=true;stats.state='partial';return unchanged();}
  if(!candidates.length){evidence.state='missing';return unchanged();}
  const matching:Array<{node:HTMLElement;read:ReturnType<typeof readUserMessageVariants>}>=[];
  for(const node of candidates){
    // Role metadata, when present, cannot be contradicted by a receipt match.
    if(receiptRoleConflict(node))continue;
    const read=readUserMessageVariants(node);
    const exact=await Promise.all(read.texts.map(text=>text.length<=160000?matchesReceipt(text,valid):false));
    const index=exact.indexOf(true);
    if(index>=0&&node.isConnected){
      // DOM can change while WebCrypto yields. Never pair an old verified
      // user-body snapshot with a newly inserted response.
      const fresh=readUserMessageVariants(node);
      if(fresh.texts.includes(read.texts[index]!))matching.push({node,read:{...fresh,texts:[read.texts[index]!,...fresh.texts.filter(text=>text!==read.texts[index])]}});
    }
  }
  // Nested matches are the same bubble, disjoint visible matches are not. Never
  // acknowledge two identical sends by deduplicating their bodies.
  const leaves=matching.filter(m=>!matching.some(n=>n!==m&&m.node.contains(n.node)));
  evidence.matches=leaves.length;
  const makeUser=(node:HTMLElement,read:ReturnType<typeof readUserMessageVariants>):MessageDiscovery=>{
    setReceiptRole(node,'user','receipt-'+(valid.messageId||valid.exchangeId||valid.textHash));
    stats.state='ready';stats.users=1;stats.assistants=0;stats.unknownTurns=0;stats.unclassifiedTail=false;
    return {messages:[node],stats,userRead:read};
  };
  if(leaves.length>1){evidence.state='ambiguous';stats.state='unrecognized';return unchanged();}
  if(!leaves.length){
    // A matching marker permits ONLY opening Show more, not acknowledging or
    // importing. The next read must recover and verify the COMPLETE body.
    const collapsed=candidates.filter(node=>!!valid.exchangeId&&!receiptRoleConflict(node)&&
      (node.textContent||'').includes('MITTER EXCHANGE '+valid.exchangeId)&&
      messageDisclosure(node,true).collapsed);
    const smallest=collapsed.filter(node=>!collapsed.some(other=>other!==node&&node.contains(other)));
    if(smallest.length===1){evidence.state='collapsed';return makeUser(smallest[0]!,readUserMessageVariants(smallest[0]!));}
    evidence.state=smallest.length>1?'ambiguous':'mismatch';return unchanged();
  }
  const exact=leaves[0]!;
  const result=makeUser(exact.node,exact.read);evidence.state='matched';
  // Find the FIRST branch following the verified bubble. Do not climb over
  // intervening content to cherry-pick a convenient JSON block further down.
  for(let branch:HTMLElement=exact.node,depth=0;depth<20;depth++){
    const parent=branch.parentElement;
    if(!parent||parent.matches('body,html,form,nav,aside,[role="dialog"]'))break;
    const nodes=Array.from(parent.childNodes),index=nodes.indexOf(branch);
    const following=nodes.slice(index+1).filter(substantiveBranch);
    if(following.length){
      evidence.tailBranches=following.length;
      if(following.length!==1||!(following[0] instanceof HTMLElement)){
        evidence.state='unknown_tail';stats.unclassifiedTail=true;stats.state='partial';return result;
      }
      const response=following[0];
      const controls=responseControls(response);
      evidence.responseControls=controls.positive+controls.negative+controls.other;
      const explicit=explicitRole(response);
      const descendantRoles=Array.from(response.querySelectorAll<HTMLElement>(roleSelector)).map(explicitRole);
      const responseOnly=(controls.positive===1&&controls.negative===1||controls.other===1)&&!controls.userEdit;
      const knownAssistant=explicit==='assistant'||descendantRoles.includes('assistant');
      if(explicit==='user'||explicit==='unknown'||descendantRoles.includes('user')||descendantRoles.includes('unknown')||
        controls.userEdit||controls.positive>1||controls.negative>1||controls.other>2){
        evidence.state='unknown_tail';stats.unclassifiedTail=true;stats.state='partial';return result;
      }
      if(!knownAssistant&&!responseOnly){
        // An incomplete response row often gets its action toolbar only after
        // streaming. Never infer completion from valid JSON alone.
        evidence.state='waiting_reply';stats.unclassifiedTail=true;stats.state='partial';return result;
      }
      const read=readAnchoredAssistant(response);
      let identity='receipt-reply-'+(valid.messageId||valid.exchangeId||valid.textHash);
      // The envelope ID is not authority. A stable ID merely prevents a
      // highlighter re-render from being mistaken for another reply.
      try{const e=readReplyJSON(read.text) as {id?:unknown}|null;if(e&&typeof e.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(e.id))identity='reply-'+e.id;}catch{}
      setReceiptRole(response,'assistant',identity);
      result.messages.push(response);result.assistantRead=read;stats.assistants=1;
      return result;
    }
    if(parent.matches('main,[role="main"]'))break;
    // A matching substring nested inside an edited/quoted message is not the
    // full user turn. Only climb through wrappers that also match the receipt.
    if(!matching.some(match=>match.node===parent)){
      // A verified new user bubble can be the last child of the transcript,
      // following a previously recorded assistant reply. The parent then
      // necessarily contains older text and cannot itself match the new send.
      // Recognize ONLY that exact preceding known reply; arbitrary introductory
      // prose / quoted copies still fail below. This grants no execution proof.
      const previous=nodes.slice(0,index).filter(substantiveBranch).at(-1);
      if(previous instanceof HTMLElement&&valid.priorReplyIds?.length){
        const read=readAnchoredAssistant(previous);
        let old:any;try{if(!read.issue&&read.format==='code')old=readReplyJSON(read.text);}catch{}
        if(old?.protocol==='mitter/1'&&old.workerId===valid.workerId&&old.projectId===valid.projectId&&
           typeof old.id==='string'&&valid.priorReplyIds.includes(old.id)){
          evidence.state='waiting_reply';return result;
        }
      }
      evidence.state='unknown_tail';stats.unclassifiedTail=true;stats.state='partial';return result;
    }
    branch=parent;
  }
  evidence.state='waiting_reply';return result;
}


/** Independent code-widget lane. Reads the bytes of the code associated with
 * Copy code, NOT the whole transcript or clipboard. This is only a candidate:
 * an exact pending replyTo or explicit UI confirmation is required separately.
 * Schema, deduplication, permissions and hash preconditions remain host gates.
 */
export interface CodeReply {id:string;workerId:string;projectId:string;replyTo?:string;text:string;hasCopyControl:boolean;format?:'code'|'plain'}
/** One generation detector shared by inspect, explicit reply preview, prepare
 * and commit. In particular, roleless response rows must not lose their global
 * streaming marker just because normal transcript discovery has no assistant. */
const generationStopSelector='button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating" i],button[aria-label="Stop streaming" i],button[aria-label="Stop response" i],button#composer-submit-button[aria-label="Stop" i]';
function generationElementVisible(el:HTMLElement):boolean {
  return !contentHidden(el)&&!el.closest('pre,code,blockquote,nav,aside,[data-mitter-ui],#mitter-automation-control');
}
function generationStopControls():HTMLElement[] {
  return pageElements().elements.filter(el=>el.matches(generationStopSelector)&&generationElementVisible(el)&&!el.matches(':disabled')&&el.getAttribute('aria-disabled')!=='true');
}
function generationActive():boolean {
  return pageElements().elements.some(el=>generationElementVisible(el)&&
    (el.matches('[data-is-streaming="true"]')||el.matches(generationStopSelector)&&!el.matches(':disabled')&&el.getAttribute('aria-disabled')!=='true'));
}
export function readCodeReply(workerId:string,projectId:string,replyId?:string,replyTo?:string):{reply?:CodeReply;count:number;issue?:string;unlinked?:CodeReply;ids?:string[];total?:number;read?:CodeReadObservation} {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(workerId)||!/^[a-zA-Z0-9_-]{1,100}$/.test(projectId))return {count:0,issue:'TASK_REQUIRED'};
  const scan=pageElements();if(scan.limited)return {count:0,issue:'SCAN_LIMIT'};
  const candidates:Array<{reply:CodeReply;node:HTMLElement;order:number}>=[];
  const observations:Array<{node:HTMLElement;order:number;read:CodeReadObservation}>=[];
  const codeSelector='pre,code,[data-testid="code-block"],.code-block';
  const outerAssistant=(el:HTMLElement)=>{
    if(explicitRole(el)!=='assistant')return false;
    for(let n=parentAcrossShadow(el);n&&!n.matches('body,html,main');n=parentAcrossShadow(n))if(n instanceof HTMLElement&&explicitRole(n)==='assistant')return false;
    return true;
  };
  const roots=scan.elements.filter(el=>(el.matches(codeSelector)||outerAssistant(el)&&!el.querySelector(codeSelector))&&!contentHidden(el)&&!el.closest('form,textarea,[contenteditable="true"],nav,aside,blockquote,[data-mitter-ui],#mitter-automation-control'));
  for(const [order,root] of roots.entries()){
    let user=false;for(let n:Element|null=root;n&&!n.matches('body,html,main');n=parentAcrossShadow(n)){if(n instanceof HTMLElement&&explicitRole(n)==='user')user=true;}
    if(user)continue;
    const plainRoot=!root.matches(codeSelector);
    const extracted=readAssistantMessage(plainRoot?root:root.tagName==='CODE'?root.parentElement||root:root);
    const literal=extracted.text,source=extracted.source||root;
    // Nested highlighter/PRE wrappers are one observation. A partial second
    // reply is still an observation, even before it contains task IDs.
    if(observations.some(o=>o.node===source||o.node.contains(source)||source.contains(o.node)))continue;
    let value:any;try{if(literal.trim()&&!exceedsHandoffBytes(literal))value=readReplyJSON(literal);}catch{}
    const observedTask=literal.includes(workerId)&&literal.includes(projectId)&&/^\s*\{/.test(literal);
    const jsonLike=/^\s*\{/.test(literal)||!literal.trim()&&!plainRoot;
    if(!jsonLike&&!observedTask)continue;
    let h=2166136261;for(let i=0;i<Math.min(literal.length,400001);i++)h=Math.imul(h^literal.charCodeAt(i),16777619);
    const read:CodeReadObservation={characters:Math.min(literal.length,400001),fingerprint:(h>>>0).toString(16),
      issue:extracted.issue||(value?'candidate':'INVALID_JSON'),
      incomplete:!value&&(!literal.trim()||isIncompleteReplyJSON(literal))};
    const taskValue=value?.protocol==='mitter/1'&&value.workerId===workerId&&value.projectId===projectId;
    if(taskValue&&typeof value.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.id))read.replyId=value.id;
    if(taskValue&&typeof value.replyTo==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.replyTo))read.replyTo=value.replyTo;
    observations.push({node:source,order,read});
    if(extracted.issue||!literal.trim()||exceedsHandoffBytes(literal))continue;
    if(!taskValue||typeof value.id!=='string'||!Array.isArray(value.actions))continue;
    if(extracted.format!=='code'&&!isReadOnlyReply(value)){read.issue='PLAIN_REPLY_REQUIRES_FENCE';continue;}
    let hasCopyControl=false;
    for(let n:HTMLElement|null=source,depth=0;n&&depth<5&&!n.matches('body,html,main');n=n.parentElement,depth++){
      const codeCount=n.querySelectorAll('pre').length;if(codeCount>2)break;
      if(Array.from(n.querySelectorAll<HTMLElement>('button,[role="button"]')).some(b=>!contentHidden(b)&&/^(?:copy(?: code| code block)?|copied!?|copier le code)$/i.test((b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim()))){hasCopyControl=true;break;}
    }
    candidates.push({node:source,order,reply:{id:value.id,workerId,projectId,...(typeof value.replyTo==='string'?{replyTo:value.replyTo}:{}),text:literal,hasCopyControl,format:extracted.format as 'code'|'plain'}});
    if(candidates.length>64)return {count:candidates.length,issue:'TOO_MANY_REPLIES'};
  }
  const newest=observations.at(-1),ids=candidates.map(c=>c.reply.id),total=candidates.length;
  const observed={ids,total,read:newest?.read};
  const laterHuman=(selected:typeof candidates[number])=>{
    const selectedIndex=scan.elements.findIndex(el=>el===selected.node||(el.matches(codeSelector)&&el.contains(selected.node)));
    return scan.elements.some((el,index)=>index>selectedIndex&&!contentHidden(el)&&explicitRole(el)==='user'&&
      !el.contains(selected.node)&&!selected.node.contains(el));
  };
  const filtered=candidates.filter(c=>(!replyId||c.reply.id===replyId)&&(!replyTo||c.reply.replyTo===replyTo));
  if(filtered.length>1)return {...observed,count:filtered.length,issue:'AMBIGUOUS_REPLIES'};
  const latest=candidates.at(-1),selected=filtered[0];
  // Never cherry-pick the last *parseable* block while a later response is
  // incomplete or malformed. It is a wait barrier, not a repaired JSON reply.
  const before=selected||latest;
  if(replyTo&&newest&&(!before||newest.order>before.order)&&!candidates.some(c=>c.node===newest.node)){
    if(before&&laterHuman(before)){
      // Preserve the human-turn barrier; the coordinator separately recognizes
      // its own exact report. Fragment metadata remains available for waiting.
      return {...observed,count:0,issue:'NEWER_USER_MESSAGE'};
    }
    return {...observed,count:0,issue:newest.read.incomplete?'REPLY_IN_PROGRESS':'NEWER_REPLY_UNREADABLE'};
  }
  if(!selected){
    if(replyTo&&!replyId&&latest){
      if(ids.filter(id=>id===latest.reply.id).length!==1)return {...observed,count:0,issue:'AMBIGUOUS_REPLIES'};
      if(laterHuman(latest))return {...observed,count:0,issue:'NEWER_USER_MESSAGE'};
      return {...observed,count:0,issue:latest.reply.replyTo?'STALE_REPLY_TO':'MISSING_REPLY_TO',unlinked:latest.reply};
    }
    return {...observed,count:0,issue:replyTo?'WAITING_CORRELATED_REPLY':'NO_CODE_REPLY'};
  }
  if(replyTo&&candidates.some(c=>c!==selected&&c.order>selected.order))return {...observed,count:1,issue:'NEWER_TASK_REPLY'};
  if(laterHuman(selected))return {...observed,count:1,issue:'NEWER_USER_MESSAGE'};
  return {...observed,reply:selected.reply,count:1};
}

/** Clear only Miter's isolated-world memory. Provider conversation/draft DOM is
 * user data and is never erased by a local application reset. */
export function clearChatDomState():void {
 const scope=globalThis as typeof globalThis & {[key:string]:any};
 for(const key of ['__mitterSessionV3','__mitterSessionV4']){
  const state=scope[key];if(state){state.stopped=true;state.prepared=null;state.committed?.clear();state.reveals?.clear();delete scope[key];}
 }
 discoveredRoles=new WeakMap();receiptIdentities=new WeakMap();
 document.getElementById('mitter-automation-control')?.remove();
}
