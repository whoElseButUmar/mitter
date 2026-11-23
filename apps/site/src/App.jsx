import { InstallCommand } from './InstallCommand.jsx';
import { InstallPage } from './InstallPage.jsx';
import { links, requirements } from './site-links.js';
import { WorkspaceDemo } from './WorkspaceDemo.jsx';

const icon = links.home + 'miter-icon.png';

function SiteNav({ footer = false }) {
  let label = 'Main navigation';
  if (footer) {
    label = 'Footer navigation';
  }

  return (
    <nav aria-label={label} className="site-nav">
      <a href={links.docs}>Docs</a>
      <a href={links.repository}>GitHub</a>
    </nav>
  );
}

function SiteHeader() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="shell header-inner">
          <a href={links.home} className="site-brand">
            <img src={icon} width="42" height="42" alt="" />
            <span>Miter</span>
          </a>
          <SiteNav />
        </div>
      </header>
    </>
  );
}

function SiteFooter({ page }) {
  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <div className="footer-install">
          <a href={links.install} className="footer-label">
            Install on macOS
          </a>
          {page === 'home' && <InstallCommand />}
        </div>
        <SiteNav footer />
      </div>
    </footer>
  );
}

function LandingPage() {
  return (
    <main id="main" className="shell">
      <section className="hero" aria-label="Build with Miter">
        <div className="hero-copy">
          <h1>
            <span>Build in Chrome.</span>
            <span>Run on your Mac.</span>
          </h1>
          <p className="intro">Connect ChatGPT to a local project and review the edits as they happen.</p>
          <InstallCommand />
          <p className="requirements">{requirements}</p>
        </div>
        <WorkspaceDemo icon={icon} />
      </section>
      <section className="workflow" aria-labelledby="workflow-title">
        <h2 id="workflow-title">From request to preview</h2>
        <div className="workflow-steps">
          <div>
            <h3>Open a folder</h3>
            <p>Point Miter at a local project on your Mac.</p>
          </div>
          <div>
            <h3>Describe the change</h3>
            <p>Tell ChatGPT what you want to build or update.</p>
          </div>
          <div>
            <h3>Run the app</h3>
            <p>Have Miter apply the code and run it locally so you can preview it.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

export function App({ page }) {
  let content = <LandingPage />;

  if (page === 'install') {
    content = <InstallPage />;
  }

  return (
    <>
      <SiteHeader />
      {content}
      <SiteFooter page={page} />
    </>
  );
}
