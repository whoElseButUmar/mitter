import {createPopover, uiId, type PopoverHandle} from './popover.js';
/** A select-only combobox with the original select retained for form values and
 * validity. No platform popup, no source text interpreted as markup. */
export interface EnhancedSelect {trigger: HTMLButtonElement; popup: PopoverHandle; refresh(): void; dispose(): void;}
export function enhanceSelect(select: HTMLSelectElement): EnhancedSelect {
  const doc = select.ownerDocument, win = doc.defaultView! as Window & typeof globalThis;
  const original = {hidden:select.hidden, tabindex:select.getAttribute('tabindex'), aria:select.getAttribute('aria-hidden')};
  const label = select.closest('label'), originalFor = label?.getAttribute('for');
  const shell = doc.createElement('span'); shell.className = 'select-control';
  const trigger = doc.createElement('button'); trigger.type = 'button'; trigger.id = uiId('select'); trigger.className = 'select-trigger'; trigger.setAttribute('role','combobox');
  const value = doc.createElement('span'); value.className = 'select-value';
  const caret = doc.createElement('span'); caret.className = 'control-caret'; caret.setAttribute('aria-hidden','true');
  trigger.append(value,caret);
  const error = doc.createElement('span'); error.className = 'select-error'; error.id = uiId('select-error'); error.setAttribute('role','alert'); error.hidden = true;
  shell.append(trigger,error); select.after(shell);
  const labelText = label?.querySelector<HTMLElement>(':scope > span');
  if (label) label.htmlFor = trigger.id;
  if (labelText && labelText !== shell) { labelText.id ||= uiId('label'); trigger.setAttribute('aria-labelledby',labelText.id); }
  else trigger.setAttribute('aria-label',select.getAttribute('aria-label') || select.name || 'Choose an option');
  const panel = doc.createElement('div'); panel.className = 'select-popup'; panel.setAttribute('aria-label',labelText?.textContent || select.getAttribute('aria-label') || 'Options');
  shell.append(panel); select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden','true'); select.dataset.enhanced = 'true';
  let highlight = -1, signature = '', disposed = false, buffer = '', typedAt = 0;
  let rows: HTMLElement[] = [];
  const options = () => Array.from(select.options);
  const enabled = (i:number) => { const o=select.options[i]; return !!o && !o.disabled && !o.hidden && !(o.parentElement instanceof win.HTMLOptGroupElement && o.parentElement.disabled); };
  function paint(scroll = false) {
    rows.forEach((row,i) => {row.classList.toggle('highlighted',i===highlight);row.setAttribute('aria-selected',String(i===select.selectedIndex));});
    if (popup.isOpen() && rows[highlight]) { trigger.setAttribute('aria-activedescendant',rows[highlight]!.id); if(scroll) rows[highlight]!.scrollIntoView({block:'nearest'}); }
    else trigger.removeAttribute('aria-activedescendant');
  }
  function commit(index: number, restore = true) {
    if (!enabled(index)) { popup.close(restore?'selection':'tab'); return; }
    const changed = select.selectedIndex !== index; select.selectedIndex = index; highlight = index;
    popup.close(restore?'selection':'tab'); error.hidden=true; error.textContent=''; trigger.removeAttribute('aria-invalid'); trigger.removeAttribute('aria-describedby');
    if (changed) {select.dispatchEvent(new win.Event('input',{bubbles:true}));select.dispatchEvent(new win.Event('change',{bubbles:true}));}
    refresh();
  }
  const popup = createPopover(trigger,panel,{role:'listbox',matchWidth:true,onOpen:() => {trigger.focus({preventScroll:true});buffer='';typedAt=0;refresh();highlight=enabled(select.selectedIndex)?select.selectedIndex:options().findIndex((_,i)=>enabled(i));paint(true);},onClose:() => {buffer='';typedAt=0;trigger.removeAttribute('aria-activedescendant');highlight=select.selectedIndex;paint();}});
  function refresh() {
    if (disposed) return;
    const list=options(), next=JSON.stringify(list.map((o,i)=>[o.value,o.text,o.disabled,o.hidden,enabled(i)]));
    if (next!==signature) {
      signature=next; panel.replaceChildren();rows=[];
      list.forEach((option,i) => {
        const row=doc.createElement('div');row.id=uiId('option');row.className='select-option';row.setAttribute('role','option');row.dataset.value=option.value;row.setAttribute('aria-disabled',String(!enabled(i)));row.hidden=option.hidden;
        const check=doc.createElement('span');check.className='option-check';check.setAttribute('aria-hidden','true');
        const text=doc.createElement('span');text.textContent=option.text;row.append(check,text);
        row.addEventListener('pointerdown',e=>e.preventDefault());
        row.addEventListener('pointermove',()=>{if(enabled(i)){highlight=i;paint();}});
        row.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(!trigger.disabled)commit(i);});
        panel.append(row);rows.push(row);
      });
    }
    value.textContent=select.selectedOptions[0]?.text || 'Choose…'; trigger.title=value.textContent;
    trigger.disabled=select.disabled;trigger.setAttribute('aria-disabled',String(select.disabled));trigger.setAttribute('aria-required',String(select.required));
    if (select.disabled) popup.close('disabled');
    if(select.validity.valid){error.hidden=true;error.textContent='';trigger.removeAttribute('aria-invalid');trigger.removeAttribute('aria-describedby');}
    if(!popup.isOpen())highlight=select.selectedIndex;
    paint();popup.position();
  }
  function move(delta:number) {
    const list=options();if(!list.length)return;
    for(let step=1;step<=list.length;step++){const i=(highlight+delta*step+list.length*2)%list.length;if(enabled(i)){highlight=i;paint(true);return;}}
  }
  function key(event:KeyboardEvent) {
    if(trigger.disabled)return;
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const was=popup.isOpen();if(!was)popup.open();
      if(event.key==='Home'||event.key==='End'){const indices=options().map((_,i)=>i).filter(enabled);highlight=(event.key==='Home'?indices[0]:indices.at(-1))??-1;paint(true);}else if(was)move(event.key==='ArrowDown'?1:-1);
    }else if(event.key==='Enter'||(event.key===' '&&!(buffer&&Date.now()-typedAt<700))){event.preventDefault();if(popup.isOpen())commit(highlight);else popup.open();}
    else if(event.key==='Tab'&&popup.isOpen()){commit(highlight,false);}
    else if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
      event.preventDefault();const now=Date.now();buffer=now-typedAt<700?buffer+event.key:event.key;typedAt=now;
      let query=buffer.toLocaleLowerCase();if([...query].every(c=>c===query[0]))query=query[0]!;
      const list=options(),start=(query.length===1?highlight+1:highlight)+list.length;
      for(let n=0;n<list.length;n++){const i=(start+n)%list.length;if(enabled(i)&&list[i]!.text.toLocaleLowerCase().startsWith(query)){highlight=i;if(popup.isOpen())paint(true);else commit(i,false);break;}}
    }
  }
  const click=()=>popup.toggle();
  const invalid=(e:Event)=>{e.preventDefault();error.textContent=select.validationMessage;error.hidden=false;trigger.setAttribute('aria-invalid','true');trigger.setAttribute('aria-describedby',error.id);trigger.focus();};
  trigger.addEventListener('click',click);trigger.addEventListener('keydown',key);select.addEventListener('change',refresh);select.addEventListener('invalid',invalid);
  const observer=new win.MutationObserver(refresh);observer.observe(select,{attributes:true,childList:true,subtree:true,characterData:true});
  const reset=()=>win.queueMicrotask(refresh);select.form?.addEventListener('reset',reset);
  refresh();
  return {trigger,popup,refresh,dispose(){if(disposed)return;disposed=true;observer.disconnect();popup.dispose();select.removeEventListener('change',refresh);select.removeEventListener('invalid',invalid);select.form?.removeEventListener('reset',reset);shell.remove();select.hidden=original.hidden;
    if(original.tabindex===null)select.removeAttribute('tabindex');else select.setAttribute('tabindex',original.tabindex);
    if(original.aria===null)select.removeAttribute('aria-hidden');else select.setAttribute('aria-hidden',original.aria);
    delete select.dataset.enhanced;if(label){if(originalFor===null||originalFor===undefined)label.removeAttribute('for');else label.setAttribute('for',originalFor);}
  }};
}
export function enhanceSelects(root:HTMLElement): {refresh():void;dispose():void} {
  const controls=Array.from(root.querySelectorAll<HTMLSelectElement>('select:not([data-enhanced])')).map(enhanceSelect);
  return {refresh:()=>controls.forEach(c=>c.refresh()),dispose:()=>controls.forEach(c=>c.dispose())};
}
