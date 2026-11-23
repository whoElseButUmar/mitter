const repository = 'https://github.com/whoElseButUmar/mitter';
const source = repository + '/blob/main/';

export const links = {
  home: import.meta.env.BASE_URL,
  docs: import.meta.env.BASE_URL + 'docs/',
  install: import.meta.env.BASE_URL + 'install/',
  repository,
  releases: repository + '/releases',
  installGuide: source + 'scripts/installation/README.md',
  terminal: source + 'apps/host/src/cli/README.md',
  checks: source + 'apps/host/src/core/quality/README.md',
  protocol: source + 'packages/protocol/README.md',
  issues: repository + '/issues',
};

export const installCommand = 'npx miter-install@latest';
export const extensionPath = '~/Library/Application Support/Miter/extension';
export const requirements = 'Apple silicon Mac · Chrome · Node.js 22+';
