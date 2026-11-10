import { rpcCounterSchema } from '../../../../../packages/protocol/src/rpc.js';

export function advanceCounter(value: number, label: string, increment = 1): number {
  const parsed = rpcCounterSchema.max(Number.MAX_SAFE_INTEGER - increment).safeParse(value);

  if (!parsed.success) {
    throw new Error(label + ' has reached its supported limit. Nothing was changed.', {
      cause: parsed.error,
    });
  }

  return parsed.data + increment;
}
