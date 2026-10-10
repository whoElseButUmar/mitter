import {PageBridgeError} from './page-transport.js';

export const TAB_LEASE_KEY='miter.chatTabLeases.v1';
type TabState={id?:number;url?:string;pendingUrl?:string;autoDiscardable?:boolean;discarded?:boolean;frozen?:boolean};
interface TabAPI{get(id:number):Promise<TabState>;update(id:number,changes:{autoDiscardable:boolean}):Promise<unknown>}
interface LeaseStorage{get(key:string):Promise<Record<string,unknown>>;set(values:Record<string,unknown>):Promise<unknown>}
const allowed=(tab:TabState)=>{try{return ['https://chatgpt.com','https://chat.openai.com'].includes(new URL(tab.url||tab.pendingUrl||'').origin);}catch{return false;}};
const closed=(error:unknown)=>/No tab with id|Invalid tab ID|tab (?:was )?closed/i.test(String(error));

/** Resource policy only, never a grant to read/send. Protect only explicitly
 * running chats from automatic discarding, and restore their original policy.
 * A session-scoped journal permits cleanup after a worker restart; it does not
 * restart tasks. Chrome can still freeze a tab or the computer can sleep. */
export class ChatTabLiveness{
  private owned=new Set<number>();
  private desired=new Set<number>();
  private tail:Promise<void>;
  private inFlight?:Promise<void>;
  private disposed=false;
  private recoveryFailed=false;
  readonly ready:Promise<void>;
  constructor(private tabs:TabAPI,private storage:LeaseStorage,private log:(kind:string,message:string)=>void){
    this.ready=this.restore();this.tail=this.ready.catch(error=>{this.recoveryFailed=true;this.log('bridge.tab.policy.error',String(error));});
  }
  private async persist(){await this.storage.set({[TAB_LEASE_KEY]:[...this.owned].sort((a,b)=>a-b)});}
  private async release(id:number):Promise<void>{
    try{const tab=await this.tabs.get(id);if(tab.autoDiscardable===false)await this.tabs.update(id,{autoDiscardable:true});}
    catch(error){if(!closed(error))throw error;}
    this.owned.delete(id);await this.persist();
  }
  private async restore(){
    const raw=(await this.storage.get(TAB_LEASE_KEY))[TAB_LEASE_KEY];
    if(raw!==undefined&&(!Array.isArray(raw)||raw.length>256||raw.some(id=>!Number.isSafeInteger(id)||id<0)))throw Error('Invalid saved chat-tab resource policy. No tab was changed.');
    for(const id of (raw||[]) as number[])this.owned.add(id);
    for(const id of [...this.owned])await this.release(id);
  }
  sync(ids:Iterable<number>):Promise<void>{
    const desired=new Set(this.disposed?[]:[...ids].filter(id=>Number.isSafeInteger(id)&&id>=0));
    const unchanged=desired.size===this.desired.size&&[...desired].every(id=>this.desired.has(id));
    this.desired=desired;
    // Repeated UI/status pulses must not create an unbounded promise queue
    // behind a slow browser-storage or tab update call.
    if(unchanged&&this.inFlight)return this.inFlight;
    const job=this.tail.then(async()=>{
      if(this.recoveryFailed)throw Error('Saved chat-tab resource policy could not be recovered. No new tab policy was applied.');
      for(const id of [...this.owned])if(!this.desired.has(id))await this.release(id);
      for(const id of this.desired){
        if(this.owned.has(id))continue;
        let tab:TabState;try{tab=await this.tabs.get(id);}catch(error){if(closed(error))continue;throw error;}
        // False may belong to the user or another extension. Never claim it.
        if(this.disposed||!this.desired.has(id)||!allowed(tab)||tab.autoDiscardable!==true)continue;
        this.owned.add(id);
        // Journal BEFORE update. A lost reply is still recoverable on restart.
        try{await this.persist();}catch(error){this.owned.delete(id);throw error;}
        if(this.disposed||!this.desired.has(id)){await this.release(id);continue;}
        try{await this.tabs.update(id,{autoDiscardable:false});this.log('bridge.tab.protected','Active chat tab '+id+' is protected from automatic discarding. Focus was not changed.');}
        catch(error){if(closed(error)){this.owned.delete(id);await this.persist();}else throw error;}
      }
    });
    this.inFlight=job;
    this.tail=job.finally(()=>{if(this.inFlight===job)this.inFlight=undefined;}).catch(error=>{this.log('bridge.tab.policy.error',String(error));});return job;
  }
  async releaseAll(){this.disposed=true;await this.sync([]);}
}

/** Do not inject into, reload, or focus a suspended document to disguise its
 * unavailability. The runner can wait safely and recheck when it resumes. */
export function assertChatTabAvailable(tab:TabState):void{
  if(tab.discarded)throw new PageBridgeError('TAB_DISCARDED','Chrome unloaded the linked chat. Reopen that tab to restore its document; no prompt was resent.',true);
  if(tab.frozen)throw new PageBridgeError('TAB_FROZEN','Chrome froze the linked chat. Waiting for it to resume without changing browser focus.',true);
}
