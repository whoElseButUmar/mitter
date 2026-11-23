import { DocsPage } from '@mitter/docs';
import { render } from 'solid-js/web';
import { links } from './site-links.js';
import './styles.css';
import '@mitter/docs/styles.css';

const root = document.getElementById('root');

if (root) {
  render(
    () => (
      <DocsPage
        brandMark={<img src={links.home + 'miter-icon.png'} width="32" height="32" alt="" />}
        toolbarLinks={[
          { label: 'Home', href: links.home },
          { label: 'Install', href: links.install },
        ]}
      />
    ),
    root,
  );
}
