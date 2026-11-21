import { createEffect, createSignal, onCleanup } from 'solid-js';
import { readinessSchema, type Readiness } from '../../../../packages/protocol/src/rpc';
import { errorMessage } from '../schemas/primitives';
import { callResult, type ViewRPC } from './rpc';

export function createReadiness(connected: () => boolean, rpc: ViewRPC) {
  const [report, setReport] = createSignal<Readiness>();
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  let revision = 0;
  let alive = true;

  const refresh = async () => {
    if (!alive || !connected()) {
      return;
    }

    const current = ++revision;
    setLoading(true);
    setError('');
    setReport(undefined);

    try {
      const next = await callResult(rpc, readinessSchema, 'system.readiness');
      if (alive && current === revision && connected()) {
        setReport(next);
      }
    } catch (failure) {
      if (alive && current === revision && connected()) {
        setError(errorMessage(failure));
      }
    } finally {
      if (alive && current === revision) {
        setLoading(false);
      }
    }
  };

  createEffect(() => {
    if (connected()) {
      void refresh();
    } else {
      revision++;
      setReport(undefined);
      setError('');
      setLoading(false);
    }
  });

  onCleanup(() => {
    alive = false;
    revision++;
  });

  return { report, error, loading, refresh };
}
