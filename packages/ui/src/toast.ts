/** Local, ephemeral feedback. Never stores source text, restarts tasks, or
 * broadcasts clipboard actions to other windows. No interval/animation loop. */
export type ToastKind='success'|'info'|'warning'|'error';
export interface ToastAction {label:string;run:()=>void|Promise<unknown>}
export interface ToastInput {message:string;kind?:ToastKind;key?:string;duration?:number;action?:ToastAction}
export interface ToastView {id:string;message:string;kind:ToastKind;action?:ToastAction;busy:boolean}
interface Entry extends ToastView {key:string;remaining:number;since:number;paused:Set<string>}
export interface ToastClock {now():number;set(fn:()=>void,ms:number):unknown;clear(id:unknown):void}
const clock:ToastClock={now:()=>Date.now(),set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id as ReturnType<typeof setTimeout>)};
export class ToastCenter {
 private entries:Entry[]=[];
 private listeners=new Set<(items:ToastView[])=>void>();
 private globalPause=new Set<string>();
 private timer:unknown;
 private serial=0;
 private disposed=false;
 constructor(private time:ToastClock=clock,private visibleLimit=3,private queueLimit=20){}
 subscribe(fn:(items:ToastView[])=>void):()=>void {this.listeners.add(fn);fn(this.items());return ()=>this.listeners.delete(fn);}
 items():ToastView[]{return this.entries.slice(0,this.visibleLimit).map(({id,message,kind,action,busy})=>({id,message,kind,action,busy}));}
 private settle(){const now=this.time.now();for(const e of this.entries.slice(0,this.visibleLimit)){if(!this.globalPause.size&&!e.paused.size&&!e.busy)e.remaining=Math.max(0,e.remaining-(now-e.since));e.since=now;}}
 private changed(){
  if(this.timer!==undefined){this.time.clear(this.timer);this.timer=undefined;}
  if(this.disposed)return;
  const now=this.time.now();for(const e of this.entries)e.since=now;
  for(const fn of this.listeners)fn(this.items());
  const active=this.entries.slice(0,this.visibleLimit).filter(e=>!e.paused.size&&!e.busy);
  if(!this.globalPause.size&&active.length){this.timer=this.time.set(()=>{this.settle();this.entries=this.entries.filter(e=>e.remaining>0);this.changed();},Math.max(1,Math.min(...active.map(e=>e.remaining))));}
 }
 push(input:ToastInput):string {
  if(this.disposed||!input.message.trim())return '';
  this.settle();const kind=input.kind||'info',key=input.key||kind+':'+input.message;
  const duration=input.duration??(input.action?8000:kind==='error'?10000:kind==='warning'?7000:4500);
  const remaining=Math.max(1000,Math.min(60000,Number.isFinite(duration)?duration:4500));
  const old=this.entries.find(e=>e.key===key&&!e.busy);
  if(old){old.message=input.message;old.kind=kind;old.action=input.action;old.remaining=remaining;this.changed();return old.id;}
  const e:Entry={id:'miter-toast-'+(++this.serial),key,message:input.message,kind,action:input.action,busy:false,remaining,since:this.time.now(),paused:new Set()};
  if(this.entries.length>=this.visibleLimit+this.queueLimit)this.entries.splice(this.visibleLimit,1);
  this.entries.push(e);this.changed();return e.id;
 }
 dismiss(id:string){this.settle();this.entries=this.entries.filter(e=>e.id!==id);this.changed();}
 pause(id:string,reason:string,paused:boolean){const e=this.entries.find(e=>e.id===id);if(!e||e.paused.has(reason)===paused)return;this.settle();paused?e.paused.add(reason):e.paused.delete(reason);this.changed();}
 pauseAll(reason:string,paused:boolean){this.settle();paused?this.globalPause.add(reason):this.globalPause.delete(reason);this.changed();}
 async invoke(id:string):Promise<void>{
  const e=this.entries.find(e=>e.id===id);if(!e||e.busy||!e.action)return;
  this.settle();e.busy=true;this.changed();
  try{await e.action.run();this.dismiss(id);}
  catch(error){if(!this.entries.includes(e))return;this.settle();e.message=error instanceof Error?error.message:String(error);e.kind='error';e.busy=false;e.action=undefined;e.remaining=10000;this.changed();}
 }
 dispose(){this.disposed=true;if(this.timer!==undefined)this.time.clear(this.timer);this.timer=undefined;this.entries=[];this.listeners.clear();}
}

/** Mount actual controls independently of the view framework. Move into an open
 * dialog so notifications remain usable above its top layer, without making the
 * rest of the application focusable or closing the dialog. */
