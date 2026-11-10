import { errorMessage } from '../../src/schemas/primitives';
import { ResetBoundary } from '../../src/ResetBoundary';
import { render } from 'solid-js/web';
import App from '../../src/App';
import { parseFileTarget, filePreviewURL } from '../../../../packages/ui/src/file-target';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Miter workspace root was not found.');
}

// Legacy file links now open the file-only surface, not another workspace.
if (new URLSearchParams(location.search).has('file')) {
  try {
    location.replace(filePreviewURL(chrome.runtime.getURL('/file.html'), parseFileTarget(location.href)));
  } catch (error) {
    root.setAttribute('role', 'alert');
    root.textContent = errorMessage(error);
  }
} else {
  render(() => <ResetBoundary app={() => <App />} />, root);
}
