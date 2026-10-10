import { DEFAULT_SETTINGS } from '../../../packages/protocol/src/model-settings';
import type {RewriteRequest} from '../../../packages/protocol/src/rewrite';
import {HealthPanel,ChangeReview} from './ReleaseTools';
import { filePreviewURL, fileWindowOptions } from '../../../packages/ui/src/file-target';
import { ToastCenter, mountToasts } from '../../../packages/ui/src/toast';
import { FileViewer, type ChangeRequest } from './FileViewer';
import { FollowupPanel } from './Followups';
import { TeamPanel } from './TeamPanel';
import { ContextArea } from './ContextArea';
import type { Followup } from '../../../packages/protocol/src/requests';
import { preferReplyRecovery } from '../../../packages/bridge/src/reply-recovery';
import { ReplyRecovery } from './ReplyRecovery';
import { lazy, createSignal, createMemo, createEffect, onMount, onCleanup, batch, For, Show } from 'solid-js';
import type { Snapshot, Worker, Project, Activity } from '../../../packages/protocol/src/index';
import { displayTaskName } from '../../../packages/protocol/src/task-brief';
import { APP_VERSION } from '../../../packages/protocol/src/index';
import type { BridgeStatus } from '../../../packages/bridge/src/index';
import { taskPresentation, turnLabel, budgetExhausted } from '../../../packages/bridge/src/presentation';
import type { DebugEntry } from '../../../packages/bridge/src/diagnostics';
import { HostClient, userReadClipboard } from './client';
import { Icon, Mark } from './icons';
import { Modal, Status } from './components';
import { ProjectForm, WorkerForm, ProfileForm, SettingsForm } from './forms';
import { DebugConsole } from './DebugConsole';
import { AutomationForm } from './AutomationForm';
import { WorkspaceTabRow, MenuButton, InfoPopover } from './controls';
import { emptyWorkspace, currentTask, type WorkspaceState, type WorkspaceAction, type TabKind } from '../../../packages/ui/src/workspace';
import { WorkspaceLibrary } from './WorkspaceLibrary';
import type {LibraryView,LibraryFilter} from '../../../packages/ui/src/library';
import type {MenuItem} from '../../../packages/ui/src/menu';
import { tabId } from '../../../packages/ui/src/tab-row';
import { closeActivePopover } from '../../../packages/ui/src/popover';
import './style.css';
const running=new Set(['queued','planning','waiting_model','waiting_lock','executing','verifying']);
const initial:Snapshot={protocol:'mitter/1',projects:[],workers:[],events:[],settings:{...DEFAULT_SETTINGS},runtime:{node:'',workflow:'',models:'Not connected'}};
type ChangedFile={path:string;status:string;bytes:number};
const TerminalDock=lazy(()=>import('./TerminalDock').then(module=>({default:module.TerminalDock})));
export default function App() {
 const [snapshot,setSnapshot]=createSignal<Snapshot>(initial),[navigation,setNavigation]=createSignal(emptyWorkspace()),[connected,setConnected]=createSignal(false),[connectionError,setConnectionError]=createSignal('');
 const selected=createMemo(()=>currentTask(navigation()));
 // New-task forms capture their project when opened, never when submitted.
 const [formProjectId,setFormProjectId]=createSignal('');
 const toasts=new ToastCenter();
 const success=(message:string)=>toasts.push({message,kind:'success'});
 const info=(message:string)=>toasts.push({message,kind:'info'});
 // Clear calls from existing forms do not erase other operation's feedback.
 const setNotice=(message:string)=>{if(message)toasts.push({message,kind:'error'});};
 const [modal,setModal]=createSignal(''),[textValue,setTextValue]=createSignal(''),[handoff,setHandoff]=createSignal(''),[trust,setTrust]=createSignal(false),[busy,setBusy]=createSignal(false);
 const [terminalOpen,setTerminalOpen]=createSignal(false),[terminalMounted,setTerminalMounted]=createSignal(false);
 const toggleTerminal=()=>{setTerminalMounted(true);setTerminalOpen(v=>!v);setDebugOpen(false);};
 const [debugOpen,setDebugOpen]=createSignal(false),[logs,setLogs]=createSignal<DebugEntry[]>([]),[bridges,setBridges]=createSignal<BridgeStatus[]>([]);
 const [files,setFiles]=createSignal<ChangedFile[]>([]),[file,setFile]=createSignal(''),[content,setContent]=createSignal(''),[view,setView]=createSignal('result');
 const [libraryView,setLibraryView]=createSignal<LibraryView>('projects'),[libraryScope,setLibraryScope]=createSignal(''),[libraryFilter,setLibraryFilter]=createSignal<LibraryFilter>('all');
 const [renameTarget,setRenameTarget]=createSignal<{kind:TabKind;id:string}|null>(null),[renameValue,setRenameValue]=createSignal(''),[renameError,setRenameError]=createSignal('');
 const [fileLibrary,setFileLibrary]=createSignal<string[]>([]),[fileQuery,setFileQuery]=createSignal('');
 const [followupHistory,setFollowupHistory]=createSignal<Followup[]>([]);
 const [mission,setMission]=createSignal(''),[conventions,setConventions]=createSignal('');
 const [notifications,setNotifications]=createSignal({enabled:false,sound:false});
 const [automationWorker,setAutomationWorker]=createSignal('');
 const [replyWorker,setReplyWorker]=createSignal('');
 const useReply=()=>{setReplyWorker(selected());setModal('reply-recovery');};
 const applyNavigation=(next:WorkspaceState)=>{
   if(next.revision<navigation().revision)return;
   const previous=selected(),priorProject=navigation().projectId;
   batch(()=>{setNavigation(next);if(previous!==currentTask(next)||priorProject!==next.projectId){closeActivePopover(document);clearPreview();}});
 };
 const client=new HostClient(s=>setSnapshot(s),(ok,error)=>{setConnected(ok);setConnectionError(error??'');},m=>{
   if(m.event==='debug')setLogs(m.data);if(m.event==='bridges')setBridges(m.data);
   if(m.event==='notificationSettings'&&modal()!=='notifications')setNotifications(m.data);if(m.event==='ding'){void playDing();}if(m.event==='workspace')applyNavigation(m.data);if(m.event==='workspaceError')setNotice(m.error);
   if(m.event==='taskNotification'){
    const n=m.data;if(typeof n?.workerId==='string'&&typeof n.message==='string')toasts.push({message:n.message,kind:n.kind==='error'?'error':n.kind==='warning'?'warning':'success',key:'task:'+n.workerId,duration:8000,
      action:{label:'Open task',run:async()=>{const state=await rpc<WorkspaceState>('workspace.action',{action:{type:'open',kind:'task',id:n.workerId}});applyNavigation(state);setModal('');}}});
   }
 });
 const worker=createMemo(()=>snapshot().workers.find(w=>w.id===selected()&&w.projectId===navigation().projectId));
 const project=createMemo(()=>snapshot().projects.find(p=>p.id===navigation().projectId));
 const projectWorkers=createMemo(()=>snapshot().workers.filter(w=>w.projectId===navigation().projectId));
 const [savedActivity,setSavedActivity]=createSignal<Activity[]>([]),[historyMore,setHistoryMore]=createSignal(false),[historyBefore,setHistoryBefore]=createSignal<number|null>(null),[historyBusy,setHistoryBusy]=createSignal(false);
 const activity=createMemo(()=>[...new Map([...snapshot().events.filter(e=>e.workerId===selected()),...savedActivity().filter(e=>e.workerId===selected())].map(e=>[e.id,e])).values()].sort((a,b)=>b.id-a.id));
 const bridge=createMemo(()=>bridges().find(b=>b.workerId===selected()));
 const progress=createMemo(()=>worker()?taskPresentation(worker()!,bridge()):undefined);
 const preferReply=createMemo(()=>!bridge()?.active&&preferReplyRecovery(bridge()?.errorCode));
 const label=(text:string)=>text.replace(/^(Worker name|The goal):\s*/i,'');
 const clearPreview=()=>{setTrust(false);setFiles([]);setFile('');setContent('');setView('result');historyTask='';setSavedActivity([]);setHistoryMore(false);setHistoryBefore(null);};
 const navigate=async(event:WorkspaceAction)=>{
   try{const next=await rpc<WorkspaceState>('workspace.action',{action:event});applyNavigation(next);return next;}
   catch(e){setNotice(e instanceof Error?e.message:String(e));return undefined;}
 };
 const chooseProject=(id:string)=>void navigate({type:'open',kind:'project',id});
 const choose=(id:string)=>void navigate({type:'open',kind:'task',id});
 const openLibrary=(view:LibraryView,scope=navigation().projectId,filter:LibraryFilter='all')=>{closeActivePopover(document);setLibraryView(view);setLibraryScope(scope);setLibraryFilter(filter);setModal('library');};
 const closeTabs=async(event:WorkspaceAction)=>{
   const before=navigation().recentlyClosed.map(h=>h.key);const next=await navigate(event);if(!next)return;
   const added=next.recentlyClosed.filter(h=>!before.includes(h.key));if(added.length){
    const group=added[0]!.group;
    toasts.push({message:added.length===1?'Closed “'+added[0]!.label+'”. Work is kept.':'Closed '+added.length+' tabs. Running tasks continue.',kind:'info',key:'closed:'+group,duration:8000,
     action:{label:'Undo',run:async()=>{const restored=await rpc<WorkspaceState>('workspace.action',{action:{type:'restoreGroup',group}});applyNavigation(restored);success('Tabs restored.');}}});
   }
 };
 const restore=(event:WorkspaceAction)=>void navigate(event).then(next=>{if(next)success('Tabs restored.');});
 const rename=(kind:TabKind,id:string)=>{const value=kind==='project'?snapshot().projects.find(p=>p.id===id)?.name:snapshot().workers.find(w=>w.id===id)?.name;if(!value)return;setRenameTarget({kind,id});setRenameValue(value);setRenameError('');setModal('rename');};
 const menuItems=(kind:TabKind,id:string):MenuItem[]=>{
   const w=kind==='task'?snapshot().workers.find(w=>w.id===id):undefined,pid=kind==='project'?id:w?.projectId||'',row=kind==='project'?navigation().openProjects:navigation().openTasks[pid]||[];
   const isOpen=row.includes(id),online=connected();
   return [
    ...(kind==='project'?[
      {id:'new-task',label:'New task…',disabled:!online,run:()=>{setFormProjectId(id);setModal('worker');}},
      {id:'folder',label:'Open folder',disabled:!online,run:()=>void action('project.reveal',{projectId:id})},
      {id:'tasks',label:'All project tasks…',run:()=>openLibrary('tasks',id)},
    ]:[
      {id:'chat',label:'Open linked chat',disabled:!online||w?.mode!=='handoff',run:()=>void action('bridge.openChat',{workerId:id})},
      {id:'activity',label:'View task history',run:()=>{void navigate({type:'open',kind,id}).then(()=>{setModal('');setView('activity');});}},
      {id:'report',label:'View full report…',disabled:!online,run:()=>{void rpc<string>('worker.report',{workerId:id}).then(text=>{setTextValue(text);setModal('report');}).catch(e=>setNotice(String(e)));}},
    ]),
    {id:'rename',label:'Rename '+kind+'…',disabled:!online,run:()=>rename(kind,id)},
    ...(!isOpen?[{id:'open-tab',label:'Open tab',separatorBefore:true,run:()=>{void navigate({type:'open',kind,id}).then(()=>setModal(''));}}]:[
     {id:'close',label:'Close tab',shortcut:'Delete',separatorBefore:true,run:()=>void closeTabs({type:'close',kind,id})},
     {id:'others',label:'Close other '+(kind==='project'?'project':'task')+' tabs',disabled:row.length<2,run:()=>void closeTabs({type:'closeOthers',kind,id})},
     {id:'right',label:'Close tabs to the right',disabled:row.indexOf(id)===row.length-1,run:()=>void closeTabs({type:'closeRight',kind,id})},
     {id:'all',label:'Close all '+(kind==='project'?'project':'task')+' tabs',run:()=>void closeTabs({type:'closeAll',kind,projectId:pid})},
    ]),
    {id:'restore',label:'Reopen closed '+kind+' tab',separatorBefore:true,disabled:!navigation().recentlyClosed.some(h=>h.kind===kind&&(kind==='project'||h.projectId===pid)),run:()=>restore({type:'restoreLast',kind,...(kind==='task'?{projectId:pid}:{})})},
    {id:'history',label:'Recently closed…',run:()=>openLibrary('history',kind==='task'?pid:'')},
   ];
 };
 const allProjectTabs=createMemo(()=>snapshot().projects.map(p=>{
   const states=snapshot().workers.filter(w=>w.projectId===p.id).map(w=>taskPresentation(w,bridges().find(b=>b.workerId===w.id)).status);
   const status=states.find(s=>['working','connecting','reconnecting','needs_approval'].includes(s))||(states.length&&states.every(s=>s==='complete')?'complete':'idle');
   return {id:p.id,label:p.name,title:p.root,status};
 }));
 const projectTabs=createMemo(()=>navigation().openProjects.flatMap(id=>{const p=allProjectTabs().find(p=>p.id===id);return p?[p]:[];}));
 const taskTabs=createMemo(()=>(navigation().openTasks[navigation().projectId]||[]).flatMap(id=>{const w=projectWorkers().find(w=>w.id===id);return w?[{id:w.id,label:displayTaskName(w),title:displayTaskName(w),status:taskPresentation(w,bridges().find(b=>b.workerId===w.id)).status}]:[];}));
 const activeCount=createMemo(()=>snapshot().workers.filter(w=>running.has(w.state)||bridges().some(b=>b.workerId===w.id&&b.active)).length);
 const rpc=<T,>(method:string,params:Record<string,unknown>={})=>client.request<T>(method,params);
 const action=async(method:string,params:Record<string,unknown>={})=>{setBusy(true);try{await rpc(method,{workerId:selected(),...params});
  const notices:Record<string,string>={'worker.openFile':'Opened file.','worker.reveal':'Opened folder.','project.reveal':'Opened folder.','worker.cancel':'Task cancelled. Existing files are kept.','worker.rollback':'File edits restored.','bridge.stop':'Task paused. Progress is saved.','bridge.pause':'Task paused. Resume keeps the current plan.','bridge.halt':'Stopped. Completed work kept; pending plan retired.','bridge.continueFresh':'Continuing from current files with a fresh plan.','worker.pause':'Task paused.','bridge.openChat':'Opened linked chat.'};
  if(notices[method])success(notices[method]);
 }catch(e){setNotice(e instanceof Error?e.message:String(e));setDebugOpen(true);}finally{setBusy(false);}};
 const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);success('Copied to clipboard.');}catch{setNotice('Clipboard unavailable. Select the text and copy it manually.');}};
 const playDing=async()=>{try{const audio=new AudioContext();await audio.resume();const gain=audio.createGain();gain.connect(audio.destination);gain.gain.setValueAtTime(0,audio.currentTime);gain.gain.linearRampToValueAtTime(.06,audio.currentTime+.01);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.38);const oscillator=audio.createOscillator();oscillator.frequency.value=880;oscillator.connect(gain);oscillator.start();oscillator.stop(audio.currentTime+.4);oscillator.onended=()=>void audio.close();}catch(error){console.warn('Miter sound could not play.',error);}};
 const rewriteDraft=async(request:RewriteRequest,signal:AbortSignal):Promise<string>=>{
   if(request.provider==='chatgpt'&&!await chrome.permissions.request({origins:['https://chatgpt.com/*','https://chat.openai.com/*']}))throw Error('ChatGPT access was not granted. Your draft is unchanged.');
   if(signal.aborted)throw Error('Rewrite cancelled.');
   const started=await rpc<{id:string;state:string;text?:string}>('rewrite.start',{request,consent:true});
   const cancel=()=>{void rpc('rewrite.cancel',{id:started.id}).catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
   try{
    if(signal.aborted){cancel();throw Error('Rewrite cancelled.');}
    let result=started;const began=Date.now();while(result.state==='waiting'){
      if(signal.aborted)throw Error('Rewrite cancelled.');if(Date.now()-began>190000){cancel();throw Error('The rewrite timed out. Your draft is unchanged.');}
      await new Promise(resolve=>setTimeout(resolve,1200));result=await rpc('rewrite.read',{id:started.id});
    }
    if(result.state!=='done'||typeof result.text!=='string')throw Error((result as {error?:string}).error||'Rewrite cancelled.');return result.text;
   }finally{signal.removeEventListener('abort',cancel);}
 };
 let resendWorker='';const showResend=async()=>{const id=selected();try{const text=await rpc<string>('bridge.lastPrompt',{workerId:id});if(selected()!==id)return;resendWorker=id;setTextValue(text);setModal('resend');}catch(e){setNotice(String(e));}};
 const sendFollowup=async(id:string,request:ChangeRequest)=>{
  const task=snapshot().workers.find(w=>w.id===id);if(!task)throw new Error('This task is no longer available.');
  if(task.mode==='handoff'){const granted=await chrome.permissions.request({origins:['https://chatgpt.com/*','https://chat.openai.com/*']});if(!granted)throw new Error('ChatGPT permission was not granted. Your request was not sent.');}
  const result=await rpc('worker.followup',{workerId:id,request});success('Follow-up saved in the same task.');return result;
 };
 const openFileWindow=(id:string,path:string)=>{try{const url=filePreviewURL(chrome.runtime.getURL('/file.html'),{workerId:id,path});void chrome.windows.create(fileWindowOptions(url)).then(()=>success('Opened file in a new window.')).catch(e=>setNotice(String(e)));}catch(e){setNotice(String(e));}};
 const fileMenu=(id:string,path:string):MenuItem[]=>[
  {id:'preview',label:'Open preview / source',run:()=>void preview(path)},
  {id:'window',label:'Open in new window',run:()=>openFileWindow(id,path)},
  {id:'finder',label:'Reveal in file manager',separatorBefore:true,run:()=>void action('worker.openFile',{workerId:id,path,application:'finder'})},
  {id:'vscode',label:'Open in VS Code',run:()=>void action('worker.openFile',{workerId:id,path,application:'vscode'})},
  {id:'copy',label:'Copy relative path',separatorBefore:true,run:()=>void copy(path)}
 ];
 const browseFiles=async()=>{const id=selected();try{const r=await rpc<{files:string[]}>('worker.browse',{workerId:id});if(selected()!==id)return;setFileLibrary(r.files);setFileQuery('');setModal('files');}catch(e){setNotice(String(e));}};
 const showFollowups=async()=>{const id=selected();try{const r=await rpc<Followup[]>('worker.followups',{workerId:id});if(selected()===id){setFollowupHistory(r);setModal('followups');}}catch(e){setNotice(String(e));}};
 const showContext=()=>{setMission(project()?.mission||'');setConventions(project()?.conventions||'');setModal('context');};
 const showNotifications=async()=>{try{setNotifications(await rpc<{enabled:boolean;sound:boolean}>('notifications.get'));setModal('notifications');}catch(e){setNotice(String(e));}};
 const showText=async(kind:string)=>{const id=selected();try{const text=await rpc<string>(kind==='report'?'worker.report':'worker.prompt',{workerId:id,kind});if(id!==selected())return;setTextValue(text);setModal(kind==='report'?'report':'prompt');}catch(e){setNotice(String(e));}};
 const newWorker=()=>{const p=project();if(!p){setModal('project');return;}setFormProjectId(p.id);setModal('worker');};
 const runWithChat=async()=>{
  if(worker()?.control?.mode==='stopped'||worker()?.control?.mode==='fresh'){await action('bridge.continueFresh');return;}
  setAutomationWorker(selected());
  if(progress()?.start!=='Resume task'){setNotice('');setModal('automation');return;}
  const id=selected();setBusy(true);setNotice('');
  try{const result=await rpc<{resumed:boolean}>('bridge.resume',{workerId:id});if(!result.resumed&&id===selected())setModal('automation');}
  catch(e){setNotice(e instanceof Error?e.message:String(e));setDebugOpen(true);}
  finally{setBusy(false);}
 };
 // A tab may retain an old chat link while its new queue was imported
 // manually. Continue that queue locally unless a durable automatic checkpoint
 // names the exact batch. Never make the user retry an ineligible chat Resume.
 const continuePending=async()=>{
  const w=worker();if(!w)return;const id=w.id;setBusy(true);setNotice('');
  try{
   const saved=w.mode==='handoff'&&bridge()?await rpc<{progress:{stage:string;lastImportedId?:string}|null}>('worker.bridgeLoad',{workerId:id}):null;
   if(saved?.progress?.stage==='local_batch'&&saved.progress.lastImportedId===w.queue[0]?.id){
    const result=await rpc<{resumed:boolean}>('bridge.resume',{workerId:id});
    if(!result.resumed&&id===selected())setNotice('Open this task’s saved chat, then continue. The local batch is preserved.');
   }else await rpc('worker.resume',{workerId:id});
  }catch(e){setNotice(e instanceof Error?e.message:String(e));setDebugOpen(true);}
  finally{setBusy(false);}
 };
 const importBatch=async()=>{const id=selected();setBusy(true);setNotice('');try{await rpc('worker.import',{workerId:id,text:handoff()});setHandoff('');setModal('');await rpc('worker.run',{workerId:id});success('Handoff queued. Continuing the task.');}catch(e){setNotice(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const confirmAction=(method:string,message:string)=>{if(confirm(message))void action(method,{confirm:true});};
 let historyGeneration=0,historyTask='';
 const loadHistory=async(reset=false)=>{const id=selected();if(!id)return;const generation=++historyGeneration;setHistoryBusy(true);try{const r=await rpc<{events:Activity[];hasMore:boolean;before:number|null}>('worker.history',{workerId:id,...(!reset&&historyBefore()?{before:historyBefore()}: {})});if(generation===historyGeneration&&id===selected()){setSavedActivity(old=>reset?r.events:[...old,...r.events]);setHistoryMore(r.hasMore);setHistoryBefore(r.before);}}catch(e){setNotice(String(e));}finally{if(generation===historyGeneration)setHistoryBusy(false);}};
 createEffect(()=>{const id=selected();if(view()==='activity'&&connected()&&historyTask!==id){historyTask=id;void loadHistory(true);}if(!id)historyTask='';});
 const preview=async(path:string)=>{setFile(path);setView('result');};
 let filesKey='';
 createEffect(()=>{const w=worker(),online=connected();if(!w||!online){filesKey='';setFiles([]);setFile('');setContent('');return;}const key=w.id+':'+w.state+':'+(project()?.revision||0);if(key===filesKey)return;filesKey=key;const id=w.id;
  void rpc<ChangedFile[]>('worker.files',{workerId:id}).then(next=>{if(selected()!==id)return;setFiles(next);}).catch(e=>{filesKey='';setNotice(String(e));});
 });
 onMount(()=>{
   const key=(e:KeyboardEvent)=>{
     if(e.altKey&&e.shiftKey&&e.code==='KeyT'&&!document.querySelector('dialog[open]')){e.preventDefault();restore({type:'restoreLast'});return;}
     if(e.altKey&&!e.shiftKey&&e.code==='KeyW'&&!document.querySelector('dialog[open]')&&selected()){e.preventDefault();void closeTabs({type:'close',kind:'task',id:selected()});return;}
     if(e.ctrlKey&&e.shiftKey&&!e.altKey&&e.code==='Backquote'){e.preventDefault();toggleTerminal();return;}
     if(e.ctrlKey&&!e.altKey&&(e.code==='Backquote'||e.key==='`')){e.preventDefault();setDebugOpen(v=>!v);}};
   document.addEventListener('keydown',key);onCleanup(()=>document.removeEventListener('keydown',key));
   const unmountToasts=mountToasts(document,toasts);onCleanup(unmountToasts);
   client.connect();void rpc<WorkspaceState>('workspace.read').then(async state=>{applyNavigation(state);const query=new URLSearchParams(location.search),id=query.get('task');if(id){await navigate({type:'open',kind:'task',id});if(query.get('file'))setFile(query.get('file')!);}}).catch(e=>setNotice(String(e)));
 });
 onCleanup(()=>client.close());
 return <div class="app-shell">
  <header class="titlebar"><span class="app-name"><Mark size={23}/>Miter</span><span class="window-caption">Local project runner</span><div class="spacer"/><button class="icon-button history-button" title="Recently closed tabs" aria-label="History" onClick={()=>openLibrary('history','')}><Icon name="history" size={16}/></button><button classList={{connection:true,online:connected(),'health-button':true}} title="Connection, diagnostics and state backups" aria-label="Connection and health" onClick={()=>setModal('health')}><i/>{connected()?'Local ready':'Disconnected'}</button><button class="icon-button" aria-label="Open full workspace" title="Open full workspace" onClick={()=>chrome.tabs.create({url:chrome.runtime.getURL('/workspace.html')})}><Icon name="expand" size={15}/></button></header>
  <div class="shell-body"><div class="main-shell">
   <WorkspaceTabRow kind="project" items={projectTabs()} selected={navigation().projectId} addDisabled={!connected()} canAdd={true} addLabel="New project" onSelect={chooseProject} onAdd={()=>setModal('project')} onClose={id=>void closeTabs({type:'close',kind:'project',id})} onList={()=>openLibrary('projects','')} listLabel="All projects" menuItems={id=>menuItems('project',id)}/>
   <div id="mitter-project-view" role={project()?'tabpanel':undefined} aria-labelledby={project()?tabId('project',project()!.id):undefined} class="project-view">
    <WorkspaceTabRow kind="task" items={taskTabs()} selected={selected()} addDisabled={!connected()} canAdd={!!project()} addLabel={project()?'New task in '+project()!.name:'Open a project to add a task'} onSelect={choose} onAdd={newWorker} onClose={id=>void closeTabs({type:'close',kind:'task',id})} onList={()=>openLibrary('tasks')} listLabel="All project tasks" menuItems={id=>menuItems('task',id)}/>
   <Show when={!connected()}><div class="connection-banner"><span>{connectionError()||'Connecting to the local host…'}</span><button onClick={()=>client.reconnect()}>Reconnect</button></div></Show>
   <Show when={project()}>{p=><div class="task-toolbar">
    <span class="project-title" title={p().root}><Icon name="folder" size={15}/>{p().name}</span><div class="spacer"/>
    <button title="Show project in file manager" disabled={!connected()} onClick={()=>worker()?action('worker.reveal',{workerId:worker()!.id}):action('project.reveal',{projectId:p().id})}><Icon name="folder" size={14}/><span class="wide-label">Open folder</span></button>
    <MenuButton label="Tools" disabled={!connected()} items={[
     {id:'task-list',label:'All project tasks…',run:()=>openLibrary('tasks')},
     {id:'history',label:'Recently closed…',run:()=>openLibrary('history')},
     {id:'rename',label:'Rename project…',run:()=>rename('project',p().id)},
     {id:'close-all',label:'Close all task tabs',disabled:!taskTabs().length,run:()=>void closeTabs({type:'closeAll',kind:'task',projectId:p().id})},
     {id:'context',label:'Project context…',run:showContext},
     {id:'files',label:'Browse workspace files…',disabled:!worker(),run:()=>void browseFiles()},
     {id:'notifications',label:'Notifications…',run:()=>void showNotifications()},
     {id:'followups',label:'Follow-up history…',disabled:!worker(),run:()=>void showFollowups()},
     {id:'profiles',label:'Command profiles…',run:()=>setModal('profile')},
     {id:'models',label:'Settings…',run:()=>setModal('settings')},
     {id:'health',label:'Connection & health…',run:()=>setModal('health')},
     {id:'changes',label:'Review file changes…',disabled:!worker(),run:()=>setModal('changes')},
     {id:'syntax',label:'Check selected JavaScript syntax',disabled:!worker()||!file()||!/\.(js|mjs|cjs)$/.test(file()),run:()=>{void rpc<{ok:boolean;details:string;scope:string}>('worker.syntax',{workerId:selected(),path:file()}).then(r=>{setTextValue((r.ok?'Syntax check passed.':'Syntax check failed.')+'\n'+r.scope+'\n'+r.details);setModal('report');}).catch(e=>setNotice(String(e)));}},
     {id:'report',label:'View full report…',disabled:!worker(),separatorBefore:true,run:()=>void showText('report')},
     {id:'use-reply',label:'Use reply from chat…',disabled:!worker()||worker()!.mode!=='handoff'||!!bridge()?.active||running.has(worker()!.state)||['complete','cancelled'].includes(worker()!.state),run:useReply},
     {id:'manual',label:'Manual handoff…',disabled:!worker(),run:()=>setModal('manual')},
     {id:'rollback',label:'Roll back file edits…',separatorBefore:true,disabled:!worker()||running.has(worker()!.state)||!!bridge()?.active,run:()=>confirmAction('worker.rollback','Restore Miter’s file edits? Later changes may block rollback. Command side effects are not undone.')},
     {id:'cancel',label:'Cancel task…',danger:true,disabled:!worker()||['complete','cancelled'].includes(worker()!.state),run:()=>confirmAction('worker.cancel','Stop this task and clear its queue? Existing edits will remain.')},
    ]}/>
   </div>}</Show>
   <div id="mitter-task-view" role={worker()?'tabpanel':undefined} aria-labelledby={worker()?tabId('task',worker()!.id):undefined} class="task-view">
   <Show when={worker()} fallback={<div class="welcome"><Icon name="folder" size={36}/><h1>{project()?(projectWorkers().length?'No open task tabs.':'No tasks yet.'):(snapshot().projects.length?'No open project tabs.':'Open a project.')}</h1>
    <p>{project()?(projectWorkers().length?'Your tasks are saved. Open one from the task list, or start another.':'Give '+project()!.name+' its first task.'):(snapshot().projects.length?'Your projects are saved. Open a project from the list, or choose another folder.':'Choose a folder, then give Miter a task.')}</p>
    <div class="button-row"><Show when={project()?projectWorkers().length:snapshot().projects.length}><button onClick={()=>openLibrary(project()?'tasks':'projects')}>{project()?'Browse tasks':'Browse projects'}</button></Show><Show when={project()} fallback={<button class="primary" onClick={()=>setModal('project')} disabled={!connected()}>Choose Folder…</button>}><button class="primary" onClick={newWorker} disabled={!connected()}>New task</button></Show></div></div>}>
    {w=><div class="task-layout">
      <ContextArea items={[{id:"copy-goal",label:"Copy task request",run:()=>void copy(w().goal)},{id:"report",label:"View report…",run:()=>void showText("report")},{id:"followups",label:"Follow-up history…",run:()=>void showFollowups()}]}><section class="goal-block"><h1 title={displayTaskName(w())}>{displayTaskName(w())}</h1><details class="task-details"><summary>Task details</summary><p>{label(w().goal)}</p></details><Show when={w().worktree}><small class="muted">Isolated worktree · {w().worktree?.branch}</small></Show></section></ContextArea>
      <div classList={{'task-state':true,success:w().state==='complete','bridge-working':!!bridge()?.active||!!bridge()?.receiving}} role="status" aria-live="polite"><Status value={progress()!.status}/><span class="state-summary">{progress()!.detail}</span></div>
      <Show when={w().error&&w().error!==progress()!.detail}><div class="error-banner" role="alert">{w().error}</div></Show>
      <Show when={w().pending}>{pending=><section class="approval"><strong>Command approval needed</strong><p>{pending().reason}</p><pre>{pending().profile?JSON.stringify([pending().profile!.program,...pending().profile!.args],null,2):JSON.stringify(pending().action,null,2)}</pre><label class="checkline"><input type="checkbox" checked={trust()} onChange={e=>setTrust(e.currentTarget.checked)}/><span>Trust registered commands in this imported batch only. New replies need fresh approval. Scripts are not sandboxed.</span></label><div class="button-row end"><button onClick={()=>action('worker.approve',{token:pending().token,approve:false})}>Reject</button><button class="primary" disabled={busy()} onClick={()=>action('worker.approve',{token:pending().token,approve:true,trustRun:trust()})}>Approve</button></div></section>}</Show>
      <Show when={w().state!=='complete'&&w().state!=='cancelled'&&!w().humanAcceptanceReady}>
       <section class="runner-controls">
        <Show when={bridge()?.monitoring} fallback={<Show when={bridge()?.active} fallback={
         <Show when={!w().pending}>
          <Show when={running.has(w().state)} fallback={
           <Show when={w().queue.length} fallback={
            <Show when={w().mode==='handoff'} fallback={<button class="primary" disabled={busy()||!connected()} onClick={()=>action(w().control?.mode==='stopped'||w().control?.mode==='fresh'?'bridge.continueFresh':'worker.run')}><Icon name="play" size={14}/>{w().control?.mode==='stopped'||w().control?.mode==='fresh'?'Continue fresh':'Run locally'}</button>}>
             <Show when={budgetExhausted(bridge())&&!preferReply()} fallback={<button class="primary" onClick={()=>worker()?.control?.mode==='stopped'||worker()?.control?.mode==='fresh'?runWithChat():preferReply()?useReply():runWithChat()} disabled={busy()||!connected()}><Icon name="play" size={14}/>{worker()?.control?.mode==='stopped'||worker()?.control?.mode==='fresh'?'Continue fresh':preferReply()?'Use reply…':busy()?'Connecting…':progress()!.start}</button>}>
              <button class="primary" disabled={busy()||!connected()} title="Authorize 15 more turns and 30 more active minutes. Previous progress is retained." onClick={()=>action('bridge.extend',{confirm:true})}>Continue · +15 turns</button>
             </Show>
            </Show>
           }><button class="primary" disabled={busy()||!connected()} onClick={()=>void continuePending()}><Icon name="play" size={14}/>{w().mode==='handoff'&&bridge()?'Continue task':'Continue local work'}</button></Show>
          }><button onClick={()=>action('worker.pause')}><Icon name="pause" size={14}/>Pause</button></Show>
         </Show>
        }><button onClick={()=>action('bridge.pause')} title="Pause; Resume keeps the current plan"><Icon name="pause" size={14}/>Pause</button></Show>}><Show when={!bridge()?.receiving}><button onClick={()=>void showResend()}>Resend prompt…</button></Show><span class="muted small">{bridge()?.receiving?"Receiving reply…":"Watching for reply"}</span></Show>
        <Show when={w().control?.mode!=='stopped'}><button class="stop-button" disabled={busy()||!connected()} onClick={()=>action('bridge.halt',{id:crypto.randomUUID()})} title="Stop running work and retire the pending plan. Completed files are kept."><span class="stop-square" aria-hidden="true"/>Stop</button></Show>
        <Show when={bridge()}>{b=><span class="muted small task-turn-counter" title={b().lowerBound?'Known minimum recovered from older task history. Earlier unrecorded sends cannot be reconstructed exactly. New sends are saved before execution.':'Task-wide send attempts. Resume and updates do not reset this count; checking a reply does not use a turn.'}>{turnLabel(b())}</span>}</Show>
        <Show when={bridge()}><button onClick={()=>action('bridge.openChat')}>Open chat</button></Show>
       </section>
      </Show>
      <Show when={bridge()?.phase==='error'||!!bridge()?.errorCode&&!bridge()?.active}><div class="bridge-note"><Show when={bridge()?.monitoring&&!bridge()?.receiving}><button class="text-button" onClick={useReply}>Use reply…</button></Show><button class="text-button" onClick={()=>setDebugOpen(true)}>Show details</button><button class="text-button" onClick={()=>{void rpc<any[]>('debug.read').then(entries=>copy(['MITER '+APP_VERSION+' diagnostics',...entries.map(e=>new Date(e.time).toISOString()+' ['+e.kind+'] '+e.message)].join('\n'))).catch(e=>{setNotice(String(e));setDebugOpen(true);});}}>Copy diagnostics</button></div></Show>
      <div class="editor-tabs"><button classList={{selected:view()==='result'}} onClick={()=>setView('result')}>Files & result <Show when={files().length}><span>{files().length}</span></Show></button><button classList={{selected:view()==='activity'}} onClick={()=>setView('activity')}>Activity</button><button classList={{selected:view()==='team'}} onClick={()=>setView('team')}>Team</button><div class="spacer"/><Show when={w().checks.length}><InfoPopover label={w().checks.length+' check'+(w().checks.length>1?'s':'')} title="Completion checks"><For each={w().checks}>{check=><p>{check.type==='command'?'Pass: '+check.profileId:check.type==='exists'?'Exists: '+check.path:check.path+' contains “'+check.text+'”'}</p>}</For></InfoPopover></Show></div>
      <section class="editor-surface">
       <Show when={view()==='team'}><TeamPanel workerId={w().id} rpc={rpc} copy={copy} success={success} revision={snapshot().events[0]?.time||0}/></Show>
       <Show when={view()==='activity'}><ContextArea items={[{id:'copy-all',label:'Copy task activity',run:()=>void copy(activity().map(e=>new Date(e.time).toISOString()+' '+e.message).join('\n'))},{id:'report',label:'View full report…',run:()=>void showText('report')}]}><div class="activity-list"><For each={activity()} fallback={<p class="muted">No activity yet.</p>}>{e=><ContextArea items={[{id:'copy',label:'Copy event',run:()=>void copy(e.message)},{id:'timestamp',label:'Copy timestamp',run:()=>void copy(new Date(e.time).toISOString())}]}><div class={`activity-line kind-${e.kind}`}><time>{new Date(e.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time><span>{e.kind==='action'?e.message.split(': {')[0]:e.message}</span></div></ContextArea>}</For><Show when={historyMore()}><button class="history-load" disabled={historyBusy()} onClick={()=>void loadHistory()}>{historyBusy()?'Loading…':'Load older activity'}</button></Show></div></ContextArea></Show>
       <Show when={view()==='result'}>
        <ContextArea items={[{id:'browse',label:'Browse workspace files…',run:()=>void browseFiles()},{id:'copy',label:'Copy changed file list',disabled:!files().length,run:()=>void copy(files().map(f=>f.path).join('\n'))}]}>
         <div class="files-heading"><span>{files().length?'Changed files':'Workspace files'}</span><button class="text-button" onClick={()=>void browseFiles()}>Browse all…</button></div>
         <For each={files()} fallback={<p class="preview-hint">No file edits yet. Existing files are available in Browse all.</p>}>{f=><ContextArea items={fileMenu(w().id,f.path)}><button classList={{'file-row':true,selected:file()===f.path}} onClick={()=>void preview(f.path)}><Icon name="file" size={15}/><span>{f.path}</span><small>{f.status==='rolled_back'?'restored':f.bytes+' B'}</small><Icon name="arrow" size={13}/></button></ContextArea>}</For>
        </ContextArea>
        <Show when={file()} fallback={<p class="preview-hint">Choose a file to preview it or select code for a change.</p>}>{path=><FileViewer workerId={w().id} path={path()} rpc={rpc} request={r=>sendFollowup(w().id,r)} copy={copy} notice={setNotice} success={success} openWindow={()=>openFileWindow(w().id,path())}/>}</Show>
       </Show>
      </section>
      <Show keyed when={w().id}>{id=><FollowupPanel workerId={id} items={snapshot().workers.find(item=>item.id===id)?.followups||[]} running={running.has(w().state)||!!bridge()?.active} disabled={!connected()} send={r=>sendFollowup(id,r)} steer={async r=>{const result=await rpc('bridge.steer',{workerId:id,request:r});success('Steering task. Completed work is kept.');return result;}} cancel={async requestId=>{const result=await rpc('worker.followupCancel',{workerId:id,id:requestId});success('Queued follow-up removed.');return result;}} copy={copy} history={()=>void showFollowups()} rewrite={rewriteDraft} start={()=>rpc('worker.followupStart',{workerId:id})}/>}</Show>

    </div>}
   </Show>
   </div></div>
  </div></div>
  <Show when={terminalMounted()}><TerminalDock visible={terminalOpen()} projectId={navigation().projectId} workerId={selected()||undefined} projectName={project()?.name||''} close={()=>setTerminalOpen(false)}/></Show>
  <Show when={debugOpen()}><DebugConsole entries={logs()} clear={()=>void rpc('debug.clear').then(()=>success('Console cleared.')).catch(e=>setNotice(String(e)))} close={()=>{setDebugOpen(false);info('Console closed.');}} copy={copy}/></Show>
  <footer class="statusbar"><span>Miter {APP_VERSION}</span><span class="footer-state">{worker()?displayTaskName(worker()!):'Ready'}</span><div class="spacer"/><Show when={activeCount()}><button title="View working tasks, including closed tabs" onClick={()=>openLibrary('tasks','','active')}>{activeCount()} working</button></Show><button onClick={toggleTerminal} aria-pressed={terminalOpen()} title="Local shell · Ctrl+Shift+`">Terminal</button><button onClick={()=>{setDebugOpen(v=>!v);setTerminalOpen(false);}} aria-pressed={debugOpen()}><Icon name="terminal" size={13}/>Console<span class="shortcut">Ctrl + `</span></button><button class="icon-button" aria-label="Settings" title="Settings" onClick={()=>setModal('settings')} disabled={!connected()}><Icon name="settings" size={14}/></button></footer>
  <Show when={modal()==='library'}><Modal title="Workspace" close={()=>setModal('')} wide>
   <WorkspaceLibrary view={libraryView()} scopeProjectId={libraryScope()} initialFilter={libraryFilter()} state={navigation()}
     projects={snapshot().projects.map(p=>({id:p.id,label:p.name,subtitle:p.root,status:allProjectTabs().find(t=>t.id===p.id)?.status||'idle'}))}
     tasks={snapshot().workers.map(w=>({id:w.id,projectId:w.projectId,label:displayTaskName(w),subtitle:w.goal,status:taskPresentation(w,bridges().find(b=>b.workerId===w.id)).status,createdAt:w.createdAt}))}
     open={(kind,id)=>{void navigate({type:'open',kind,id}).then(next=>{if(next)setModal('');});}}
     restore={key=>{void navigate({type:'restore',key}).then(next=>{if(next){setModal('');success('Tab restored.');}});}}
     clearHistory={async()=>{const next=await rpc<WorkspaceState>('workspace.action',{action:{type:'clearHistory'}});applyNavigation(next);}}
     menu={menuItems}/>
  </Modal></Show>
  <Show when={modal()==='rename'&&renameTarget()}><Modal title={'Rename '+renameTarget()!.kind} close={()=>setModal('')}><form onSubmit={async e=>{e.preventDefault();const target=renameTarget()!;setBusy(true);setRenameError('');try{await rpc(target.kind==='project'?'project.rename':'worker.rename',{...(target.kind==='project'?{projectId:target.id}:{workerId:target.id}),name:renameValue().trim()});setModal('');success('Name updated. Your folder, goal and progress are unchanged.');}catch(e){setRenameError(String(e));}finally{setBusy(false);}}}>
   <label class="field"><span>Name</span><input autofocus required maxLength={60} value={renameValue()} onInput={e=>setRenameValue(e.currentTarget.value)}/></label>
   <p class="muted small">Only the display name changes. Your files, conversation and task progress are kept.</p><Show when={renameError()}><p class="error" role="alert">{renameError()}</p></Show>
   <div class="button-row end"><button type="button" onClick={()=>setModal('')}>Cancel</button><button class="primary" disabled={busy()||!renameValue().trim()}>Save name</button></div>
  </form></Modal></Show>
  <Show when={modal()==='files'}><Modal title="Workspace files" close={()=>setModal('')}><label class="field"><span>Find a file</span><input value={fileQuery()} onInput={e=>setFileQuery(e.currentTarget.value)} autofocus placeholder="Filter by path…"/></label><div class="file-browser"><For each={fileLibrary().filter(path=>path.toLowerCase().includes(fileQuery().toLowerCase()))} fallback={<p class="muted">No matching files.</p>}>{path=><ContextArea items={fileMenu(selected(),path)}><button class="file-row" onClick={()=>{void preview(path);setModal('');}}><Icon name="file" size={14}/>{path}</button></ContextArea>}</For></div></Modal></Show>
  <Show when={modal()==='context'}><Modal title="Project context" close={()=>setModal('')}><form onSubmit={async e=>{e.preventDefault();try{await rpc('project.context',{projectId:project()!.id,save:true,mission:mission(),conventions:conventions()});setModal('');success('Project context saved for all tasks.');}catch(e){setNotice(String(e));}}}><label class="field"><span>Ultimate project goal</span><textarea maxlength="4000" rows="3" value={mission()} onInput={e=>setMission(e.currentTarget.value)}/></label><label class="field"><span>Shared conventions</span><textarea maxlength="4000" rows="3" value={conventions()} onInput={e=>setConventions(e.currentTarget.value)}/></label><p class="muted small">These notes accompany each task. Existing task requests and approval rules are unchanged.</p><div class="button-row end"><button type="button" onClick={()=>setModal('')}>Cancel</button><button class="primary">Save context</button></div></form></Modal></Show>
  <Show when={modal()==='followups'}><Modal title="Follow-up history" close={()=>setModal('')}><div class="followup-history"><For each={followupHistory()} fallback={<p class="muted">No follow-ups yet.</p>}>{f=><ContextArea items={[{id:'copy',label:'Copy request',run:()=>void copy(f.instruction)}]}><article><strong>{f.status}</strong><time>{new Date(f.createdAt).toLocaleString()}</time><p>{f.instruction}</p><Show when={f.selection}><small>{f.selection?.path} · code selection</small></Show><Show when={f.error}><p class="error">{f.error}</p></Show></article></ContextArea>}</For></div></Modal></Show>
  <Show when={modal()==='notifications'}><Modal title="Notifications" close={()=>setModal('')}><form onSubmit={async e=>{e.preventDefault();try{if(notifications().enabled&&!await chrome.permissions.request({permissions:['notifications']}))throw new Error('Notification permission was not granted.');await rpc('notifications.set',notifications());setModal('');success('Notification settings saved.');}catch(e){setNotice(String(e));}}}><label class="checkline"><input type="checkbox" checked={notifications().enabled} onChange={e=>setNotifications(p=>({...p,enabled:e.currentTarget.checked}))}/><span>Desktop notifications for completion and attention</span></label><label class="checkline"><input type="checkbox" checked={notifications().sound} onChange={e=>setNotifications(p=>({...p,sound:e.currentTarget.checked}))}/><span>Play a quiet chime while a Miter view is open</span></label><p class="muted small">Click a notification to open its task. Your operating system’s notification settings also apply.</p><div class="button-row end"><button type="button" onClick={()=>void playDing()}>Test sound</button><button class="primary">Save</button></div></form></Modal></Show>
  <Show when={modal()==='resend'}><Modal title="Resend the pending prompt" close={()=>setModal('')} wide><p class="muted">Miter is still watching for a reply. Resend only if ChatGPT did not answer. This is the exact pending prompt; already-applied actions are not replayed. Another send uses one turn.</p><textarea class="code-input" rows={8} readonly value={textValue()} aria-label="Exact pending prompt"/><div class="button-row end"><button onClick={()=>copy(textValue())}>Copy prompt</button><button onClick={()=>setModal('')}>Cancel</button><button class="primary" disabled={busy()} onClick={async()=>{setBusy(true);try{const result=await rpc<{sent:boolean;replyFound?:boolean;pending?:boolean}>('bridge.resend',{workerId:resendWorker,confirm:true});setModal('');success(result.replyFound?'A reply has arrived. Miter is checking it instead of resending.':result.pending?'Waiting for ChatGPT’s Send button. The saved prompt will send when ready.':'Pending prompt resent. Watching for its reply.');}catch(e){setNotice(String(e));}finally{setBusy(false);}}}>Resend once</button></div></Modal></Show>
  <Show when={modal()==='project'}><ProjectForm close={()=>setModal('')} pick={()=>rpc('project.pickFolder')} save={async p=>{const added=await rpc<Project>('project.add',p);setSnapshot(s=>({...s,projects:s.projects.some(p=>p.id===added.id)?s.projects:[...s.projects,added]}));chooseProject(added.id);success('Project opened: '+added.name);}}/></Show>
  <Show when={modal()==='worker'}><WorkerForm rewrite={rewriteDraft} projects={snapshot().projects} scopedProjectId={formProjectId()} close={()=>setModal('')}
    authorize={()=>chrome.permissions.request({origins:['https://chatgpt.com/*','https://chat.openai.com/*']})}
    create={async p=>{const created=await rpc<Worker>('worker.create',p);setSnapshot(s=>({...s,workers:s.workers.some(w=>w.id===created.id)?s.workers:[...s.workers,created]}));return created;}} created={id=>{choose(id);success('Task created.');}}
    start={async(id,mode)=>{try{return await rpc(mode==='handoff'?'bridge.start':'worker.run',mode==='handoff'?{workerId:id,consent:true,newChat:true,maxTurns:15,maxMinutes:30}:{workerId:id});}catch(e){setNotice(e instanceof Error?e.message:String(e));throw e;}}}
    stop={(id,mode)=>rpc('bridge.halt',{workerId:id,id:crypto.randomUUID()})}/>
</Show>
  <Show when={modal()==='profile'&&project()}><ProfileForm project={project()!} close={()=>setModal('')} save={async p=>{await rpc('project.profile',p);success('Command profile saved.');}}/></Show>
  <Show when={modal()==='settings'}><SettingsForm settings={snapshot().settings} close={()=>setModal('')} save={async p=>{await rpc('settings.update',p);success('Settings saved.');}}/></Show>
  <Show when={modal()==='automation'}><AutomationForm workerId={automationWorker()} rpc={rpc} close={()=>setModal('')} started={()=>setNotice('')}/></Show>
  <Show when={modal()==='reply-recovery'}><Modal title="Use this reply" close={()=>setModal('')}><ReplyRecovery workerId={replyWorker()} rpc={rpc} close={()=>setModal('')} applied={()=>{setModal('');success('Reply queued. Continuing the same task.');}}/></Modal></Show>
  <Show when={modal()==='manual'}><Modal title="Manual handoff" close={()=>setModal('')}><p class="muted">Use this only when you want to copy instructions yourself.</p><div class="button-row"><button onClick={()=>showText('bootstrap')}>Setup prompt</button><button onClick={()=>setModal('import')}>Paste handoff</button><button onClick={()=>showText('report')}>Review report</button></div></Modal></Show>
  <Show when={modal()==='health'}><Modal title="Connection & health" close={()=>setModal('')} wide><HealthPanel rpc={rpc} copy={copy} notice={success}/></Modal></Show>
  <Show when={modal()==='changes'&&selected()}><Modal title="Review file changes" close={()=>setModal('')} wide><ChangeReview workerId={selected()} path={file()||undefined} rpc={rpc} notice={success}/></Modal></Show>
  <Show when={modal()==='import'}><Modal title="Paste handoff" close={()=>setModal('')} wide><p class="muted">Paste the complete mitter/1 JSON for this task.</p><textarea class="code-input" rows={13} spellcheck={false} value={handoff()} onInput={e=>setHandoff(e.currentTarget.value)} aria-label="Handoff JSON"/><div class="button-row spread"><button onClick={async()=>{try{setHandoff(await userReadClipboard());}catch(e){setNotice(String(e));}}}>Read clipboard</button><button class="primary" disabled={busy()||!handoff().trim()} onClick={importBatch}>Import & run</button></div></Modal></Show>
  <Show when={modal()==='report'||modal()==='prompt'}><Modal title={modal()==='report'?'Review report':'Setup prompt'} close={()=>setModal('')} wide><p class="muted">{modal()==='report'?'Review before sharing. The report can contain project code and command output.':'Paste this into ChatGPT, then bring its complete JSON reply back.'}</p><textarea readonly class="code-input" rows={15} value={textValue()}/><div class="button-row end"><button onClick={()=>setModal('')}>Close</button><button class="primary" onClick={()=>copy(textValue())}><Icon name="copy" size={14}/>Copy {modal()==='report'?'report':'prompt'}</button></div></Modal></Show>
 </div>;
}
