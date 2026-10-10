import {mountMenu,type MenuItem} from './menu.js';
import {enhanceSelect} from './select.js';
import type {WorkspaceState,TabKind} from './workspace.js';
export type LibraryFilter='all'|'open'|'closed'|'active'|'attention'|'complete';
export type LibraryView='projects'|'tasks'|'history';
export interface LibraryRecord {id:string;projectId?:string;label:string;subtitle:string;status:string;createdAt?:number;}
export interface LibraryOptions {
 view:LibraryView;scopeProjectId:string;initialFilter?:LibraryFilter;state:WorkspaceState;projects:LibraryRecord[];tasks:LibraryRecord[];
 open(kind:TabKind,id:string):void;restore(key:string):void;clearHistory():Promise<unknown>;
 menu(kind:TabKind,id:string):MenuItem[];
}
/** Searchable project/task catalog and reversible tab history. Closed tabs are
 * views of retained records; opening a row never runs a task. */
export function mountLibrary(root:HTMLElement,initial:LibraryOptions){
 const doc=root.ownerDocument;let options=initial,view=initial.view,scope=initial.scopeProjectId,filter:string=initial.initialFilter||'all',query='',lastShape='',externalView=initial.view,externalScope=initial.scopeProjectId,externalFilter=initial.initialFilter||'all';
 let disposers:(()=>void)[]=[];
 root.className='workspace-library';
 const tabs=doc.createElement('div');tabs.className='library-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Workspace lists');
 const buttons=new Map<LibraryView,HTMLButtonElement>();
 for(const [id,label]of [['projects','Projects'],['tasks','Tasks'],['history','Recently closed']] as const){const b=doc.createElement('button');b.type='button';b.textContent=label;b.setAttribute('role','tab');b.id='library-tab-'+id;b.addEventListener('click',()=>{view=id;filter='all';filterSelect.value='all';filterControl.refresh();render();});tabs.append(b);buttons.set(id,b);}
 tabs.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const bs=[...buttons.values()],i=bs.indexOf(doc.activeElement as HTMLButtonElement);const n=e.key==='Home'?0:e.key==='End'?bs.length-1:(i+(e.key==='ArrowRight'?1:-1)+bs.length)%bs.length;bs[n]!.click();bs[n]!.focus();});
 const tools=doc.createElement('div');tools.className='library-search-row';
 const input=doc.createElement('input');input.type='search';input.placeholder='Search projects';input.setAttribute('aria-label','Search workspace');input.autocomplete='off';input.addEventListener('input',()=>{query=input.value;renderList();});
 const filterSelect=doc.createElement('select');filterSelect.setAttribute('aria-label','Filter list');filterSelect.innerHTML='<option value="all">All</option><option value="open">Open tabs</option><option value="closed">Closed tabs</option><option value="active">Working</option><option value="attention">Needs attention</option><option value="complete">Complete</option>';
 filterSelect.value=filter;
 const filterRoot=doc.createElement('div');filterRoot.className='library-filter';filterRoot.append(filterSelect);tools.append(input,filterRoot);
 const scopeRow=doc.createElement('div');scopeRow.className='library-scope';
 const allProjects=doc.createElement('button');allProjects.type='button';allProjects.className='text-button';allProjects.addEventListener('click',()=>{scope=scope?'':options.scopeProjectId;render();});
 const count=doc.createElement('span');count.className='muted small';scopeRow.append(count,allProjects);
 const panel=doc.createElement('div');panel.className='library-panel';panel.setAttribute('role','tabpanel');panel.id='library-results';
 const list=doc.createElement('ul');list.className='library-list';const empty=doc.createElement('p');empty.className='library-empty';panel.append(list,empty);
 const foot=doc.createElement('div');foot.className='library-foot';const hint=doc.createElement('span');hint.textContent='Closing a tab keeps its work saved. Running tasks continue.';
 const clear=doc.createElement('button');clear.type='button';clear.textContent='Clear list…';clear.className='text-button';
 const confirm=doc.createElement('div');confirm.className='history-confirm';confirm.hidden=true;confirm.setAttribute('role','alert');
 const message=doc.createElement('span');message.textContent='Clear all recently closed tabs? Projects, tasks and files are kept.';
 const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='Keep history';
 const yes=doc.createElement('button');yes.type='button';yes.textContent='Clear history';
 confirm.append(message,cancel,yes);clear.addEventListener('click',()=>{confirm.hidden=false;cancel.focus();});cancel.addEventListener('click',()=>{confirm.hidden=true;clear.focus();});
 yes.addEventListener('click',async()=>{yes.disabled=true;try{await options.clearHistory();confirm.hidden=true;input.focus();}catch(e){message.textContent='Could not clear history: '+String(e);}finally{yes.disabled=false;}});
 foot.append(hint,clear);root.append(tabs,tools,scopeRow,panel,confirm,foot);
 const filterControl=enhanceSelect(filterSelect);filterSelect.addEventListener('change',()=>{filter=filterSelect.value;renderList();});
 const active=new Set(['working','connecting','reconnecting','executing','queued','verifying','planning','waiting_model','waiting_lock']);
 const attention=new Set(['paused','blocked','review','needs_approval','awaiting_approval','error']);
 function render(){
  for(const [id,b]of buttons){b.setAttribute('aria-selected',String(id===view));b.tabIndex=id===view?0:-1;b.classList.toggle('selected',id===view);b.setAttribute('aria-controls',panel.id);}
  panel.setAttribute('aria-labelledby','library-tab-'+view);input.placeholder=view==='history'?'Search recently closed':view==='tasks'?'Search tasks and goals':'Search projects and folders';
  filterRoot.hidden=view==='history';allProjects.hidden=view==='projects'||!options.scopeProjectId;
  const p=options.projects.find(p=>p.id===scope);allProjects.textContent=scope?'Show all projects':options.projects.find(p=>p.id===options.scopeProjectId)?.label+' only';
  if(!p&&scope)scope='';clear.hidden=view!=='history';confirm.hidden=true;renderList();
 }
 function renderList(){
  const records=view==='projects'?options.projects:options.tasks;
  let rows:{key:string;kind:TabKind;id:string;projectId:string;label:string;subtitle:string;status:string;opened:boolean;selected:boolean;stamp?:number;available:boolean}[];
  if(view==='history')rows=options.state.recentlyClosed.map(h=>{const r=(h.kind==='project'?options.projects:options.tasks).find(r=>r.id===h.id);return {key:h.key,kind:h.kind,id:h.id,projectId:h.projectId,label:r?.label||h.label,subtitle:h.kind==='project'?'Project · '+(r?.subtitle||'Unavailable'):'Task · '+(options.projects.find(p=>p.id===h.projectId)?.label||'Unavailable project'),status:r?.status||'unavailable',opened:false,selected:false,stamp:h.closedAt,available:!!r};});
  else rows=records.map(r=>{const kind=view==='projects'?'project':'task',pid=kind==='project'?r.id:r.projectId||'';return {key:kind+':'+r.id,kind,id:r.id,projectId:pid,label:r.label,subtitle:view==='tasks'?(options.projects.find(p=>p.id===pid)?.label||'')+' · '+r.subtitle:r.subtitle,status:r.status,opened:view==='projects'?options.state.openProjects.includes(r.id):(options.state.openTasks[pid]||[]).includes(r.id),selected:view==='projects'?options.state.projectId===r.id:options.state.projectId===pid&&options.state.taskByProject[pid]===r.id,stamp:r.createdAt,available:true};});
  const q=query.toLocaleLowerCase().trim();rows=rows.filter(r=>(view==='projects'||!scope||r.projectId===scope)&&(!q||(r.label+' '+r.subtitle).toLocaleLowerCase().includes(q))&&(view==='history'||filter==='all'||filter==='open'&&r.opened||filter==='closed'&&!r.opened||filter==='active'&&active.has(r.status)||filter==='attention'&&attention.has(r.status)||filter==='complete'&&r.status==='complete'));
  if(view==='tasks')rows.sort((a,b)=>(b.stamp||0)-(a.stamp||0));
  const scopeName=view!=='projects'&&scope?options.projects.find(p=>p.id===scope)?.label:'';
  count.textContent=rows.length+' '+(view==='projects'?'project':view==='history'?'closed tab':'task')+(rows.length===1?'':'s')+(scopeName?' in '+scopeName:'');
  clear.disabled=!options.state.recentlyClosed.length;const shape=JSON.stringify([view,rows]);if(shape===lastShape)return;lastShape=shape;
  const focused=(doc.activeElement as HTMLElement)?.closest<HTMLElement>('[data-library-key]')?.dataset.libraryKey;const scroll=panel.scrollTop;
  for(const d of disposers)d();disposers=[];list.replaceChildren();
  for(const r of rows){
   const li=doc.createElement('li');li.className='library-row';li.dataset.libraryKey=r.key;
   const button=doc.createElement('button');button.type='button';button.className='library-open';button.dataset.libraryKey=r.key;button.disabled=!r.available;button.setAttribute('aria-label',(view==='history'?'Restore ':'Open ')+r.label);if(r.selected)button.setAttribute('aria-current','true');
   const dot=doc.createElement('i');dot.className='state-dot dot-'+r.status;dot.setAttribute('aria-hidden','true');
   const body=doc.createElement('span');body.className='library-item-body';const title=doc.createElement('strong');title.textContent=r.label;const sub=doc.createElement('small');sub.textContent=r.subtitle;body.append(title,sub);
   const detail=doc.createElement('span');detail.className='library-item-detail';detail.textContent=view==='history'?'Restore':(r.opened?'Open tab':r.status==='idle'?'Saved':r.status.replaceAll('_',' '));
   if(r.stamp){const time=doc.createElement('time');time.dateTime=new Date(r.stamp).toISOString();time.title=new Date(r.stamp).toLocaleString();time.textContent=new Date(r.stamp).toLocaleDateString(undefined,{month:'short',day:'numeric'});detail.append(time);}
   button.append(dot,body,detail);button.addEventListener('click',()=>view==='history'?options.restore(r.key):options.open(r.kind,r.id));li.append(button);list.append(li);
   if(view!=='history'){
    const menu=mountMenu(li,r.label,[],{trigger:button,items:()=>options.menu(r.kind,r.id)});disposers.push(()=>menu.dispose());
    const more=doc.createElement('div');more.className='library-more';li.append(more);const visible=mountMenu(more,'…',options.menu(r.kind,r.id));visible.trigger.setAttribute('aria-label','Actions for '+r.label);disposers.push(()=>visible.dispose());
   }
  }
  empty.hidden=rows.length>0;empty.textContent=query?'No matches. Try another name.':view==='history'?'No recently closed tabs.':view==='projects'?'No projects in this list.':'No tasks in this list.';
  panel.scrollTop=scroll;
  if(focused){const target=Array.from(list.querySelectorAll<HTMLButtonElement>('button.library-open')).find(b=>b.dataset.libraryKey===focused);(target||input).focus({preventScroll:true});}
 }
 const move=(e:KeyboardEvent)=>{const bs=Array.from(list.querySelectorAll<HTMLButtonElement>('button.library-open:not(:disabled)'));if(!bs.length)return;const i=bs.indexOf(doc.activeElement as HTMLButtonElement);if((e.target===input&&e.key==='ArrowDown')||['ArrowDown','ArrowUp','Home','End'].includes(e.key)&&i>=0){e.preventDefault();const index=e.key==='Home'?0:e.key==='End'?bs.length-1:e.target===input?0:(i+(e.key==='ArrowDown'?1:-1)+bs.length)%bs.length;bs[index]!.focus();}};
 root.addEventListener('keydown',move);render();queueMicrotask(()=>{if(root.isConnected)input.focus();});
 return{update(next:LibraryOptions){options=next;if(next.view!==externalView||next.scopeProjectId!==externalScope||(next.initialFilter||'all')!==externalFilter){view=next.view;scope=next.scopeProjectId;externalView=next.view;externalScope=next.scopeProjectId;externalFilter=next.initialFilter||'all';filter=externalFilter;filterSelect.value=filter;filterControl.refresh();render();}else renderList();},dispose(){for(const d of disposers)d();filterControl.dispose();root.removeEventListener('keydown',move);root.replaceChildren();}};
}
