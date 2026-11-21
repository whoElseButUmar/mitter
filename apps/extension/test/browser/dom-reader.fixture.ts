import { checkDisclosureRecovery } from './disclosure.fixture';
import { inspectEditedSource } from './sent-source.fixture';
import { inspectLongTranscript } from './long-transcript.fixture';
import { checkStaleDraftRecovery } from './stale-draft.fixture';
import { matchesReceipt, wrapMessage, messageDigest } from '../../../../packages/bridge/src/message-wire';
import { readReplyJSON } from '../../../../packages/protocol/src/reply-json';
import { PageBridgeError, PageTransport } from '../../../../packages/bridge/src/page-transport';
import type { ChatView } from '../../../../packages/bridge/src/chat-dom';
import {
  DOM_READER_URL,
  domReaderGateSchema,
  domReaderControlSchema,
  domReaderObservationSchema,
  domReaderReadResultSchema,
  type DomReaderObservation,
} from './dom-reader-contracts';
import {
  installDomReaderDigestGate,
  inspectDomReaderDigestGate,
  releaseDomReaderDigestGate,
} from './dom-reader-digest.fixture';
import { createDomReaderScenario, type DomReaderScenario } from './dom-reader-scenarios';
import { z } from 'zod';

const operationSchema = z.enum(['inspect', 'probe']).describe('A fixture-owned read-only page operation.');

type HeldRead = z.infer<typeof domReaderReadResultSchema>;

