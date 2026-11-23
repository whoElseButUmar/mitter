import { InstallCommand } from './InstallCommand.jsx';
import { extensionPath, links, requirements } from './site-links.js';

export function InstallPage() {
  return (
    <main id="main" className="shell guide">
      <h1>Install Miter</h1>
      <p className="intro">Install the local helper and load Miter into Chrome.</p>
      <p className="requirements">{requirements}</p>
      <InstallCommand />
      <section className="guide-section" aria-labelledby="load-extension">
        <h2 id="load-extension">Load the extension</h2>
        <ol>
          <li>
            In Chrome, open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.
          </li>
          <li>
            Choose <strong>Load unpacked</strong> and pick the folder printed by the installer.
          </li>
          <li>Open Miter from Chrome’s Extensions menu. Use the profile where you sign in to ChatGPT.</li>
        </ol>
        <p>
          The default extension folder is <code>{extensionPath}</code>.
        </p>
      </section>
      <section className="guide-section" aria-labelledby="update">
        <h2 id="update">Update Miter</h2>
        <p>Run the same installer command, then reload Miter’s card in Chrome and reopen the workspace.</p>
      </section>
      <section className="guide-section" aria-labelledby="alternatives">
        <h2 id="alternatives">Other install options</h2>
        <p>
          Open <strong>Install Miter.command</strong> from the Mac ZIP to install without npm. The full guide
          covers source setup, Chromium, and uninstall.
        </p>
        <ul className="resource-links">
          <li>
            <a href={links.releases}>Mac installer downloads</a>
          </li>
          <li>
            <a href={links.installGuide}>Full installation guide</a>
          </li>
        </ul>
      </section>
    </main>
  );
}
