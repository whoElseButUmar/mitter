import { createEffect, createMemo, createSignal, on, type Accessor } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';

type TrustChoice = { identity: string; checked: boolean };

export function createApprovalTrust(task: Accessor<Worker>) {
  const [choice, setChoice] = createSignal<TrustChoice | undefined>();
  const identity = createMemo(() => {
    const worker = task();
    const approval = worker.pending;

    if (!approval) {
      return undefined;
    }

    return JSON.stringify([
      worker.id,
      worker.runId,
      worker.queue[0]?.id,
      approval.token,
      approval.fingerprint,
      approval.revision,
    ]);
  });

  createEffect(on(identity, () => setChoice(undefined)));

  const checked = (): boolean => {
    const approvalIdentity = identity();
    const selection = choice();
    return approvalIdentity !== undefined && selection?.identity === approvalIdentity && selection.checked;
  };

  const setChecked = (checked: boolean): void => {
    const approvalIdentity = identity();

    if (approvalIdentity === undefined) {
      setChoice(undefined);
      return;
    }

    setChoice({ identity: approvalIdentity, checked });
  };

  return { checked, setChecked };
}
