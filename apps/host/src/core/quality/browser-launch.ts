import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

export function browserNetworkArguments(origin: string): string[] {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    !/^miter-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
    !url.port
  ) {
    throw new Error('Browser checks require one exact owned preview origin.');
  }
  return [
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;' + url.host,
    '--host-resolver-rules=MAP ' + url.hostname + ' 127.0.0.1, MAP * ~NOTFOUND',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ];
}

function browserEnvironment(directory: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(PATH|LANG|LC_[A-Z_]+|TZ)$/i.test(key)) {
      environment[key] = value;
    }
  }
  const home = path.join(directory, 'home');
  const temporary = path.join(directory, 'tmp');
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
}

export function killBrowser(browser: Browser | undefined): void {
  const child = browser?.process();
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) {
    return;
  }
  const timer = setTimeout(() => killBrowser(browser), 1500);
  try {
    await browser.close();
  } finally {
    clearTimeout(timer);
    killBrowser(browser);
  }
}

export function launchPreviewBrowser(
  executablePath: string,
  temporary: string,
  url: string,
  headless = true,
) {
  return puppeteer.launch({
    executablePath,
    headless,
    ignoreDefaultArgs: ['--disable-popup-blocking'],
    pipe: true,
    userDataDir: path.join(temporary, 'profile'),
    env: browserEnvironment(temporary),
    timeout: 20_000,
    protocolTimeout: 30_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-breakpad',
      '--use-mock-keychain',
      '--password-store=basic',
      ...browserNetworkArguments(new URL(url).origin),
    ],
  });
}
