import { createHash } from 'node:crypto';
import { z } from 'zod';
import { existing, fileText, listFiles } from '../workspace.js';
import { checkJavaScript } from '../syntax-check.js';
import type { CheckResult } from '../service/schemas.js';
import { inspectWebApp, qualityTestPathSchema, webAppQualityManifestSchema } from './inspect.js';
import { runQualityTests } from './runner.js';
import { snapshotApp, staticPreviewFingerprint } from '../preview/snapshot.js';
import { detectDevProject, devProjectFingerprint } from '../dev-server/index.js';
import { browserRepairFindings } from './browser-findings.js';
import type { runBrowserQuality as BrowserRunner } from './browser-runtime.js';

const SOURCE_PATH = /\.(?:html?|css|[cm]?js|[jt]sx?|json)$/i;
const MAX_FILES = 256;
const MAX_BYTES = 4 * 1024 * 1024;

const runBrowserQuality: typeof BrowserRunner = async (request) => {
  const runtime = await import('./browser-runtime.js');
  return runtime.runBrowserQuality(request);
};

type QualityRequest = {
  root: string;
  dataDir: string;
  changedPaths: readonly string[];
  commandsRan: boolean;
  verifyExistingWebApp?: boolean;
  skillsRead: readonly string[];
  copyInstructions?: readonly string[];
  signal: AbortSignal;
  beforeTests: (scope: 'node' | 'web') => void;
};

const emptyDependencies = z.strictObject({}).optional().describe('Empty or absent npm dependency table.');
const dependencyFreePackage = z
  .object({
    dependencies: emptyDependencies,
    devDependencies: emptyDependencies,
    peerDependencies: emptyDependencies,
    optionalDependencies: emptyDependencies,
    workspaces: z.never().optional().describe('Workspace installs are outside the isolated Node check.'),
  })
  .describe('A single Node package whose tests need no installed dependencies.');

function webEntry(relative: string): boolean {
  return /\.html?$/i.test(relative) || relative === 'miter.quality.json';
}

/** Only a user's app-scoped request can opt an unchanged project into the web
 * gates. Model summaries, project source and standing conventions are not task intent. */
