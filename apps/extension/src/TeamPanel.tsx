import {createEffect,createSignal,onCleanup,For,Show} from 'solid-js';
import type {PreviewRPC} from '../../../packages/ui/src/preview';
import {ContextArea} from './ContextArea';
export function TeamPanel(props:{workerId:string;rpc:PreviewRPC;revision:number;copy:(s:string)=>Promise<void>;success?:(s:string)=>void}){
 const [data,setData]=createSignal<any>({peers:[],messages:[]}),[text,setText]=createSignal(''),[busy,setBusy]=createSignal(false),[error,setError]=createSignal('');let generation=0;
 const load=async()=>{const gen=++generation,id=props.workerId;try{const r=await props.rpc('worker.team',{workerId:id});if(gen===generation)setData(r);}catch(e){setError(String(e));}};
 createEffect(()=>{props.workerId;props.revision;void load();});onCleanup(()=>generation++);
 return <section class="team-panel"><h2>Project team</h2><p class="muted small">Updates reach other tasks in their next model turn. File checks protect shared work in the meantime.</p>
  <For each={data().peers} fallback={<p class="muted">No other tasks in this project yet.</p>}>{(peer:any)=><ContextArea items={[{id:'copy',label:'Copy task summary',run:()=>void props.copy(peer.name+' · '+peer.state+' · '+peer.branch)}]}><div class="team-peer"><strong>{peer.name}</strong><small>{peer.held||peer.state} · {peer.branch}</small></div></ContextArea>}</For>
  <h3>Recent updates</h3><For each={data().messages} fallback={<p class="muted">No team messages yet.</p>}>{(m:any)=><ContextArea items={[{id:'copy',label:'Copy update',run:()=>void props.copy(m.message||m.text||'')}]}><div class="team-message"><time>{new Date(m.createdAt||m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time><p>{m.message||m.text}</p></div></ContextArea>}</For>
  <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await props.rpc('worker.teamMessage',{workerId:props.workerId,message:text(),id:crypto.randomUUID()});setText('');props.success?.('Project update shared.');await load();}catch(e){setError(String(e));}finally{setBusy(false);}}}><label class="field"><span>Share a project update</span><textarea required maxlength="3000" rows="2" value={text()} onInput={e=>setText(e.currentTarget.value)}/></label><div class="button-row end"><button disabled={busy()||!text().trim()}>Send update</button></div></form><Show when={error()}><p class="error">{error()}</p></Show>
 </section>;
}
