import {createEffect,onMount,onCleanup,type JSX} from 'solid-js';
import {mountMenu,type MenuItem} from '../../../packages/ui/src/menu';
import {mountTabRow,type TabRowOptions} from '../../../packages/ui/src/tab-row';
import {enhanceSelects} from '../../../packages/ui/src/select';
import {bindInfoPopover,uiId} from '../../../packages/ui/src/popover';
import {Icon} from './icons';
export function WorkspaceTabRow(props:TabRowOptions){
 let root!:HTMLDivElement;
 onMount(()=>{const row=mountTabRow(root,props);createEffect(()=>row.update({...props,items:props.items,selected:props.selected,addDisabled:props.addDisabled,canAdd:props.canAdd,addLabel:props.addLabel,onClose:props.onClose,onList:props.onList,listLabel:props.listLabel,menuItems:props.menuItems}));onCleanup(row.dispose);});
 return <div ref={root}/>;
}
export function MenuButton(props:{label:string;items:MenuItem[];disabled?:boolean}){
 let root!:HTMLDivElement;
 onMount(()=>{const menu=mountMenu(root,props.label,props.items);createEffect(()=>menu.update(props.items,props.disabled));onCleanup(menu.dispose);});
 return <div class="menu-control" ref={root}/>;
}
export function InfoPopover(props:{label:string;title:string;children:JSX.Element}){
 let trigger!:HTMLButtonElement,panel!:HTMLDivElement;
 const id=uiId('info-button');
 onMount(()=>{const pop=bindInfoPopover(trigger,panel);onCleanup(pop.dispose);});
 return <div class="info-control"><button id={id} ref={trigger} type="button" class="info-trigger">{props.label}<Icon name="down" size={12}/></button><div ref={panel} hidden tabindex="-1" class="info-popup" aria-label={props.title}>{props.children}</div></div>;
}
/** Progressive enhancement for forms whose DOM is rendered by Solid. */
export function SelectSurface(props:{children:JSX.Element}){
 let root!:HTMLDivElement;
 onMount(()=>{const selects=enhanceSelects(root);onCleanup(selects.dispose);});
 return <div ref={root}>{props.children}</div>;
}
