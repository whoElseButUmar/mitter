import {createPopover, uiId, type PopoverHandle} from './popover.js';
export interface MenuItem {id:string;label:string;disabled?:boolean;danger?:boolean;separatorBefore?:boolean;shortcut?:string;run():void;}
export interface MenuHandle {trigger:HTMLElement;popup:PopoverHandle;update(items:MenuItem[],disabled?:boolean):void;dispose():void;}
/** The same lifetime/dismissal model as select-only comboboxes. */
export function mountMenu(root:HTMLElement,label:string,initial:MenuItem[],context?:{trigger:HTMLElement;items:()=>MenuItem[]}):MenuHandle {
  const doc=root.ownerDocument;
  const trigger=context?.trigger||doc.createElement('button');
  if(!context){(trigger as HTMLButtonElement).type='button';trigger.id=uiId('menu-button');trigger.className='menu-trigger';trigger.textContent=label;const caret=doc.createElement('span');caret.className='control-caret';caret.setAttribute('aria-hidden','true');trigger.append(caret);}
  const panel=doc.createElement('div');panel.className='menu-popup';if(context)panel.setAttribute('aria-label',label);else panel.setAttribute('aria-labelledby',trigger.id);if(!context)root.append(trigger);root.append(panel);
  let point:{x:number;y:number}|undefined;
  let items=initial,buttons:HTMLButtonElement[]=[],active=-1,typed='',typedAt=0;
  function focus(index:number){if(index<0||!buttons[index]||buttons[index]!.disabled)return;active=index;buttons[index]!.focus({preventScroll:true});buttons[index]!.scrollIntoView({block:'nearest'});}
  const enabled=()=>buttons.map((b,i)=>b.disabled?-1:i).filter(i=>i>=0);
  const popup=createPopover(trigger,panel,{role:'menu',align:context?'start':'end',minWidth:222,decorateTrigger:!context,anchor:()=>{const r=trigger.getBoundingClientRect();return context&&point?{left:point.x,right:point.x,top:point.y,bottom:point.y,width:0}:r;},onOpen:()=>{typed='';typedAt=0;focus(enabled()[0]??-1);}});
  function update(next:MenuItem[],disabled=false){
    const previousFocus=buttons[active]===doc.activeElement?items[active]?.id:undefined;
    const shape=JSON.stringify(items.map(i=>[i.id,i.label,!!i.disabled,!!i.danger,!!i.separatorBefore,i.shortcut]));
    const changed=!buttons.length||shape!==JSON.stringify(next.map(i=>[i.id,i.label,!!i.disabled,!!i.danger,!!i.separatorBefore,i.shortcut]));
    items=next;if(!context)(trigger as HTMLButtonElement).disabled=disabled;if(disabled)popup.close('disabled');
    if(changed){panel.replaceChildren();buttons=[];
      for(const item of items){
        if(item.separatorBefore){const separator=doc.createElement('div');separator.className='menu-separator';separator.setAttribute('role','separator');panel.append(separator);}
        const button=doc.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.tabIndex=-1;button.disabled=!!item.disabled;button.setAttribute('aria-disabled',String(!!item.disabled));button.className='menu-item';if(item.danger)button.classList.add('danger');button.textContent=item.label;if(item.shortcut){const hint=doc.createElement('kbd');hint.className='menu-shortcut';hint.textContent=item.shortcut;button.append(hint);}
        button.addEventListener('focus',()=>{active=buttons.indexOf(button);});
        button.addEventListener('pointermove',e=>{if(popup.isOpen()&&!button.disabled&&e.pointerType!=='touch')button.focus({preventScroll:true});});
        button.addEventListener('click',()=>{const current=items.find(i=>i.id===item.id);if(!current||current.disabled)return;popup.close('selection');current.run();});
        panel.append(button);buttons.push(button);
      }
      if(popup.isOpen()){const i=items.findIndex(i=>i.id===previousFocus&&!i.disabled);focus(i>=0?i:(enabled()[0]??-1));popup.position();}
    }
  }
  const click=()=>popup.toggle();
  const triggerKey=(e:KeyboardEvent)=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();popup.open();focus(e.key==='ArrowUp'?(enabled().at(-1)??-1):(enabled()[0]??-1));}};
  const menuKey=(e:KeyboardEvent)=>{
    const indices=enabled(),idx=indices.indexOf(active);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
      e.preventDefault();const index=e.key==='Home'?indices[0]:e.key==='End'?indices.at(-1):indices[(idx+(e.key==='ArrowDown'?1:-1)+indices.length)%indices.length];focus(index??-1);
    }else if(e.key==='Tab'){
      // Let the browser continue from the trigger's normal document position.
      popup.close('tab');trigger.focus({preventScroll:true});
    }else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&(e.key!==' '||(typed&&Date.now()-typedAt<700))){
      e.preventDefault();const now=Date.now();typed=now-typedAt<700?typed+e.key:e.key;typedAt=now;let q=typed.toLocaleLowerCase();if([...q].every(c=>c===q[0]))q=q[0]!;
      for(let offset=1;offset<=indices.length;offset++){const i=indices[(idx+offset)%indices.length]!;if(items[i]!.label.toLocaleLowerCase().startsWith(q)){focus(i);break;}}
    }
  };
  const openContext=(e:MouseEvent|KeyboardEvent)=>{
    const target=e.target instanceof doc.defaultView!.Element?e.target:undefined;
    if(root.hasAttribute('data-miter-context')&&(target?.closest('input,textarea,[contenteditable=true]')||target?.closest('[data-miter-context]')!==root))return;
    e.preventDefault();e.stopPropagation();point=e instanceof doc.defaultView!.MouseEvent&&e.button===2?{x:e.clientX,y:e.clientY}:undefined;update(context!.items());popup.open();};
  const contextKey=(e:KeyboardEvent)=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey)openContext(e);};
  if(context){root.addEventListener('contextmenu',openContext);trigger.addEventListener('keydown',contextKey);}else{trigger.addEventListener('click',click);trigger.addEventListener('keydown',triggerKey);}
  panel.addEventListener('keydown',menuKey);update(initial);
  return {trigger,popup,update,dispose(){popup.dispose();trigger.removeEventListener('click',click);trigger.removeEventListener('keydown',triggerKey);panel.removeEventListener('keydown',menuKey);root.removeEventListener('contextmenu',openContext);trigger.removeEventListener('keydown',contextKey);if(!context)root.replaceChildren();}};
}
