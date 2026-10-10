/** A transport wrapper for outgoing task/report text, not a permission token.
 * Literal fences prevent Markdown in a file/report from changing the echo used
 * for acknowledgement. The entire body must match; the exchange ID alone is
 * never evidence that the expected user message was sent.
 */
export const WIRE_INSTRUCTION='Follow the task instructions in this text block. Return only the requested mitter/1 JSON reply.';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function wrapMessage(payload:string,exchangeId:string):string {
  if(!new RegExp('^'+uuid+'$','i').test(exchangeId))throw new Error('Invalid message exchange ID.');
  let longest=2;for(const match of payload.matchAll(/`+/g))longest=Math.max(longest,match[0].length);
  const fence='`'.repeat(longest+1);
  return `MITTER EXCHANGE ${exchangeId}\n${WIRE_INSTRUCTION}\n\n${fence}text\n${payload}\n${fence}\n\nEND MITTER EXCHANGE ${exchangeId}`;
}
export function unwrapMessage(text:string):{exchangeId:string;payload:string}|undefined {
  // Strict structural decoding, not an opportunistic substring/regex extract.
  const value=text.replace(/\r\n/g,'\n').trim();
  const match=new RegExp('^MITTER EXCHANGE ('+uuid+')\\n'+WIRE_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\n\\n(`{3,})text\\n','i').exec(value);
  if(!match)return;
  const end=`\n${match[2]}\n\nEND MITTER EXCHANGE ${match[1]}`;
  if(!value.endsWith(end))return;
  const payload=value.slice(match[0].length,-end.length);
  if(wrapMessage(payload,match[1]!)!==value)return;
  return {exchangeId:match[1]!,payload};
}
export function messagePayload(text:string):string{return unwrapMessage(text)?.payload??text;}

/** Receipts outside a literal PRE are reconstructed only when they surround
 * exactly one payload and contain the exact header/footer, with no extra prose.
 * Whitespace normalization applies to wrapper labels, NEVER to the code/body.
 */
export function decodeRenderedMessage(before:string,payload:string,after:string):string|undefined {
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
  const prefix=normalize(before),suffix=normalize(after);
  const match=new RegExp('^MITTER EXCHANGE ('+uuid+') '+WIRE_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?: (?:text|plaintext|plain text))?$','i').exec(prefix);
  if(!match||suffix!==`END MITTER EXCHANGE ${match[1]}`)return;
  return wrapMessage(payload,match[1]!);
}

/** Some renderers use styled DIVs instead of PRE/CODE for a literal message.
 * These are complete, framed serialization candidates, NOT accepted messages.
 * The coordinator must match a saved FULL payload hash before using one. No
 * payload whitespace, markup, escaping or backticks are normalized here.
 */
export function decodeFlatRenderedMessages(text:string):string[] {
  if(text.length>160000)return [];
  const value=text.replace(/\r\n/g,'\n').trim();
  if(unwrapMessage(value))return [value];
  const spaces=(s:string)=>s.split(' ').map(word=>word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[ \t\n]+');
  const prefix=new RegExp('^MITTER[ \t\n]+EXCHANGE[ \t\n]+('+uuid+')[ \t\n]+'+spaces(WIRE_INSTRUCTION)).exec(value);
  if(!prefix)return [];
  const suffix=new RegExp('END[ \t\n]+MITTER[ \t\n]+EXCHANGE[ \t\n]+'+prefix[1]+'$').exec(value);
  if(!suffix||suffix.index<prefix[0].length)return [];
  const body=value.slice(prefix[0].length,suffix.index).trim();
  if(!body)return [];
  const candidates=[wrapMessage(body,prefix[1]!)];
  // A separate language label is presentation, but can also be legitimate body
  // text. Preserve both alternatives; only an exact receipt can choose one.
  const label=/^(?:text|plaintext|plain text)[ \t]*\n/.exec(body);
  if(label)candidates.push(wrapMessage(body.slice(label[0].length),prefix[1]!));
  return [...new Set(candidates)];
}

export function sameMessage(actual:string,expected:string):boolean {
  const normalize=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim();
  if(normalize(actual)===normalize(expected))return true;
  const a=unwrapMessage(actual),b=unwrapMessage(expected);
  // A Markdown code renderer may retain its terminating newline. Only outer
  // payload whitespace is normalized; file contents inside JSON stay exact.
  return !!a&&!!b&&a.exchangeId===b.exchangeId&&normalize(a.payload)===normalize(b.payload);
}

/** Durable send intent contains hashes, not prompt/code bodies. It is only a
 * correlation record for this exact goal/project/task, never an execution grant.
 */
export interface OutboundReceipt {
  workerId:string;projectId:string;goalHash:string;textHash:string;renderedHash:string;at:number;
  // Optional v2 fields: legacy hash-only receipts remain readable.
  exchangeId?:string;expectsReplyTo?:boolean;payloadHash?:string;messageId?:string;turn?:number;
  // The visible task-reply baseline before this send; never stores code.
  // Optional for compatibility with pre-0.6.2 checkpoints.
  priorReplyIds?:string[];
  acknowledgedUserId?:string;acknowledgedHash?:string;priorUserId?:string;priorUserHash?:string;priorAssistantHash?:string;
}
export function parseReceipt(raw:unknown):OutboundReceipt|undefined {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
  const v=raw as Record<string,unknown>;
  const id=(x:unknown)=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
  const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  if(!id(v.workerId)||!id(v.projectId)||!hash(v.goalHash)||!hash(v.textHash)||!hash(v.renderedHash)||!Number.isFinite(v.at))return;
  const receipt:OutboundReceipt={workerId:v.workerId as string,projectId:v.projectId as string,goalHash:v.goalHash as string,textHash:v.textHash as string,renderedHash:v.renderedHash as string,at:v.at as number};
  if(typeof v.exchangeId==='string'&&new RegExp('^'+uuid+'$','i').test(v.exchangeId))receipt.exchangeId=v.exchangeId;
  if(v.expectsReplyTo===true&&receipt.exchangeId)receipt.expectsReplyTo=true;
  if(hash(v.payloadHash))receipt.payloadHash=v.payloadHash as string;
  if(v.priorReplyIds!==undefined){
    if(!Array.isArray(v.priorReplyIds)||v.priorReplyIds.length>64||!v.priorReplyIds.every(id))return;
    receipt.priorReplyIds=[...new Set(v.priorReplyIds as string[])];
  }
  if(id(v.messageId))receipt.messageId=v.messageId as string;
  if(Number.isSafeInteger(v.turn)&&Number(v.turn)>=1&&Number(v.turn)<=100000)receipt.turn=v.turn as number;
  if(id(v.acknowledgedUserId))receipt.acknowledgedUserId=v.acknowledgedUserId as string;
  if(hash(v.acknowledgedHash))receipt.acknowledgedHash=v.acknowledgedHash as string;
  if(id(v.priorUserId))receipt.priorUserId=v.priorUserId as string;
  if(hash(v.priorUserHash))receipt.priorUserHash=v.priorUserHash as string;
  if(hash(v.priorAssistantHash))receipt.priorAssistantHash=v.priorAssistantHash as string;
  return receipt;
}
export async function messageDigest(text:string):Promise<string> {
  const bytes=new TextEncoder().encode(text.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim());
  const result=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(result),v=>v.toString(16).padStart(2,'0')).join('');
}

/** Checks the complete reconstructed message, not just an exchange label or
 * worker ID. Payload-hash fallback permits wrapper layout changes only when
 * strict framing validates the same unique exchange and all payload bytes. */
export async function matchesReceipt(text:string,receipt:OutboundReceipt):Promise<boolean> {
  const value=await messageDigest(text);
  if([receipt.textHash,receipt.renderedHash,receipt.acknowledgedHash].includes(value))return true;
  const frame=unwrapMessage(text);
  return !!frame&&frame.exchangeId===receipt.exchangeId&&!!receipt.payloadHash&&await messageDigest(frame.payload)===receipt.payloadHash;
}
