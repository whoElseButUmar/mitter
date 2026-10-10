export interface HealthPanelOptions {rpc:(method:string,params:Record<string,unknown>)=>Promise<any>;copy:(text:string)=>Promise<unknown>;notice:(text:string)=>void}
/** Mounted only on demand. No periodic health polling or hidden network calls. */
export function mountHealthPanel(root:HTMLElement,options:HealthPanelOptions){
 root.classList.add('miter-release-tool');
 const doc=root.ownerDocument;let disposed=false,busy=false,generation=0,report:any;
 const make=(tag:string,text='',cls='')=>{const el=doc.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
 const state=make('p','Checking the local host…','health-status');state.setAttribute('role','status');
 const detail=make('dl','','health-details'),attention=make('div'),actions=make('div','','button-row'),backups=make('div','','backup-list');
 const error=make('p','','error');error.setAttribute('role','alert');
 const refresh=make('button','Check again') as HTMLButtonElement,backup=make('button','Back up task state') as HTMLButtonElement,copy=make('button','Copy health report') as HTMLButtonElement;
 for(const b of [refresh,backup,copy])b.type='button';
 actions.append(refresh,backup,copy);
 const note=make('p','State backups include task history and journaled source, not project folders or worktree files. Keep them private.','preview-hint');
 root.append(state,detail,attention,actions,error,make('h3','Recent state backups'),backups,note);
 function pending(value:boolean){busy=value;refresh.disabled=backup.disabled=value;copy.disabled=value||!report;}
 async function run(fn:()=>Promise<void>){if(busy||disposed)return;pending(true);error.textContent='';try{await fn();}catch(e){if(!disposed)error.textContent=e instanceof Error?e.message:String(e);}finally{if(!disposed)pending(false);}}
 async function load(){const id=++generation;const next=await options.rpc('system.health',{});if(disposed||id!==generation)return;report=next;detail.replaceChildren();attention.replaceChildren();backups.replaceChildren();
  state.textContent=next.database.ok?'Local host connected · Database check passed':'Local host connected · Database needs attention';
  for(const [label,value] of [['Version',next.version],['Runtime',next.node+' · '+next.workflow],['Tasks',next.tasks.total+' saved · '+next.tasks.active+' executing locally'],['State directory',next.dataDirectory]]){detail.append(make('dt',String(label)),make('dd',String(value)));}
  if(next.attention.length){attention.append(make('p',next.attention.length+' task(s) need attention. Open their task tabs for recovery or approvals.','muted'));}
  if(!next.backups.length)backups.append(make('p','No state backup yet. An existing database is backed up before the first launch of a different release.','muted'));
  for(const item of next.backups){
   const row=make('div','','backup-row'),name=make('div',new Date(item.createdAt).toLocaleString()+' · '+item.reason),meta=make('small',Math.ceil(item.bytes/1024)+' KB · '+item.appVersion,'muted'),buttons=make('div','','button-row');
   const verify=make('button','Verify') as HTMLButtonElement,command=make('button','Copy restore command') as HTMLButtonElement;verify.type=command.type='button';
   verify.onclick=()=>void run(async()=>{await options.rpc('system.verifyBackup',{id:item.id});if(!disposed)options.notice('Backup checksum and database verified.');});
   command.onclick=()=>void run(async()=>{await options.copy('node scripts/maintenance.mjs restore '+item.id+' --confirm');});
   buttons.append(verify,command);row.append(name,meta,buttons);backups.append(row);
  }
 }
 refresh.onclick=()=>void run(load);
 backup.onclick=()=>void run(async()=>{await options.rpc('system.backup',{});if(!disposed){options.notice('Task-state backup created. Project files are not included.');await load();}});
 copy.onclick=()=>void run(async()=>{await options.copy(JSON.stringify(report,null,2));});
 const help=make('details'),summary=make('summary','Restore and safety');help.append(summary,make('p','To restore: close or disable Miter first, then run the copied command from the installed mitter folder. A backup of the current state is made before replacement. Restoring state does not roll back project files. Approved commands run with your operating-system permissions, not in an OS sandbox.','preview-hint'));root.append(help);
 void run(load);
 return {dispose(){disposed=true;generation++;root.replaceChildren();root.classList.remove('miter-release-tool');}};
}
