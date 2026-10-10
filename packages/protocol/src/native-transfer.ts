import {MAX_FRAME} from './index.js';
const EVENT='miter.native-part/1';
export const MAX_NATIVE_TRANSFER=32*1024*1024;
const PART_CHARS=128000;
/** Outgoing-only framing: the browser cannot use this to enlarge action input. */
export function nativeMessages(message:unknown,transferId:string):unknown[]{
 const text=JSON.stringify(message),bytes=new TextEncoder().encode(text).byteLength;
 if(bytes<=MAX_FRAME)return [message];
 if(bytes>MAX_NATIVE_TRANSFER)throw new Error('Native response exceeds the 32 MB transfer limit.');
 const parts=Math.ceil(text.length/PART_CHARS);
 return Array.from({length:parts},(_,index)=>({event:EVENT,transferId,index,parts,characters:text.length,text:text.slice(index*PART_CHARS,(index+1)*PART_CHARS)}));
}
interface Pending {parts:number;characters:number;next:number;received:number;text:string[];expires:number}
/** Per-native-port decoder; bounded, ordered, expires stale partial responses. */
export class NativeMessageInbox {
 private pending=new Map<string,Pending>();
 constructor(private clock=()=>Date.now()){}
 accept(message:any):any|undefined{
  const now=this.clock();for(const [id,p] of this.pending)if(p.expires<now)this.pending.delete(id);
  if(message?.event!==EVENT)return message;
  const {transferId,index,parts,characters,text}=message;
  if(typeof transferId!=='string'||!/^[\w-]{1,100}$/.test(transferId)||!Number.isInteger(index)||!Number.isInteger(parts)||parts<2||parts>263||index<0||index>=parts||!Number.isInteger(characters)||characters<1||characters>MAX_NATIVE_TRANSFER||typeof text!=='string'||text.length>PART_CHARS)throw Error('Invalid native response fragment.');
  let p=this.pending.get(transferId);
  if(!p){if(index!==0||this.pending.size>=4)throw Error('Unexpected native response fragment.');p={parts,characters,next:0,received:0,text:[],expires:now+10000};this.pending.set(transferId,p);}
  if(p.parts!==parts||p.characters!==characters||p.next!==index){this.pending.delete(transferId);throw Error('Out-of-order native response fragments.');}
  p.received+=text.length;
  if(p.received>characters){this.pending.delete(transferId);throw Error('Native response size mismatch.');}
  p.text.push(text);p.next++;p.expires=now+10000;
  if(p.next!==parts)return undefined;
  this.pending.delete(transferId);
  if(p.received!==characters)throw Error('Truncated native response.');
  const payload=p.text.join('');
  if(new TextEncoder().encode(payload).byteLength>MAX_NATIVE_TRANSFER)throw Error('Native response exceeds its byte limit.');
  const result=JSON.parse(payload);
  if(result?.event===EVENT)throw Error('Nested native response fragments are not supported.');
  return result;
 }
 clear(){this.pending.clear();}
}