export function mountToasts(document:Document,center:ToastCenter):()=>void {
 const root=document.createElement('section');root.className='miter-toasts';root.setAttribute('aria-label','Notifications');root.dataset.miterUi='toasts';
 const hovered=new Set<string>();
 const cards=new Map<string,{node:HTMLElement;message:HTMLElement;action:HTMLButtonElement;close:HTMLButtonElement;returnTo:Element|null}>();
 const hover=(id:string,on:boolean)=>{on?hovered.add(id):hovered.delete(id);center.pause(id,'hover',on);};
 // Portals/top-layer moves and entry animations can suppress a boundary leave
 // event. Reconcile only currently hovered cards (at most three) on movement;
 // this has no timer and does nothing when no card is hovered.
 const pointer=(event:PointerEvent)=>{for(const id of hovered){const card=cards.get(id);if(!card||!(event.target instanceof Node)||!card.node.contains(event.target))hover(id,false);}};
 const clearHover=()=>{for(const id of [...hovered])hover(id,false);};
 document.addEventListener('pointermove',pointer,{capture:true,passive:true});
 document.addEventListener('pointercancel',clearHover,true);
 document.defaultView?.addEventListener('blur',clearHover);
 const icon=(kind:ToastKind)=>{
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');
  const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx','12');circle.setAttribute('cy','12');circle.setAttribute('r','9');svg.append(circle);
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',kind==='success'?'m7.5 12 3 3 6-6':kind==='error'?'m9 9 6 6m0-6-6 6':'M12 7v6m0 3v1');svg.append(path);return svg;
 };
 const relocate=()=>{const dialogs=Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));const host=dialogs.at(-1)||document.body;if(root.parentElement!==host)host.append(root);};
 relocate();
 const observer=new MutationObserver(records=>{
  if(records.some(r=>r.type==='attributes'&&r.target instanceof HTMLDialogElement||r.type==='childList'&&[...Array.from(r.addedNodes),...Array.from(r.removedNodes)].some(n=>n instanceof Element&&(n.matches('dialog')||!!n.querySelector('dialog')))))relocate();
 });
 observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
 const unsubscribe=center.subscribe(items=>{
  const ids=new Set(items.map(e=>e.id));
  for(const [id,card]of cards)if(!ids.has(id)){
    const hadFocus=card.node.contains(document.activeElement);card.node.remove();cards.delete(id);hovered.delete(id);
    if(hadFocus&&card.returnTo instanceof HTMLElement&&card.returnTo.isConnected)card.returnTo.focus({preventScroll:true});
  }
  for(const entry of items){
    let card=cards.get(entry.id);
    if(!card){
      const node=document.createElement('article');node.className='miter-toast';node.dataset.toastId=entry.id;
      const badge=document.createElement('span');badge.className='miter-toast-icon';node.append(badge);
      const text=document.createElement('div');text.className='miter-toast-content';
      const message=document.createElement('p');message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.setAttribute('aria-atomic','true');
      const action=document.createElement('button');action.type='button';action.className='miter-toast-action';action.onclick=()=>void center.invoke(entry.id);text.append(message,action);
      const close=document.createElement('button');close.type='button';close.className='miter-toast-close';close.setAttribute('aria-label','Dismiss notification');close.title='Dismiss notification';close.textContent='×';close.onclick=()=>center.dismiss(entry.id);
      node.append(text,close);node.onpointerenter=()=>hover(entry.id,true);node.onpointerleave=()=>hover(entry.id,false);
      node.addEventListener('focusin',()=>center.pause(entry.id,'focus',true));node.addEventListener('focusout',e=>{if(!(e.relatedTarget instanceof Node)||!node.contains(e.relatedTarget))center.pause(entry.id,'focus',false);});
      node.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();center.dismiss(entry.id);}};
      card={node,message,action,close,returnTo:document.activeElement};cards.set(entry.id,card);root.append(node);
    }
    if(card.node.dataset.kind!==entry.kind){card.node.dataset.kind=entry.kind;card.node.querySelector('.miter-toast-icon')!.replaceChildren(icon(entry.kind));}
    if(card.message.textContent!==entry.message)card.message.textContent=entry.message;
    card.action.hidden=!entry.action;card.action.textContent=entry.busy?'Working…':entry.action?.label||'';card.action.disabled=entry.busy;
  }
  root.hidden=!items.length;
 });
 const visibility=()=>center.pauseAll('hidden',document.hidden);document.addEventListener('visibilitychange',visibility);visibility();
 return ()=>{unsubscribe();observer.disconnect();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('pointermove',pointer,true);document.removeEventListener('pointercancel',clearHover,true);document.defaultView?.removeEventListener('blur',clearHover);hovered.clear();root.remove();cards.clear();center.dispose();};
}
