import { bridgeStartResultSchema, bridgeStopStartedResultSchema } from '../schemas/local-results';
import type { BridgeStopStartedParameters } from '../schemas/requests';
import { callResult, type ViewRPC } from './rpc';

export function createChatStartCleanup(rpc: ViewRPC) {
  let receipt: BridgeStopStartedParameters | undefined;

  const start = async (send: () => Promise<unknown>) => {
    receipt = undefined;
    const admitted = await callResult(send, bridgeStartResultSchema, 'bridge.start');
    // A late acknowledgement still belongs to this form, even after its disposal.
    receipt = {
      workerId: admitted.workerId,
      admissionId: admitted.admissionId,
      expectedRun: admitted.expectedRun,
    };
    return admitted;
  };

  const stop = async () => {
    const admitted = receipt;
    receipt = undefined;
    if (!admitted) {
      return { stopped: false };
    }
    return callResult(rpc, bridgeStopStartedResultSchema, 'bridge.stopStarted', admitted);
  };

  return { start, stop };
}
