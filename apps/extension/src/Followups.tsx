import type {RewriteRequest} from '../../../packages/protocol/src/rewrite';
import {createEffect,onMount,onCleanup,For,Show,createSignal} from 'solid-js';
import {mountFollowupComposer} from '../../../packages/ui/src/followup-composer';
import type {FollowupSummary} from '../../../packages/protocol/src/requests';
import type {ChangeRequest} from './FileViewer';
import {ContextArea} from './ContextArea';
export function FollowupPanel(props:{workerId:string;items:FollowupSummary[];running:boolean;disabled:boolean;send:(r:ChangeRequest)=>Promise<unknown>;steer:(r:ChangeRequest)=>Promise<unknown>;cancel:(id:string)=>Promise<unknown>;copy:(v:string)=>Promise<void>;history:()=>void;rewrite:(request:RewriteRequest,signal:AbortSignal)=>Promise<string>;start:()=>Promise<unknown>}){
 let root!:HTMLDivElement;const [error,setError]=createSignal('');
 onMount(()=>{const form=mountFollowupComposer(root,{workerId:props.workerId,running:props.running,disabled:props.disabled,rewrite:props.rewrite,send:r=>props.send({...r,autoStart:true}),steer:r=>props.steer({...r,autoStart:true})});createEffect(()=>form.update({workerId:props.workerId,running:props.running,disabled:props.disabled,rewrite:props.rewrite,send:r=>props.send({...r,autoStart:true}),steer:r=>props.steer({...r,autoStart:true})}));onCleanup(form.dispose);});
 const pending=()=>props.items.filter(f=>['queued','blocked'].includes(f.status));
 return <section class="followup-section" aria-label="Follow up on this task"><div class="followup-topline"><span>Continue this task</span><Show when={props.items.length}><button class="text-button" onClick={props.history}>Follow-up history</button></Show></div><div ref={root}/>
  <Show when={pending().length}><details class="followup-queue" open><summary>{pending().length} pending follow-up{pending().length===1?'':'s'}</summary><Show when={!props.running}><button class="text-button" onClick={()=>void props.start().catch(e=>setError(String(e)))}>Continue queued follow-ups</button></Show><For each={pending()}>{f=><ContextArea label="Follow-up actions" items={[{id:'copy',label:'Copy request',run:()=>void props.copy(f.instruction)},{id:'remove',label:'Remove queued request',run:()=>{void props.cancel(f.id).catch(e=>setError(String(e)));}}]}><div class="followup-row"><span>{f.instruction}</span><small>{f.status}</small><button class="icon-button" title="Remove queued request" aria-label="Remove queued request" onClick={()=>void props.cancel(f.id).catch(e=>setError(String(e)))}>×</button></div><Show when={f.error}><p class="error">{f.error}</p></Show></ContextArea>}</For></details></Show><Show when={error()}><p class="error">{error()}</p></Show>
 </section>;
}
