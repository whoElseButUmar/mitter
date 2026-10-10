import { onMount, onCleanup, type JSX } from 'solid-js';
import { Icon } from './icons';
import { closeActivePopover } from '../../../packages/ui/src/popover';
export function Modal(props:{title:string;children:JSX.Element;close:()=>void;wide?:boolean;closeDisabled?:boolean}) {
  let dialog!:HTMLDialogElement;
  let opener:HTMLElement|null=null;
  onMount(()=>{opener=document.activeElement as HTMLElement;closeActivePopover(document,'superseded');dialog.showModal();});
  onCleanup(()=>{closeActivePopover(document,'dispose');dialog.close();if(opener?.isConnected&&!document.querySelector('dialog[open]'))opener.focus({preventScroll:true});});
  return <dialog ref={dialog} classList={{wide:props.wide??false}} onCancel={event=>{event.preventDefault();if(!props.closeDisabled)props.close();}}>
    <div class="modal-head"><h2>{props.title}</h2><button type="button" class="icon-button" title="Close dialog" aria-label="Close dialog" disabled={props.closeDisabled} onClick={props.close}><Icon name="close"/></button></div>{props.children}
  </dialog>;
}
export function Field(props:{label:string;hint?:string;children:JSX.Element}){return <label class="field"><span>{props.label}</span>{props.children}{props.hint&&<small>{props.hint}</small>}</label>;}
export function Empty(props:{title:string;text:string;children?:JSX.Element}){return <div class="empty"><div class="empty-glyph"><Icon name="bolt" size={26}/></div><h2>{props.title}</h2><p>{props.text}</p>{props.children}</div>;}
export function Status(props:{value:string}){return <span class={`status status-${props.value}`}><i/>{props.value.replaceAll('_',' ')}</span>;}
