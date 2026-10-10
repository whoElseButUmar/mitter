import {closeActivePopover} from './popover.js';
import {mountMenu,type MenuItem,type MenuHandle} from './menu.js';
export interface TabItem {id:string;label:string;title?:string;status?:string;}
export interface TabRowOptions {
 kind:'project'|'task';items:TabItem[];selected:string;addDisabled?:boolean;canAdd:boolean;addLabel:string;
 onSelect(id:string):void;onAdd():void;onClose?(id:string):void;onList?():void;listLabel?:string;
 menuItems?(id:string):MenuItem[];
}
export const tabId=(kind:'project'|'task',id:string)=>`mitter-${kind}-tab-${encodeURIComponent(id)}`;
/** Keyed tab DOM preserves focus while status changes. Close is a sibling
 * button (never a nested interactive element), with a separate action. */
export function mountTabRow(root:HTMLElement,initial:TabRowOptions):{update(next:TabRowOptions):void;dispose():void} {
 const doc=root.ownerDocument;let options=initial,selectedBefore='';
 const entries=new Map<string,{wrap:HTMLDivElement;tab:HTMLButtonElement;close:HTMLButtonElement;menu?:MenuHandle}>();
 root.className=`workspace-tab-row ${initial.kind}-tab-row`;
 const label=doc.createElement('span');label.className='tab-row-label';label.textContent=initial.kind==='project'?'Projects':'Tasks';label.id=`mitter-${initial.kind}-tabs-label`;
 const list=doc.createElement('div');list.className='tabbar';list.setAttribute('role','tablist');list.setAttribute('aria-labelledby',label.id);list.setAttribute('aria-orientation','horizontal');
 const empty=doc.createElement('span');empty.className='empty-tabs';empty.textContent=initial.kind==='project'?'No open projects':'No open tasks';
 const add=doc.createElement('button');add.type='button';add.className='add-tab';add.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
 add.addEventListener('click',()=>{closeActivePopover(doc);options.onAdd();});
 const all=doc.createElement('button');all.type='button';all.className='list-tabs';all.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
 all.addEventListener('click',()=>{closeActivePopover(doc);options.onList?.();});
 root.append(label,list,add,all);
 function resetRoving(){for(const [id,e]of entries){e.tab.tabIndex=id===options.selected?0:-1;e.close.tabIndex=id===options.selected?0:-1;}}
 function close(id:string){const e=entries.get(id);if(!e||!options.onClose)return;const focused=e.wrap.contains(doc.activeElement);closeActivePopover(doc);options.onClose(id);if(focused){queueMicrotask(()=>{if(!e.wrap.isConnected)(entries.get(options.selected)?.tab||add).focus({preventScroll:true});});}}
 function update(next:TabRowOptions){
  options=next;const hadFocus=list.contains(doc.activeElement);
  for(const [id,e]of entries)if(!next.items.some(t=>t.id===id)){e.menu?.dispose();e.wrap.remove();entries.delete(id);}
  for(const [index,item]of next.items.entries()){
   let e=entries.get(item.id);
   if(!e){
    const wrap=doc.createElement('div');wrap.className='tab-wrap';wrap.setAttribute('role','presentation');
    const tab=doc.createElement('button');tab.type='button';tab.className=`worker-tab ${next.kind}-tab`;tab.setAttribute('role','tab');tab.id=tabId(next.kind,item.id);tab.dataset.tabId=item.id;
    const dot=doc.createElement('i');dot.setAttribute('aria-hidden','true');dot.className='state-dot';const text=doc.createElement('span');tab.append(dot,text);
    const x=doc.createElement('button');x.type='button';x.className='close-tab';x.innerHTML='<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>';
    tab.addEventListener('click',()=>{closeActivePopover(doc);options.onSelect(item.id);});
    x.addEventListener('click',event=>{event.stopPropagation();close(item.id);});
    wrap.addEventListener('auxclick',event=>{if(event.button===1){event.preventDefault();close(item.id);}});
    wrap.addEventListener('mousedown',event=>{if(event.button===1)event.preventDefault();});
    wrap.append(tab,x);list.append(wrap);e={wrap,tab,close:x};entries.set(item.id,e);
    if(next.menuItems){tab.setAttribute('aria-haspopup','menu');e.menu=mountMenu(wrap,item.label,[],{trigger:tab,items:()=>options.menuItems?.(item.id)||[]});}
   }
   const current=list.children[index];if(current!==e.wrap)list.insertBefore(e.wrap,current||null);
   e.tab.querySelector('span')!.textContent=item.label;e.tab.title=item.title||item.label;
   e.tab.querySelector('i')!.className=`state-dot dot-${item.status||'idle'}`;
   e.tab.classList.toggle('selected',next.selected===item.id);e.wrap.classList.toggle('selected',next.selected===item.id);
   e.tab.setAttribute('aria-selected',String(next.selected===item.id));e.tab.setAttribute('aria-controls',next.kind==='project'?'mitter-project-view':'mitter-task-view');
   e.close.hidden=!next.onClose;e.close.title='Close '+item.label+' tab (keeps work saved)';e.close.setAttribute('aria-label','Close '+item.label+' tab');
   if(!list.contains(doc.activeElement)||selectedBefore!==next.selected){e.tab.tabIndex=next.selected===item.id?0:-1;e.close.tabIndex=next.selected===item.id?0:-1;}
  }
  if(!next.items.length)list.append(empty);else empty.remove();
  add.disabled=!!next.addDisabled||!next.canAdd;add.title=next.addLabel;add.setAttribute('aria-label',next.addLabel);
  all.hidden=!next.onList;all.title=next.listLabel||('All '+next.kind+'s');all.setAttribute('aria-label',all.title);
  if(selectedBefore!==next.selected){entries.get(next.selected)?.tab.scrollIntoView({block:'nearest',inline:'nearest'});selectedBefore=next.selected;resetRoving();}
  if(hadFocus&&!list.contains(doc.activeElement))(entries.get(next.selected)?.tab||add).focus({preventScroll:true});
 }
 function key(event:KeyboardEvent){
  const current=(event.target as HTMLElement).closest<HTMLButtonElement>('[role=tab]');if(!current||!list.contains(current))return;
  if(event.key==='Delete'&&options.onClose){event.preventDefault();close(current.dataset.tabId!);return;}
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const enabled=Array.from(list.querySelectorAll<HTMLButtonElement>('[role=tab]:not(:disabled)'));if(!enabled.length)return;
  event.preventDefault();let index=enabled.indexOf(current);if(event.key==='Home')index=0;else if(event.key==='End')index=enabled.length-1;else index=(index+(event.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length;
  for(const b of enabled)b.tabIndex=-1;enabled[index]!.tabIndex=0;enabled[index]!.focus({preventScroll:true});enabled[index]!.scrollIntoView({block:'nearest',inline:'nearest'});
 }
 const leave=(e:FocusEvent)=>{if(!list.contains(e.relatedTarget as Node))resetRoving();};
 list.addEventListener('keydown',key);list.addEventListener('focusout',leave);update(initial);
 return{update,dispose(){for(const e of entries.values())e.menu?.dispose();list.removeEventListener('keydown',key);list.removeEventListener('focusout',leave);root.replaceChildren();}};
}