/** Owns only transport requests to the single offline reader-fixture tab. */
class DomReaderFixture {
  private testingStaleDraft = false;
  private tabId: number | undefined;
  private scenario: DomReaderScenario | undefined;
  private pendingRead: Promise<HeldRead> | undefined;
  private activeToken: string | undefined;
  private transport = new PageTransport(
    {
      checkAvailable: async (tabId) => {
        const tab = await chrome.tabs.get(tabId);
        const fixtureRoot = this.testingStaleDraft && tab.url === 'https://chatgpt.com/';
        if ((!fixtureRoot && tab.url !== DOM_READER_URL) || tab.discarded || tab.frozen) {
          throw new PageBridgeError('FIXTURE_UNAVAILABLE', 'The disposable reader tab changed.');
        }
      },
      send: (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      inject: async (tabId) => {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          files: ['mitter-page.js'],
        });
      },
    },
    () => {},
    6000,
  );

  async authorize(): Promise<boolean> {
    const origins = ['https://chatgpt.com/*'];
    const manifest = chrome.runtime.getManifest();
    if (!manifest.optional_host_permissions?.includes(origins[0] ?? '')) {
      throw new Error('The reader fixture requires the existing optional ChatGPT host permission.');
    }
    // The release driver approves this declared host through Chrome settings
    // first; request then activates the existing optional origin without a prompt.
    return chrome.permissions.request({ origins });
  }

  async connect(): Promise<void> {
    if (!(await chrome.permissions.contains({ origins: ['https://chatgpt.com/*'] }))) {
      throw new Error('Authorize only the existing ChatGPT permission in the disposable profile first.');
    }
    const tabs = (await chrome.tabs.query({ url: DOM_READER_URL })).filter(
      (tab) => tab.url === DOM_READER_URL,
    );
    const tab = tabs[0];
    if (tabs.length !== 1 || !tab || tab.id === undefined) {
      throw new Error('The reader fixture requires exactly one offline reader-fixture tab.');
    }
    this.tabId = tab.id;
    await this.transport.ensure(tab.id);
  }

  private connectedTab(): number {
    if (this.tabId === undefined) {
      throw new Error('Connect the disposable DOM-reader tab before reading it.');
    }
    return this.tabId;
  }

  private currentScenario(): DomReaderScenario {
    if (!this.scenario) {
      throw new Error('Prepare a DOM-reader scenario before reading it.');
    }
    return this.scenario;
  }

  async prepare(name: unknown) {
    if (this.pendingRead) {
      throw new Error('Release the current held inspection before replacing its scenario.');
    }
    const scenario = await createDomReaderScenario(name);
    this.scenario = scenario;
    return scenario.plan;
  }

  private async summarize(
    scenario: DomReaderScenario,
    operation: 'inspect' | 'probe',
    view: ChatView,
  ): Promise<DomReaderObservation> {
    const candidates = [view.lastUserText, ...(view.lastUserCandidates ?? [])];
    const receiptMatches = await Promise.all(
      candidates.map((candidate) => matchesReceipt(candidate, scenario.receipt)),
    );
    const receipt = view.transcript?.receiptDiscovery;
    let literalPayloadExact = false;
    if (['literal-fenced-roleless', 'literal-escaped-fence'].includes(scenario.name)) {
      try {
        literalPayloadExact =
          JSON.stringify(readReplyJSON(view.codeReply?.text ?? view.assistantText)) ===
          JSON.stringify(readReplyJSON(scenario.expectedReplyText));
      } catch {}
    }
    return domReaderObservationSchema.parse({
      scenario: scenario.name,
      operation,
      count: view.count,
      userCount: view.userCount,
      lastRole: view.lastRole,
      lastUserId: view.lastUserId ?? '',
      userIds: view.userIds ?? [],
      busy: view.busy,
      draft: view.draft,
      recoveryKind: view.replyRecovery?.kind ?? null,
      recoveryExact: view.replyRecovery?.responseText === scenario.expectedReplyText,
      recoveryUserExact: view.replyRecovery?.userText === scenario.expectedUserText,
      recoveryExchangeMatched: view.replyRecovery?.exchangeId === scenario.receipt.exchangeId,
      recoveryConflictPreserved:
        scenario.name === 'recovery-duplicate-known-conflicting' &&
        view.replyRecovery?.responseText.includes(scenario.expectedReplyText) === true &&
        view.replyRecovery.responseText.includes('reader_conflicting_reply'),
      literalPayloadExact,
      complete: view.complete,
      stopped: view.stopped,
      ready: view.ready === true,
      userExact: candidates.includes(scenario.expectedUserText),
      receiptMatched: receiptMatches.some(Boolean),
      assistantExact: view.assistantText === scenario.expectedReplyText,
      assistantCharacters: view.assistantText.length,
      assistantFormat: view.assistantFormat ?? null,
      assistantIssue: view.assistantReadIssue ?? null,
      codeReply: view.codeReply !== undefined,
      codeExact: view.codeReply?.text === scenario.expectedReplyText,
      copyControl: view.codeReply?.hasCopyControl === true,
      codeIssue: view.codeReplyIssue ?? null,
      receiptState: receipt?.state ?? null,
      receiptMatches: receipt?.matches ?? 0,
      responseControls: receipt?.responseControls ?? 0,
      tailBranches: receipt?.tailBranches ?? 0,
      unknownTurns: view.transcript?.unknownTurns ?? 0,
      unclassifiedTail: view.transcript?.unclassifiedTail === true,
      scanLimited: view.transcript?.scanLimited === true,
      transcriptUsers: view.transcript?.users ?? 0,
      transcriptAssistants: view.transcript?.assistants ?? 0,
      history: view.observedTaskTurns ?? [],
    });
  }

  async observe(rawOperation: unknown = 'inspect'): Promise<DomReaderObservation> {
    const operation = operationSchema.parse(rawOperation);
    const scenario = this.currentScenario();
    let token = scenario.request.token;
    if (operation === 'inspect') {
      this.activeToken = token;
    } else {
      token = 'reader-probe-' + crypto.randomUUID();
    }
    const view = await this.transport.request(this.connectedTab(), {
      ...scenario.request,
      op: operation,
      token,
    });
    return this.summarize(scenario, operation, view);
  }

  async startHeldInspection(): Promise<void> {
    if (this.pendingRead) {
      throw new Error('A DOM-reader inspection is already held.');
    }
    const tabId = this.connectedTab();
    const scenario = this.currentScenario();
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: installDomReaderDigestGate,
    });
    this.activeToken = scenario.request.token;
    this.pendingRead = this.transport
      .request(tabId, scenario.request)
      .then(async (view): Promise<HeldRead> => {
        const observation = await this.summarize(scenario, 'inspect', view);
        return domReaderReadResultSchema.parse({ ok: true, observation });
      })
      .catch((error: unknown): HeldRead => {
        if (error instanceof PageBridgeError) {
          return domReaderReadResultSchema.parse({ ok: false, code: error.code });
        }
        throw new Error('The held DOM-reader inspection failed outside the page transport.', {
          cause: error,
        });
      });
    // The driver collects the held result later. Observe a rejection now while
    // preserving it on pendingRead for finishHeldInspection and cleanup.
    void this.pendingRead.catch(() => {});
  }

  async gate() {
    const results = await chrome.scripting.executeScript({
      target: { tabId: this.connectedTab(), frameIds: [0] },
      world: 'ISOLATED',
      func: inspectDomReaderDigestGate,
    });
    const result = results[0];
    if (results.length !== 1 || result?.frameId !== 0) {
      throw new Error('The digest gate must run only in the isolated top frame.');
    }
    return domReaderGateSchema.parse(result.result);
  }

  async finishHeldInspection(): Promise<HeldRead> {
    const pending = this.pendingRead;
    if (!pending) {
      throw new Error('No DOM-reader inspection is held.');
    }
    try {
      await this.releaseGate();
      return domReaderReadResultSchema.parse(await pending);
    } finally {
      this.pendingRead = undefined;
    }
  }

  private async releaseGate(): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.connectedTab(), frameIds: [0] },
      world: 'ISOLATED',
      func: releaseDomReaderDigestGate,
    });
  }

  async stop(): Promise<void> {
    const scenario = this.currentScenario();
    await this.transport.request(this.connectedTab(), { ...scenario.request, op: 'stop' });
  }

  async replaceSession(): Promise<void> {
    const token = 'reader-replacement-' + crypto.randomUUID();
    await this.transport.request(this.connectedTab(), {
      op: 'inspect',
      token,
      url: DOM_READER_URL,
      expiresAt: Date.now() + 60000,
    });
    this.activeToken = token;
  }

  async control() {
    const token = this.activeToken;
    if (!token) {
      throw new Error('No fixture-owned session is available for the control check.');
    }
    const view = await this.transport.request(this.connectedTab(), {
      op: 'control',
      token,
      url: DOM_READER_URL,
      expiresAt: Date.now() + 60000,
    });
    return domReaderControlSchema.parse({ ready: view.ready, stopped: view.stopped });
  }

  async disclosureRecovery() {
    const scenario = await createDomReaderScenario('complete-roleless');
    return checkDisclosureRecovery(
      this.connectedTab(),
      this.transport,
      scenario.request,
      scenario.expectedUserText,
      scenario.expectedReplyText,
    );
  }

  async sentSourceRecovery() {
    return inspectEditedSource(this.connectedTab(), this.transport);
  }

  async longTranscript() {
    const scenario = await createDomReaderScenario('complete-roleless');
    const payload = 'A saved long project report with source bytes.\n'.repeat(2200);
    const text = wrapMessage(payload, scenario.receipt.exchangeId ?? 'a05c70de-2fa8-471d-82f0-df6cdf8b64b4');
    const hash = await messageDigest(text);
    const receipt = {
      ...scenario.receipt,
      textHash: hash,
      renderedHash: hash,
      payloadHash: await messageDigest(payload),
    };
    return inspectLongTranscript(
      this.connectedTab(),
      this.transport,
      { ...scenario.request, receipt },
      text,
      scenario.expectedReplyText,
    );
  }

  async staleDraftRecovery() {
    this.testingStaleDraft = true;
    try {
      return await checkStaleDraftRecovery(this.connectedTab(), this.transport);
    } finally {
      this.testingStaleDraft = false;
    }
  }

  async destroy(): Promise<void> {
    const tabId = this.tabId;
    if (tabId === undefined) {
      return;
    }
    try {
      try {
        await this.releaseGate();
      } finally {
        await this.pendingRead;
        this.pendingRead = undefined;
      }
      if (this.activeToken) {
        await this.transport.request(tabId, {
          op: 'stop',
          token: this.activeToken,
          url: DOM_READER_URL,
          expiresAt: Date.now() + 60000,
        });
      }
    } finally {
      this.transport.forget(tabId);
      this.pendingRead = undefined;
      this.tabId = undefined;
      this.scenario = undefined;
      this.activeToken = undefined;
    }
  }
}

export function createDomReaderFixture() {
  return new DomReaderFixture();
}
