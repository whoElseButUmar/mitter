/** UI selection only. No worker state, chat link, approval or budget is mutated. */
export const WORKSPACE_NAV_KEY = 'mitter.workspaceNavigation.v1';
export interface NavigationState {version:1;projectId:string;taskByProject:Record<string,string>;}
export interface NavigationProject {id:string;}
export interface NavigationTask {id:string;projectId:string;}
export const emptyNavigation = ():NavigationState=>({version:1,projectId:'',taskByProject:{}});
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
export function restoreNavigation(value:unknown,legacyWorker:unknown,projects:NavigationProject[],tasks:NavigationTask[]):NavigationState {
  const next=emptyNavigation();
  if(record(value)&&value.version===1){
    if(typeof value.projectId==='string')next.projectId=value.projectId;
    if(record(value.taskByProject))for(const [key,id] of Object.entries(value.taskByProject)){if(typeof id==='string'&&projects.some(p=>p.id===key)&&tasks.some(t=>t.id===id&&t.projectId===key))next.taskByProject[key]=id;}
  }else if(typeof legacyWorker==='string'){
    const old=tasks.find(t=>t.id===legacyWorker);if(old){next.projectId=old.projectId;next.taskByProject[old.projectId]=old.id;}
  }
  return reconcileNavigation(next,projects,tasks);
}
export function reconcileNavigation(state:NavigationState,projects:NavigationProject[],tasks:NavigationTask[]):NavigationState {
  const taskByProject:Record<string,string>={};
  for(const p of projects){const remembered=state.taskByProject[p.id];const task=tasks.find(t=>t.id===remembered&&t.projectId===p.id)||tasks.find(t=>t.projectId===p.id);if(task)taskByProject[p.id]=task.id;}
  const projectId=projects.some(p=>p.id===state.projectId)?state.projectId:(projects[0]?.id||'');
  return {version:1,projectId,taskByProject};
}
export function selectProject(state:NavigationState,id:string,projects:NavigationProject[],tasks:NavigationTask[]):NavigationState {
  if(!projects.some(p=>p.id===id))return state;
  return reconcileNavigation({...state,projectId:id},projects,tasks);
}
export function selectTask(state:NavigationState,id:string,projects:NavigationProject[],tasks:NavigationTask[]):NavigationState {
  const task=tasks.find(t=>t.id===id);if(!task||!projects.some(p=>p.id===task.projectId))return state;
  return reconcileNavigation({...state,projectId:task.projectId,taskByProject:{...state.taskByProject,[task.projectId]:id}},projects,tasks);
}
export function activeTaskId(state:NavigationState):string{return state.taskByProject[state.projectId]||'';}
