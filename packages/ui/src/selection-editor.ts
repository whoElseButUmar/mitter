import {createPopover, uiId} from './popover.js';
import type {CodeSelection} from '../../protocol/src/requests.js';
export interface SelectionEditorOptions {
  workerId:string; path:string; content:string; hash:string;
  submit(request:{id:string;instruction:string;selection:CodeSelection}):Promise<unknown>;
  submitted?():void;
}
/** Capture once before focusing the prompt. Never use the later live selection
 * or a changed source preview as a replacement target. */
export function captureCodeSelection(root:HTMLElement,options:Pick<SelectionEditorOptions,'path'|'content'|'hash'>):CodeSelection|undefined{
  const selection=root.ownerDocument.getSelection();
  if(!selection||selection.rangeCount!==1||selection.isCollapsed)return;
  const range=selection.getRangeAt(0);
  if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return;
  const prefix=range.cloneRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset);
  const start=prefix.toString().length,text=range.toString(),end=start+text.length;
  if(!text.length||text.length>16000||options.content.slice(start,end)!==text)return;
  return {path:options.path,hash:options.hash,start,end,text};
}
export function mountSelectionEditor(root:HTMLElement,options:SelectionEditorOptions){
  const doc=root.ownerDocument,win=doc.defaultView!;
  let captured:CodeSelection|undefined,alive=true,busy=false,anchor:{x:number;y:number}|undefined;
  let requestKey='',requestId='',savedInstruction='';
  const panel=doc.createElement('form');panel.className='selection-editor';panel.tabIndex=-1;panel.setAttribute('aria-label','Change selected code');
  const title=doc.createElement('strong');title.textContent='Change selected code';
  const header=doc.createElement('header'),dismiss=doc.createElement('button');dismiss.type='button';dismiss.className='icon-button';dismiss.textContent='×';dismiss.setAttribute('aria-label','Close selection prompt');header.append(title,dismiss);
  const meta=doc.createElement('div');meta.className='selection-location';
  const label=doc.createElement('label');label.className='field';label.textContent='What would you like changed here?';
  const input=doc.createElement('textarea');input.rows=3;input.maxLength=4000;input.required=true;input.placeholder='Describe the change…';input.id=uiId('selection-instruction');label.htmlFor=input.id;label.append(input);
  const status=doc.createElement('p');status.className='selection-error';status.setAttribute('role','status');status.hidden=true;
  const hint=doc.createElement('small');hint.textContent='Same task and chat · file checked before editing';
  const send=doc.createElement('button');send.className='primary';send.type='submit';send.textContent='Send';
  const footer=doc.createElement('footer');footer.append(hint,send);panel.append(header,meta,label,status,footer);
  const pop=createPopover(root,panel,{role:'dialog',decorateTrigger:false,minWidth:300,maxHeight:300,
    anchor:()=>{const r=root.getBoundingClientRect();const x=anchor?.x??r.left+16,y=anchor?.y??r.top+16;return {left:x,right:x,top:y,bottom:y,width:0};},
    onOpen:()=>{input.value=savedInstruction;input.focus({preventScroll:true});},onClose:()=>{savedInstruction=input.value;}});
  function open(point?:{x:number;y:number},selection=captureCodeSelection(root,options)){
    if(!alive||busy||!selection)return false;
    const changed=!captured||captured.start!==selection.start||captured.end!==selection.end;
    pop.close('superseded');
    if(changed){requestKey='';requestId='';savedInstruction='';}
    captured=Object.freeze({...selection});anchor=point;
    const first=options.content.slice(0,selection.start).split('\n').length,last=options.content.slice(0,selection.end).split('\n').length;
    meta.textContent=options.path+' · '+(first===last?'line '+first:'lines '+first+'–'+last);
    status.hidden=true;pop.open();return true;
  }
  const pointer=(event:PointerEvent)=>{if(event.button!==0)return;queueMicrotask(()=>{if(alive&&!pop.isOpen())open({x:event.clientX+8,y:event.clientY+8});});};
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')return;if(event.altKey&&event.key==='Enter'){event.preventDefault();open();}};
  const submit=async(event:Event)=>{
    event.preventDefault();if(busy||!captured||!input.value.trim())return;
    const instruction=input.value.trim(),selection={...captured};
    const fingerprint=JSON.stringify({instruction,selection});if(requestKey!==fingerprint){requestKey=fingerprint;requestId=crypto.randomUUID();}
    busy=true;send.disabled=true;input.readOnly=true;send.textContent='Sending…';status.hidden=true;
    try{await options.submit({id:requestId,instruction,selection});if(!alive)return;savedInstruction='';input.value='';pop.close('selection');options.submitted?.();}
    catch(e){if(alive){status.textContent=e instanceof Error?e.message:String(e);status.hidden=false;pop.position();}}
    finally{busy=false;if(alive){send.disabled=false;input.readOnly=false;send.textContent='Send';}}
  };
  const inputKey=(event:KeyboardEvent)=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();panel.requestSubmit();}};
  root.addEventListener('pointerup',pointer);root.addEventListener('keydown',key);panel.addEventListener('submit',submit);input.addEventListener('keydown',inputKey);dismiss.onclick=()=>pop.close('toggle');
  return {open,selection:()=>captureCodeSelection(root,options),dispose(){alive=false;root.removeEventListener('pointerup',pointer);root.removeEventListener('keydown',key);panel.removeEventListener('submit',submit);input.removeEventListener('keydown',inputKey);pop.dispose();}};
}
