import type {ProposalEnvelope as Envelope} from '../../../packages/protocol/src/proposal';
import {NativeRequestTimeout} from '../../../packages/bridge/src/native-request';
import {RewriteRunner} from '../../../packages/bridge/src/rewrite-runner';
import {parseRewriteRequest,structureLocally} from '../../../packages/protocol/src/rewrite';
import {bindTerminalPort} from './terminal-port';
import {NativeMessageInbox} from '../../../packages/protocol/src/native-transfer';
import { bindFilePreviewPort } from './file-preview-port';
import { boundReply, replyDigest, actionSummary, type ReplyPreview } from '../../../packages/bridge/src/reply-recovery';
import { APP_VERSION, type Snapshot, type Worker } from '../../../packages/protocol/src/index';
import { DataResetCoordinator, ResetViewBarrier, DATA_RESET_KEY, ChatTabLiveness, assertChatTabAvailable, BridgeRunner, chatStartURL, type BridgeStatus } from '../../../packages/bridge/src/index';
import { PageTransport } from '../../../packages/bridge/src/page-transport';
import { ChatLinkStore, type ChatLink } from '../../../packages/bridge/src/chat-links';
import type {TaskProgress} from '../../../packages/bridge/src/progress';
import type { OutboundReceipt } from '../../../packages/bridge/src/message-wire';
import { WorkspaceStore } from '../../../packages/ui/src/workspace-store';
import { displayTaskName } from '../../../packages/protocol/src/task-brief';
import { Diagnostics } from '../../../packages/bridge/src/diagnostics';

