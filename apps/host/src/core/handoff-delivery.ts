import type {Worker} from '../../../../packages/protocol/src/index.js';
import {Store} from './database.js';

/** Body-free receipt, persisted in the SAME transaction as import. This is
 * acknowledgement recovery, not permission to run a different/stopped plan. */
export interface HandoffDelivery {
  version:1; workerId:string; projectId:string; runId:string; epoch:number;
  hash:string; started:boolean;
}
export const deliveryKey=(envelopeId:string)=>'miter.handoffDelivery.v1.'+envelopeId;
export function matchingDelivery(store:Store,w:Worker,envelopeId:string,hash:string):HandoffDelivery {
  const d=store.get<HandoffDelivery>(deliveryKey(envelopeId));
  if(!d||d.version!==1||store.envelopeOwner(envelopeId)!==w.id||
     d.workerId!==w.id||d.projectId!==w.projectId||d.runId!==w.runId||
     d.epoch!==(w.control?.epoch??0)||d.hash!==hash||typeof d.started!=='boolean')
    throw new Error('The saved handoff acknowledgement does not match this exact batch and run. No actions were repeated.');
  return d;
}
