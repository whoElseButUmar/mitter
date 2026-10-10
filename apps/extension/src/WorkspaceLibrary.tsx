import {onMount,onCleanup,createEffect} from 'solid-js';
import {mountLibrary,type LibraryOptions} from '../../../packages/ui/src/library';
export function WorkspaceLibrary(props:LibraryOptions){
 let root!:HTMLDivElement;
 onMount(()=>{const lib=mountLibrary(root,props);createEffect(()=>lib.update({...props,state:props.state,projects:props.projects,tasks:props.tasks,initialFilter:props.initialFilter}));onCleanup(lib.dispose);});
 return <div ref={root}/>;
}
