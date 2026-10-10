import { onMount, onCleanup } from 'solid-js';
import { Modal } from './components';
import { mountStartSheet, type ChatChoice } from '../../../packages/bridge/src/start-sheet';
export function AutomationForm(props:{close:()=>void;rpc:<T=unknown>(method:string,params?:Record<string,unknown>)=>Promise<T>;workerId:string;started:()=>void}) {
 let root!:HTMLDivElement;
 onMount(()=>{
  const dispose=mountStartSheet(root,{
   authorize:()=>chrome.permissions.request({origins:['https://chatgpt.com/*','https://chat.openai.com/*']}),
   lastChat:()=>props.rpc<ChatChoice|null>('bridge.lastChat',{workerId:props.workerId}),
   loadChats:()=>props.rpc<ChatChoice[]>('bridge.tabs'),
   start:options=>props.rpc('bridge.start',{workerId:props.workerId,...options}),
   stop:()=>props.rpc('bridge.stop',{workerId:props.workerId}),
   close:props.close,started:props.started,
  });onCleanup(dispose);
 });
 return <Modal title="Run with ChatGPT" close={props.close}><div ref={root}/></Modal>;
}
