import { id, integer, object, only, text } from './index.js';

/** Text offsets are UTF-16 indices into the exact source displayed in the viewer. */
export interface CodeSelection {
  path: string;
  hash: string;
  start: number;
  end: number;
  text: string;
}
export type FollowupState = 'queued' | 'active' | 'review' | 'completed' | 'cancelled' | 'blocked' | 'superseded';
export interface Followup {
  id: string; workerId: string; instruction: string; selection?: CodeSelection;
  status: FollowupState; createdAt: number; activatedAt?: number; finishedAt?: number;
  error?: string; baseRunId: string; autoStart: boolean;
}
export interface FollowupSummary {
  id: string; instruction: string; status: FollowupState; createdAt: number; error?: string;
  path?: string;
}
export function parseSelection(value: unknown): CodeSelection {
  const s=object(value,'code selection');only(s,['path','hash','start','end','text']);
  const hash=text(s.hash,'source hash',64);
  if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Select code from a fully loaded source file.');
  const start=integer(s.start,'selection start',0,120000),end=integer(s.end,'selection end',1,120000);
  const source=text(s.text,'selected code',16000,true);
  if(end<=start||source.length!==end-start)throw new Error('The selection range does not match its text. Select the code again.');
  return {path:text(s.path,'selected file',1000),hash,start,end,text:source};
}
export function parseFollowup(value:unknown):{id:string;instruction:string;selection?:CodeSelection;autoStart:boolean}{
  const p=object(value,'follow-up');only(p,['id','instruction','selection','autoStart']);
  return {id:id(p.id,'request ID'),instruction:text(p.instruction,'follow-up',4000).trim(),
    ...(p.selection===undefined?{}:{selection:parseSelection(p.selection)}),autoStart:p.autoStart!==false};
}
export function summarizeFollowup(f:Followup):FollowupSummary{
  return {id:f.id,instruction:f.instruction.slice(0,600),status:f.status,createdAt:f.createdAt,error:f.error,path:f.selection?.path};
}
