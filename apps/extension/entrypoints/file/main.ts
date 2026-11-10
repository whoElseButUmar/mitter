import { connectResetView } from '../../src/data-view.js';
import { mountFileWindow } from '../../../../packages/ui/src/file-window.js';
import { parseFileTarget } from '../../../../packages/ui/src/file-target.js';
import { FilePreviewClient } from '../../src/file-preview-client.js';
import { errorMessage } from '../../src/schemas/primitives.js';
import './style.css';

function startFileWindow(): void {
  const root = document.getElementById('file-root');

  if (!root) {
    throw new Error('The file window root is missing.');
  }

  const client = new FilePreviewClient();
  let unmount: (() => void) | undefined;

  try {
    unmount = mountFileWindow(root, {
      target: parseFileTarget(location.href),
      rpc: client.request,
      sandboxURL: chrome.runtime.getURL('/preview-sandbox.html'),
      onTitle: (title) => {
        document.title = title;
      },
    });
  } catch (error) {
    root.setAttribute('role', 'alert');
    root.textContent = errorMessage(error);
  }

  const reset = connectResetView(
    (state) => {
      if (state.phase === 'idle') {
        return;
      }

      if (state.phase === 'complete') {
        root.textContent = 'Miter data cleared.';
      } else {
        root.textContent = state.error || 'Miter data reset in progress. This file view has been closed.';
      }
    },
    () => {
      unmount?.();
      unmount = undefined;
      client.close();
      root.replaceChildren();
      document.title = 'Miter · Data reset';
    },
  );

  window.addEventListener(
    'pagehide',
    () => {
      unmount?.();
      client.close();
      reset.close();
    },
    { once: true },
  );
}

startFileWindow();
