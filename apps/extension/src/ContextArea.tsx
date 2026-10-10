import {onMount,onCleanup,type JSX} from 'solid-js';
import {mountMenu,type MenuItem} from '../../../packages/ui/src/menu';
/** Context actions belong to a scope. Text inputs keep the OS editing menu. */
export function ContextArea(props:{items:MenuItem[];children:JSX.Element;class?:string;label?:string;focusable?:boolean}){
 let root!:HTMLDivElement;
 onMount(()=>{const menu=mountMenu(root,props.label||'Actions',[],{trigger:root,items:()=>props.items});onCleanup(menu.dispose);});
 return <div ref={root} class={'context-area '+(props.class||'')} data-miter-context tabindex={props.focusable?0:undefined} aria-label={props.label}>{props.children}</div>;
}
