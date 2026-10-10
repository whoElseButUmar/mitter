/** Mitter protocol. No parsing of arbitrary prose and no implicit tool execution. */
import { readReplyJSON } from './reply-json.js';
import { editBaseError, atAction, ReplyValidationError } from './validation.js';
export const APP_VERSION = '1.0.0-rc.21';
export const VERSION = 'mitter/1' as const;
export const MAX_FRAME = 800_000;
export const MAX_TEXT = 120_000;
/** Pinned unpacked-extension identity. TypeScript sources import these; the
 * mirror for .mjs scripts and the native-messaging manifest is
 * brand/extension-identity.json. Changing either requires re-registering the
 * native host and reloading the unpacked extension. */
export const EXTENSION_ID = 'mclgchkiejnomabbnglaodgnmfhhipep';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const NATIVE_HOST_NAME = 'ai.mitter.host';
export type Action =
  | { type: 'list'; path: string }
  | { type: 'read'; path: string; offset?:number; limit?:number }
  | { type: 'search'; query: string }
  | { type: 'write'; path: string; content: string; expectedHash: string }
  | { type: 'replace'; path: string; before: string; after: string; expectedHash: string }
  | { type: 'command'; profileId: string }
  | { type: 'diff' }
  | { type: 'team_message'; message: string; to?: string }
  | { type: 'team_pause'; workerId: string; reason: string; seconds: number }
  | { type: 'team_resume'; workerId: string; context: string }
  | { type: 'finish'; summary: string }
  | { type: 'ask'; question: string };
export type Check =
  | { type: 'exists'; path: string }
  | { type: 'contains'; path: string; text: string }
  | { type: 'command'; profileId: string };
export interface Envelope {
  protocol: typeof VERSION; id: string; workerId: string; projectId: string;
  summary: string; actions: Action[]; replyTo?: string;
}
export type WorkerState = 'idle' | 'queued' | 'planning' | 'waiting_model'
 | 'waiting_lock' | 'executing' | 'verifying' | 'awaiting_approval' | 'paused'
 | 'review' | 'blocked' | 'complete' | 'cancelled';
export interface Profile { id: string; label: string; program: string; args: string[]; timeoutMs: number }
export interface Project { id: string; name: string; root: string; profiles: Profile[]; revision: number; mission?:string; conventions?:string; sourceRoot?:string }
export interface Approval {
  token: string; fingerprint: string; action: Action; reason: string; revision: number;
  profile?: Profile;
}
/** User-owned run boundary; persisted with the existing worker JSON. Old tasks
 * simply have no control record (epoch zero). It is never model-writable. */
