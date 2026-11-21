export function connectionHelp(error: string) {
  if (/background did not answer the workspace check/i.test(error)) {
    return {
      title: 'Reconnect the extension',
      detail:
        'The workspace could not confirm its connection to Miter’s background. Try Reconnect. If it still fails, reload Miter in Chrome’s extensions page.',
      action: 'retry',
      label: 'Reconnect',
    };
  }

  if (/not found|not registered|native host.*missing/i.test(error)) {
    return {
      title: 'Install the local helper',
      detail: 'Open Install Miter.command from your installer, then check the connection here.',
      action: 'install',
      label: 'Check connection',
    };
  }

  if (/version|matching local host|reload miter after setup/i.test(error)) {
    return {
      title: 'Finish updating Miter',
      detail: 'Reload the extension to finish the update. Your saved projects and tasks are kept.',
      action: 'reload',
      label: 'Reload extension',
    };
  }

  if (/forbidden|not allowed|access.*denied/i.test(error)) {
    return {
      title: 'Repair the browser connection',
      detail: 'Chrome could not open the registered helper. Run the Miter installer again, then reconnect.',
      action: 'install',
      label: 'Check connection',
    };
  }

  if (error) {
    return {
      title: 'Reconnect the local helper',
      detail:
        'Miter cannot reach its local helper. Reconnect first; if it keeps failing, run the installer again.',
      action: 'retry',
      label: 'Reconnect',
    };
  }

  return {
    title: 'Connecting to Miter',
    detail: 'Waiting for the local helper. Your saved projects will appear when it connects.',
    action: 'wait',
    label: '',
  };
}
