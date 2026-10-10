import {ReadSnapshots} from './read-snapshots.js';
import {appendObservation,renderObservations,actionRecord} from './model-observations.js';
import {parseProposalEnvelope,parseProposalAction,type ProposalEnvelope} from '../../../../packages/protocol/src/proposal.js';
import {MAX_HANDOFF_BYTES,exceedsHandoffBytes} from '../../../../packages/protocol/src/reply-json.js';
import {ReplyValidationError} from '../../../../packages/protocol/src/validation.js';
import {deliveryKey,matchingDelivery,type HandoffDelivery} from './handoff-delivery.js';
import {createStateBackup,listStateBackups,verifyStateBackup} from './backups.js';
import {inspectHealth} from './health.js';
import {reviewFile} from './review.js';
import {checkJavaScript} from './syntax-check.js';
import {readAsset,openTaskFile,MAX_PREVIEW_BYTES} from './assets.js';
import { Followups } from './followups.js';
import { Collaboration } from './collaboration.js';
import { createWorktree } from './worktrees.js';
import {parseFollowup} from '../../../../packages/protocol/src/requests.js';
import type {Followup} from '../../../../packages/protocol/src/requests.js';
import {parseTaskProgress,progressKey,progressSummary} from '../../../../packages/bridge/src/progress.js';
import { suggestedTaskName } from '../../../../packages/protocol/src/task-brief.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Action, Envelope, Project, Worker, Settings, Snapshot, Request, Response } from '../../../../packages/protocol/src/index.js';
import { APP_VERSION, VERSION,  parseAction, parseChecks, object, text, integer, id, only } from '../../../../packages/protocol/src/index.js';
import { EditConflict, isFileEdit, digest as editDigest } from './edit-plan.js';
import { Store } from './database.js';
import { parseModelSettings, restoreModelSettings } from '../../../../packages/protocol/src/model-settings.js';
import { Workspace, canonicalRoot, overlaps, digest, fileText, listFiles, searchFiles, safePath, validateRelative } from './workspace.js';
import { Locks } from './locks.js';
import { parseProfile, runCommand, redact, gitDiff } from './commands.js';
import type { Profile } from '../../../../packages/protocol/src/index.js';
import { chatPrompt, localPrompt } from './prompts.js';
import { ApprovalNeeded, UserQuestion, errorMessage } from './types.js';
import type { Models, Workflow, WorkflowFactory } from './types.js';
import { pickFolder, revealProject } from './desktop.js';
const stableStates=new Set(['idle','paused','review','blocked','complete','cancelled']);
export class Service {
  readonly projects=new Map<string,Project>();
  readonly workers=new Map<string,Worker>();
  private actors=new Map<string,Workflow>();
  private active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private interruptions=new Set<string>();
  private locks=new Locks();
  private workspace:Workspace;
  private reads:ReadSnapshots;
  readonly followups:Followups;
  readonly team:Collaboration;
  private listeners=new Set<()=>void>();
  settings:Settings;
  private closed=false;
  private teamTimer:ReturnType<typeof setInterval>;
  constructor(readonly store:Store, readonly dataDir:string, readonly factory:WorkflowFactory, readonly models:Models, readonly workflowName='xstate') {
    this.workspace=new Workspace(store);this.reads=new ReadSnapshots(store);this.followups=new Followups(store);this.team=new Collaboration(store,this.workers);const savedSettings=store.get<unknown>('settings');
    this.settings=restoreModelSettings(savedSettings);
    if(savedSettings!==undefined&&JSON.stringify(savedSettings)!==JSON.stringify(this.settings))store.set('settings',this.settings);
    this.teamTimer=setInterval(()=>{if(this.team.expire())this.changed();},1000);this.teamTimer.unref();
    for(const project of store.projects())this.projects.set(project.id,project);
    for(const w of store.workers()) {
      if(!stableStates.has(w.state)) {
        w.state='paused';w.pending=undefined;w.approvedFingerprint=undefined;
        w.error='Interrupted by host shutdown. Inspect the report before resuming. In-flight commands are never blindly replayed.';
        store.event(w.id,'recovery',w.error);
      }
      if(w.control?.mode==='stopped') {
        if(w.queue.length)store.set('miter.retiredQueue.'+w.control.operationId,{workerId:w.id,runId:w.runId,queue:w.queue,cursor:w.cursor,at:Date.now()});
        w.queue=[];w.cursor=0;w.pending=undefined;w.approvedFingerprint=undefined;
        w.state='paused';w.humanAcceptanceReady=false;w.completion=undefined;
      }
      // v0.7.2 removes the redundant acceptance gate, but only for an
      // explicit finish that already passed its configured checks. Never
      // complete ordinary intermediate review states, errors or approvals.
      if(w.state==='review' && w.humanAcceptanceReady===true && !w.queue.length && !w.pending && !w.error && w.control?.mode!=='stopped') {
        w.state='complete';w.humanAcceptanceReady=false;w.completion=undefined;
        w.completion={version:1,verification:w.checks.length?'passed':'not-run',summary:'Finished before this update; acceptance click is no longer required.',checked:w.checks.length,at:Date.now(),...(w.activeFollowupId?{followupId:w.activeFollowupId}:{})};
        this.followups.finish(w,'completed');this.team.releaseOwner(w.id);
        store.event(w.id,'completion-migration','Finished work retained. No files changed or tests rerun; the former acceptance gate was removed.');
      }
      w.autoCommands=false;
      this.workers.set(w.id,w);this.attach(w);store.saveWorker(w);
    }
  }
  private attach(w:Worker):void {
    const actor=this.factory(w.state,state=>{w.state=state;this.store.saveWorker(w);this.changed();});this.actors.set(w.id,actor);
  }
  subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  private changed():void {for(const listener of this.listeners)listener();}
  private save(w:Worker):void {this.store.saveWorker(w);this.changed();}
  private move(w:Worker,state:Worker['state']):void {this.actors.get(w.id)!.move(state);}
  private event(w:Worker,kind:string,message:string):void {this.store.event(w.id,kind,redact(message));this.changed();}
  private worker(value:unknown):Worker {const w=this.workers.get(id(value,'worker ID'));if(!w)throw new Error('Worker not found.');return w;}
  private project(value:unknown):Project {const p=this.projects.get(id(value,'project ID'));if(!p)throw new Error('Project not found.');return p;}
  private executionProject(w:Worker):Project {
    const base=this.project(w.projectId);if(!w.worktree)return base;
    const derived:Project={...base,root:w.worktree.root,sourceRoot:base.root};
    Object.defineProperty(derived,'revision',{enumerable:true,get:()=>base.revision,set:(v:number)=>{base.revision=v;}});
    return derived;
  }
  private idle(w:Worker):void {if(this.active.has(w.id))throw new Error('Pause the worker and wait for the current operation to stop first.');}
  private remember(w:Worker,message:string):void {w.observations=appendObservation(w.observations,message);this.save(w);}
  snapshot():Snapshot {
    // Do not broadcast entire source files or enormous queues to every browser view.
    const small=(a:Action):Action=>a.type==='write'?{...a,content:`[${a.content.length} characters; omitted from status]`}:a.type==='replace'?{...a,before:a.before.slice(0,180),after:a.after.slice(0,180)}:a;
    const bridgeProgress=[...this.workers.values()].flatMap(w=>{const p=parseTaskProgress(this.store.get(progressKey(w.id)));return p&&p.projectId===w.projectId&&p.goalHash===digest(w.goal.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim())?[progressSummary(p)]:[];});
    return {protocol:VERSION,bridgeProgress,projects:[...this.projects.values()],workers:[...this.workers.values()].map(w=>({...w,teamPaused:this.team.reason(w.id)||undefined,followups:this.followups.summaries(w.id),observations:[],queue:w.queue.slice(0,10).map(q=>({...q,actions:q.actions.map(small)}))})),events:this.store.events().slice(0,40).map(e=>({...e,message:e.message.slice(0,2400)})),settings:{...this.settings},runtime:{version:APP_VERSION,node:process.version,workflow:this.workflowName,models:this.settings.coderModelPath?'Local model configured; loaded on demand':'Not configured'}};
  }
  async dispatch(request:Request):Promise<Response> {
    try {return{id:request.id,ok:true,result:await this.handle(request.method,request.params)};}
    catch(error) {return{id:request.id,ok:false,error:redact(errorMessage(error))};}
  }
  async handle(method:string,p:Record<string,unknown>):Promise<unknown> {
    if(this.closed)throw new Error('Host is shutting down.');
    if(method==='state')return this.snapshot();
    if(method==='system.health')return inspectHealth(this.store,this.dataDir,[...this.workers.values()],this.active.size,this.workflowName);
    if(method==='system.backups')return listStateBackups(this.dataDir);
    if(method==='system.backup'){
      if(this.active.size)throw new Error('Pause active local work before creating a state backup.');
      return createStateBackup(this.store.db,this.dataDir,'manual');
    }
    if(method==='system.verifyBackup')return verifyStateBackup(this.dataDir,text(p.id,'backup ID',100));
    if(method==='project.pickFolder')return pickFolder();
    if(method==='project.reveal') {await revealProject(this.project(p.projectId).root);return {opened:true};}
    if(method==='project.read') {
      const project=this.project(p.projectId),relative=text(p.path,'file path',1000);
      const controller=new AbortController();
      return this.locks.using(project.root,controller.signal,()=>fileText(project.root,relative));
    }
    if(method==='project.context'){
      const project=this.project(p.projectId);
      if(p.save===true){project.mission=text(p.mission??'','project goal',4000,true);project.conventions=text(p.conventions??'','conventions',4000,true);this.store.saveProject(project);this.changed();}
      return {mission:project.mission??'',conventions:project.conventions??''};
    }
    if(method==='project.rename'){
      const project=this.project(p.projectId),name=text(p.name,'project name',60).trim();
      if(!name)throw new Error('Enter a project name.');
      project.name=name;this.store.saveProject(project);this.changed();return project;
    }
    if(method==='project.add') {
      if(this.projects.size>=50)throw new Error('This preview supports at most 50 saved projects.');
      const root=await canonicalRoot(text(p.root,'project root',2000));
      if(overlaps(root,this.dataDir))throw new Error('Do not register Mitter’s own data directory.');
      for(const existing of this.projects.values())if(overlaps(root,existing.root))throw new Error('This folder overlaps an existing project. Reuse that project so workers share its lock.');
      const project:Project={id:randomUUID(),name:text(p.name,'project name',60),root,profiles:[],revision:0};
      this.projects.set(project.id,project);this.store.saveProject(project);this.changed();return project;
    }
    if(method==='project.profile') {
      const project=this.project(p.projectId);
      if([...this.workers.values()].some(w=>w.projectId===project.id&&this.active.has(w.id)))throw new Error('Pause this project’s workers before changing command profiles.');
      const profile=parseProfile(p.profile);
      if(project.profiles.length>=16&&!project.profiles.some(c=>c.id===profile.id))throw new Error('At most 16 command profiles per project.');
      project.profiles=project.profiles.filter(c=>c.id!==profile.id).concat(profile);project.revision++;
      this.store.saveProject(project);this.changed();return project;
    }
    if(method==='worker.create') {
      if(this.workers.size>=200)throw new Error('This preview supports at most 200 saved tasks. Closing a tab preserves its record.');
      const project=this.project(p.projectId);
      const checks=parseChecks(p.checks??[]);
      for(const check of checks)if(check.type!=='command')validateRelative(check.path);
      if(p.mode!=='handoff'&&p.mode!=='local')throw new Error('Choose handoff or local mode.');
      const goal=text(p.goal,'goal',4000).trim();
      const name=p.name===undefined||typeof p.name==='string'&&!p.name.trim()?suggestedTaskName(goal):text(p.name,'worker name',60).trim();
      const w:Worker={id:randomUUID(),projectId:project.id,name,goal,checks,mode:p.mode,state:'idle',queue:[],cursor:0,runId:randomUUID(),iteration:0,maxIterations:integer(p.maxIterations??8,'iterations',1,100),maxMinutes:integer(p.maxMinutes??15,'minutes',1,240),startedAt:0,autoCommands:false,observations:[],repeatCount:0,createdAt:Date.now()};
      if(p.workspaceMode==='worktree')w.worktree=await createWorktree(project.root,this.dataDir,w.id);
      else if(p.workspaceMode!==undefined&&p.workspaceMode!=='shared')throw new Error('Choose shared workspace or worktree.');
      this.workers.set(w.id,w);this.attach(w);this.save(w);this.event(w,'created','Worker created. Nothing runs until you press Run.');return w;
    }
    if(method==='settings.update') {
      if(this.active.size)throw new Error('Pause all workers before changing model settings.');
      const next=parseModelSettings(p.settings);
      if(next.coderModelPath) {
        if(!path.isAbsolute(next.coderModelPath)||!next.coderModelPath.toLowerCase().endsWith('.gguf'))throw new Error('Select an absolute local .gguf file path. URLs are not accepted.');
        if(!(await fs.stat(next.coderModelPath)).isFile())throw new Error('Select a local .gguf file, not a directory.');
      }
      // Filesystem checks yield; do not reconfigure a worker that started meanwhile.
      if(this.active.size)throw new Error('Pause all workers before changing model settings.');
      this.store.set('settings',next);this.settings=next;this.models.close();this.changed();return this.settings;
    }
    const w=this.worker(p.workerId),project=this.executionProject(w);
    if(method==='worker.steerValidate'){
      const request=parseFollowup(p.request),previous=this.store.get<{signature:string}>('miter.controlOperation.'+request.id);
      if(previous){if(previous.signature!==digest(JSON.stringify({workerId:w.id,steer:true,request})))throw new Error('This control ID was used for another request.');return {valid:true,alreadyApplied:true};}
      await this.validateSteering(w,project,request);return {valid:true,alreadyApplied:false};
    }
    if(method==='worker.stop'||method==='worker.steer')return this.interruptTask(w,project,p,method==='worker.steer');
    if(method==='worker.continueFresh') {
      this.idle(w);
      if(this.interruptions.has(w.id))throw new Error('The previous operation is still stopping. Wait before continuing.');
      if(w.control?.mode!=='stopped')return {ready:w.control?.mode==='fresh'};
      // Complete crash recovery before rearming. Never execute the old queue.
      if(w.queue.length){this.store.set('miter.retiredQueue.'+w.control.operationId,{workerId:w.id,runId:w.runId,queue:w.queue,cursor:w.cursor,at:Date.now()});w.queue=[];w.cursor=0;}
      w.control.mode='fresh';w.error=undefined;this.move(w,'paused');this.save(w);
      this.event(w,'control','Fresh continuation requested. Completed files and history retained; old unexecuted proposals will not run.');
      return {ready:true,epoch:w.control.epoch};
    }
    const gated=new Set(['worker.validateReply','worker.import','worker.run','worker.resume','worker.approve','worker.followupActivate','worker.accept']);
    if(gated.has(method)){
      if(this.interruptions.has(w.id)||w.control?.mode==='stopped')throw new Error('This task is stopped. Use Continue fresh; the old plan will not be replayed.');
      if(['worker.validateReply','worker.import','worker.run','worker.resume','worker.approve'].includes(method)&&w.control&&(p.epoch??0)!==w.control.epoch)
        throw new Error('This operation belongs to an earlier run. It was not executed.');
    }
    if(method==='worker.reveal'){await revealProject(project.root);return {opened:true};}
    if(method==='worker.read')return this.locks.using(project.root,new AbortController().signal,()=>fileText(project.root,text(p.path,'path',1000)));
    if(method==='worker.browse')return {root:project.root,files:await listFiles(project.root,typeof p.path==='string'?p.path:'.')};
    if(method==='worker.asset')return readAsset(project.root,text(p.path,'path',1000),integer(p.offset??0,'offset',0,MAX_PREVIEW_BYTES),integer(p.length??192000,'chunk size',1,192000),p.stamp===undefined?undefined:text(p.stamp,'stamp',64));
    if(method==='worker.openFile'){
      if(p.application!=='finder'&&p.application!=='vscode')throw new Error('Choose Finder or VS Code.');
      return openTaskFile(project.root,text(p.path,'path',1000),p.application);
    }
    if(method==='worker.followups')return this.followups.list(w.id);
    if(method==='worker.followup'){
      const f=await this.locks.using(project.root,new AbortController().signal,()=>this.followups.enqueue(w,project.root,p.request));
      this.event(w,'followup','Follow-up queued: '+f.instruction);return f;
    }
    if(method==='worker.followupCancel'){
      const f=this.followups.get(id(p.id));
      if(!f||f.workerId!==w.id||!['queued','blocked'].includes(f.status))throw new Error('Only a queued follow-up can be removed.');
      f.status='cancelled';f.finishedAt=Date.now();this.followups.save(f);this.changed();return {cancelled:true};
    }
    if(method==='worker.followupActivate')return this.locks.using('followup:'+w.id,new AbortController().signal,()=>this.activateFollowup(w,project));
    if(method==='worker.team')return {peers:[...this.workers.values()].filter(peer=>peer.projectId===w.projectId&&peer.id!==w.id).map(peer=>({id:peer.id,name:peer.name,state:peer.state,branch:peer.worktree?.branch??'Shared workspace',held:this.team.reason(peer.id)})),messages:this.team.messages(w.projectId)};
    if(method==='worker.teamMessage'){
      const a=parseAction({type:'team_message',message:p.message,...(p.to?{to:p.to}:{})});
      if(a.type!=='team_message')throw new Error('Invalid message');const result=this.team.execute(w,a,id(p.id));this.changed();return result;
    }
    if(method==='worker.bridgeLoad') {
      const raw=this.store.get(progressKey(w.id)),progress=parseTaskProgress(raw);
      if(raw!==undefined&&!progress)throw new Error('Saved task progress uses an unsupported or damaged format. It was not overwritten. Restore a compatible version or review diagnostics.');
      if(progress&&(progress.workerId!==w.id||progress.projectId!==w.projectId||progress.goalHash!==digest(w.goal.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim())))throw new Error('Saved progress belongs to a different task goal. Nothing was reset.');
      return {progress:progress??null,importedCount:this.store.envelopeCount(w.id)};
    }
    if(method==='worker.bridgeSave') {
      if(w.control&&(w.control.mode==='stopped'||(p.epoch??0)!==w.control.epoch))throw new Error('This progress update belongs to a stopped or earlier run. It was not saved.');
      const next=parseTaskProgress(p.progress);
      if(!next||next.workerId!==w.id||next.projectId!==w.projectId||next.goalHash!==digest(w.goal.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim()))throw new Error('Invalid task progress binding.');
      const saved=this.store.transaction(()=>{
        const raw=this.store.get(progressKey(w.id)),prior=parseTaskProgress(raw);
        if(raw!==undefined&&!prior)throw new Error('Unsupported saved progress format; refusing to overwrite it.');
        if(next.revision!==(prior?.revision??0))throw new Error('Task progress changed in another session. Resume to reload it.');
        if(prior&&(next.turns<prior.turns||next.maxTurns!==prior.maxTurns||next.maxMinutes!==prior.maxMinutes||next.activeMs<prior.activeMs||next.startedAt!==prior.startedAt))throw new Error('Task counters and budgets cannot be reset by Resume.');
        const value={...next,revision:next.revision+1,reason:redact(next.reason)};
        this.store.set(progressKey(w.id),value);return value;
      });this.changed();return saved;
    }
    if(method==='worker.bridgeExtend') {
      if(p.confirm!==true)throw new Error('Explicit authorization is required to extend the task budget.');
      const raw=this.store.get(progressKey(w.id)),progress=parseTaskProgress(raw);
      if(!progress||progress.goalHash!==digest(w.goal.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim()))throw new Error('No compatible saved progress for this task.');
      if(!['idle','review','paused','blocked'].includes(w.state)||w.humanAcceptanceReady)throw new Error('Review this task before extending its budget.');
      const next={...progress,maxTurns:Math.min(100000,Math.max(progress.maxTurns,progress.turns)+15),maxMinutes:Math.min(100000,Math.max(progress.maxMinutes,Math.ceil(progress.activeMs/60000))+30),revision:progress.revision+1};
      this.store.set(progressKey(w.id),next);this.event(w,'budget','User added 15 chat turns and 30 active minutes. Previous progress retained.');return next;
    }
    if(method==='worker.rename'){
      const name=text(p.name,'task name',60).trim();if(!name)throw new Error('Enter a task name.');
      w.name=name;this.save(w);return w;
    }
    if(method==='worker.prompt')return chatPrompt(w,project,typeof p.kind==='string'?p.kind:'bootstrap')+this.followups.prompt(w)+(w.control?'\n\nRUN CONTROL: The user interrupted an earlier plan. Keep completed file edits and task history. Earlier unexecuted proposals are retired. Read the relevant current files and plan again; never assume a displayed earlier reply executed.':'')+await this.team.context(w,project);
    if(method==='worker.history'){
      const before=p.before===undefined?Number.MAX_SAFE_INTEGER:integer(p.before,'history cursor',1,Number.MAX_SAFE_INTEGER);
      const rows=this.store.taskEvents(w.id,before),events=rows.slice(0,100).map(e=>({...e,message:e.message.slice(0,2400)}));
      return {events,hasMore:rows.length>100,before:events.at(-1)?.id??null};
    }
    if(method==='worker.report')return this.report(w,project)+await this.team.context(w,project);
    if(method==='worker.handoffSeen')return {seen:this.store.envelopeOwner(id(p.envelopeId,'envelope ID'))===w.id};
    if(method==='worker.change')return this.locks.using(project.root,new AbortController().signal,()=>reviewFile(this.store,w.runId,project.root,text(p.path,'file path',1000)));
    if(method==='worker.syntax')return this.locks.using(project.root,new AbortController().signal,()=>checkJavaScript(project.root,text(p.path,'file path',1000),this.dataDir,new AbortController().signal));
    if(method==='worker.restoreFile'){
      this.idle(w);
      if(p.confirm!==true)throw new Error('Confirm restoring this journaled file.');
      if(w.queue.length||!(w.state==='complete'||w.state==='cancelled'||w.control?.mode==='stopped'))throw new Error('Stop the task before restoring a file while work is unfinished.');
      const relative=text(p.path,'file path',1000),expected=text(p.expectedHash,'reviewed hash',64);
      if(!/^[a-f0-9]{64}$/.test(expected))throw new Error('Restore requires the current reviewed file hash.');
      const result=await this.locks.using(project.root,new AbortController().signal,()=>this.workspace.rollback(project,w.runId,relative,expected));
      w.completion=undefined;w.humanAcceptanceReady=false;w.error=undefined;w.autoCommands=false;
      if(w.state!=='cancelled')this.move(w,'paused');this.save(w);this.event(w,'restore-file','Restored recorded edits for '+relative+'. Other files were not changed.');return result;
    }
    if(method==='worker.files') {
      const latest=new Map<string,{path:string;status:string;bytes:number}>();
      for(const edit of this.store.changedFiles(w.runId))if(!latest.has(edit.path))latest.set(edit.path,edit);
      return [...latest.values()];
    }
    if(method==='worker.validateReply') {
      try {
        const raw=text(p.text,'handoff',MAX_HANDOFF_BYTES);
        if(exceedsHandoffBytes(raw))throw new Error('Handoff is too large. Split it into smaller batches.');
        const e=parseProposalEnvelope(raw);
        if(e.workerId!==w.id||e.projectId!==project.id)throw new Error('This reply belongs to a different task or project.');
        this.validateProposal(w,project,e);
        return {valid:true};
      } catch(error) {
        if(error instanceof ReplyValidationError)return {valid:false,issue:error.issue};
        throw error;
      }
    }
    if(method==='worker.import') {
      const raw=text(p.text,'handoff',MAX_HANDOFF_BYTES);
      if(exceedsHandoffBytes(raw))throw new Error('Handoff is too large. Split it into smaller batches.');
      const e=parseProposalEnvelope(raw);
      if(e.workerId!==w.id||e.projectId!==project.id)throw new Error('This handoff belongs to a different worker or project. Switch to its tab.');
      // A retry must be an exact acknowledgement replay, not another import.
      // Keep ordinary/manual duplicate imports rejected. The task epoch gate
      // above still runs before this branch, including after Stop or Steer.
      if(this.store.hasEnvelope(e.id)){
        if(p.reconcile!==true)throw new Error('This handoff was already imported. Duplicate execution is blocked.');
        matchingDelivery(this.store,w,e.id,digest(JSON.stringify(e)));
        return {queued:w.queue.some(q=>q.id===e.id),acknowledged:true};
      }
      this.idle(w);
      if(w.control){
        if(e.replyTo&&w.control.retiredExchanges.includes(e.replyTo))throw new Error('This reply belongs to a stopped exchange. No actions were imported.');
        if(w.control.mode==='fresh'){
          const savedProgress=parseTaskProgress(this.store.get(progressKey(w.id)));
          if(!savedProgress?.lastReceipt?.exchangeId||e.replyTo!==savedProgress.lastReceipt.exchangeId||!['commit_intent','waiting_reply'].includes(savedProgress.stage))
            throw new Error('Fresh continuation requires a reply to its new request. Old replies cannot be reused.');
        }
      }
      if(w.queue.length>=20)throw new Error('Queue is full (20 batches).');
      const executable=this.validateProposal(w,project,e);
      this.newRunIfNeeded(w);w.humanAcceptanceReady=false;w.completion=undefined;
      // Command trust is a per-batch grant. Each newly imported reply contains
      // actions nobody has seen; it must not inherit "trust this run".
      w.autoCommands=false;
      const delivery:HandoffDelivery={version:1,workerId:w.id,projectId:w.projectId,runId:w.runId,
        epoch:w.control?.epoch??0,hash:digest(JSON.stringify(e)),started:false};
      this.store.transaction(()=>{
        this.store.rememberEnvelope(e.id,w.id);this.store.set(deliveryKey(e.id),delivery);
        if(w.control)w.control.mode='active';w.queue.push(executable);this.store.saveWorker(w);
      });
      w.pending=undefined;w.approvedFingerprint=undefined;w.error=undefined;this.move(w,'queued');this.save(w);this.event(w,'import',e.summary);return {queued:true};
    }
    if(method==='worker.run'&&p.envelopeId!==undefined){
      const envelopeId=id(p.envelopeId,'envelope ID'),hash=text(p.envelopeHash,'envelope hash',64);
      const d=matchingDelivery(this.store,w,envelopeId,hash);
      if(d.started){
        // A lost start acknowledgement cannot run a command or edit again.
        // The caller polls actual worker state for approval/failure/completion.
        return {started:true,acknowledged:true,state:w.state};
      }
      if(this.active.has(w.id)||w.state!=='queued'||w.queue[0]?.id!==envelopeId||w.cursor!==0||w.pending||w.error)
        throw new Error('The accepted batch is not at its untouched queue head. Review local work before continuing.');
      // Record start intent before scheduling any side effect. A crash in this
      // boundary remains paused on host restart; it is never an automatic retry.
      this.store.set(deliveryKey(envelopeId),{...d,started:true});
      this.run(w.id);return {started:true};
    }
    if(method==='worker.run'||method==='worker.resume') {this.run(w.id);return {started:true};}
    if(method==='worker.pause'||method==='worker.cancel') {
      if(p.epoch!==undefined&&p.epoch!==(w.control?.epoch??0))throw new Error('This cancellation belongs to an earlier run. Current work was not changed.');
      // A Stop request may race the final successful verification. Preserve
      // completion rather than turning an already-finished task into paused.
      if(method==='worker.pause'&&w.state==='complete'&&!this.active.has(w.id))return {stopping:false,completed:true};
      if(method==='worker.pause'&&w.state==='review'&&!w.queue.length&&!this.active.has(w.id))return {stopping:false,review:true};
      this.active.get(w.id)?.controller.abort(new Error('Stopped by user.'));
      this.move(w,method==='worker.pause'?'paused':'cancelled');w.pending=undefined;w.approvedFingerprint=undefined;w.autoCommands=false;
      if(method==='worker.cancel') {w.queue=[];w.cursor=0;this.followups.finish(w,'cancelled');}
      this.team.releaseOwner(w.id);
      this.save(w);return {stopping:this.active.has(w.id)};
    }
    if(method==='worker.approve') {
      this.idle(w);
      if(!w.pending||w.pending.token!==p.token)throw new Error('Approval expired or does not match this worker.');
      if(p.approve!==true) {w.pending=undefined;w.error='Action denied by user.';this.move(w,'blocked');this.save(w);return {denied:true};}
      if(w.pending.revision!==project.revision) {w.pending=undefined;this.move(w,'blocked');this.save(w);throw new Error('Workspace changed while approval was pending. Run again to review a fresh approval.');}
      w.approvedFingerprint=w.pending.fingerprint;w.autoCommands=p.trustRun===true;w.pending=undefined;w.error=undefined;this.move(w,'queued');this.save(w);this.run(w.id);return {approved:true};
    }
    if(method==='worker.skip') {
      this.idle(w);if(p.confirm!==true)throw new Error('Explicit confirmation is required.');
      const q=w.queue[0];if(!q)throw new Error('No queued action to skip.');
      const skipped=q.actions[w.cursor];
      if(skipped&&isFileEdit(skipped))this.store.set(`edit-skipped:${q.id}_${w.cursor}`,{workerId:w.id,runId:w.runId,actionHash:editDigest(JSON.stringify(skipped))});
      this.event(w,'user','User skipped a quarantined or unwanted action.');w.cursor++;
      if(w.cursor>=q.actions.length){w.queue.shift();w.cursor=0;}
      w.pending=undefined;w.approvedFingerprint=undefined;w.error=undefined;this.move(w,'paused');this.save(w);return {skipped:true};
    }
    if(method==='worker.rollback') {
      this.idle(w);if(p.confirm!==true)throw new Error('Confirm rollback; command side effects cannot be undone.');
      const controller=new AbortController();
      const result=await this.locks.using(project.root,controller.signal,()=>this.workspace.rollback(project,w.runId));
      w.pending=undefined;w.approvedFingerprint=undefined;w.queue=[];w.cursor=0;w.autoCommands=false;w.humanAcceptanceReady=false;w.completion=undefined;w.error=undefined;this.move(w,'paused');this.save(w);this.event(w,'rollback',JSON.stringify(result));return result;
    }
    if(method==='worker.accept') {
      this.idle(w);
      // Older UI clients may still send their former acceptance request.
      // A completed task is idempotent; do not record a fabricated review.
      if(p.confirm===true&&w.state==='complete'&&!w.queue.length)return {accepted:false,alreadyComplete:true};if(p.confirm!==true||w.state!=='review'||w.queue.length||w.humanAcceptanceReady!==true||(w.checks.length>0&&!w.activeFollowupId))throw new Error('Only an explicit finish with no objective checks can be manually accepted. A listed folder is not a completed goal.');
      w.completion={version:1,verification:'legacy-accepted',summary:'Manually accepted through a legacy client.',checked:w.checks.length,at:Date.now()};this.followups.finish(w,'completed');this.move(w,'complete');w.autoCommands=false;this.save(w);this.event(w,'user','Goal accepted by the user (not independently proven by the model).');return {accepted:true};
    }
    throw new Error('Unknown request method.');
  }
  private async validateSteering(w:Worker,project:Project,raw:unknown){
    const request=parseFollowup(raw);
    if(!request.instruction.trim())throw new Error('Enter a steering instruction.');
    const old=this.followups.get(request.id);
    const operation=this.store.get('miter.controlOperation.'+request.id);
    if(old&&!operation&&(old.workerId!==w.id||old.status!=='queued'||old.instruction!==request.instruction||JSON.stringify(old.selection)!==JSON.stringify(request.selection)))
      throw new Error('This steering request ID was already used. Submit a new instruction.');
    if(!old&&this.followups.list(w.id).filter(f=>f.status==='queued'||f.status==='blocked').length>=20)
      throw new Error('This task already has 20 pending follow-ups. Complete or remove one first.');
    if(request.selection){const f=await fileText(project.root,request.selection.path);if(f.hash!==request.selection.hash||f.content.slice(request.selection.start,request.selection.end)!==request.selection.text)throw new Error('The selected code changed. Reload and select it again.');}
    return request;
  }
  /** Stop is durable cancellation of an execution plan, NOT task deletion.
   * Fence callbacks synchronously, abort owned processes, then archive the exact
   * settled cursor. Already committed writes are never rolled back implicitly. */
  private async interruptTask(w:Worker,project:Project,p:Record<string,unknown>,steer:boolean):Promise<unknown> {
    const request=steer?parseFollowup(p.request):undefined;
    if(steer&&!request!.instruction.trim())throw new Error('Enter a steering instruction.');
    const operationId=id(request?.id??p.id,'operation ID');
    const key='miter.controlOperation.'+operationId;
    const signature=digest(JSON.stringify({workerId:w.id,steer,request}));
    const previous=this.store.get<{signature:string;result:unknown}>(key);
    if(previous){if(previous.signature!==signature)throw new Error('This control ID was used for another request.');return previous.result;}
    if(this.interruptions.has(w.id))throw new Error('This task is already stopping. Wait for it to finish.');
    this.interruptions.add(w.id);
    try {
      // Validate selections before interrupting when possible; an invalid
      // instruction must not replace a valid running request.
      if(request)await this.validateSteering(w,project,request);
      const raw=this.store.get(progressKey(w.id)),progress=parseTaskProgress(raw);
      if(raw&&!progress)throw new Error('Saved progress is incompatible. It was not overwritten.');
      const retired=[...(w.control?.retiredExchanges??[])];
      if(progress?.lastReceipt?.exchangeId&&!retired.includes(progress.lastReceipt.exchangeId))retired.push(progress.lastReceipt.exchangeId);
      // Persist before the first await following abort: stale send/import saves
      // get a different epoch/revision, including after a host crash.
      this.store.transaction(()=>{
        this.store.set('miter.controlArchive.'+operationId,{workerId:w.id,runId:w.runId,progress,queue:w.queue,cursor:w.cursor,at:Date.now(),kind:steer?'steer':'stop'});
        w.control={version:1,epoch:(w.control?.epoch??0)+1,mode:'stopped',at:Date.now(),operationId,reason:steer?'Steering instruction requested.':'Stopped by you.',retiredExchanges:retired};
        if(progress){
          progress.revision++;progress.stage='report_due';progress.phase='stopped';progress.reason='Stopped. Completed files kept; next continuation replans from current files.';
          progress.errorCode=undefined;progress.lastReceipt=undefined;progress.approvedReply=undefined;progress.formatRepairs=0;progress.repeats=0;progress.lastActionsHash=undefined;
          this.store.set(progressKey(w.id),progress);
        }
        this.store.saveWorker(w);
      });
      this.active.get(w.id)?.controller.abort(new Error(steer?'Steered by user.':'Stopped by user.'));
      this.changed();
      await this.wait(w.id);
      this.store.set('miter.retiredQueue.'+operationId,{workerId:w.id,runId:w.runId,queue:w.queue,cursor:w.cursor,at:Date.now()});
      w.queue=[];w.cursor=0;w.pending=undefined;w.approvedFingerprint=undefined;w.autoCommands=false;w.error=undefined;w.humanAcceptanceReady=false;w.completion=undefined;
      this.team.releaseOwner(w.id);
      this.move(w,'paused');
      const control=w.control;if(!control)throw new Error('Run-control state was lost. Work remains stopped.');
      if(request){
        const followup=await this.locks.using(project.root,new AbortController().signal,()=>this.followups.enqueue(w,project.root,request));
        if(followup.status!=='queued')throw new Error('That steering request was already used. Submit a new request.');
        this.followups.finish(w,'superseded');
        followup.status='active';followup.activatedAt=Date.now();this.followups.save(followup);w.activeFollowupId=followup.id;
        control.mode='fresh';
        if(progress){progress.revision++;progress.maxTurns=Math.max(progress.maxTurns,progress.turns+15);progress.maxMinutes=Math.max(progress.maxMinutes,Math.ceil(progress.activeMs/60000)+30);this.store.set(progressKey(w.id),progress);}
        w.maxIterations=Math.max(w.maxIterations,w.iteration+8);
      }
      this.save(w);
      this.event(w,'control',steer?'Steering now: '+request!.instruction:'Stopped. Completed file changes kept; remaining plan archived. Continue fresh will inspect the current files.');
      const result={stopped:!steer,ready:steer,epoch:control.epoch,operationId};
      this.store.set(key,{signature,result});return result;
    } finally {this.interruptions.delete(w.id);this.save(w);}
  }
  private async activateFollowup(w:Worker,project:Project):Promise<{activated:boolean;id?:string;reason?:string}> {
    if(this.active.has(w.id)||w.queue.length||w.pending||this.team.reason(w.id))return {activated:false,reason:'Current work must reach a safe boundary first.'};
    if(w.activeFollowupId&&this.followups.get(w.activeFollowupId)?.status==='active')return {activated:false,reason:'The current follow-up is still in progress.'};
    const raw=this.store.get(progressKey(w.id)),progress=parseTaskProgress(raw);
    if(raw&&!progress)throw new Error('Saved progress is incompatible; it was not reset.');
    if(progress&&['commit_intent','waiting_reply','prepared','local_batch'].includes(progress.stage))return {activated:false,reason:'Confirm the pending chat exchange before starting a follow-up.'};
    const next=this.followups.list(w.id).find(f=>f.status==='queued'||f.status==='blocked');
    if(!next||next.status==='blocked')return {activated:false,reason:next?.error};
    if(!['idle','review','complete','paused','blocked','cancelled'].includes(w.state))return {activated:false};
    try{await this.locks.using(project.root,new AbortController().signal,()=>this.followups.checkSelection(next,project.root));}
    catch(e){this.changed();throw e;}
    this.store.transaction(()=>{
      // Historical requests remain in the additive table; never overwrite them.
      if(w.activeFollowupId&&this.followups.get(w.activeFollowupId)?.status!=='completed')this.followups.finish(w,'superseded');next.status='active';next.activatedAt=Date.now();this.followups.save(next);
      w.activeFollowupId=next.id;w.error=undefined;w.humanAcceptanceReady=false;w.completion=undefined;w.autoCommands=false;w.pending=undefined;w.approvedFingerprint=undefined;
      w.repeatCount=0;w.lastProposal=undefined;w.maxIterations=Math.max(w.maxIterations,w.iteration+8);
      if(progress){
        const previous={...progress};this.store.set('miter.followup.checkpoint.'+next.id,previous);
        progress.revision++;progress.stage='report_due';progress.approvedReply=undefined;progress.phase='stopped';progress.reason='Follow-up ready in the same conversation.';progress.errorCode=undefined;
        progress.formatRepairs=0;progress.repeats=0;progress.maxTurns=Math.max(progress.maxTurns,progress.turns+15);progress.maxMinutes=Math.max(progress.maxMinutes,Math.ceil(progress.activeMs/60000)+30);
        this.store.set(progressKey(w.id),progress);
      }
      this.store.saveWorker(w);
    });
    this.move(w,'paused');this.save(w);this.event(w,'followup','Continuing this task: '+next.instruction);
    return {activated:true,id:next.id};
  }
  /** Admission is distinct from transport parsing and execution. Only the host
   * can bind read references. It never fixes model contents or substitutes the
   * live file hash; file preflight remains under the project lock at execution. */
  private validateProposal(w:Worker,project:Project,e:ProposalEnvelope):Envelope {
    for(let i=0;i<e.actions.length;i++) {
      const a=e.actions[i]!;
      if(a.type==='finish'&&i!==e.actions.length-1)throw new Error('finish must be the final action in a batch.');
      if('path' in a)validateRelative(a.path,a.type==='list');
      if(a.type==='command'&&!project.profiles.some(c=>c.id===a.profileId))throw new Error(`Register the command profile ${a.profileId} yourself before importing it.`);
    }
    return this.reads.resolve(w,project,e);
  }
  private newRunIfNeeded(w:Worker):void {
    if(['complete','cancelled'].includes(w.state)) {
      w.humanAcceptanceReady=false;w.completion=undefined;w.runId=randomUUID();w.iteration=0;w.repeatCount=0;w.lastProposal=undefined;w.cursor=0;w.autoCommands=false;
    }
  }
  run(workerId:string):void {
    const w=this.worker(workerId);this.idle(w);
    if(this.interruptions.has(w.id)||w.control?.mode==='stopped')throw new Error('Task stopped. Use Continue fresh before running.');
    if(w.control?.mode==='fresh'&&w.mode==='local'){w.control.mode='active';this.save(w);}
    if(w.state==='awaiting_approval')throw new Error('Approve or reject the pending action first.');
    if(w.mode==='handoff'&&!w.queue.length)throw new Error('Import a handoff first. Or create a Local mode worker.');
    this.newRunIfNeeded(w);w.error=undefined;w.startedAt=Date.now();
    this.move(w,w.queue.length?'queued':'planning');this.save(w);
    const controller=new AbortController();
    const budgetTimer=setTimeout(()=>{
      w.error='Active run time budget reached. Inspect the report before resuming.';
      this.event(w,'budget',w.error);controller.abort(new Error(w.error));
    },w.maxMinutes*60000);budgetTimer.unref();
    // Register before entering the async loop, so another request cannot double-start it.
    const record={controller,promise:Promise.resolve()};this.active.set(w.id,record);
    record.promise=Promise.resolve().then(()=>this.loop(w,controller.signal)).catch(error=>{
      if(error instanceof ApprovalNeeded)return;
      if(controller.signal.aborted) {if(!['paused','cancelled'].includes(w.state))this.move(w,'paused');return;}
      w.error=redact(errorMessage(error));this.move(w,'blocked');this.event(w,'error',w.error);
    }).finally(()=>{clearTimeout(budgetTimer);this.active.delete(w.id);this.save(w);});
  }
  async wait(workerId:string):Promise<void> {await this.active.get(workerId)?.promise;}
  private async loop(w:Worker,signal:AbortSignal):Promise<void> {
    const project=this.executionProject(w);
    while(!this.closed) {
      signal.throwIfAborted();
      while(this.team.reason(w.id)){
        signal.throwIfAborted();
        await new Promise<void>(resolve=>setTimeout(resolve,100));
      }
      if(Date.now()-w.startedAt>w.maxMinutes*60000)throw new Error('Active run time budget reached. Review progress before continuing.');
      let batch=w.queue[0];
      if(!batch) {
        if(w.mode==='handoff') {this.move(w,'review');w.autoCommands=false;this.event(w,'handoff','Batch finished. Export the report or import the next handoff. The goal has not been declared complete.');return;}
        if(w.iteration>=w.maxIterations)throw new Error('Iteration budget reached. Create a new worker or review the remaining scope.');
        if(!this.settings.coderModelPath)throw new Error('Configure a local GGUF coding model in Settings. No cloud or pretend model is substituted.');
        this.move(w,'planning');
        if(!w.observations.length) {const files=await this.locks.using(project.root,signal,()=>listFiles(project.root));this.remember(w,'Initial project files: '+JSON.stringify(files));}
        this.move(w,'waiting_model');w.iteration++;this.save(w);
        const context=await this.team.context(w,project);
        const generated=await this.locks.using('inference',signal,()=>this.models.propose(localPrompt(w,project)+this.followups.prompt(w)+context,signal));
        signal.throwIfAborted();
        const proposal=object(JSON.parse(generated),'model proposal');only(proposal,['summary','actions']);
        if(!Array.isArray(proposal.actions)||!proposal.actions.length||proposal.actions.length>8)throw new Error('Model must propose 1–8 structured actions.');
        const actions=proposal.actions.map(parseProposalAction);
        const fingerprint=digest(JSON.stringify(actions));w.repeatCount=w.lastProposal===fingerprint?w.repeatCount+1:0;w.lastProposal=fingerprint;
        if(w.repeatCount>=2)throw new Error('Model repeated the same proposal three times. Stopped to avoid a loop.');
        w.error=undefined;
        batch=this.validateProposal(w,project,{protocol:VERSION,id:randomUUID(),workerId:w.id,projectId:project.id,summary:text(proposal.summary,'summary',4000),actions});
        for(let i=0;i<actions.length;i++)if(actions[i]!.type==='finish'&&i!==actions.length-1)throw new Error('Model put an action after finish. Proposal rejected.');
        // A fresh local proposal is new content too; command trust ends with the batch it was granted in.
        w.autoCommands=false;
        this.store.transaction(()=>{this.store.rememberEnvelope(batch!.id,w.id);w.queue.push(batch!);w.cursor=0;this.store.saveWorker(w);});
        this.event(w,'plan',batch.summary);
      }
      if(w.cursor>=batch.actions.length) {w.queue.shift();w.cursor=0;this.save(w);continue;}
      const action=batch.actions[w.cursor]!;
      const actionId=`${batch.id}_${w.cursor}`;
      this.move(w,'waiting_lock');
      let finished=false;
      try {
        if(isFileEdit(action)) {
          await this.locks.using(project.root,signal,async()=>{
            this.move(w,'executing');signal.throwIfAborted();
            // Validate the entire contiguous edit segment before writing any
            // of it, and hold one project lock until that segment is committed.
            const plan=await this.workspace.plan(project,w.id,w.runId,batch!,w.cursor);
            signal.throwIfAborted();
            for(const step of plan.steps) {
              signal.throwIfAborted();
              const result=await this.workspace.commitStep(project,w.id,w.runId,step);
              this.remember(w,JSON.stringify({action:actionRecord(step.action),result}));
              this.event(w,'action',`${step.action.type} ${step.action.path}: ${JSON.stringify(result).slice(0,2200)}`);
              // Journal publication precedes cursor advancement. A crash in
              // this gap is recovered from the exact journal, never by replay.
              w.cursor=step.index+1;this.save(w);
            }
            w.cursor=plan.end;
          });
          if(w.cursor>=batch.actions.length){w.queue.shift();w.cursor=0;}
          this.save(w);continue;
        }
        await this.locks.using(project.root,signal,async()=>{
          this.move(w,'executing');signal.throwIfAborted();
          if(action.type==='ask') {w.cursor++;this.remember(w,'Question for user: '+action.question);throw new UserQuestion(action.question);}
          if(action.type==='finish') {
            if(w.queue.length>1) {this.remember(w,'Completion deferred: more queued batches remain.');return;}
            this.move(w,'verifying');
            const result=await this.verify(w,project,action,actionId,signal);
            this.remember(w,JSON.stringify(result));
            if(!result.ok) {
              if(w.mode==='local') {this.event(w,'verify','Verification failed. Returning evidence to the local coder.');return;}
              throw new Error('Goal verification failed. Export the report and fix the failing checks.');
            }
            w.queue=[];w.cursor=0;w.autoCommands=false;w.humanAcceptanceReady=false;w.completion=undefined;
            w.completion={version:1,verification:result.verification,summary:action.summary,checked:result.results.length,at:Date.now(),...(w.activeFollowupId?{followupId:w.activeFollowupId}:{})};
            this.followups.finish(w,'completed');this.team.releaseOwner(w.id);
            this.move(w,'complete');this.event(w,'goal',w.checks.length?'Finished. Configured checks passed.':'Finished. No automated checks were configured.');finished=true;return;
          }
          const result=await this.execute(w,project,action,actionId,signal);
          this.remember(w,JSON.stringify({action:actionRecord(action),result}));this.event(w,'action',`${action.type}${'path'in action?' '+action.path:''}: ${JSON.stringify(result).slice(0,2200)}`);
          if(action.type==='command'&&object(result).code!==0) {
            // Drop remaining stale plan after a failing command. A local worker replans from evidence.
            w.cursor=batch!.actions.length;
            if(w.mode==='handoff')throw new Error('Command failed. Remaining actions were stopped. Export the report before importing a fix.');
          }
        });
      } catch(error) {
        if(error instanceof ApprovalNeeded)throw error;
        if(signal.aborted)throw error;
        if(error instanceof UserQuestion)throw error;
        if(error instanceof EditConflict) {
          await this.prepareEditRepair(w,project,batch,error);
          if(w.mode==='local'){this.move(w,'planning');continue;}
          this.move(w,'review');this.save(w);return;
        }
        this.remember(w,JSON.stringify({action:actionRecord(action),error:errorMessage(error)}));
        if(w.mode==='local') {w.queue.shift();w.cursor=0;this.move(w,'planning');this.event(w,'repair','Action failed; returning bounded error evidence to the local coder.');continue;}
        throw error;
      }
      if(finished) {this.save(w);return;}
      w.cursor++;
      if(w.cursor>=batch.actions.length){w.queue.shift();w.cursor=0;}
      this.save(w);
    }
  }
  private async prepareEditRepair(w:Worker,project:Project,batch:Envelope,error:EditConflict):Promise<void> {
    const failedIndex=error.index>=0?error.index:w.cursor;
    const pending=w.queue.slice();
    let current:unknown;
    try {
      const file=await fileText(project.root,error.path);
      // Complete small-file evidence; never silently splice a source fragment
      // into a JSON read result or change its hash. Large content stays omitted.
      current={path:error.path,hash:file.hash,bytes:Buffer.byteLength(file.content),
        ...(file.content.length<=6000?{content:file.content}:{contentOmitted:true})};
    } catch(e) {current={path:error.path,error:errorMessage(e)};}
    const repair={code:error.code,batchId:batch.id,actionIndex:failedIndex,path:error.path,
      message:error.message,current,
      applied:this.store.writes(w.runId).filter(j=>j.id.startsWith(batch.id+'_')&&j.status==='applied').map(j=>({actionId:j.id,path:j.path,hash:j.afterHash})),
      discarded:pending.map((q,i)=>({batchId:q.id,remainingActions:q.actions.length-(i===0?w.cursor:0)})),
      next:'The unapplied remainder has been set aside, NOT executed. Preserve successful edits. Read current files and return a new minimal batch with fresh hashes. Do not replay completed actions or claim completion. Commands and goal checks were not run by this repair.'};
    this.store.transaction(()=>{
      this.store.set(`edit-repair:${w.runId}:${batch.id}`,{version:1,workerId:w.id,runId:w.runId,cursor:w.cursor,batches:pending,repair,time:Date.now()});
      w.queue=[];w.cursor=0;w.pending=undefined;w.approvedFingerprint=undefined;w.autoCommands=false;w.humanAcceptanceReady=false;w.completion=undefined;
      w.error=`Edit plan needs updating: ${error.path}. Completed edits are preserved; the remaining plan was set aside.`;
      this.store.saveWorker(w);
    });
    // The audit record retains every action above. The model observation must
    // stay a complete JSON object within remember()'s limit, even when a batch
    // contains long file paths or heavily escaped source text.
    const reportRepair={...repair,current:current&&typeof current==='object'?{...current}:current,
      applied:[...repair.applied],discarded:[...repair.discarded],appliedOmitted:0,discardedOmitted:0};
    const encode=()=>JSON.stringify({editRepair:reportRepair});
    if(encode().length>12000&&reportRepair.current&&typeof reportRepair.current==='object'&&'content' in reportRepair.current){
      delete (reportRepair.current as Record<string,unknown>).content;
      (reportRepair.current as Record<string,unknown>).contentOmitted=true;
    }
    while(encode().length>12000&&reportRepair.applied.length){reportRepair.applied.pop();reportRepair.appliedOmitted++;}
    while(encode().length>12000&&reportRepair.discarded.length){reportRepair.discarded.pop();reportRepair.discardedOmitted++;}
    this.remember(w,encode());
    this.event(w,'repair',w.error!);
  }
  private requireApproval(w:Worker,project:Project,action:Action,profiles:Profile[]):void {
    const fingerprint=digest(JSON.stringify({runId:w.runId,action,profiles,revision:project.revision}));
    if(w.autoCommands)return;
    if(w.approvedFingerprint===fingerprint){w.approvedFingerprint=undefined;this.save(w);return;}
    w.pending={token:randomUUID(),fingerprint,action,revision:project.revision,profile:profiles[0],reason:`Run ${profiles.map(p=>`${p.label}: ${JSON.stringify([p.program,...p.args])}`).join('; ')}. Project programs run with your OS user permissions. This is not a sandbox.`};
    this.move(w,'awaiting_approval');this.save(w);this.event(w,'approval',w.pending.reason);throw new ApprovalNeeded();
  }
  private profile(project:Project,id:string):Profile {const p=project.profiles.find(p=>p.id===id);if(!p)throw new Error(`Command profile not found: ${id}`);return parseProfile(p);}
  private async command(w:Worker,project:Project,profile:Profile,actionId:string,signal:AbortSignal) {
    const key=`command:${actionId}`,previous=this.store.get<{status:string;result?:unknown}>(key);
    if(previous?.status==='finished')return previous.result;
    if(previous)throw new Error('This command was interrupted and its side effects are unknown. Inspect them, then explicitly skip this step. It will not be replayed.');
    this.store.set(key,{status:'started',workerId:w.id,profile,time:Date.now()});
    const scratch=path.join(this.dataDir,'runtime',w.id);
    let outputAt=0;
    const result=await runCommand(profile,project.root,scratch,signal,line=>{if(Date.now()-outputAt>500){this.event(w,'output',line);outputAt=Date.now();}});
    project.revision++;this.store.saveProject(project);
    if(result.aborted||result.timedOut) {this.store.set(key,{status:'interrupted',workerId:w.id,result});throw new Error(result.timedOut?'Command timed out. Inspect side effects before skipping or replacing it.':'Command cancelled; side effects may remain.');}
    this.store.set(key,{status:'finished',workerId:w.id,result});return result;
  }
  private async execute(w:Worker,project:Project,action:Action,actionId:string,signal:AbortSignal):Promise<unknown> {
    switch(action.type) {
      case 'team_message': case 'team_pause': case 'team_resume': {const result=this.team.execute(w,action,actionId);this.changed();return result;}
      case 'list': return {files:await listFiles(project.root,action.path),limit:300};
      case 'read': return await this.reads.read(w,project,action,signal);
      case 'search': return await searchFiles(project.root,action.query);
      case 'write': case 'replace': return await this.workspace.write(project,w.id,w.runId,actionId,action);
      case 'diff': return await gitDiff(project.root,path.join(this.dataDir,'runtime',w.id),signal);
      case 'command': {
        const profile=this.profile(project,action.profileId);
        const previous=this.store.get<{status:string;result?:unknown}>(`command:${actionId}`);
        if(previous?.status==='finished')return previous.result;
        if(previous)throw new Error('Interrupted command quarantined. Inspect it and use Skip action; it will not be replayed.');
        this.requireApproval(w,project,action,[profile]);return await this.command(w,project,profile,actionId,signal);
      }
      default:throw new Error('Action cannot execute in this context.');
    }
  }
  private async verify(w:Worker,project:Project,action:Extract<Action,{type:'finish'}>,actionId:string,signal:AbortSignal) {
    const profiles=w.checks.filter(c=>c.type==='command').map(c=>this.profile(project,c.profileId));
    if(profiles.length) {
      const verificationKey=`verification:${actionId}`;
      if(this.store.get(verificationKey))throw new Error('This command verification attempt already ran or was interrupted. Inspect its effects, skip this finish step, and import a fresh finish batch. Cached test output is not fresh verification.');
      this.requireApproval(w,project,action,profiles);
      this.store.set(verificationKey,{status:'started',time:Date.now(),revision:project.revision});
    }
    const results:{check:unknown;ok:boolean;detail?:unknown}[]=[];
    // Commands first. File checks run afterwards so generated outputs are included.
    let i=0;
    for(const profile of profiles) {
      const result=object(await this.command(w,project,profile,`${actionId}_check_${i++}`,signal));
      results.push({check:{type:'command',profileId:profile.id},ok:result.code===0,detail:result});
    }
    for(const check of w.checks.filter(c=>c.type!=='command')) {
      signal.throwIfAborted();
      try {
        if(check.type==='exists') {const target=await safePath(project.root,check.path);await fs.access(target);results.push({check,ok:true});}
        else {const f=await fileText(project.root,check.path);results.push({check,ok:f.content.includes(check.text)});}
      } catch(error) {results.push({check,ok:false,detail:errorMessage(error)});}
    }
    return {ok:results.every(r=>r.ok),results,requiresHumanAcceptance:false,verification:(w.checks.length?'passed':'not-run') as 'passed'|'not-run',summary:action.summary};
  }
  report(w:Worker,project:Project):string {
    return `MITTER REPORT — local project results\nProject: ${project.name}\nWorker: ${w.name} (${w.id})\nGoal: ${w.goal}\nState: ${w.state}\nChecks: ${JSON.stringify(w.checks)}\nCompletion: ${JSON.stringify(w.completion??null)}\nError: ${w.error??'none'}\n\n${this.followups.prompt(w)}\n${renderObservations(w.observations)}\n\nFiles journaled in this run:\n${this.store.changedFiles(w.runId).slice(0,64).map(j=>`${j.path}: ${j.status}`).join('\n')}\n(Recent journal entries only; full history remains available locally.)\n\nThis report may contain proprietary code. Review it before pasting into an online chat. Redaction is best effort, not a guarantee.\n`;
  }
  private quiescing?:Promise<void>;
  private storeClosed=false;
  quiesce():Promise<void> {
    if(!this.quiescing)this.quiescing=this.stopWriters().catch(error=>{this.quiescing=undefined;throw error;});
    return this.quiescing;
  }
  private async stopWriters():Promise<void> {
    this.closed=true;clearInterval(this.teamTimer);for(const {controller} of this.active.values())controller.abort(new Error('Host shutting down.'));
    this.models.close();await Promise.all([...this.active.values()].map(a=>a.promise));
    for(const actor of this.actors.values())actor.stop();
    await (this.models as Models & {settled?:()=>Promise<void>}).settled?.();
  }
  async close():Promise<void> {
    await this.quiesce();
    if(!this.storeClosed){this.store.close();this.storeClosed=true;}
  }
}
