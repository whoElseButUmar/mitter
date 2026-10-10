import type { Worker } from '../../protocol/src/index.js';
import type { BridgeStatus } from './index.js';
export function taskPresentation(worker:Worker,bridge?:BridgeStatus){
 if(worker.state==='complete')return {status:'complete',detail:worker.completion?.verification==='legacy-accepted'?'Finished. Previously accepted by you.':worker.completion?.verification==='passed'?'Finished. Configured checks passed.':worker.completion?.verification==='not-run'?'Finished. No automated checks configured.':worker.checks.length?'Finished. Configured checks passed.':'Finished. Verification not recorded.',start:'Run with ChatGPT',tone:'success'};
 if(worker.humanAcceptanceReady)return {status:'review',detail:'Ready for your review.',start:'Run with ChatGPT',tone:'normal'};
 if(worker.control?.mode==='stopped')return {status:'stopped',detail:'Stopped. Completed work is kept; Continue fresh replans from the current files.',start:'Continue fresh',tone:'normal'};
 if(worker.control?.mode==='fresh'&&!bridge?.active)return {status:'paused',detail:worker.error||'Ready to continue from the current files with a fresh plan.',start:'Continue fresh',tone:'normal'};
 if(bridge?.monitoring&&bridge.receiving)return {status:'working',detail:bridge.reason,start:'Resume task',tone:'working'};
 if(bridge?.monitoring)return {status:'needs_attention',detail:bridge.reason,start:'Resume task',tone:'error'};
 if(bridge?.active)return {status:bridge.phase==='waiting_approval'?'needs_approval':bridge.phase==='reconnecting'?'reconnecting':bridge.phase==='connecting'?'connecting':'working',detail:bridge.reason,start:'Resume task',tone:'working'};
 if(bridge?.phase==='error')return {status:'paused',detail:bridge.reason,start:'Resume task',tone:'error'};
 if(bridge?.phase==='stopped')return {status:'paused',detail:bridge.reason,start:'Resume task',tone:'normal'};
 return {status:worker.state,detail:worker.state==='idle'?'Ready when you are.':worker.state==='review'?(worker.error||'Ready for the next step.'):worker.error||'',start:worker.state==='idle'?'Run with ChatGPT':'Resume task',tone:'normal'};
}

/** The counter is per TASK, not per Resume session. Legacy releases did not
 * save every send; expose a minimum rather than inventing an exact total. */
export function turnLabel(bridge:BridgeStatus):string {
 return `${bridge.lowerBound?'≥':''}${bridge.turns}/${bridge.maxTurns} turns`;
}
export function budgetExhausted(bridge:BridgeStatus|undefined):boolean {
 return !!bridge&&!bridge.active&&(
  bridge.errorCode==='TIME_LIMIT'||bridge.errorCode==='TURN_LIMIT'||
  typeof bridge.activeMs==='number'&&typeof bridge.maxMinutes==='number'&&bridge.activeMs>=bridge.maxMinutes*60000);
}
