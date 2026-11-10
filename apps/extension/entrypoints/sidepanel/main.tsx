import { ResetBoundary } from '../../src/ResetBoundary';
import { render } from 'solid-js/web';
import App from '../../src/App';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Miter side panel root was not found.');
}

render(() => <ResetBoundary app={() => <App />} />, root);
