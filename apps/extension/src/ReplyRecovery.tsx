import {onMount,onCleanup} from 'solid-js';
import {mountReplySheet} from '../../../packages/bridge/src/reply-sheet';
import type {ReplyPreview} from '../../../packages/bridge/src/reply-recovery';
import {userReadClipboard} from './client';
export function ReplyRecovery(props:{workerId:string;rpc:<T>(method:string,params:Record<string,unknown>)=>Promise<T>;close:()=>void;applied:()=>void}){
  let root!:HTMLDivElement;
  onMount(()=>{const dispose=mountReplySheet(root,{
    workerId:props.workerId,
    preview:p=>props.rpc<ReplyPreview>('bridge.replyPreview',p),
    apply:p=>props.rpc('bridge.replyApply',p),
    readClipboard:userReadClipboard,close:props.close,applied:props.applied,
  });onCleanup(dispose);});
  return <div ref={root}/>;
}
