import {
  chatChoiceSchema,
  mountStartSheet,
  type StartSheetDependencies,
} from '../../../packages/bridge/src/start-sheet';
import { taskBoundarySchema, type TaskBoundary } from '../../../packages/protocol/src/index';
import type { ViewRPC } from './ui/rpc';
import { callResult } from './ui/rpc';
import { requireElement } from './ui/dom';
import { createChatStartCleanup } from './ui/chat-start-cleanup';
import { onMount, onCleanup } from 'solid-js';
import { Modal } from './components';
type AutomationFormProps = {
  close: () => void;
  rpc: ViewRPC;
  workerId: string;
  expectedRun: TaskBoundary;
  started: () => void;
};

export function createAutomationFormRequests(props: AutomationFormProps): StartSheetDependencies {
  const { workerId, rpc, close, started } = props;
  const expectedRun = taskBoundarySchema.parse(props.expectedRun);
  const cleanup = createChatStartCleanup(rpc);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  return {
    authorize: () => {
      if (!alive) {
        return Promise.resolve(false);
      }
      return chrome.permissions.request({
        origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      });
    },
    lastChat: () => callResult(rpc, chatChoiceSchema.nullable(), 'bridge.lastChat', { workerId }),
    loadChats: () => callResult(rpc, chatChoiceSchema.array(), 'bridge.tabs'),
    start: (options) => {
      if (!alive) {
        return Promise.reject(new Error('This task dialog is closed. Review the task before starting.'));
      }
      return cleanup.start(() => rpc('bridge.start', { ...options, workerId, expectedRun }));
    },
    stop: cleanup.stop,
    close: () => {
      if (alive) {
        alive = false;
        close();
      }
    },
    started: () => {
      if (alive) {
        started();
      }
    },
  };
}

export function AutomationForm(props: AutomationFormProps) {
  const requests = createAutomationFormRequests(props);
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const dispose = mountStartSheet(requireElement(root, 'AutomationForm root'), requests);
    onCleanup(dispose);
  });

  return (
    <Modal title="Run with ChatGPT" close={requests.close}>
      <div
        ref={(element) => {
          root = element;
        }}
      />
    </Modal>
  );
}
