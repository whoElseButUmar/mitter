import { registerHooks } from 'node:module';

// A query gives each simulated browser document a fresh module-local persistence gate.
// Delegate transformation to the repository's existing Rolldown source loader.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) {
      const parsed = new URL(url);

      if (parsed.pathname.endsWith('.ts') && parsed.search) {
        parsed.search = '';
        return nextLoad(parsed.href, context);
      }
    }

    return nextLoad(url, context);
  },
});