/** One host and one coordinator shared by all views. Page scripts cannot call host RPC. */
export function startBackground() {
  let reset:DataResetCoordinator;
  const notificationWrites=new Set<Promise<unknown>>();
  const notifyChrome=(id:string,options:chrome.notifications.NotificationOptions & {type:'basic';iconUrl:string;title:string;message:string})=>{const job=chrome.notifications.create(id,options);notificationWrites.add(job);void job.then(()=>notificationWrites.delete(job),()=>notificationWrites.delete(job));return job;};
  const views=new Set<chrome.runtime.Port>();
  const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const runners=new Map<string,BridgeRunner>();
  const rewriteJobs=new Map<string,RewriteRunner>();
  const starting=new Set<string>();
  const controlBusy=new Set<string>();
  const continuing=new Set<string>();
  const startRevisions=new Map<string,number>();
  const startGuard=(workerId:string)=>{const revision=startRevisions.get(workerId)??0;return()=>{if(reset?.blocked||(startRevisions.get(workerId)??0)!==revision)throw new Error('This start was superseded by Stop or Steer. No further message will be sent.');};};
  const followupArmed=new Set<string>(),followupStarting=new Set<string>();
  let notificationPrefs={enabled:false,sound:false};
  let notificationTail=Promise.resolve();
  const notificationStates=new Map<string,string>();
  const notificationTargets=new Map<string,string>();
  const bridgeNotificationStates=new Map<string,string>();
  type Link=ChatLink;
  const startingTabs=new Map<number,string>();
  type ReplyTicket={workerId:string;projectId:string;goal:string;link:Link;envelope:Envelope;hash:string;source:'chat'|'clipboard';expiresAt:number;createdAt:number};
  const replyTickets=new Map<string,ReplyTicket>();
  let native:chrome.runtime.Port|undefined,snapshot:Snapshot|undefined,lastEvent=0;
  const post=(port:chrome.runtime.Port,message:unknown)=>{try{port.postMessage(message);}catch{views.delete(port);}};
  const broadcast=(message:unknown)=>{for(const view of views)post(view,message);};
  const diagnostics=new Diagnostics(entries=>broadcast({event:'debug',data:entries}));
  const log=(kind:string,message:string)=>diagnostics.add(kind,message);
  const tabLiveness=new ChatTabLiveness(chrome.tabs,chrome.storage.session,log);
  const syncTabLiveness=()=>tabLiveness.sync(reset?.blocked?[]:[...[...runners.values()].filter(r=>r.status.active||r.status.monitoring).map(r=>r.status.tabId),...[...rewriteJobs.values()].filter(j=>j.result.state==='waiting').map(j=>j.tabId)]);
  const workspace=new WorkspaceStore(chrome.storage.local??chrome.storage.session,s=>broadcast({event:'workspace',data:s}));
  const catalog=(s:Snapshot)=>({projects:s.projects,tasks:s.workers.map(w=>({...w,name:displayTaskName(w)}))});
  const syncWorkspace=(s:Snapshot)=>void workspace.sync(catalog(s)).catch(e=>{log('workspace.error',String(e));broadcast({event:'workspaceError',error:String(e)});});
  const links=new ChatLinkStore(chrome.storage.local??chrome.storage.session,chrome.storage.session,message=>log('bridge.storage.error',message));
  log('app.start',`Miter ${APP_VERSION}; packaged message bridge v4.`);
  const bridgeStates=():BridgeStatus[]=>{
    const states=[...runners.values()].map(r=>({...r.status}));
    // Saved metadata is not a running session. A reload never restarts sends.
    for(const [workerId,link] of links.entries()){
      const w=snapshot?.workers.find(w=>w.id===workerId);
      if(!w||w.state==='complete'||w.state==='cancelled'||runners.has(workerId)||link.projectId&&link.projectId!==w.projectId)continue;
      const saved=snapshot?.bridgeProgress?.find(p=>p.workerId===workerId);
      states.push({workerId,tabId:link.id,url:link.url,active:false,phase:'stopped',reason:'Progress saved. Resume continues in the same chat.',turns:saved?.turns??0,maxTurns:saved?.maxTurns??link.maxTurns??15,startedAt:saved?.startedAt??link.updatedAt??0,lowerBound:saved?.lowerBound,activeMs:saved?.activeMs,maxMinutes:saved?.maxMinutes,errorCode:saved?.errorCode});
    }
    return states;
  };
  const publish=()=>{
    void syncTabLiveness().catch(()=>{});
    if(reset?.blocked)return;
    broadcast({event:'bridges',data:bridgeStates()});
    for(const r of runners.values()){
      const previous=bridgeNotificationStates.get(r.status.workerId),state=r.status.phase+':'+r.status.reason;
      bridgeNotificationStates.set(r.status.workerId,state);
      if(r.status.phase==='error'&&previous!==state){const task=snapshot?.workers.find(w=>w.id===r.status.workerId);broadcast({event:'taskNotification',data:{workerId:r.status.workerId,kind:'warning',message:(task?displayTaskName(task):'Task')+' needs attention. '+r.status.reason}});
        if(notificationPrefs.enabled&&chrome.notifications){const key='miter-task-'+r.status.workerId;notificationTargets.set(key,r.status.workerId);void notifyChrome(key,{type:'basic',iconUrl:chrome.runtime.getURL('icon-128.png'),title:'Miter · Chat needs attention',message:r.status.monitoring?'Check the linked chat. Miter is still watching for its reply.':r.status.reason.slice(0,160),silent:true}).then(()=>{if(notificationPrefs.sound){const view=[...views].at(-1);if(view)post(view,{event:'ding'});}}).catch(e=>log('notification.error',String(e)));}
      }
      const link=links.get(r.status.workerId);
      if(link&&link.id===r.status.tabId&&(link.url!==r.status.url||!!link.bindingPending!==!!r.status.bindingPending)){links.set(r.status.workerId,{...link,url:r.status.url,newChat:!r.status.url.includes('/c/'),bindingPending:r.status.bindingPending,updatedAt:Date.now()});}
    }

  };
  const saveReceipt=async(workerId:string,tabId:number,receipt:OutboundReceipt)=>{
    const link=links.get(workerId);
    if(!link||link.id!==tabId)throw new Error('The task conversation changed before sending.');
    links.set(workerId,{...link,lastReceipt:receipt,updatedAt:Date.now()});
    await links.flush(true);
  };
  const pageTransport=new PageTransport({
    checkAvailable:async tabId=>{assertChatTabAvailable(await chrome.tabs.get(tabId));},
    send:(tabId,message)=>{const m=message as {kind?:string;action?:{op?:string}};if(reset?.blocked&&m.kind==='request'&&!['stop','interrupt'].includes(m.action?.op||''))return Promise.reject(Error('Data reset in progress. No page operation was sent.'));return chrome.tabs.sendMessage(tabId,message,{frameId:0});},
    inject:async tabId=>{await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:['mitter-page.js']});},
  },log);
  const loadedLinks=links.ready.then(()=>publish());
  const notificationReady=Promise.resolve(chrome.storage.local?.get('miter.notifications.v1')).then(v=>{
    const saved=v?.['miter.notifications.v1'];
    notificationPrefs={enabled:saved?.enabled===true,sound:saved?.sound===true};
  }).catch(e=>log('notification.settings.error',String(e)));
  notificationTail=notificationReady;
  const notify=(s:Snapshot)=>{
    if(reset?.blocked)return;
    for(const w of s.workers){
      const state=w.state==='complete'?'complete':w.humanAcceptanceReady?'review':w.state==='review'?'continuing':w.state,old=notificationStates.get(w.id);notificationStates.set(w.id,state);
      if(old===undefined||old===state||!['complete','review','blocked','awaiting_approval'].includes(state))continue;
      const title=state==='complete'?'Task complete':state==='review'?'Ready for review':state==='awaiting_approval'?'Approval needed':'Task needs attention';
      broadcast({event:'taskNotification',data:{workerId:w.id,kind:['blocked','awaiting_approval'].includes(state)?'warning':'success',message:title+' · '+displayTaskName(w)}});
      if(!notificationPrefs.enabled)continue;
      const key='miter-task-'+w.id;notificationTargets.set(key,w.id);
      if(chrome.notifications)void notifyChrome(key,{type:'basic',iconUrl:chrome.runtime.getURL('icon-128.png'),title:'Miter · '+title,message:displayTaskName(w),silent:true}).then(()=>{
        if(notificationPrefs.sound){const first=[...views].at(-1);if(first)post(first,{event:'ding'});}
      }).catch(e=>log('notification.error',String(e)));
    }
  };
  const openingNotifications=new Set<string>();
  chrome.notifications?.onClicked.addListener(async key=>{
    // Chrome does not await event listeners. Keep all failures inside this
    // boundary, and do not open duplicate workspace tabs for repeated clicks.
    if(reset?.blocked||openingNotifications.has(key))return;
    const workerId=notificationTargets.get(key)??(key.startsWith('miter-task-')?key.slice('miter-task-'.length):undefined);
    if(!workerId)return;
    openingNotifications.add(key);
    try{
      const s=snapshot??await rpc<Snapshot>('state');
      if(!s.workers.some(w=>w.id===workerId))return;
      await workspace.dispatch({type:'open',kind:'task',id:workerId},catalog(s));
      const workspaceURL=chrome.runtime.getURL('workspace.html');
      const target=workspaceURL+'?task='+encodeURIComponent(workerId);
      const opened=(await chrome.tabs.query({url:workspaceURL+'*'})).find(candidate=>
        candidate.id!==undefined&&(candidate.url||candidate.pendingUrl||'').split(/[?#]/)[0]===workspaceURL);
      let tab:chrome.tabs.Tab|undefined;
      if(opened?.id!==undefined){
        // tabs.update() may succeed without returning a Tab. Re-read that same
        // tab for its current window; never assume the update result exists or
        // create a second tab just because Chrome returned no object.
        tab=await chrome.tabs.update(opened.id,{url:target,active:true});
        if(!tab)tab=await chrome.tabs.get(opened.id);
      }else{
        tab=await chrome.tabs.create({url:target,active:true});
      }
      if(tab?.id===undefined)throw new Error('Chrome did not return the task workspace tab. Click the notification to retry.');
      if(tab.windowId!==undefined&&tab.windowId>=0)await chrome.windows.update(tab.windowId,{focused:true});
      await chrome.notifications.clear(key);
      notificationTargets.delete(key);
    }catch(error){
      // A tab/window can close between awaits. Keep the notification available
      // for an explicit retry; do not navigate a different tab or start work.
      log('notification.open.error',error instanceof Error?error.message:String(error));
    }finally{
      openingNotifications.delete(key);
    }
  });
  async function kickFollowup(workerId:string):Promise<unknown>{
    if(reset?.blocked||controlBusy.has(workerId)||followupStarting.has(workerId)||starting.has(workerId)||(runners.get(workerId)?.status.active||runners.get(workerId)?.status.monitoring))return {queued:true};
    followupStarting.add(workerId);
    try{
      await runners.get(workerId)?.flushed();
      const before=await rpc<Snapshot>('state');snapshot=before;
      const task=before.workers.find(w=>w.id===workerId);
      if(!task)return {queued:true};
      if(!task.followups?.some(f=>f.status==='queued')){followupArmed.delete(workerId);return {queued:true};}
      const result=await rpc<{activated:boolean;reason?:string}>('worker.followupActivate',{workerId});
      if(!result.activated)return {queued:true,reason:result.reason};
      snapshot=await rpc<Snapshot>('state');broadcast({event:'snapshot',data:snapshot});
      if(task.mode==='local')return rpc('worker.run',{workerId,epoch:snapshot.workers.find(w=>w.id===workerId)?.control?.epoch??0});
      const resumed=await resumeChat(workerId);if(resumed.resumed)return resumed;
      if(!await chrome.permissions.contains({origins}))return {queued:true,reason:'Allow ChatGPT access to start the saved follow-up.'};
      return request('bridge.start',{workerId,newChat:true,consent:true,maxTurns:15,maxMinutes:30});
    }catch(error){followupArmed.delete(workerId);log('followup.error',error instanceof Error?error.message:String(error));throw error;}
    finally{followupStarting.delete(workerId);}
  }
  const connect=()=>{
    if(native)return native;
    const port=chrome.runtime.connectNative('ai.mitter.host');native=port;log('host.connect','Opening native host connection');
    let announced=false;
    const inbox=new NativeMessageInbox();
    port.onMessage.addListener(fragment=>{
      if(native!==port)return;
      let message:any;
      try{message=inbox.accept(fragment);}catch(error){log('host.protocol.error',String(error));inbox.clear();port.disconnect();return;}
      if(message===undefined)return; // Ignore callbacks from a superseded connection.
      if(message?.event==='resetRequired'){reset.recover(String(message.error||'Data reset incomplete.'));return;}
      if(message?.event==='snapshot'){
        if(reset?.blocked)return;
        snapshot=message.data;if(snapshot)notify(snapshot);broadcast(message);publish();if(snapshot)syncWorkspace(snapshot);
        const compatible=snapshot?.runtime.version===APP_VERSION;
        broadcast({event:'connection',connected:compatible,error:compatible?undefined:`Local host ${snapshot?.runtime.version||'unknown'} differs from Miter ${APP_VERSION}. Finish setup, then reload Miter in Chrome’s extensions page.`});
        if(!announced){announced=true;log('host.ready',`Host ${snapshot?.runtime.version||'unknown'}; extension ${APP_VERSION}.`);}
        for(const e of [...(snapshot?.events||[])].reverse())if(e.id>lastEvent){lastEvent=e.id;diagnostics.add('worker.'+e.kind,`[${e.workerId.slice(0,8)}] ${e.message}`,e.time);}
      }else if(typeof message?.id==='string'){
        const target=pending.get(message.id);if(target){clearTimeout(target.timer);pending.delete(message.id);message.ok?target.resolve(message.result):target.reject(new Error(message.error||'Host request failed'));}
      }
    });
    port.onDisconnect.addListener(()=>{
      if(native!==port)return;
      const error=chrome.runtime.lastError?.message??'Local host disconnected.';
      if(native===port)native=undefined;snapshot=undefined;
      for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(error));}pending.clear();
      for(const r of runners.values())void r.stop('The local host disconnected. Your files are saved; reconnect before resuming.','error');
      log('host.error',error);broadcast({event:'connection',connected:false,error});
    });return port;
  };
  async function rpc<T=unknown>(method:string,params:Record<string,unknown>={}):Promise<T>{
    if(reset?.blocked&&!['system.resetPrepare','system.reset','system.resetComplete'].includes(method)&&!(reset.busy&&reset.state.phase==='stopping'&&['worker.pause','worker.bridgeSave'].includes(method)))throw Error('Data reset in progress or incomplete. No task operation was executed.');
    const id=crypto.randomUUID();
    if(!method.startsWith('terminal.')&&!['state','worker.files','worker.handoffSeen','worker.bridgeLoad','worker.bridgeSave'].includes(method))log('rpc.request',`${method} · ${id.slice(0,8)}`);
    try{
      const result=await new Promise<T>((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new NativeRequestTimeout(method));},method.startsWith('system.reset')?180000:method==='project.pickFolder'?130000:30000);
        pending.set(id,{resolve,reject,timer});
        try{connect().postMessage({id,method,params});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
      });
      if(!method.startsWith('terminal.')&&!['state','worker.files','worker.handoffSeen','worker.bridgeLoad','worker.bridgeSave'].includes(method))log('rpc.result',`${method} · OK`);return result;
    }catch(error){if(!method.startsWith('terminal.'))log('rpc.error',`${method} · ${error instanceof Error?error.message:String(error)}`);throw error;}
  }
  const origins=['https://chatgpt.com/*','https://chat.openai.com/*'];
  const choice=(tab:chrome.tabs.Tab):Link|undefined=>{
    if(tab.id===undefined)return;
    try{const url=chatStartURL(tab.url||tab.pendingUrl||'',true);return{id:tab.id,url,title:tab.title||'New ChatGPT chat',newChat:/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)$/.test(url)};}catch{return;}
  };
  async function savedChat(workerId:string,reopen=false):Promise<Link|undefined>{
    await loadedLinks;
    const originalLink=links.get(workerId);if(!originalLink)return;
    let link:Link=originalLink;
    if(link.newChat||link.bindingPending){
      const saved=await rpc<{progress:TaskProgress|null}>('worker.bridgeLoad',{workerId});
      if(saved.progress?.conversationUrl)link={...link,url:saved.progress.conversationUrl,newChat:false};
    }
    const w=snapshot?.workers.find(item=>item.id===workerId);
    if(link.projectId&&w&&link.projectId!==w.projectId)return;
    try{
      const tab=await chrome.tabs.get(link.id),current=choice(tab);
      if(current&&(current.url===link.url||link.newChat&&!current.newChat))return {...link,...current};
      // A stopped first send can still be on ChatGPT's temporary local route.
      // Retain the known tab; a new blank tab cannot confirm that saved send.
      if(link.newChat&&link.lastReceipt){
        const u=new URL(tab.url||tab.pendingUrl||'');
        if(['https://chatgpt.com','https://chat.openai.com'].includes(u.origin)&&/^\/c\/local-chatgpt(?::|%3A)/i.test(u.pathname))return {...link,url:u.origin,newChat:true,bindingPending:true};
      }
    }catch(error){console.warn('Miter could not read the saved chat tab; falling back to a conversation search.',error);}
    // Browser restarts change tab IDs. Match the saved conversation URL instead
    // of reading arbitrary open conversations or choosing the first tab.
    if(!link.newChat){
      const open=(await chrome.tabs.query({url:origins})).map(choice).find(item=>item?.url===link.url);
      if(open)return {...link,...open};
      if(reopen){
        const tab=await chrome.tabs.create({url:link.url,active:true});
        if(tab.id===undefined)throw new Error('Chrome could not reopen the saved conversation.');
        return {...link,id:tab.id};
      }
    }
  }
  async function lastChat(workerId:string):Promise<Link|undefined>{return savedChat(workerId);}
  function reserveTab(workerId:string,selected:Link):void{
    if(startingTabs.has(selected.id)&&startingTabs.get(selected.id)!==workerId||[...runners.values()].some(r=>(r.status.active||r.status.monitoring)&&r.status.workerId!==workerId&&(r.status.tabId===selected.id||!selected.newChat&&r.status.url===selected.url)))throw new Error('Another task is already using that chat. Choose a separate chat.');
    startingTabs.set(selected.id,workerId);
  }
  /** Select once at Start. Active-tab changes are NEVER used by a running task.
   * Reuse an idle, unclaimed chat tab; do not displace another task, a draft,
   * generation, or a page that changed while we inspected it.
   */
  async function freshChat(workerId:string,check=()=>{}):Promise<Link>{
    check();
    const active=(await chrome.tabs.query({active:true,currentWindow:true,url:origins})).map(choice).find((item):item is Link=>!!item);
    check();
    if(active){
      const claimed=[...rewriteJobs.values()].some(j=>j.result.state==='waiting'&&j.tabId===active.id)||startingTabs.has(active.id)||[...runners.values()].some(r=>(r.status.active||r.status.monitoring)&&r.status.tabId===active.id)||links.entries().some(([id,link])=>id!==workerId&&(link.id===active.id||!active.newChat&&link.url===active.url));
      if(!claimed){
        startingTabs.set(active.id,workerId);let retained=false;
        try{
          const view=await pageTransport.request(active.id,{op:'probe',token:crypto.randomUUID(),url:active.url,expiresAt:Date.now()+12000});
          const still=choice(await chrome.tabs.get(active.id));check();
          if(still?.url===active.url&&view.url===active.url&&view.ready&&!view.draft&&!view.busy){
            if(active.newChat&&view.count===0&&(!view.transcript||view.transcript.state==='empty')){
              retained=true;log('bridge.reuse','Using the empty ChatGPT tab '+active.id+' for '+workerId.slice(0,8)+'.');return {...active,bindingPending:true};
            }
            if(!active.newChat&&(!view.transcript||view.transcript.state==='ready')){
              // Normal supported navigation, not a synthetic OS shortcut. The
              // previous conversation remains in ChatGPT history and Back.
              await chrome.tabs.update(active.id,{url:'https://chatgpt.com/',active:true});pageTransport.forget(active.id);
              retained=true;log('bridge.newChat','Opened a fresh conversation in the current unclaimed tab '+active.id+'.');
              return {id:active.id,url:'https://chatgpt.com',title:'New ChatGPT chat',newChat:true,bindingPending:true};
            }
          }
          log('bridge.keepTab','Left the current chat untouched because it is busy, has a draft, or is not ready.');
        }catch(error){log('bridge.keepTab','Could not safely reuse the current chat. Opening a separate task tab. '+(error instanceof Error?error.message:String(error)));}
        finally{if(!retained&&startingTabs.get(active.id)===workerId)startingTabs.delete(active.id);}
      }else log('bridge.keepTab','The current chat belongs to another task. Keeping its connection intact.');
    }
    check();
    const tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:true});check();
    if(tab.id===undefined)throw new Error('Chrome could not open a chat.');
    startingTabs.set(tab.id,workerId);
    log('bridge.newChat',`Created task tab ${tab.id} for ${workerId.slice(0,8)}.`);
    return {id:tab.id,url:'https://chatgpt.com',title:'New ChatGPT chat',newChat:true,bindingPending:true};
  }
  async function resumeChat(workerId:string):Promise<{resumed:boolean;status?:BridgeStatus}>{
    const watching=runners.get(workerId);if(watching?.status.monitoring){await watching.tick();return {resumed:true,status:{...watching.status}};}
    if(controlBusy.has(workerId)||starting.has(workerId))throw new Error('This task is changing run state. Wait for it to finish.');
    if(runners.get(workerId)?.status.active)return {resumed:true,status:{...runners.get(workerId)!.status}};
    starting.add(workerId);const check=startGuard(workerId);let reserved:number|undefined;
    try{
      await loadedLinks;await runners.get(workerId)?.flushed();
      const fresh=await rpc<Snapshot>('state');snapshot=fresh;broadcast({event:'snapshot',data:fresh});
      if(fresh.runtime.version!==APP_VERSION)throw new Error('Reload Miter after completing setup so the host and extension versions match.');
      const w=fresh.workers.find(item=>item.id===workerId);if(!w)throw new Error('Task not found.');
      if(w.control?.mode==='stopped')throw new Error('Task stopped. Use Continue fresh rather than resuming the retired plan.');
      if(w.mode!=='handoff'||!['idle','review','paused','blocked'].includes(w.state)||w.pending||w.humanAcceptanceReady)throw new Error('Review this task’s result or pending approval before resuming chat.');
      // A queued batch can continue in the same chat ONLY if the durable bridge
      // checkpoint names that exact imported batch. Manual/unrelated queues
      // retain the explicit local-only path and never acquire chat authority.
      if(w.queue.length){
        const saved=await rpc<{progress:TaskProgress|null}>('worker.bridgeLoad',{workerId});
        const head=w.queue[0],progress=saved.progress;
        const lostAck=!!progress&&['waiting_reply','commit_intent'].includes(progress.stage)&&!!head&&
          ((!!head.replyTo&&head.replyTo===progress.lastReceipt?.exchangeId)||head.id===progress.approvedReply?.id);
        if(!lostAck&&(progress?.stage!=='local_batch'||progress.lastImportedId!==head?.id))
          throw new Error('There is an unfinished local batch. Use Continue local work before resuming chat.');
      }
      check();
      if(!await chrome.permissions.contains({origins}))return {resumed:false};
      check();let current=await savedChat(workerId,true);check();
      if(!current&&links.get(workerId)?.lastReceipt)throw new Error('The pending send belongs to this task’s original chat. Reopen that chat before resuming; a new blank chat will not be used. Your progress is saved.');
      if(!current){
        // Legacy installs may have no saved link. Only inspect the active chat
        // after an explicit Resume click; ownership is checked by the runner.
        current=(await chrome.tabs.query({active:true,currentWindow:true,url:origins})).map(choice).find((item):item is Link=>!!item&&!item.newChat);
      }
      if(!current&&w.control?.mode==='fresh'&&!links.get(workerId)){
        // Stop before the first send has no conversation to reopen. An explicit
        // fresh continuation may create/reuse an empty unclaimed tab, never
        // replace an existing pending conversation.
        current=await freshChat(workerId,check);
      }
      check();if(!current)return {resumed:false};
      reserveTab(workerId,current);reserved=current.id;
      const previous=links.get(workerId);
      // These are initial-session hints only. The native checkpoint restores any
      // explicitly extended task budget, which can exceed the new-task form cap.
      const maxTurns=Math.min(20,previous?.maxTurns??runners.get(workerId)?.status.maxTurns??15),maxMinutes=Math.min(60,previous?.maxMinutes??30);
      links.set(workerId,{...current,projectId:w.projectId,maxTurns,maxMinutes,updatedAt:Date.now()});
      const runner=new BridgeRunner({workerId,projectId:w.projectId,tabId:current.id,url:current.url,maxTurns,maxMinutes,token:crypto.randomUUID(),newChat:current.newChat||current.bindingPending,resumeExisting:true,lastReceipt:previous?.lastReceipt,previousProgress:fresh.bridgeProgress?.find(p=>p.workerId===workerId)},{loadProgress:()=>rpc<{progress:TaskProgress|null;importedCount:number}>('worker.bridgeLoad',{workerId}),saveProgress:(p,epoch)=>rpc<TaskProgress>('worker.bridgeSave',{workerId,progress:p,epoch}),saveReceipt:r=>saveReceipt(workerId,current!.id,r),rpc,snapshot:()=>snapshot,log,publish:()=>publish(),page:(id,action)=>pageTransport.request(id,action)});
      runners.set(workerId,runner);publish();
      log('bridge.resume',`Reconnecting ${workerId.slice(0,8)} to its existing conversation; nothing is replayed automatically.`);
      void runner.start().catch(()=>{});
      return {resumed:true,status:{...runner.status}};
    }finally{starting.delete(workerId);if(reserved!==undefined)startingTabs.delete(reserved);}
  }
  async function replyContext(workerId:string):Promise<{worker:Worker;link:Link}>{
    if(starting.has(workerId)||runners.get(workerId)?.status.active)throw new Error('Stop automatic mode before selecting a reply.');
    await loadedLinks;await runners.get(workerId)?.flushed();
    const fresh=await rpc<Snapshot>('state');snapshot=fresh;broadcast({event:'snapshot',data:fresh});
    if(fresh.runtime.version!==APP_VERSION)throw new Error('Complete setup and reload Miter so the host and extension versions match.');
    const w=fresh.workers.find(item=>item.id===workerId);
    if(!w||w.control?.mode==='stopped'||w.control?.mode==='fresh'||w.mode!=='handoff'||!['idle','review','paused','blocked'].includes(w.state)||w.queue.length||w.pending||w.humanAcceptanceReady)throw new Error('Resolve pending local work or review this task before selecting another reply.');
    if(!await chrome.permissions.contains({origins}))throw new Error('ChatGPT access is needed for the linked conversation.');
    const link=await savedChat(workerId);
    if(!link||link.newChat||!link.url.includes('/c/'))throw new Error('Open this task’s saved conversation first. No other tab will be used.');
    return {worker:w,link};
  }
  async function previewReply(params:Record<string,unknown>):Promise<ReplyPreview>{
    const workerId=String(params.workerId),{worker:w,link}=await replyContext(workerId);
    const source=params.source==='clipboard'?'clipboard':'chat';
    const view=await pageTransport.request(link.id,{op:'reply',token:crypto.randomUUID(),url:link.url,workerId:w.id,projectId:w.projectId,expiresAt:Date.now()+20000});
    if(view.url!==link.url||view.busy||view.draft||view.ready===false)throw new Error('Wait for the linked chat to finish and keep its composer empty. Nothing was imported.');
    const raw=source==='clipboard'?params.text:view.codeReply?.text;
    if(typeof raw!=='string')throw new Error(view.codeReplyIssue==='AMBIGUOUS_REPLIES'?'Several task replies are visible. Click Copy code on the reply you want, then Use copied reply.':'The code widget could not be read directly. Click its Copy code button, then Use copied reply.');
    const envelope=boundReply(raw,w.id,w.projectId);
    const saved=await rpc<{progress:TaskProgress|null}>('worker.bridgeLoad',{workerId});
    if(envelope.replyTo&&saved.progress?.lastReceipt?.expectsReplyTo&&envelope.replyTo!==saved.progress.lastReceipt.exchangeId)throw new Error('This is a reply to an older exchange. Select the latest reply; no actions were imported.');
    const seen=await rpc<{seen:boolean}>('worker.handoffSeen',{workerId,envelopeId:envelope.id});
    if(seen.seen)throw new Error('This batch was already applied. Use Resume or Continue local work; it will not be applied twice.');
    if(envelope.actions.some(a=>'base' in a)){
      const admission=await rpc<{valid:boolean;issue?:{message:string}}>('worker.validateReply',{workerId,text:JSON.stringify(envelope),epoch:w.control?.epoch??0});
      if(admission.valid!==true)throw new Error(admission.issue?.message||'This reply could not be validated locally. Nothing was imported.');
    }
    const ticket=crypto.randomUUID(),expiresAt=Date.now()+120000,hash=await replyDigest(envelope);
    for(const [key,entry] of replyTickets)if(entry.expiresAt<Date.now()||entry.workerId===workerId)replyTickets.delete(key);
    replyTickets.set(ticket,{workerId,projectId:w.projectId,goal:w.goal,link,envelope,hash,source,expiresAt,createdAt:Date.now()});
    while(replyTickets.size>12)replyTickets.delete(replyTickets.keys().next().value!);
    log('bridge.reply.preview',`Validated ${source} reply for ${workerId.slice(0,8)}; ${envelope.actions.length} actions. Awaiting your confirmation.`);
    return {ticket,workerId,taskName:displayTaskName(w),summary:envelope.summary,source,actions:actionSummary(envelope),expiresAt};
  }
  async function confirmReply(params:Record<string,unknown>){
    if(params.confirm!==true)throw new Error('Select and confirm the reply before applying it.');
    const key=String(params.ticket),ticket=replyTickets.get(key);
    if(!ticket||ticket.workerId!==params.workerId||ticket.expiresAt<Date.now())throw new Error('This reply preview expired. Read it again; nothing was executed.');
    const {worker:w,link}=await replyContext(ticket.workerId);
    if(link.id!==ticket.link.id||link.url!==ticket.link.url||w.projectId!==ticket.projectId||w.goal!==ticket.goal)throw new Error('The task or its linked conversation changed. Select the reply again.');
    if(starting.has(w.id)||runners.get(w.id)?.status.active)throw new Error('This task is already starting.');
    reserveTab(w.id,link);starting.add(w.id);
    try{
      // Let the visible payload settle, then compare the exact candidate again.
      if(ticket.source==='chat')await new Promise(resolve=>setTimeout(resolve,Math.max(0,1800-(Date.now()-ticket.createdAt))));
      const view=await pageTransport.request(link.id,{op:'reply',token:crypto.randomUUID(),url:link.url,workerId:w.id,projectId:w.projectId,replyId:ticket.envelope.id,expiresAt:Date.now()+20000});
      if(view.url!==link.url||view.busy||view.draft||view.ready===false)throw new Error('The chat changed or is still busy. No actions were imported.');
      if(ticket.source==='chat'&&(!view.codeReply||await replyDigest(boundReply(view.codeReply.text,w.id,w.projectId))!==ticket.hash))throw new Error('The visible reply changed since the preview. Read it again before applying.');
      // A clipboard choice is explicitly selected by the user. It intentionally
      // does not require the broken role/ancestor reader to find the same text.
      replyTickets.delete(key);
      const old=links.get(w.id),maxTurns=Math.min(20,old?.maxTurns??15),maxMinutes=Math.min(60,old?.maxMinutes??30);
      links.set(w.id,{...link,projectId:w.projectId,maxTurns,maxMinutes,updatedAt:Date.now()});
      await links.flush(true);
      await runners.get(w.id)?.stop('Using the reply selected by you.');
      const runner=new BridgeRunner({workerId:w.id,projectId:w.projectId,tabId:link.id,url:link.url,maxTurns,maxMinutes,token:crypto.randomUUID(),resumeExisting:true,lastReceipt:old?.lastReceipt},{loadProgress:()=>rpc<{progress:TaskProgress|null;importedCount:number}>('worker.bridgeLoad',{workerId:w.id}),saveProgress:(p,epoch)=>rpc<TaskProgress>('worker.bridgeSave',{workerId:w.id,progress:p,epoch}),saveReceipt:r=>saveReceipt(w.id,link.id,r),rpc,snapshot:()=>snapshot,log,publish:()=>publish(),page:(id,action)=>pageTransport.request(id,action)});
      runners.set(w.id,runner);publish();
      await runner.startWithReply(JSON.stringify(ticket.envelope),link.url);
      return {...runner.status};
    }finally{starting.delete(w.id);if(startingTabs.get(link.id)===w.id)startingTabs.delete(link.id);}
  }
  async function changeRun(method:'stop'|'steer',params:Record<string,unknown>){
    const workerId=String(params.workerId);
    if(controlBusy.has(workerId))throw new Error('This task is already stopping or steering.');
    const instruction=(params.request as {instruction?:unknown}|undefined)?.instruction;
    if(method==='steer'&&(typeof instruction!=='string'||!instruction.trim()||instruction.length>4000))throw new Error('Enter a steering instruction (up to 4,000 characters).');
    controlBusy.add(workerId);
    // A Stop is immediate. A Steer only supersedes an in-flight Start after its
    // instruction/selection passes validation; an invalid request is a no-op.
    if(method==='stop')startRevisions.set(workerId,(startRevisions.get(workerId)??0)+1);
    let runner=runners.get(workerId);
    let stopping:Promise<unknown>|undefined,generation:Promise<unknown>|undefined;
    try {
      if(method==='steer'){
        const validation=await rpc<{alreadyApplied:boolean}>('worker.steerValidate',{workerId,request:params.request});
        if(validation.alreadyApplied)return {ready:true,alreadyApplied:true};
        startRevisions.set(workerId,(startRevisions.get(workerId)??0)+1);
        // Start may have finished while the steering selection was validated.
        runner=runners.get(workerId);
      }
      followupArmed.delete(workerId);
      // Both calls begin now. Stop invalidates the runner synchronously. The
      // host epoch fences a request already in transit; never wait for a stuck
      // page read before asking the executor to stop its owned process.
      stopping=runner?.stop(method==='steer'?'Steering to your new instruction…':'Stopped by you. Completed work is kept.');
      generation=runner?.interruptGeneration();
      const result=await rpc(method==='steer'?'worker.steer':'worker.stop',{workerId,...(method==='steer'?{request:params.request}:{id:typeof params.id==='string'?params.id:crypto.randomUUID()})});
      await Promise.allSettled([stopping,generation]);await runner?.settled();
      runners.delete(workerId);
      for(const [key,ticket] of replyTickets)if(ticket.workerId===workerId)replyTickets.delete(key);
      snapshot=await rpc<Snapshot>('state');broadcast({event:'snapshot',data:snapshot});publish();
      log('control.'+method,method==='steer'?'Old pending plan retired. Continuing with the steering instruction.':'Run stopped. No queued plan or stale reply will be resumed.');
      return result;
    } finally {await Promise.allSettled([stopping,generation]);controlBusy.delete(workerId);}
  }
  async function request(method:string,params:Record<string,unknown>){
    await reset.ready;if(reset.blocked)throw Error('Miter data reset is incomplete or running. Retry Clear all Miter data before continuing.');
    if(method==='rewrite.start'){
      const input=parseRewriteRequest(params.request);
      if(input.provider==='local')return {id:crypto.randomUUID(),state:'done',text:structureLocally(input),provider:'local'};
      if(params.consent!==true||!await chrome.permissions.contains({origins}))throw Error('Allow ChatGPT access before rewriting.');
      for(const [id,j] of rewriteJobs)if(j.result.state!=='waiting'&&Date.now()-j.result.at>300000)rewriteJobs.delete(id);
      if([...rewriteJobs.values()].filter(j=>j.result.state==='waiting').length>=2)throw Error('Finish or cancel an existing rewrite first.');
      const tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:true});if(tab.id===undefined)throw Error('Chrome could not open a rewrite chat.');
      const job=new RewriteRunner(crypto.randomUUID(),tab.id,input,(id,r)=>pageTransport.request(id,r));rewriteJobs.set(job.id,job);void syncTabLiveness().catch(()=>{});void job.run().finally(()=>syncTabLiveness()).catch(()=>{});return {...job.result};
    }
    if(method==='rewrite.read'||method==='rewrite.cancel'){
      const job=rewriteJobs.get(String(params.id));if(!job)throw Error('This rewrite expired. Your original draft is unchanged.');
      if(method==='rewrite.cancel')job.cancel();return {...job.result};
    }
    if(method==='bridge.lastPrompt'||method==='bridge.resend'){
      const runner=runners.get(String(params.workerId));if(!runner)throw Error('Resume this task’s saved chat first.');
      return method==='bridge.lastPrompt'?runner.recoveryPrompt():runner.resendPrompt(params.confirm===true);
    }

    if(method==='bridge.halt')return changeRun('stop',params);
    if(method==='bridge.steer'){
      await changeRun('steer',params);
      const workerId=String(params.workerId),w=snapshot?.workers.find(w=>w.id===workerId);
      if((params.request as {autoStart?:boolean}|undefined)?.autoStart!==false)followupArmed.add(workerId);
      if(w?.mode==='local')return rpc('worker.run',{workerId,epoch:w.control?.epoch});
      const result=await resumeChat(workerId);
      if(!result.resumed)throw new Error('Steering saved. Open the task’s saved chat and choose Continue fresh.');
      return result;
    }
    if(method==='bridge.continueFresh'){
      const workerId=String(params.workerId);
      if(controlBusy.has(workerId)||continuing.has(workerId)||starting.has(workerId)||(runners.get(workerId)?.status.active||runners.get(workerId)?.status.monitoring))throw new Error('Stop the current task run or reply watch before changing run state.');
      continuing.add(workerId);const check=startGuard(workerId);
      try{
        await runners.get(workerId)?.settled();check();
        await rpc('worker.continueFresh',{workerId});check();runners.delete(workerId);
        snapshot=await rpc<Snapshot>('state');check();broadcast({event:'snapshot',data:snapshot});
        const w=snapshot.workers.find(w=>w.id===workerId);
        if(w?.mode==='local')return rpc('worker.run',{workerId,epoch:w.control?.epoch});
        const result=await resumeChat(workerId);
        if(!result.resumed)throw new Error('Open the saved conversation to continue fresh. Your work is preserved.');
        return result;
      }finally{continuing.delete(workerId);}
    }
    if(method==='bridge.pause'){
      const workerId=String(params.workerId);followupArmed.delete(workerId);
      const runner=runners.get(workerId);
      if(runner?.status.active)await runner.stop('Paused by you. Resume keeps the current plan.');
      else await rpc('worker.pause',{workerId});
      return {paused:true};
    }

    if(['bridge.stop','worker.pause','worker.cancel'].includes(method))followupArmed.delete(String(params.workerId));
    if(method==='workspace.read'||method==='workspace.action'){
      let s=snapshot;
      const a=params.action as {type?:string;kind?:string;id?:string}|undefined;
      // A creation response arrives before the throttled status broadcast.
      // Open the new record from fresh host state, not an outdated tab catalog.
      const missing=a?.type==='open'&&!(a.kind==='project'?s?.projects.some(p=>p.id===a.id):s?.workers.some(w=>w.id===a.id));
      if(!s||missing){s=await rpc<Snapshot>('state');snapshot=s;broadcast({event:'snapshot',data:s});}
      if(method==='workspace.read')return workspace.sync(catalog(s));
      const next=await workspace.dispatch(params.action,catalog(s));
      log('workspace.action',`${a?.type||'action'} ${a?.kind||''}; saved revision ${next.revision}. Task execution unchanged.`);return next;
    }
    if(method==='notifications.get'){await notificationTail;return {...notificationPrefs};}
    if(method==='notifications.set'){
      for(const key of ['enabled','sound'])if(params[key]!==undefined&&typeof params[key]!=='boolean')throw new Error('Notification preferences must be booleans.');
      const write=notificationTail.then(async()=>{
        const change={...notificationPrefs,...(params.enabled===undefined?{}:{enabled:params.enabled===true}),...(params.sound===undefined?{}:{sound:params.sound===true})};
        if(change.enabled&&!await chrome.permissions.contains({permissions:['notifications']}))throw new Error('Desktop notification permission was not granted.');
        await chrome.storage.local.set({'miter.notifications.v1':change});notificationPrefs=change;
        broadcast({event:'notificationSettings',data:{...change}});
        return {...change};
      });notificationTail=write.then(()=>{},()=>{});return write;
    }
    if(method==='worker.followup'){
      const workerId=String(params.workerId),f=await rpc('worker.followup',params);
      if(params.request&&typeof params.request==='object'&&(params.request as {autoStart?:boolean}).autoStart!==false){followupArmed.add(workerId);await kickFollowup(workerId);}return f;
    }
    if(method==='worker.followupStart'){followupArmed.add(String(params.workerId));return kickFollowup(String(params.workerId));}
    if(method==='debug.clear'){diagnostics.clear();return {cleared:true};}
    if(method==='debug.read')return diagnostics.read();
    if(method==='bridge.replyPreview')return previewReply(params);
    if(method==='bridge.replyApply')return confirmReply(params);
    if(method==='bridge.list')return bridgeStates();
    if(method==='bridge.lastChat')return await lastChat(String(params.workerId))||null;
    if(method==='bridge.resume')return await resumeChat(String(params.workerId));
    if(method==='bridge.extend'){
      const workerId=String(params.workerId);
      if(params.confirm!==true||runners.get(workerId)?.status.active||runners.get(workerId)?.status.monitoring||starting.has(workerId)||continuing.has(workerId)||controlBusy.has(workerId))throw new Error('Pause and explicitly authorize more task time first.');
      continuing.add(workerId);const check=startGuard(workerId);
      try{
        await runners.get(workerId)?.flushed();check();
        await rpc('worker.bridgeExtend',{workerId,confirm:true});check();
        await rpc('worker.continueFresh',{workerId});check();
        return await resumeChat(workerId);
      }finally{continuing.delete(workerId);}
    }
    if(method==='bridge.openChat'){
      const selected=await savedChat(String(params.workerId),true);
      if(!selected)throw new Error('No saved conversation yet. Start the task first.');
      await chrome.tabs.update(selected.id,{active:true});
      const tab=await chrome.tabs.get(selected.id);if(tab.windowId!==undefined)await chrome.windows.update(tab.windowId,{focused:true});
      return {opened:true};
    }
    if(method==='bridge.tabs'){
      if(!await chrome.permissions.contains({origins}))throw new Error('Allow ChatGPT access before choosing a chat.');
      return (await chrome.tabs.query({url:origins})).map(choice).filter(Boolean);
    }
    if(method==='bridge.newChat'){
      if(!await chrome.permissions.contains({origins}))throw new Error('Allow ChatGPT access before creating a chat.');
      const tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:true});
      if(tab.id===undefined)throw new Error('Chrome did not return the new chat tab.');
      return{id:tab.id,title:'New ChatGPT chat',url:'https://chatgpt.com',newChat:true};
    }
    if(method==='bridge.start'){
      const workerId=String(params.workerId);
      if(params.consent!==true)throw new Error('Starting requires your authorization to send project information to ChatGPT.');
      if(controlBusy.has(workerId)||starting.has(workerId)||(runners.get(workerId)?.status.active||runners.get(workerId)?.status.monitoring))throw new Error('This task is already starting, running, or watching for a reply.');
      starting.add(workerId);const check=startGuard(workerId);let reserved:number|undefined;
      try{
        await loadedLinks;
        // Creation replies precede the host's debounced snapshot. The one-click
        // create/start path must read current state, not the stale UI cache.
        const fresh=await rpc<Snapshot>('state');snapshot=fresh;broadcast({event:'snapshot',data:fresh});
        if(fresh.runtime.version!==APP_VERSION)throw new Error('Reload Miter after completing setup so the host and extension versions match.');
        const w=fresh.workers.find(w=>w.id===workerId);if(!w)throw new Error('Task not found.');
        if(w.control?.mode==='stopped')throw new Error('Task stopped. Use Continue fresh rather than starting another chat.');
        if(w.mode!=='handoff'||!['idle','review','paused','blocked'].includes(w.state)||w.pending||w.queue.length||w.humanAcceptanceReady)throw new Error('This task has pending local work or a result ready for review. Resolve that before starting another chat.');
        check();
        if(!await chrome.permissions.contains({origins}))throw new Error('ChatGPT access was not granted. No chat was changed.');
        check();
        let selected:Link|undefined;
        const checkpoint=await rpc<{progress:TaskProgress|null}>('worker.bridgeLoad',{workerId});
        check();const existing=checkpoint.progress;
        // Start on an existing exchange is continuation, even when the UI is
        // stale or the first conversation is still being assigned its URL.
        if(existing?.lastReceipt||existing?.lastImportedId){
          selected=await savedChat(workerId,true);
          if(!selected)throw new Error('This task already has saved chat work. Reopen its original conversation and use Resume. Nothing was sent to a new chat.');
        }else if(params.newChat===true&&params.tabId===undefined){
          selected=await freshChat(workerId,check);reserved=selected.id;
        }else{
          const tabId=Number(params.tabId);if(!Number.isSafeInteger(tabId))throw new Error('Choose a chat, or use a new one.');
          selected=choice(await chrome.tabs.get(tabId));
        }
        check();if(!selected)throw new Error('The selected page is not a ChatGPT chat.');
        reserveTab(workerId,selected);reserved=selected.id;
        const runner=new BridgeRunner({workerId,projectId:w.projectId,tabId:selected.id,url:selected.url,maxTurns:Number(params.maxTurns??15),maxMinutes:Number(params.maxMinutes??30),token:crypto.randomUUID(),newChat:selected.newChat||selected.bindingPending,resumeExisting:!!existing,lastReceipt:links.get(workerId)?.lastReceipt,previousProgress:fresh.bridgeProgress?.find(p=>p.workerId===workerId)},{loadProgress:()=>rpc<{progress:TaskProgress|null;importedCount:number}>('worker.bridgeLoad',{workerId}),saveProgress:(p,epoch)=>rpc<TaskProgress>('worker.bridgeSave',{workerId,progress:p,epoch}),saveReceipt:r=>saveReceipt(workerId,selected!.id,r),rpc,snapshot:()=>snapshot,log,publish:()=>publish(),page:(id,action)=>pageTransport.request(id,action)});
        runners.set(workerId,runner);links.set(workerId,{...links.get(workerId),...selected,projectId:w.projectId,maxTurns:Number(params.maxTurns??15),maxMinutes:Number(params.maxMinutes??30),updatedAt:Date.now()});publish();
        // Do not hold the UI request hostage while the page loads. Progress and
        // any failure are published by the runner on the main task screen.
        void runner.start().catch(()=>{});
        return {...runner.status};
      }finally{starting.delete(workerId);if(reserved!==undefined)startingTabs.delete(reserved);}
    }
    if(method==='bridge.stop'){void runners.get(String(params.workerId))?.stop();return{stopped:true};}
    if(['worker.pause','worker.cancel','worker.rollback','worker.restoreFile'].includes(method))await runners.get(String(params.workerId))?.stop('Stopped by you');
    if(method==='worker.import'&&(runners.get(String(params.workerId))?.status.active||runners.get(String(params.workerId))?.status.monitoring))throw new Error('Stop automatic mode before manually importing a handoff.');
    const allowed=new Set(['system.health','system.backups','system.backup','system.verifyBackup','worker.change','worker.restoreFile','worker.syntax','state','notifications.get','notifications.set','project.context','worker.reveal','worker.read','worker.browse','worker.asset','worker.openFile','worker.team','worker.teamMessage','worker.followups','worker.followupCancel','project.add','project.rename','project.pickFolder','project.reveal','project.read','project.profile','worker.create','worker.rename','worker.run','worker.resume','worker.pause','worker.cancel','worker.approve','worker.skip','worker.rollback','worker.accept','worker.prompt','worker.report','worker.history','worker.import','worker.files','worker.handoffSeen','settings.update']);
    if(!allowed.has(method))throw new Error('Unsupported UI request.');
    if(['worker.import','worker.run','worker.resume','worker.approve'].includes(method)){const fresh=await rpc<Snapshot>('state');params={...params,epoch:fresh.workers.find(w=>w.id===params.workerId)?.control?.epoch??0};}
    return rpc(method,params);
  }
  // Every Miter document participates in a write barrier before browser stores
  // are cleared. Older/unresponsive documents make reset fail closed.
  const resetViews=new Set<chrome.runtime.Port>();
  const auxiliaryViews=new Set<chrome.runtime.Port>();
  const uiWork=new Set<Promise<unknown>>();
  const resetPageIds=new Set<number>();
  const dataViewURLs=['sidepanel.html','workspace.html','file.html'].map(p=>chrome.runtime.getURL(p));
  const postReset=(port:chrome.runtime.Port,message:unknown)=>{try{port.postMessage(message);}catch{resetViews.delete(port);viewBarrier.remove(port);}};
  const viewBarrier=new ResetViewBarrier(dataViewURLs,()=>{
    if(!chrome.runtime.getContexts)throw Error('This Chrome version cannot enumerate Miter documents. Update Chrome before resetting.');
    return chrome.runtime.getContexts({});
  });
  const quiesceView=(port:chrome.runtime.Port)=>viewBarrier.quiesce(port);
  const quiesceViews=()=>viewBarrier.quiesceAll();
  async function waitFor<T>(promise:Promise<T>,label:string,ms=150000):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' did not stop. Reset remains locked; close it and retry.')),ms);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  function capturePageIds(){for(const [,link]of links.entries())resetPageIds.add(link.id);for(const r of runners.values())resetPageIds.add(r.status.tabId);for(const j of rewriteJobs.values())resetPageIds.add(j.tabId);}
  async function clearPageState(){
    // A user may grant only one of the two supported provider origins. Requiring
    // both would miss orphaned endpoints in otherwise authorized open tabs.
    const granted=await chrome.permissions.getAll();
    const pageOrigins=(granted.origins||[]).filter(origin=>origins.includes(origin));
    if(pageOrigins.length)for(const tab of await chrome.tabs.query({url:pageOrigins}))if(tab.id!==undefined)resetPageIds.add(tab.id);
    const failures:string[]=[];
    for(const tabId of resetPageIds){
      try{
        // A missing receiver means there is no Miter endpoint left in this
        // document. Never inject into unrelated tabs or delete chat contents.
        const send=()=>waitFor(chrome.tabs.sendMessage(tabId,{channel:'mitter-page/4',kind:'reset',id:crypto.randomUUID(),confirmation:'CLEAR'},{frameId:0}),'Chat page '+tabId,20000);
        let reply=await send();
        if(reply?.error?.code==='BAD_REQUEST'){
          const tab=await chrome.tabs.get(tabId);if(!tab.url||!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url))throw Error('The old bridge moved to a different document.');
          if(!await chrome.permissions.contains({origins:[new URL(tab.url).origin+'/*']}))throw Error('The old bridge no longer has authorized origin access.');
          await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:['mitter-page.js']});reply=await send();
        }
        if(reply?.ok!==true||reply?.value?.cleared!==true)throw Error(reply?.error?.message||'No data-clear acknowledgement.');
        pageTransport.forget(tabId);
      }catch(e){const detail=e instanceof Error?e.message:String(e);if(!/Receiving end does not exist|No tab with id|Could not establish connection/i.test(detail))failures.push('Chat tab '+tabId+': '+detail+' Close or reload that tab, then retry.');}
    }
    if(failures.length)throw Error(failures.join('\n'));
  }
  reset=new DataResetCoordinator({
    storage:chrome.storage.local,
    publish:state=>{for(const view of resetViews)postReset(view,{type:'reset-state',state});},
    quiesceViews,
    stop:async()=>{
      capturePageIds();followupArmed.clear();
      for(const workerId of new Set([...starting,...continuing,...runners.keys()]))startRevisions.set(workerId,(startRevisions.get(workerId)||0)+1);
      for(const job of rewriteJobs.values())job.cancel();
      await waitFor(Promise.all([...runners.values()].map(r=>r.stop('Clearing all Miter data.'))),'Chat workers',45000);
      await waitFor(Promise.allSettled([...uiWork]),'Pending UI requests');
      capturePageIds();for(const job of rewriteJobs.values())job.cancel();
      await waitFor(Promise.all([...runners.values()].map(r=>r.settled())),'Chat worker checkpoints',45000);
      await waitFor(Promise.all([...rewriteJobs.values()].map(j=>j.settled())),'Rewrite jobs',45000);
      await Promise.all([workspace.quiesce(),links.quiesce(),notificationTail,Promise.allSettled([...notificationWrites])]);
      await clearPageState();
      await waitFor(tabLiveness.releaseAll(),'Chat tab resource policy',15000);
    },
    hostPrepare:()=>rpc('system.resetPrepare',{confirmation:'CLEAR'}),
    hostClear:()=>rpc('system.reset',{confirmation:'CLEAR'}),
    hostComplete:()=>rpc('system.resetComplete',{confirmation:'CLEAR'}),
    clearBrowser:async()=>{
      await quiesceViews();
      for(const port of auxiliaryViews)try{port.disconnect();}catch{}auxiliaryViews.clear();
      const failures:string[]=[];
      const attempt=async(label:string,run:()=>Promise<unknown>)=>{try{await run();}catch(e){failures.push(label+': '+String(e));}};
      // Chrome storage is extension-scoped. Never use browsingData or touch a
      // provider origin, another extension, browser history, or user projects.
      for(const [name,area]of Object.entries({local:chrome.storage.local,session:chrome.storage.session,sync:chrome.storage.sync})){
        if(!area)continue;
        await attempt('chrome.storage.'+name,async()=>{
          await area.clear();if(name==='local')await area.set({[DATA_RESET_KEY]:true});
          const remaining=Object.keys(await area.get(null)).filter(key=>name!=='local'||key!==DATA_RESET_KEY);
          if(remaining.length)throw Error('Could not remove keys: '+remaining.join(', '));
        });
      }
      if(typeof caches!=='undefined')await attempt('Extension CacheStorage',async()=>{for(const name of await caches.keys())if(!await caches.delete(name))throw Error('Could not delete cache '+name);if((await caches.keys()).length)throw Error('Caches remain after deletion.');});
      if(typeof indexedDB!=='undefined')await attempt('Extension IndexedDB',async()=>{
        for(const db of await indexedDB.databases())if(db.name)await new Promise<void>((resolve,reject)=>{
          const request=indexedDB.deleteDatabase(db.name!);const timer=setTimeout(()=>reject(Error('Timed out deleting database '+db.name)),10000);
          const done=(error?:unknown)=>{clearTimeout(timer);error?reject(error):resolve();};request.onsuccess=()=>done();request.onerror=()=>done(request.error);request.onblocked=()=>done(Error('Database is still open: '+db.name));
        });
        if((await indexedDB.databases()).some(db=>db.name))throw Error('Databases remain after deletion.');
      });
      if(chrome.notifications&&await chrome.permissions.contains({permissions:['notifications']}))await attempt('Desktop notifications',async()=>{
        for(const id of Object.keys(await chrome.notifications.getAll()))await chrome.notifications.clear(id);
        if(Object.keys(await chrome.notifications.getAll()).length)throw Error('Notifications remain.');
      });
      if(failures.length)throw Error(failures.join('\n'));
      await attempt('Optional permissions',async()=>{
        const granted=await chrome.permissions.getAll();
        // Required permissions (including fontSettings) cannot be revoked.
        // Reset clears the local system-font preference, not Chrome font settings.
        const permissions=(granted.permissions||[]).filter(p=>['clipboardRead','notifications'].includes(p));
        const grantedOrigins=(granted.origins||[]).filter(p=>origins.includes(p));
        if((permissions.length||grantedOrigins.length)&&!await chrome.permissions.remove({permissions,origins:grantedOrigins}))throw Error('Optional permission removal was not confirmed.');
      });
      if(failures.length)throw Error(failures.join('\n'));
      // Nothing in these maps survives the first-run restart.
      runners.clear();rewriteJobs.clear();starting.clear();continuing.clear();controlBusy.clear();startRevisions.clear();startingTabs.clear();replyTickets.clear();
      followupStarting.clear();notificationStates.clear();notificationTargets.clear();bridgeNotificationStates.clear();openingNotifications.clear();resetPageIds.clear();
      notificationPrefs={enabled:false,sound:false};snapshot=undefined;lastEvent=0;diagnostics.clear();
    },
    restart:()=>{setTimeout(()=>chrome.runtime.reload(),150);},
  });
  function bindResetView(port:chrome.runtime.Port):boolean{
    if(port.name!=='miter-data-view')return false;
    const url=port.sender?.url?.split(/[?#]/)[0];
    if(port.sender?.id!==chrome.runtime.id||!url||!dataViewURLs.includes(url)){port.disconnect();return true;}
    resetViews.add(port);viewBarrier.add(port);
    port.onMessage.addListener(message=>{
      if(viewBarrier.receive(port,message))return;
      if(message?.type==='reset-start'&&typeof message.id==='string'&&message.id.length<=100&&url!==chrome.runtime.getURL('file.html')){
        void reset.clear(message.confirmation).then(()=>postReset(port,{id:message.id,ok:true})).catch(e=>postReset(port,{id:message.id,ok:false,error:String(e)}));
      }
    });
    port.onDisconnect.addListener(()=>{resetViews.delete(port);viewBarrier.remove(port);});
    void reset.ready.then(()=>{postReset(port,{type:'reset-state',state:reset.state});if(reset.busy)void quiesceView(port).catch(()=>{});});
    return true;
  }

  chrome.runtime.onConnect.addListener(view=>{
    if(bindResetView(view))return;
    if(reset.blocked&&view.name!=='mitter-ui'){view.disconnect();return;}
    if(['miter-terminal','miter-file-preview'].includes(view.name)){auxiliaryViews.add(view);view.onDisconnect.addListener(()=>auxiliaryViews.delete(view));}
    if(view.name==='miter-terminal'){bindTerminalPort(view,{extensionId:chrome.runtime.id,viewURLs:[chrome.runtime.getURL('sidepanel.html'),chrome.runtime.getURL('workspace.html')],rpc});return;}
    if(view.name==='miter-file-preview'){bindFilePreviewPort(view,{extensionId:chrome.runtime.id,viewerURL:chrome.runtime.getURL('file.html'),rpc});return;}
    const url=view.sender?.url;
    if(view.name!=='mitter-ui'||view.sender?.id!==chrome.runtime.id||!url||![chrome.runtime.getURL('sidepanel.html'),chrome.runtime.getURL('workspace.html')].some(allowed=>url.split(/[?#]/)[0]===allowed))return;
    views.add(view);view.onDisconnect.addListener(()=>views.delete(view));if(reset.blocked){try{connect();}catch{}return;}if(workspace.peek())post(view,{event:'workspace',data:workspace.peek()});if(snapshot)post(view,{event:'snapshot',data:snapshot});post(view,{event:'debug',data:diagnostics.read()});post(view,{event:'bridges',data:bridgeStates()});
    view.onMessage.addListener(message=>{
      // Liveness only: never touches a task, composer, native RPC or permissions.
      if(message?.type==='ping'&&typeof message.id==='string'&&message.id.length<=100){post(view,{type:'pong',id:message.id});return;}
      if(message?.type==='reconnect'){try{connect();}catch(error){log('host.error',String(error));}return;}
      if(!message||typeof message.id!=='string'||typeof message.method!=='string'||!message.params||typeof message.params!=='object')return;
      const job=request(message.method,message.params);uiWork.add(job);void job.finally(()=>uiWork.delete(job)).catch(()=>{});
      void job.then(result=>post(view,{id:message.id,ok:true,result})).catch(error=>{if(message.method.startsWith('bridge.'))log('bridge.error',error instanceof Error?error.message:String(error));post(view,{id:message.id,ok:false,error:error instanceof Error?error.message:String(error)});});
    });
    try{connect();}catch(error){post(view,{event:'connection',connected:false,error:String(error)});}
  });
  chrome.action.onClicked.addListener(tab=>{if(tab.windowId!==undefined)void chrome.sidePanel.open({windowId:tab.windowId}).catch(error=>log('ui.open.error',error instanceof Error?error.message:String(error)));});
  chrome.commands.onCommand.addListener(async command=>{if(command==='open-mitter'){try{const window=await chrome.windows.getCurrent();if(window.id!==undefined)await chrome.sidePanel.open({windowId:window.id});}catch(error){log('ui.open.error',error instanceof Error?error.message:String(error));}}});
  chrome.tabs.onRemoved.addListener(tabId=>{pageTransport.forget(tabId);for(const r of runners.values())if(r.status.tabId===tabId)void r.stop('The task’s chat was closed. Reopen a chat before resuming.');});
  chrome.tabs.onUpdated.addListener((tabId,change)=>{
    if(change.status==='loading')pageTransport.forget(tabId);
    if(reset.blocked)return;
    // Browser lifecycle events supplement the worker timer. No tab activation
    // or foreground focus is used to deliver a prepared prompt.
    if(change.status==='complete'||'frozen' in change||'discarded' in change)for(const r of runners.values())if(r.status.tabId===tabId)void r.tick().catch(e=>log('bridge.tick.error',String(e)));
  });
  const timer=setInterval(()=>{if(reset.blocked)return;for(const runner of runners.values())void runner.tick().catch(e=>log('bridge.tick.error',e instanceof Error?e.message:String(e)));for(const id of followupArmed)void kickFollowup(id).catch(()=>{});},1500);
  return{dispose:()=>{void tabLiveness.releaseAll().catch(()=>{});viewBarrier.dispose();clearInterval(timer);for(const j of rewriteJobs.values())j.cancel();for(const r of runners.values())void r.stop('Extension shutdown');},diagnostics};
}
