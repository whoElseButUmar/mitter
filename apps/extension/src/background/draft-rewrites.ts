import type { z } from 'zod';
import { RewriteRunner, type RewriteResult } from '../../../../packages/bridge/src/rewrite-runner.js';
import type { PageTransport } from '../../../../packages/bridge/src/page-transport.js';
import {
  parseRewriteRequest,
  structureLocally,
  type RewriteRequest,
} from '../../../../packages/protocol/src/rewrite.js';
import { chatOrigins, waitFor } from './storage-reset.js';
import type { rewriteOperationResultSchema } from '../schemas/local-results.js';
import { identifierSchema } from '../schemas/primitives.js';

type RewriteOperationResult = z.infer<typeof rewriteOperationResultSchema>;

/** Composer-only jobs own their results and cleanup, never task or native-host authority. */
export class DraftRewrites {
  private jobs = new Map<string, RewriteRunner>();
  private starting = new Map<symbol, Promise<RewriteResult>>();
  private retiring = new Set<Promise<void>>();
  private startRevision = 0;
  private quiescing = 0;

  constructor(
    private page: PageTransport,
    private livenessChanged: () => Promise<void>,
  ) {}

  get activeTabIds(): number[] {
    return [...this.jobs.values()].filter((job) => job.result.state === 'waiting').map((job) => job.tabId);
  }

  get tabIds(): number[] {
    return [...this.jobs.values()].map((job) => job.tabId);
  }

  async start(rawRequest: unknown, consent: unknown): Promise<RewriteOperationResult> {
    const input = parseRewriteRequest(rawRequest);

    if (input.provider === 'local') {
      return {
        id: crypto.randomUUID(),
        state: 'done',
        text: structureLocally(input),
        provider: 'local',
      };
    }

    if (consent !== true) {
      throw new Error('Allow ChatGPT access before rewriting.');
    }

    const revision = this.startRevision;
    this.checkStart(revision);

    if (this.starting.size + this.activeTabIds.length >= 2) {
      throw new Error('Finish or cancel an existing rewrite first.');
    }

    const reservation = Symbol();
    // Register the slot before permission or tab APIs can yield or reenter admission.
    const starting = Promise.resolve().then(() => this.startRemote(input, revision, reservation));
    this.starting.set(reservation, starting);

    try {
      return await starting;
    } finally {
      this.starting.delete(reservation);
    }
  }

  private checkStart(revision: number): void {
    if (revision !== this.startRevision || this.quiescing > 0) {
      throw new Error('This rewrite start was cancelled. Your original draft is unchanged.');
    }
  }

  private async startRemote(
    input: RewriteRequest,
    revision: number,
    reservation: symbol,
  ): Promise<RewriteResult> {
    this.checkStart(revision);
    const granted = await chrome.permissions.contains({ origins: chatOrigins });
    this.checkStart(revision);

    if (!granted) {
      throw new Error('Allow ChatGPT access before rewriting.');
    }

    for (const [id, job] of this.jobs) {
      if (job.result.state !== 'waiting' && Date.now() - job.result.at > 300000) {
        this.jobs.delete(id);
      }
    }

    const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
    this.checkStart(revision);

    if (tab.id === undefined) {
      throw new Error('Chrome could not open a rewrite chat.');
    }

    const job = new RewriteRunner(crypto.randomUUID(), tab.id, input, (tabId, request) =>
      this.page.request(tabId, request),
    );
    this.starting.delete(reservation);
    this.jobs.set(job.id, job);
    void this.livenessChanged().catch(() => {});
    void job
      .run()
      .finally(this.livenessChanged)
      .catch(() => {});

    return { ...job.result };
  }

  private job(id: unknown): RewriteRunner {
    const job = this.jobs.get(identifierSchema.parse(id));

    if (!job) {
      throw new Error('This rewrite expired. Your original draft is unchanged.');
    }

    return job;
  }

  read(id: unknown): RewriteResult {
    return { ...this.job(id).result };
  }

  cancel(id: unknown): RewriteResult {
    const job = this.job(id);

    if (job.result.state === 'waiting') {
      job.cancel();
      void this.livenessChanged().catch(() => {});
    }

    return { ...job.result };
  }

  cancelAll(): void {
    this.startRevision++;
    let cancelled = false;

    for (const job of this.jobs.values()) {
      if (job.result.state === 'waiting') {
        job.cancel();
        cancelled = true;
      }
    }

    if (cancelled) {
      void this.livenessChanged().catch(() => {});
    }
  }

  async quiesce(): Promise<void> {
    this.startRevision++;
    this.quiescing++;

    try {
      await waitFor(
        Promise.all([
          Promise.allSettled([...this.starting.values()]),
          Promise.all([...this.jobs.values()].map((job) => job.settled())),
          Promise.all([...this.retiring]),
        ]),
        'Rewrite jobs',
        45000,
      );
    } finally {
      this.quiescing--;
    }
  }

  clear(): void {
    this.cancelAll();

    for (const job of this.jobs.values()) {
      const settled = job.settled();
      this.retiring.add(settled);
      void settled.finally(() => this.retiring.delete(settled)).catch(() => {});
    }

    this.jobs.clear();
    // Retired Chrome calls stay tracked until they settle, so reset cannot forget an in-flight admission.
  }
}
