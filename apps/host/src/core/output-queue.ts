/** Coalesce unsent status snapshots while preserving RPC results in FIFO order.
 * Both count and serialized-size bounds protect a slow/disconnected browser.
 * Size is charged as UTF-16 storage, conservatively covering JSON text in memory;
 * one currently-writing response is separately bounded by nativeMessages(). */
export class OutputQueue {
 private messages:{message:unknown;bytes:number}[]=[];
 private queuedBytes=0;private writing=false;private closed=false;
 constructor(private write:(message:unknown)=>Promise<void>,private error:(e:unknown)=>void,private maxQueuedBytes=64*1024*1024){}
 send(message:unknown){
  if(this.closed)return;
  let bytes:number;
  try{const text=JSON.stringify(message);if(text===undefined)throw Error('Native output must be a JSON value.');bytes=text.length*2;}
  catch(error){this.fail(error);return;}
  const i=(message as any)?.event==='snapshot'?this.messages.findIndex(m=>(m.message as any)?.event==='snapshot'):-1;
  const total=this.queuedBytes-(i>=0?(this.messages[i]?.bytes??0):0)+bytes;
  if(total>this.maxQueuedBytes||(i<0&&this.messages.length>=256)){this.fail(Error('Native output queue exceeded its count or size bound.'));return;}
  if(i>=0)this.messages[i]={message,bytes};else this.messages.push({message,bytes});
  this.queuedBytes=total;void this.flush();
 }
 private fail(error:unknown){this.closed=true;this.messages=[];this.queuedBytes=0;this.error(error);}
 private async flush(){
  if(this.writing||this.closed)return;this.writing=true;
  try{while(this.messages.length&&!this.closed){const next=this.messages.shift()!;this.queuedBytes-=next.bytes;await this.write(next.message);}}
  catch(e){this.fail(e);}finally{this.writing=false;}
 }
 close(){this.closed=true;this.messages=[];this.queuedBytes=0;}
}
