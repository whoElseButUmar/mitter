import {enhanceSelect} from './select.js';
import type {LineDiff} from './line-diff.js';
export interface ChangeReviewOptions {workerId:string;path?:string;rpc:(method:string,params:Record<string,unknown>)=>Promise<any>;notice:(text:string)=>void}
export function mountChangeReview(root:HTMLElement,options:ChangeReviewOptions){
 root.classList.add('miter-release-tool');
 const doc=root.ownerDocument;let disposed=false,generation=0,review:any,busy=false,selectControl:ReturnType<typeof enhanceSelect>|undefined;
 const make=(tag:string,text='',cls='')=>{const e=doc.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
 const label=make('label','File','field'),select=doc.createElement('select');select.setAttribute('aria-label','File to review');label.append(select);
 const status=make('p','Loading changes…','change-status');status.setAttribute('role','status');
 const hint=make('p','Recorded changes for this task’s current run. Reviewing does not apply or re-run anything.','preview-hint');
 const output=make('div','','change-diff');output.tabIndex=0;output.setAttribute('aria-label','Recorded file changes');
 const actions=make('div','','button-row');const reload=make('button','Reload') as HTMLButtonElement,restore=make('button','Restore this file…') as HTMLButtonElement;reload.type=restore.type='button';actions.append(reload,restore);
 const error=make('p','','error');error.setAttribute('role','alert');
 const confirmation=make('div','','restore-confirmation');confirmation.hidden=true;
 const warning=make('p','Restore this file to its content before this run? A created file will be removed. Other files and command side effects are not changed.');
 const cancel=make('button','Keep file') as HTMLButtonElement,confirm=make('button','Restore file') as HTMLButtonElement;cancel.type=confirm.type='button';confirmation.append(warning,cancel,confirm);
 root.append(label,hint,status,output,error,actions,confirmation);
 const pending=(value:boolean)=>{busy=value;select.disabled=value;selectControl?.refresh();reload.disabled=value;restore.disabled=value||!review?.canRestore;confirm.disabled=value;};
 async function load(){const id=++generation;pending(true);error.textContent='';confirmation.hidden=true;review=undefined;restore.disabled=true;output.replaceChildren();
  try{const value=await options.rpc('worker.change',{workerId:options.workerId,path:select.value});if(disposed||id!==generation)return;review=value;
   status.textContent=value.path+' · '+value.kind+' · +'+value.diff.additions+' / −'+value.diff.deletions+(value.conflict?' · Modified since this run':'');
   if(value.warning)error.textContent=value.warning;
   const diff=value.diff as LineDiff;
   for(const line of diff.lines){const row=make('div','','diff-line diff-'+line.kind),number=make('span',line.kind==='omitted'?'…':String(line.newLine??line.oldLine??''),'diff-number'),code=make('code',(line.kind==='add'?'+ ':line.kind==='remove'?'− ':line.kind==='omitted'?'… ':'  ')+line.text);row.append(number,code);output.append(row);}
   if(!diff.lines.length)output.append(make('p','No text difference in the recorded versions.','preview-hint'));
   if(diff.truncated||diff.simplified)output.append(make('p','Large change: this is a bounded review, not a patch for applying. Open the file in your editor for the full source.','preview-hint'));
  }catch(e){if(!disposed&&id===generation)error.textContent=e instanceof Error?e.message:String(e);}finally{if(!disposed&&id===generation)pending(false);}
 }
 select.onchange=()=>{if(!busy)void load();};reload.onclick=()=>void load();restore.onclick=()=>{if(!review||busy)return;confirmation.hidden=false;cancel.focus();};cancel.onclick=()=>{confirmation.hidden=true;restore.focus();};
 confirm.onclick=()=>{if(!review||busy)return;pending(true);const saved=review;void options.rpc('worker.restoreFile',{workerId:options.workerId,path:saved.path,expectedHash:saved.currentHash,confirm:true}).then(()=>{if(!disposed){options.notice('Restored '+saved.path+'. Other files were preserved.');status.textContent='Recorded edits restored for '+saved.path;output.replaceChildren();review=undefined;confirmation.hidden=true;}}).catch(e=>{if(!disposed)error.textContent=e instanceof Error?e.message:String(e);}).finally(()=>{if(!disposed)pending(false);});};
 pending(true);
 void options.rpc('worker.files',{workerId:options.workerId}).then((files:{path:string;status:string}[])=>{if(disposed)return;for(const f of files.filter(f=>['applied','prepared'].includes(f.status))){const o=doc.createElement('option');o.value=f.path;o.textContent=f.path;select.append(o);}if(options.path&&Array.from(select.options).some(o=>o.value===options.path))select.value=options.path;if(!select.options.length){status.textContent='No active journaled file changes in this run.';pending(false);restore.disabled=reload.disabled=true;return;}selectControl=enhanceSelect(select);return load();}).catch(e=>{if(!disposed){error.textContent=String(e);pending(false);}});
 return {dispose(){disposed=true;generation++;selectControl?.dispose();root.replaceChildren();root.classList.remove('miter-release-tool');}};
}
