import { onCleanup, onMount, type JSX } from 'solid-js';
import { mountStartSheet, type StartSheetDependencies } from '../../../../packages/bridge/src/start-sheet';
import { Modal } from '../../src/components';
import { requireElement } from '../../src/ui/dom';
import { TaskNavigationFixture } from './task-navigation.fixture';

type StartOptions = Parameters<StartSheetDependencies['start']>[0];

/** Real start-sheet DOM; permissions and admission stay inside this disposable fixture. */
export function createTaskRecoveryFixture(mount: (component: () => JSX.Element) => void, close: () => void) {
  const chats = [
    {
      id: 42,
      title: 'Planning',
      providerId: 'chatgpt',
      url: 'https://chatgpt.com/c/fixture-conversation-one',
    },
    {
      id: 43,
      title: 'Planning',
      providerId: 'chatgpt',
      url: 'https://chatgpt.com/c/fixture-conversation-two',
    },
    { id: 44, title: 'Project notes', providerId: 'chatgpt', url: 'https://chatgpt.com/c/fixture-notes' },
  ];
  let permission: ((allowed: boolean) => void) | undefined;
  let rejectAdmission: ((error: Error) => void) | undefined;
  let authorizations = 0;
  let inventories = 0;
  let closed = 0;
  let stopped = 0;
  const starts: StartOptions[] = [];

  function show() {
    if (permission || rejectAdmission) {
      throw new Error('Finish the previous controlled task-start request before remounting.');
    }
    authorizations = 0;
    inventories = 0;
    closed = 0;
    stopped = 0;
    starts.length = 0;
    const dependencies: StartSheetDependencies = {
      authorize: () => {
        authorizations++;
        return new Promise<boolean>((resolve) => {
          permission = resolve;
        });
      },
      lastChat: async () => chats[0],
      loadChats: async () => {
        inventories++;
        return chats;
      },
      start: (options) => {
        starts.push({ ...options });
        return new Promise<unknown>((_resolve, reject) => {
          rejectAdmission = reject;
        });
      },
      stop: async () => {
        stopped++;
        return { stopped: false };
      },
      started: () => {
        throw new Error('The recovery fixture never acknowledges a successful start.');
      },
      close: () => {
        closed++;
        close();
      },
    };
    mount(() => {
      let root: HTMLDivElement | undefined;
      onMount(() => {
        const dispose = mountStartSheet(requireElement(root, 'Task recovery fixture'), dependencies);
        onCleanup(dispose);
      });
      return (
        <Modal title="Run with ChatGPT" close={dependencies.close}>
          <div
            ref={(element) => {
              root = element;
            }}
          />
        </Modal>
      );
    });
  }

  function resolvePermission(allowed: boolean) {
    const resolve = permission;
    if (!resolve) {
      throw new Error('No task permission request is pending.');
    }
    permission = undefined;
    resolve(allowed);
  }

  function rejectStart() {
    const reject = rejectAdmission;
    if (!reject) {
      throw new Error('No task-start acknowledgement is pending.');
    }
    rejectAdmission = undefined;
    reject(new Error('The chat connection was interrupted.'));
  }

  function dispose() {
    const resolve = permission;
    const reject = rejectAdmission;
    permission = undefined;
    rejectAdmission = undefined;
    resolve?.(false);
    reject?.(new Error('The task recovery fixture was disposed.'));
  }

  return {
    show,
    showNavigation: (mode: string) => {
      if (mode !== 'project' && mode !== 'setup') {
        throw new Error('Unknown task-navigation fixture mode.');
      }
      mount(() => <TaskNavigationFixture mode={mode} />);
    },
    resolvePermission,
    rejectStart,
    dispose,
    inspect: () => ({ authorizations, inventories, closed, stopped, starts: [...starts] }),
  };
}