export function requestsWebVerification(instruction: string, projectName: string): boolean {
  const name = projectName.toLowerCase().replace(/[-_]+/g, ' ').trim();
  const sourceReviewOnly =
    /\b(?:source[- ]only|static) (?:code )?review\b/i.test(instruction) ||
    /\b(?:do not|don't|never) (?:write files or )?run commands\b/i.test(instruction);
  const clauses = instruction.toLowerCase().split(/[,;.!?\n]+|\s+(?:and(?: then)?|then)\s+/);
  for (const clause of clauses) {
    const action =
      /^\s*(?:(?:please|can you|could you|i want you to|also)\s+)*((?:re)?(?:check|test|audit)|verify|validate|exercise|review|repair|fix|debug|make sure|run(?: the)?(?: quality)? (?:checks|tests|audits|lighthouse))\b(.*)/.exec(
        clause,
      );
    if (!action) {
      continue;
    }
    if (sourceReviewOnly && action[1] === 'review') {
      continue;
    }
    const target = action[2]?.trim() ?? '';
    if (
      /^(?:(?:the|our|its|this|my|a)\s+)*(?:readme|documentation|docs?|comments?|instructions?|installation guide)\b/.test(
        target,
      )
    ) {
      continue;
    }
    if (
      /\brun(?: the)?(?: quality)? (?:checks|tests|audits|lighthouse)\b/.test(action[0]) ||
      /\b(?:apps?|application|sites?|websites?|pages?|project|ui|interface|accessibility|lighthouse|browser|filters?|forms?|buttons?|controls?|layouts?|empty[- ]states?|copy|workflows?|journeys?|keyboard|preview|frontend|dashboard)\b/.test(
        target,
      ) ||
      /^(?:it|this|everything)(?:\s+(?:again|works|runs|end[- ]to[- ]end))?$/.test(target) ||
      (name && (' ' + target.replace(/[-_]+/g, ' ') + ' ').includes(' ' + name + ' '))
    ) {
      return true;
    }
  }
  return false;
}

async function sourcePaths(
  root: string,
  nodeTests: readonly string[],
  framework?: 'vite' | 'next',
): Promise<string[]> {
  let omission: string | undefined;
  const listed = await listFiles(root, '.', 1001, (reason) => {
    omission ??= reason;
  });
  if (listed.length > 1000) {
    throw new Error('The automatic quality scan supports up to 1000 project files. No partial scan passed.');
  }
  let paths: string[];
  if (framework || listed.some(webEntry)) {
    paths = listed.filter((relative) => SOURCE_PATH.test(relative));
  } else {
    if (
      !nodeTests.length ||
      listed.includes('pnpm-workspace.yaml') ||
      listed.some((relative) => relative.endsWith('/package.json'))
    ) {
      return [];
    }
    if (listed.includes('package.json')) {
      const manifest = await fileText(root, 'package.json');
      let packageInfo: unknown;
      try {
        packageInfo = JSON.parse(manifest.content);
      } catch {
        return [];
      }
      if (!dependencyFreePackage.safeParse(packageInfo).success) {
        return [];
      }
    }
    // Include fixtures as well as modules. A partial file list can change a test's behavior.
    if (omission) {
      throw new Error(omission);
    }
    paths = listed.filter((relative) => relative !== '.DS_Store' && !relative.endsWith('/.DS_Store'));
    if (nodeTests.some((test) => !paths.includes(test))) {
      throw new Error('A task-written Node test is missing from the source snapshot. No tests passed.');
    }
  }
  if (paths.length > MAX_FILES) {
    throw new Error('The automatic quality scan supports up to 256 source files. No partial scan passed.');
  }
  return paths.sort();
}

type SourceFile = { path: string; content: string; hash: string };

async function checkSnapshot(
  request: QualityRequest,
  files: readonly SourceFile[],
  nodeTests: readonly string[],
  testCount: number,
  assetsHash?: string,
  hasBackend = false,
  framework?: 'vite' | 'next',
): Promise<CheckResult> {
  const paths = await sourcePaths(request.root, nodeTests, framework);
  const fingerprint = createHash('sha256');
  let unchanged = paths.length === files.length;
  for (const [index, file] of files.entries()) {
    request.signal.throwIfAborted();
    fingerprint.update(JSON.stringify([file.path, file.hash]));
    if (paths[index] !== file.path || (await existing(request.root, file.path)).hash !== file.hash) {
      unchanged = false;
      break;
    }
  }
  let detail = 'Source changed during verification. Finish again to check the current files.';
  if (unchanged) {
    detail =
      `Verified source snapshot SHA-256: ${fingerprint.digest('hex')}; ${files.length} files; ` +
      `${testCount} passing tests.`;
    if (assetsHash) {
      detail += ` Browser asset SHA-256: ${assetsHash}.`;
      if (framework) {
        detail +=
          ' The fingerprint covers the project used for live framework journeys and the production build.';
      } else if (hasBackend) {
        detail += ' The fingerprint covers the backend entry, its modules and the public browser assets.';
      } else {
        detail += ' Browser results cover the static snapshot.';
      }
    }
  }
  return { check: { type: 'quality', name: 'snapshot' }, ok: unchanged, detail };
}

export async function verifyProjectQuality(
  request: QualityRequest,
  browserRunner = runBrowserQuality,
): Promise<CheckResult[]> {
  const { root, signal } = request;
  if (!request.verifyExistingWebApp && !request.commandsRan && request.changedPaths.length === 0) {
    return [];
  }

  const nodeTests = [
    ...new Set(request.changedPaths.filter((relative) => qualityTestPathSchema.safeParse(relative).success)),
  ].sort();
  let framework: 'vite' | 'next' | undefined;
  let frameworkFingerprint: string | undefined;
  try {
    framework = await detectDevProject(root);
    if (framework) {
      frameworkFingerprint = await devProjectFingerprint(root, signal);
    }
  } catch (error) {
    signal.throwIfAborted();
    let detail = 'Could not read the framework project for verification.';
    if (error instanceof Error) {
      detail = error.message.slice(0, 4000);
    }
    return [{ check: { type: 'quality', name: 'browser' }, ok: false, detail }];
  }
  const paths = await sourcePaths(root, nodeTests, framework);
  if (paths.length === 0) {
    return [];
  }
  const files: SourceFile[] = [];
  let totalBytes = 0;
  for (const relative of paths) {
    signal.throwIfAborted();
    const source = await fileText(root, relative);
    totalBytes += Buffer.byteLength(source.content, 'utf8');
    if (totalBytes > MAX_BYTES) {
      throw new Error('The automatic quality scan supports up to 4 MiB of source. No partial scan passed.');
    }
    files.push({ path: relative, ...source });
  }

  let changedPaths = [...new Set(request.changedPaths)];
  if (request.commandsRan || request.verifyExistingWebApp) {
    // An explicit web audit covers the existing project. Registered commands
    // can also generate files beyond the edit journal.
    changedPaths = paths;
  }
  const sources = files.map(({ path, content }) => ({ path, content }));
  if (!framework && !paths.some(webEntry)) {
    signal.throwIfAborted();
    request.beforeTests('node');
    const tested = await runQualityTests({
      files: sources,
      tests: nodeTests,
      dataDir: request.dataDir,
      signal,
    });
    signal.throwIfAborted();
    const results: CheckResult[] = [
      {
        check: { type: 'quality', name: 'tests' },
        ok: tested.ok,
        detail: 'Task-written Node tests: ' + nodeTests.join(', ') + '\n' + tested.detail,
      },
    ];
    if (tested.ok) {
      results.push(await checkSnapshot(request, files, nodeTests, tested.testCount));
    }
    return results;
  }
  const inspection = inspectWebApp(sources, changedPaths, framework);
  if (!inspection.applicable) {
    return [];
  }

  const missing = ['app-design', 'engineering-quality'].filter((name) => !request.skillsRead.includes(name));
  let skillDetail = 'Both implementation skills were read in this run.';
  if (missing.length > 0) {
    skillDetail = 'Read these bundled skills before finishing: ' + missing.join(', ') + '.';
  }
  const results: CheckResult[] = [
    {
      check: { type: 'quality', name: 'skills' },
      ok: missing.length === 0,
      detail:
        'Fresh task prompts include Caveman and No AI Slop. Ponytail applies to coding work. ' + skillDetail,
    },
    {
      check: { type: 'quality', name: 'components' },
      ok: inspection.issues.length === 0,
      ...(inspection.issues[0] && {
        finding: inspection.issues[0].path + ': ' + inspection.issues[0].message,
      }),
      detail: JSON.stringify({
        scope:
          'Source baseline: linked components, picker/dialog rules and themed scroll/focus styles. ' +
          'This does not test rendered behavior or guarantee design quality.',
        issues: inspection.issues,
      }),
    },
  ];
  if (results.some((result) => !result.ok)) {
    return results;
  }

  const syntaxFailures: string[] = [];
  for (const file of files.filter((candidate) => /\.[cm]?js$/.test(candidate.path))) {
    // Next compiles JSX in .js pages and components as part of the production build.
    if (framework === 'next' && file.path.endsWith('.js')) {
      continue;
    }
    const syntax = await checkJavaScript(root, file.path, request.dataDir, signal);
    if (!syntax.ok || syntax.hash !== file.hash) {
      syntaxFailures.push(file.path + ': ' + syntax.details.slice(0, 1000));
    }
  }
  results.push({
    check: { type: 'quality', name: 'syntax' },
    ok: syntaxFailures.length === 0,
    detail: syntaxFailures.join('\n').slice(0, 8000) || 'JavaScript sources parsed without execution.',
  });
  if (syntaxFailures.length > 0) {
    return results;
  }

  signal.throwIfAborted();
  request.beforeTests('web');
  const tested = await runQualityTests({
    files: sources,
    tests: inspection.tests,
    dataDir: request.dataDir,
    signal,
  });
  signal.throwIfAborted();
  results.push({
    check: { type: 'quality', name: 'tests' },
    ok: tested.ok,
    detail: tested.detail,
  });
  if (!tested.ok) {
    return results;
  }

  const manifestFile = files.find((file) => file.path === 'miter.quality.json');
  const manifest = webAppQualityManifestSchema.parse(JSON.parse(manifestFile?.content ?? '{}'));
  let assetsHash: string;
  let hasBackend = false;
  try {
    const browserInputs = {
      entry: manifest.entry,
      copyInstructions: request.copyInstructions ?? [],
      journeys: manifest.journeys,
      signal,
      dataDir: request.dataDir,
    };
    let browser;
    if (framework && frameworkFingerprint) {
      assetsHash = frameworkFingerprint;
      hasBackend = paths.includes('miter.backend.json');
      browser = await browserRunner({
        ...browserInputs,
        devProject: { root, framework, fingerprint: frameworkFingerprint, hasBackend },
      });
    } else {
      const snapshot = await snapshotApp(root, signal, manifest.entry);
      hasBackend = Boolean(snapshot.backend);
      assetsHash = staticPreviewFingerprint(snapshot);
      signal.throwIfAborted();
      browser = await browserRunner({ ...browserInputs, snapshot });
    }
    signal.throwIfAborted();
    const backendVerified =
      !hasBackend ||
      ['desktop', 'mobile'].every((device) =>
        browser.backend?.some(
          (item) => item.device === device && manifest.journeys.some(({ name }) => name === item.journey),
        ),
      );
    const findings = [...browser.findings];
    if (!backendVerified && browser.browserOk) {
      findings.push('Browser checks did not verify backend persistence on both desktop and mobile.');
    }
    let scope =
      'Isolated local Chrome snapshot, desktop and mobile. All default scored categories. Repair failures and finish again; never hide features or weaken checks to raise scores.';
    if (framework) {
      scope =
        'Production framework build in isolated Chrome on desktop and mobile. Live development server journeys are recorded separately. All default scored categories.';
    }
    const browserFindings = browserRepairFindings(
      findings.filter((finding) => !finding.includes(' Lighthouse: ')),
      manifest.journeys,
    );
    results.push({
      check: { type: 'quality', name: 'browser' },
      ok: browser.browserOk && backendVerified,
      ...(browserFindings.summary && { finding: browserFindings.summary }),
      detail: JSON.stringify({
        ...(framework && browser.browserOk && { devServer: framework, devServerFingerprint: assetsHash }),
        ...(!framework &&
          browser.browserOk && { staticPreview: { entry: manifest.entry, fingerprint: assetsHash } }),
        ...(hasBackend && { backend: browser.backend ?? [] }),
        findings: browserFindings.details,
        reports: browser.reports.slice(0, 12),
      }),
    });
    if (!browser.browserOk && browser.scores.length === 0) {
      return results;
    }
    const lighthouseFindings = browser.findings
      .filter((finding) => finding.includes(' Lighthouse: '))
      .slice(0, 12)
      .map((finding) => finding.slice(0, 700));
    results.push({
      check: { type: 'quality', name: 'lighthouse' },
      ok: browser.lighthouseOk,
      ...(lighthouseFindings.length > 0 && { finding: lighthouseFindings.slice(0, 2).join(' · ') }),
      detail: JSON.stringify({
        target: 100,
        scores: browser.scores,
        ...(browser.lighthouseRetries && { retries: browser.lighthouseRetries }),
        reports: browser.reports.filter((file) =>
          /lighthouse-(?:desktop|mobile)(?:-attempt-1)?\.(?:json|html)$/.test(file),
        ),
        findings: lighthouseFindings,
        scope,
      }),
    });
    let currentHash: string;
    if (framework) {
      currentHash = await devProjectFingerprint(root, signal);
    } else {
      currentHash = staticPreviewFingerprint(await snapshotApp(root, signal, manifest.entry));
    }
    if (currentHash !== assetsHash) {
      results.push({
        check: { type: 'quality', name: 'snapshot' },
        ok: false,
        detail: 'Linked browser assets changed during verification. Finish again to check the current app.',
      });
      return results;
    }
  } catch (error) {
    signal.throwIfAborted();
    let detail = 'Browser verification failed. No browser evidence passed.';
    if (error instanceof Error) {
      detail = error.message.slice(0, 4000);
    }
    results.push({
      check: { type: 'quality', name: 'browser' },
      ok: false,
      detail,
    });
    return results;
  }

  results.push(
    await checkSnapshot(request, files, nodeTests, tested.testCount, assetsHash, hasBackend, framework),
  );
  return results;
}