export interface TaskControl {
  version:1; epoch:number; mode:'stopped'|'fresh'|'active'; at:number;
  operationId:string; reason:string; retiredExchanges:string[];
}
export interface CompletionRecord {
  version:1; verification:'passed'|'not-run'|'legacy-accepted';
  summary:string; checked:number; at:number; followupId?:string;
}
export interface Worker {
  completion?:CompletionRecord;
  control?:TaskControl;
  id: string; projectId: string; name: string; goal: string; checks: Check[];
  mode: 'handoff' | 'local'; state: WorkerState; queue: Envelope[]; cursor: number;
  runId: string; iteration: number; maxIterations: number; maxMinutes: number;
  startedAt: number; pending?: Approval; approvedFingerprint?: string;
  autoCommands: boolean; humanAcceptanceReady?: boolean; error?: string; observations: string[];
  activeFollowupId?:string; followups?:import('./requests.js').FollowupSummary[];
  worktree?:{root:string;branch:string;baseCommit:string}; teamPaused?:string;
  lastProposal?: string; repeatCount: number; createdAt: number;
}
export interface Settings {
  coderModelPath: string;
  contextSize: number; maxTokens: number; gpu: 'auto' | 'cpu';
}
export interface Activity { id: number; workerId: string; time: number; kind: string; message: string }
export interface BridgeProgressSummary {
  workerId:string;turns:number;maxTurns:number;lowerBound:boolean;activeMs:number;maxMinutes:number;startedAt:number;phase:string;reason:string;errorCode?:string;
}
export interface Snapshot {
  bridgeProgress?:BridgeProgressSummary[];
  protocol: typeof VERSION; projects: Project[]; workers: Worker[]; events: Activity[];
  settings: Settings; runtime: { version?: string; node: string; workflow: string; models: string };
}
export interface Request { id: string; method: string; params: Record<string, unknown> }
export type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export function object(value: unknown, label = 'object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected ${label}.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 4000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0'))
    throw new Error(`Invalid ${label} (maximum ${max} characters).`);
  return value;
}
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}
export function only(o: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(o)) if (!keys.includes(key)) throw new Error(`Unexpected field: ${key}`);
}
export function id(value: unknown, label = 'identifier'): string {
  const s = text(value, label, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error(`Invalid ${label}.`);
  return s;
}
function hash(value: unknown): string {
  if(typeof value!=='string'||value!=='missing'&&!/^[a-f0-9]{64}$/.test(value))throw editBaseError('expectedHash');
  return value;
}
export function parseAction(value: unknown): Action {
  const a = object(value, 'action');
  switch (a.type) {
    case 'list': only(a, ['type','path']); return { type: a.type, path: text(a.path ?? '.', 'path', 1000) };
    case 'read': only(a, ['type','path','offset','limit']); return { type:a.type, path:text(a.path,'path',1000), ...(a.offset===undefined?{}:{offset:integer(a.offset,'read offset',0,120000)}), ...(a.limit===undefined?{}:{limit:integer(a.limit,'read limit',1,64000)}) };
    case 'search': only(a, ['type','query']); return { type: a.type, query: text(a.query, 'query', 200) };
    case 'write': only(a, ['type','path','content','expectedHash']); return { type: a.type, path: text(a.path, 'path', 1000), content: text(a.content, 'content', MAX_TEXT, true), expectedHash: hash(a.expectedHash) };
    case 'replace': only(a, ['type','path','before','after','expectedHash']); return { type: a.type, path: text(a.path, 'path', 1000), before: text(a.before, 'before', MAX_TEXT), after: text(a.after, 'after', MAX_TEXT, true), expectedHash: hash(a.expectedHash) };
    case 'command': only(a, ['type','profileId']); return { type: a.type, profileId: id(a.profileId) };
    case 'team_message': only(a,['type','message','to']); return {type:a.type,message:text(a.message,'team message',3000),...(a.to===undefined?{}:{to:id(a.to,'recipient')})};
    case 'team_pause': only(a,['type','workerId','reason','seconds']); return {type:a.type,workerId:id(a.workerId),reason:text(a.reason,'pause reason',1000),seconds:integer(a.seconds??120,'pause duration',10,300)};
    case 'team_resume': only(a,['type','workerId','context']); return {type:a.type,workerId:id(a.workerId),context:text(a.context,'handoff context',3000)};
    case 'diff': only(a, ['type']); return { type: a.type };
    case 'finish': only(a, ['type','summary']); return { type: a.type, summary: text(a.summary, 'summary', 4000) };
    case 'ask': only(a, ['type','question']); return { type: a.type, question: text(a.question, 'question', 4000) };
    default: throw new Error('Unknown action type. No action was executed.');
  }
}
export function parseCheck(value: unknown): Check {
  const a = object(value, 'check');
  if (a.type === 'exists') { only(a,['type','path']); return {type:'exists',path:text(a.path,'path',1000)}; }
  if (a.type === 'contains') { only(a,['type','path','text']); return {type:'contains',path:text(a.path,'path',1000),text:text(a.text,'text',4000)}; }
  if (a.type === 'command') { only(a,['type','profileId']); return {type:'command',profileId:id(a.profileId)}; }
  throw new Error('Invalid goal check.');
}
export function parseChecks(value: unknown): Check[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Provide an array of at most 20 checks.');
  return value.map(parseCheck);
}
export function parseEnvelopeWith<A>(input:string,parse:(value:unknown)=>A):Omit<Envelope,'actions'>&{actions:A[]} {
  const parsed=readReplyJSON(input);
  const e = object(parsed, 'handoff');
  if(Object.keys(e).some(key=>!['protocol','id','workerId','projectId','summary','actions','replyTo'].includes(key)))
    throw new ReplyValidationError({stage:'schema',code:'ENVELOPE_FIELDS',message:'The reply contains unsupported top-level fields.'});
  if (e.protocol !== VERSION) throw new Error('Unsupported protocol. Expected mitter/1.');
  if (!Array.isArray(e.actions) || e.actions.length < 1 || e.actions.length > 16) throw new Error('A handoff must contain 1–16 actions.');
  return {protocol:VERSION,id:id(e.id),workerId:id(e.workerId),projectId:id(e.projectId),summary:text(e.summary,'summary',4000),actions:e.actions.map((a,index)=>{try{return parse(a);}catch(error){return atAction(error,index);}}),...(e.replyTo === undefined ? {} : {replyTo:id(e.replyTo,'replyTo')})};
}
export function parseEnvelope(input:string):Envelope {return parseEnvelopeWith(input,parseAction);}
export function parseRequest(value: unknown): Request {
  const r = object(value, 'request'); only(r, ['id','method','params']);
  return {id:id(r.id),method:text(r.method,'method',100),params:object(r.params ?? {},'params')};
}
