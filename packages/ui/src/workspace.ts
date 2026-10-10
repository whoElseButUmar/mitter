/** Durable UI workspace. Tab visibility never controls task execution. */
import {restoreNavigation, WORKSPACE_NAV_KEY as LEGACY_KEY} from './workspace-state.js';
export const WORKSPACE_KEY='mitter.workspace.v2';
export const LEGACY_WORKSPACE_KEY=LEGACY_KEY;
export const HISTORY_LIMIT=200;
export type TabKind='project'|'task';
export interface CatalogProject {id:string;name?:string;root?:string;}
export interface CatalogTask {id:string;projectId:string;name?:string;}
export interface Catalog {projects:CatalogProject[];tasks:CatalogTask[];}
export interface ClosedTab {key:string;group:string;kind:TabKind;id:string;projectId:string;label:string;index:number;closedAt:number;wasSelected?:boolean;}
export interface WorkspaceState {
 version:2;revision:number;projectId:string;taskByProject:Record<string,string>;
 openProjects:string[];openTasks:Record<string,string[]>;
 knownProjects:string[];knownTasks:string[];recentlyClosed:ClosedTab[];
}
export type WorkspaceAction=
 |{type:'open';kind:TabKind;id:string}
 |{type:'close';kind:TabKind;id:string}
 |{type:'closeOthers'|'closeRight';kind:TabKind;id:string}
 |{type:'closeAll';kind:TabKind;projectId?:string}
 |{type:'restore';key:string}
 |{type:'restoreLast';kind?:TabKind;projectId?:string}
 |{type:'restoreGroup';group:string}
 |{type:'clearHistory'};
