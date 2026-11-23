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

export function DocsPage() {
  return (
    <main id="main" className="shell guide">
      <h1>Miter docs</h1>
      <p className="intro">Set up Miter, run a task, and open the finished app.</p>
      <section className="guide-section" aria-labelledby="first-task">
        <h2 id="first-task">Run your first task</h2>
        <ol>
          <li>
            <a href={links.install}>Install Miter</a> and open it from Chrome’s Extensions menu.
          </li>
          <li>
            Choose <strong>Create project</strong> or <strong>Open existing project</strong>.
          </li>
          <li>
            Choose <strong>New task</strong>, describe what you want changed, and start the task.
          </li>
        </ol>
        <blockquote>Build a reading list where I can save books and mark them as read.</blockquote>
        <p>
          You can attach images or paste a screenshot into the task. Open{' '}
          <strong>Help → Documentation</strong> in the extension for more examples.
        </p>
      </section>
      <section className="guide-section" aria-labelledby="commands-and-previews">
        <h2 id="commands-and-previews">Commands and previews</h2>
        <p>
          Miter shows a command and its effects when it needs approval. Run it there, decline it, or open the
          project terminal to run it yourself.
        </p>
        <p>
          For supported web apps, Miter runs project and browser checks. Use <strong>Run</strong> to open the
          app and manage its server in the terminal.
        </p>
        <ul className="resource-links">
          <li>
            <a href={links.terminal}>Terminal commands</a>
          </li>
          <li>
            <a href={links.checks}>Browser and accessibility checks</a>
          </li>
          <li>
            <a href={links.protocol}>ChatGPT message protocol</a>
          </li>
        </ul>
      </section>
      <section className="guide-section" aria-labelledby="connection">
        <h2 id="connection">Fix a connection</h2>
        <p>
          Check <strong>Setup &amp; connection</strong> in Miter. If the helper and extension show different
          build IDs, update Miter and reload its Chrome extension card.
        </p>
        <a href={links.issues}>Report an issue on GitHub</a>
      </section>
    </main>
  );
}
