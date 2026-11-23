import { DocsPage } from '@mitter/docs';
import { render } from 'solid-js/web';
import { Mark } from '../../src/icons';
import '../../src/style.css';
import '@mitter/docs/styles.css';

const root = document.getElementById('root');

if (root) {
  render(
    () => (
      <DocsPage
        brandMark={<Mark size={27} />}
        toolbarLinks={[{ label: 'Workspace', href: 'workspace.html' }]}
      />
    ),
    root,
  );
}