const rec=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const strings=(v:unknown):string[]=>Array.isArray(v)?[...new Set(v.filter((x):x is string=>typeof x==='string'))]:[];
const dict=<T>():Record<string,T>=>Object.create(null) as Record<string,T>;
export const emptyWorkspace=():WorkspaceState=>({version:2,revision:0,projectId:'',taskByProject:dict(),openProjects:[],openTasks:dict(),knownProjects:[],knownTasks:[],recentlyClosed:[]});
export const currentTask=(s:WorkspaceState)=>s.projectId?s.taskByProject[s.projectId]||'':'';
export function restoreWorkspace(raw:unknown,legacy:unknown,selectedWorker:unknown,catalog:Catalog):WorkspaceState {
 if(rec(raw)&&typeof raw.version==='number'&&raw.version>2)throw new Error('Workspace was saved by a newer Mitter. Its tab history has not been overwritten. Update Mitter to open it.');
 if(!rec(raw)||raw.version!==2){
  const old=restoreNavigation(legacy,selectedWorker,catalog.projects,catalog.tasks),s=emptyWorkspace();
  s.projectId=old.projectId;s.taskByProject={...old.taskByProject};return reconcileWorkspace(s,catalog);
 }
 const s=emptyWorkspace();s.revision=Number.isSafeInteger(raw.revision)&&Number(raw.revision)>=0?Number(raw.revision):0;
 s.projectId=typeof raw.projectId==='string'?raw.projectId:'';
 s.openProjects=strings(raw.openProjects);s.knownProjects=strings(raw.knownProjects);s.knownTasks=strings(raw.knownTasks);
 if(rec(raw.openTasks))for(const [k,v]of Object.entries(raw.openTasks))s.openTasks[k]=strings(v);
 if(rec(raw.taskByProject))for(const [k,v]of Object.entries(raw.taskByProject))if(typeof v==='string')s.taskByProject[k]=v;
 if(Array.isArray(raw.recentlyClosed))for(const h of raw.recentlyClosed){
  if(!rec(h)||!['project','task'].includes(String(h.kind))||typeof h.id!=='string'||typeof h.key!=='string'||typeof h.projectId!=='string'||typeof h.group!=='string'||typeof h.label!=='string'||!Number.isFinite(h.closedAt)||Number(h.closedAt)<0||Number(h.closedAt)>8640000000000000||!Number.isSafeInteger(h.index)||Number(h.index)<0)continue;
  if(s.recentlyClosed.some(v=>v.kind===h.kind&&v.id===h.id))continue;
  s.recentlyClosed.push({key:h.key,group:h.group,kind:h.kind as TabKind,id:h.id,projectId:h.projectId,label:h.label.slice(0,300),index:Number(h.index),closedAt:Number(h.closedAt),wasSelected:h.wasSelected===true});
 }
 s.recentlyClosed=s.recentlyClosed.slice(0,HISTORY_LIMIT);return reconcileWorkspace(s,catalog);
}
export function reconcileWorkspace(state:WorkspaceState,c:Catalog):WorkspaceState {
 const pids=new Set(c.projects.map(p=>p.id)),s:WorkspaceState={...state,openProjects:state.openProjects.filter(id=>pids.has(id)),openTasks:dict(),taskByProject:dict(),recentlyClosed:[...state.recentlyClosed]};
 const knownP=new Set(state.knownProjects),knownT=new Set(state.knownTasks);
 for(const p of c.projects){
  if(!knownP.has(p.id)&&!s.openProjects.includes(p.id))s.openProjects.push(p.id);
  const tasks=c.tasks.filter(t=>t.projectId===p.id),ids=new Set(tasks.map(t=>t.id));
  s.openTasks[p.id]=(state.openTasks[p.id]||[]).filter(id=>ids.has(id));
  for(const t of tasks)if(!knownT.has(t.id)&&!s.openTasks[p.id]!.includes(t.id))s.openTasks[p.id]!.push(t.id);
  const remembered=state.taskByProject[p.id];s.taskByProject[p.id]=s.openTasks[p.id]!.includes(remembered||'')?remembered!:s.openTasks[p.id]![0]||'';
 }
 s.knownProjects=c.projects.map(p=>p.id);s.knownTasks=c.tasks.filter(t=>pids.has(t.projectId)).map(t=>t.id);
 if(!s.openProjects.includes(s.projectId))s.projectId=s.openProjects[0]||'';
 return s;
}
export function validateWorkspaceAction(value:unknown):WorkspaceAction {
 if(!rec(value)||typeof value.type!=='string')throw new Error('Invalid workspace action.');
 const kind=()=>{if(value.kind!=='project'&&value.kind!=='task')throw new Error('Invalid tab kind.');return value.kind;};
 const string=(key:string)=>{if(typeof value[key]!=='string'||!value[key]||value[key].length>300)throw new Error('Invalid workspace '+key+'.');return value[key] as string;};
 switch(value.type){
  case 'open':case 'close':case 'closeOthers':case 'closeRight':return{type:value.type,kind:kind(),id:string('id')};
  case 'closeAll':return{type:'closeAll',kind:kind(),...(value.projectId?{projectId:string('projectId')}:{})};
  case 'restore':return{type:'restore',key:string('key')};
  case 'restoreGroup':return{type:'restoreGroup',group:string('group')};
  case 'restoreLast':return{type:'restoreLast',...(value.kind?{kind:kind()}:{}),...(value.projectId?{projectId:string('projectId')}:{})};
  case 'clearHistory':return{type:'clearHistory'};
  default:throw new Error('Unknown workspace action.');
 }
}
export function reduceWorkspace(state:WorkspaceState,action:WorkspaceAction,c:Catalog,now=Date.now(),group=String(now)):WorkspaceState {
 const s=reconcileWorkspace(state,c);
 const list=(kind:TabKind,projectId='')=>kind==='project'?s.openProjects:(s.openTasks[projectId]||[]);
 const owner=(kind:TabKind,id:string)=>kind==='project'?c.projects.find(p=>p.id===id)?.id:c.tasks.find(t=>t.id===id)?.projectId;
 const available=(h:ClosedTab)=>h.kind==='project'?c.projects.some(p=>p.id===h.id):c.tasks.some(t=>t.id===h.id&&t.projectId===h.projectId)&&c.projects.some(p=>p.id===h.projectId);
 function open(kind:TabKind,id:string,index?:number){
  const pid=owner(kind,id);if(!pid||!c.projects.some(p=>p.id===pid))return;
  if(!s.openProjects.includes(pid))s.openProjects.push(pid);
  const ids=list(kind,pid);if(!ids.includes(id))ids.splice(index===undefined?ids.length:Math.min(index,ids.length),0,id);
  else if(kind==='project'&&index!==undefined){ids.splice(ids.indexOf(id),1);ids.splice(Math.min(index,ids.length),0,id);}
  s.projectId=pid;if(kind==='task')s.taskByProject[pid]=id;
  s.recentlyClosed=s.recentlyClosed.filter(h=>!(h.kind===kind&&h.id===id)&&!(h.kind==='project'&&h.id===pid));
 }
 function closeMany(kind:TabKind,ids:string[]){
  const indices=new Map(ids.map(id=>[id,list(kind,owner(kind,id)||'').indexOf(id)]));
  const selectedBefore=kind==='project'?[s.projectId]:Object.values(s.taskByProject);
  for(const id of ids){
   const pid=owner(kind,id);if(!pid)continue;const row=list(kind,pid),index=row.indexOf(id);if(index<0)continue;
   const label=(kind==='project'?c.projects.find(p=>p.id===id)?.name:c.tasks.find(t=>t.id===id)?.name)||id;
   s.recentlyClosed=s.recentlyClosed.filter(h=>!(h.kind===kind&&h.id===id));
   s.recentlyClosed.unshift({key:group+':'+kind+':'+id,group,kind,id,projectId:pid,label,index:indices.get(id)??index,closedAt:now,wasSelected:selectedBefore.includes(id)});
   row.splice(index,1);
   if(kind==='project'&&s.projectId===id)s.projectId=row[Math.min(index,row.length-1)]||'';
   if(kind==='task'&&s.taskByProject[pid]===id)s.taskByProject[pid]=row[Math.min(index,row.length-1)]||'';
  }
  s.recentlyClosed=s.recentlyClosed.slice(0,HISTORY_LIMIT);
 }
 switch(action.type){
  case 'open':open(action.kind,action.id);break;
  case 'close':closeMany(action.kind,[action.id]);break;
  case 'closeOthers':case 'closeRight':{
   const pid=owner(action.kind,action.id);if(!pid)break;const row=list(action.kind,pid);if(!row.includes(action.id))break;
   closeMany(action.kind,action.type==='closeOthers'?row.filter(id=>id!==action.id):row.slice(row.indexOf(action.id)+1));break;
  }
  case 'closeAll':closeMany(action.kind,[...list(action.kind,action.projectId||s.projectId)]);break;
  case 'restore':{const h=s.recentlyClosed.find(h=>h.key===action.key);if(h&&available(h))open(h.kind,h.id,h.index);break;}
  case 'restoreLast':{const h=s.recentlyClosed.find(h=>(!action.kind||h.kind===action.kind)&&(!action.projectId||h.projectId===action.projectId)&&available(h));if(h)open(h.kind,h.id,h.index);break;}
  case 'restoreGroup':{const hs=s.recentlyClosed.filter(h=>h.group===action.group&&available(h)).reverse();for(const h of hs)open(h.kind,h.id,h.index);const selected=hs.find(h=>h.wasSelected);if(selected)open(selected.kind,selected.id);break;}
  case 'clearHistory':s.recentlyClosed=[];break;
 }
 return s;
}
