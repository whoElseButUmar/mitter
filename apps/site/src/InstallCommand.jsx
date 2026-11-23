import { useEffect, useRef, useState } from 'react';
import { installCommand } from './site-links.js';

export function InstallCommand() {
  const code = useRef(null);
  const timer = useRef(undefined);
  const [status, setStatus] = useState('');
  const copied = status === 'Copied install command.';
  let feedbackClass = 'visually-hidden';

  if (status === 'Select the command to copy it.') {
    feedbackClass = 'copy-feedback';
  }

  useEffect(() => {
    return () => clearTimeout(timer.current);
  }, []);

  async function copy() {
    clearTimeout(timer.current);

    try {
      await navigator.clipboard.writeText(installCommand);
      setStatus('Copied install command.');
      timer.current = setTimeout(() => setStatus(''), 2000);
    } catch {
      setStatus('Select the command to copy it.');

      const selection = window.getSelection();

      if (selection && code.current) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  return (
    <div className="install-command">
      <div className="command-field">
        <code ref={code}>{installCommand}</code>
        <button
          className="button primary copy-button"
          type="button"
          onClick={copy}
          aria-label="Copy install command"
        >
          {copied && 'Copied'}
          {!copied && 'Copy'}
        </button>
      </div>
      <p className={feedbackClass} role="status">
        {status}
      </p>
    </div>
  );
}
