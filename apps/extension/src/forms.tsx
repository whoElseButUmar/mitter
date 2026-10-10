import { mountModelSettingsForm } from '../../../packages/ui/src/model-settings-form';
import { createSignal, Show, onMount, onCleanup } from 'solid-js';
import type { Project, Settings, Check } from '../../../packages/protocol/src/index';
import { Field, Modal } from './components';
import { Icon } from './icons';
import { mountTaskSheet, type TaskSheetDependencies } from '../../../packages/bridge/src/task-sheet';
export function ProjectForm(props:{close:()=>void;save:(p:Record<string,unknown>)=>Promise<void>;pick:()=>Promise<{root?:string;cancelled:boolean}>}) {
 const [busy,setBusy]=createSignal(false),[error,setError]=createSignal(''),[root,setRoot]=createSignal(''),[name,setName]=createSignal('');
 const choose=async()=>{setBusy(true);setError('');try{const r=await props.pick();if(r.root){setRoot(r.root);if(!name())setName(r.root.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)||'Project');}}catch(e){setError(String(e));}finally{setBusy(false);}};
 const submit=async(e:SubmitEvent)=>{e.preventDefault();setBusy(true);setError('');try{await props.save({name:name(),root:root()});props.close();}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <Modal title="Open a project" close={props.close}><form onSubmit={submit}>
  <p class="muted">Choose the folder Miter should work in.</p>
  <button type="button" class="folder-picker full" onClick={choose} disabled={busy()}><Icon name="folder"/>{busy()?'Opening…':'Choose Folder…'}</button>
  <Field label="Folder path"><input required value={root()} onInput={e=>setRoot(e.currentTarget.value)} placeholder="Or enter an absolute folder path" spellcheck={false}/></Field>
  <Field label="Project name"><input required value={name()} onInput={e=>setName(e.currentTarget.value)} maxLength={60} placeholder="My project"/></Field>
  <p class="muted small">Only this folder is registered. Project commands still run with your computer’s permissions.</p>
  <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="button-row end"><button type="button" onClick={props.close}>Cancel</button><button class="primary" type="submit" disabled={busy()||!root()||!name()}>Open project</button></div>
 </form></Modal>;
}
export function WorkerForm(props:TaskSheetDependencies) {
 let root!:HTMLDivElement;
 onMount(()=>{const dispose=mountTaskSheet(root,props);onCleanup(dispose);});
 return <Modal title="New task" close={props.close}><div ref={root}/></Modal>;
}
export function ProfileForm(props:{project:Project;close:()=>void;save:(p:Record<string,unknown>)=>Promise<void>}) {
 const [error,setError]=createSignal(''),[busy,setBusy]=createSignal(false);let id!:HTMLInputElement,label!:HTMLInputElement,program!:HTMLInputElement,args!:HTMLTextAreaElement;
 const submit=async(e:SubmitEvent)=>{e.preventDefault();setBusy(true);try{await props.save({projectId:props.project.id,profile:{id:id.value,label:label.value,program:program.value,args:JSON.parse(args.value),timeoutMs:120000}});props.close();}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <Modal title="Register a command" close={props.close}><form onSubmit={submit}>
  <p class="muted">Only you can register programs. Models can request an existing profile, never supply a shell command.</p>
  <div class="form-row"><Field label="Profile ID"><input ref={id} required pattern="[a-zA-Z0-9_-]+" value="test"/></Field><Field label="Display name"><input ref={label} required value="Run tests"/></Field></div>
  <Field label="Executable"><input ref={program} required value="node" spellcheck={false}/></Field>
  <Field label="Arguments (JSON array)" hint={'For npm on macOS/Linux: executable npm, arguments ["test"]. Windows setup notes explain the shell-free equivalent.'}><textarea ref={args} required rows={3} class="mono" spellcheck={false}>{'["--test"]'}</textarea></Field>
  <p class="notice">A test script can modify files, access the network, or run other programs. Miter requests approval before executing it.</p>
  <Show when={error()}><p class="error" role="alert">{error()}</p></Show><button type="submit" class="primary full" disabled={busy()}>Register profile</button>
 </form></Modal>;
}
export function SettingsForm(props:{settings:Settings;close:()=>void;save:(p:Record<string,unknown>)=>Promise<void>}) {
 const [busy,setBusy]=createSignal(false);let root!:HTMLDivElement,editor:ReturnType<typeof mountModelSettingsForm>|undefined;
 onMount(()=>{editor=mountModelSettingsForm(root,{settings:props.settings,save:props.save,close:props.close,busyChanged:setBusy,
  reset:()=>{props.close();window.dispatchEvent(new Event('miter-request-reset'));}});});
 onCleanup(()=>editor?.dispose());
 return <Modal title="Settings" close={props.close} closeDisabled={busy()}><div ref={root}/></Modal>;
}
