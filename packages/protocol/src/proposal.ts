import {parseAction,parseEnvelopeWith,object,only,text,MAX_TEXT,type Action,type Envelope} from './index.js';
import {ReplyValidationError,editBaseError} from './validation.js';

/** Model wire input is NOT an executable plan. Only the native host can resolve
 * a read reference to a recorded SHA-256 and produce an executable Envelope.
 * Legacy exact-hash replies stay supported for saved conversations/queues. */
export type ReferencedEdit =
  | {type:'write';path:string;content:string;base:string}
  | {type:'replace';path:string;before:string;after:string;base:string};
export type ProposalAction=Action|ReferencedEdit;
export type ProposalEnvelope=Omit<Envelope,'actions'>&{actions:ProposalAction[]};
export const isReadReference=(value:unknown):value is string=>typeof value==='string'&&/^r_[a-f0-9]{16}$/.test(value);
export function parseProposalAction(value:unknown):ProposalAction {
  const a=object(value,'action');
  if(a.type!=='write'&&a.type!=='replace')return parseAction(a);
  if(a.base!==undefined&&a.expectedHash!==undefined)throw new ReplyValidationError({stage:'schema',code:'BASE_CONFLICT',field:'base',message:'An edit must use either base or expectedHash, never both.'});
  if(a.base===undefined){
    if(a.expectedHash===undefined)throw new ReplyValidationError({stage:'schema',code:'BASE_REQUIRED',field:'base',message:'An edit needs a recorded read base or an exact expectedHash. No default/current version is assumed.'});
    return parseAction(a);
  }
  if(!isReadReference(a.base)&&a.base!=='missing'||a.type==='replace'&&a.base==='missing')throw editBaseError('base');
  if(a.type==='write'){
    only(a,['type','path','content','base']);
    return {type:'write',path:text(a.path,'path',1000),content:text(a.content,'content',MAX_TEXT,true),base:a.base as string};
  }
  only(a,['type','path','before','after','base']);
  return {type:'replace',path:text(a.path,'path',1000),before:text(a.before,'before',MAX_TEXT),after:text(a.after,'after',MAX_TEXT,true),base:a.base as string};
}
export function parseProposalEnvelope(input:string):ProposalEnvelope {
  const e=parseEnvelopeWith(input,parseProposalAction);
  for(let i=0;i<e.actions.length-1;i++)if(e.actions[i]!.type==='finish')throw new ReplyValidationError({stage:'schema',code:'FINISH_ORDER',actionIndex:i,field:'type',message:'finish must be the final action in a batch.'});
  return e;
}
