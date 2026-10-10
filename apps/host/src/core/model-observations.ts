import type {Action} from '../../../../packages/protocol/src/index.js';
import {redact} from './redaction.js';

export const MAX_OBSERVATION=48000;
const MAX_STORED=128000;
/** Prompt rendering budget shared with the caller: whole records only, newest
 * first, older entries explicitly marked omitted. */
export const OBSERVATION_PROMPT_BUDGET=24000;
/** Window for export/report renders (completion report), wider than the model
 * prompt budget because the reader is a human, not the model. */
export const OBSERVATION_REPORT_BUDGET=72000;
/** Redact string VALUES, before serializing. Redacting the encoded JSON can
 * remove a closing quote; slicing the encoded JSON can remove path/hash keys. */
export const encodeObservation=(value:unknown):string=>JSON.stringify(value,(_key,v)=>typeof v==='string'?redact(v):v);
export function actionRecord(action:Action):unknown {
  if(action.type==='write')return {type:action.type,path:action.path,expectedHash:action.expectedHash,contentCharacters:action.content.length};
  if(action.type==='replace')return {type:action.type,path:action.path,expectedHash:action.expectedHash,beforeCharacters:action.before.length,afterCharacters:action.after.length};
  return action;
}
function compact(value:unknown):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return {detailsOmitted:true};
  const v=value as Record<string,unknown>,result=v.result;
  if(result&&typeof result==='object'&&!Array.isArray(result)){
    const {content,...metadata}=result as Record<string,unknown>;
    return {...v,result:{...metadata,...(typeof content==='string'?{contentOmitted:true,contentCharacters:content.length}:{}),detailsOmitted:true}};
  }
  return {action:v.action??null,detailsOmitted:true,next:'Repeat a focused read to retrieve current file content.'};
}
export function appendObservation(previous:string[],message:string):string[] {
  let value:unknown;
  try{value=JSON.parse(message);}catch{value={note:redact(message).slice(0,8000),...(message.length>8000?{detailsOmitted:true}:{})};}
  let entry=encodeObservation(value);
  if(entry.length>MAX_OBSERVATION)entry=encodeObservation(compact(value));
  if(entry.length>MAX_OBSERVATION)entry=encodeObservation({detailsOmitted:true,next:'Request a smaller, focused result.'});
  const entries=[...previous,entry].slice(-16);
  while(entries.reduce((sum,s)=>sum+s.length,0)>MAX_STORED&&entries.length>1)entries.shift();
  return entries;
}
/** Whole records only. Even legacy truncated observations are explicitly marked
 * as incomplete notes, never presented as complete machine-readable evidence. */
export function renderObservations(observations:string[],budget=OBSERVATION_REPORT_BUDGET):string {
  const out:string[]=[];let remaining=budget,omitted=0;
  for(let i=observations.length-1;i>=0;i--){
    const raw=observations[i]!;let value:unknown;
    try{value=JSON.parse(raw);}catch{value={legacyNote:redact(raw).slice(0,3000),incomplete:true,next:'Read current files; do not infer file versions from a partial legacy note.'};}
    let record=encodeObservation(value);
    if(record.length+2>remaining)record=encodeObservation(compact(value));
    if(record.length+2>remaining){omitted++;continue;}
    out.unshift(record);remaining-=record.length+2;
  }
  return (omitted?JSON.stringify({olderObservationsOmitted:omitted})+'\n\n':'')+out.join('\n\n');
}
