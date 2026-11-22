import { render } from 'solid-js/web';
import { DocsPage } from '../../src/docs/DocsPage';
import '../../src/style.css';
import '../../src/docs/docs.css';

const root = document.getElementById('root');

if (root) {
  render(() => <DocsPage />, root);
}
