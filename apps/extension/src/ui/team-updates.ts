import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { PreviewRPC } from '../../../../packages/ui/src/preview';
import { teamViewSchema, type TeamView } from './view-data';
import { errorMessage } from '../schemas/primitives';
import { coreRpcRegistry, parseRpcParams, parseRpcResult } from '../../../../packages/protocol/src/rpc.js';

export type TeamUpdatesOptions = {
  workerId: string;
  revision: number;
  rpc: PreviewRPC;
  success?: (message: string) => void;
};

export function createTeamUpdates(options: TeamUpdatesOptions) {
  const [data, setData] = createSignal<TeamView>({ peers: [], messages: [] });
  const [text, writeText] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal('');
  const [sendError, setSendError] = createSignal('');
  let alive = true;
  let scopedWorkerId = '';
  let loadGeneration = 0;
  let sendGeneration = 0;
  let draftRevision = 0;

  const setText = (value: string) => {
    if (alive) {
      draftRevision++;
      writeText(value);
    }
  };
  const error = () => sendError() || loadError();

  const load = async () => {
    if (!alive) {
      return;
    }
    const operation = ++loadGeneration;
    const workerId = options.workerId;
    const isCurrent = () => alive && operation === loadGeneration && workerId === options.workerId;
    setLoading(true);
    setLoadError('');

    try {
      const response = await options.rpc('worker.team', { workerId });
      if (!isCurrent()) {
        return;
      }
      const result = teamViewSchema.safeParse(response);
      if (!result.success) {
        throw new Error('Miter could not read the team response. Refresh team updates to try again.', {
          cause: result.error,
        });
      }
      setData(result.data);
    } catch (event) {
      if (isCurrent()) {
        setLoadError(
          'Team updates could not be loaded. Refresh team updates to try again. ' + errorMessage(event),
        );
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  };

  const send = async () => {
    if (!alive || busy()) {
      return;
    }
    const message = text();
    if (!message.trim()) {
      setSendError('Write a project update before sending it.');
      return;
    }
    const workerId = options.workerId;
    const operation = ++sendGeneration;
    const submittedRevision = draftRevision;
    const isCurrent = () => alive && operation === sendGeneration && workerId === options.workerId;
    setBusy(true);
    setSendError('');

    try {
      const params = { workerId, message, id: crypto.randomUUID() };
      parseRpcParams(coreRpcRegistry, 'worker.teamMessage', params);
      const result = await options.rpc('worker.teamMessage', params);
      if (!isCurrent()) {
        return;
      }
      parseRpcResult(coreRpcRegistry, 'worker.teamMessage', result);
      if (submittedRevision === draftRevision) {
        setText('');
      }
      options.success?.('Project update shared.');
      if (isCurrent()) {
        await load();
      }
    } catch (event) {
      if (isCurrent()) {
        setSendError(
          'Miter could not confirm that the update was shared. It may already appear in recent updates. Refresh and check before sending it again. ' +
            errorMessage(event),
        );
      }
    } finally {
      if (isCurrent()) {
        setBusy(false);
      }
    }
  };

  createEffect(() => {
    const workerId = options.workerId;
    options.revision;
    if (workerId !== scopedWorkerId) {
      scopedWorkerId = workerId;
      sendGeneration++;
      draftRevision++;
      setData({ peers: [], messages: [] });
      writeText('');
      setBusy(false);
      setSendError('');
    }
    void load();
  });

  onCleanup(() => {
    alive = false;
    loadGeneration++;
    sendGeneration++;
    setData({ peers: [], messages: [] });
    writeText('');
    setLoadError('');
    setSendError('');
    setBusy(false);
    setLoading(false);
  });

  return { data, text, setText, busy, loading, error, load, send };
}
