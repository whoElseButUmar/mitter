/** Absolute read-only deadline after a receive failure. Polling and retry
 * backoff never renew this deadline. */
export const LATE_REPLY_WATCH_MS = 15 * 60_000;

export const recoverableReceiveErrors = new Set([
  'REPLY_DISAPPEARED',
  'REPLY_RECOVERY_EXHAUSTED',
  'SEND_UNCERTAIN_DRAFT',
  'REPLY_UNREADABLE',
  'REPLY_NOT_ADVANCING',
  'REPLY_LINK_MISSING',
  'REPLY_FORMAT',
  'USER_ECHO_UNREADABLE',
  'USER_TURN_UNCONFIRMED',
  'FIRST_SEND_UNCONFIRMED',
  'MESSAGE_COLLAPSED',
  'TRANSCRIPT_UNSUPPORTED',
  'BRIDGE_TIMEOUT',
  'BRIDGE_DISCONNECTED',
  'BRIDGE_INJECTION_FAILED',
  'BRIDGE_NAVIGATED',
  'INVALID_BRIDGE_REPLY',
  'INVALID_PAGE_STATE',
  'STALE_PAGE_READER',
  'TAB_FROZEN',
  'TAB_DISCARDED',
]);

/** Read scheduling and candidate stability only. This component has no page,
 * receipt, task, or execution authority; the coordinator owns those gates. */
export class LateReplyWatch {
  private polling = false;
  private watchReason = '';
  private candidate = '';
  private stableAt = 0;
  private pollAt = 0;
  private retryAt = 0;
  private failures = 0;
  private errorCode = '';

  get running(): boolean {
    return this.polling;
  }

  get reason(): string {
    return this.watchReason;
  }

  start(reason: string): void {
    this.watchReason =
      reason +
      ' Still watching this chat for a verified reply. Open chat to intervene, or use Resend prompt.';
    this.clearCandidate();
    this.pollAt = 0;
    this.retryAt = 0;
    this.failures = 0;
    this.errorCode = '';
  }

  canPoll(now: number): boolean {
    return now - this.pollAt >= 1500 && now >= this.retryAt;
  }

  beginPoll(now: number): void {
    this.polling = true;
    this.pollAt = now;
  }

  finishPoll(): void {
    this.polling = false;
  }

  clearCandidate(): void {
    this.candidate = '';
  }

  isStable(fingerprint: string, now: number, correction: boolean): boolean {
    if (this.candidate !== fingerprint) {
      this.candidate = fingerprint;
      this.stableAt = now;
      return false;
    }
    let stableWindowMs = 1800;
    if (correction) {
      stableWindowMs = 3000;
    }
    return now - this.stableAt >= stableWindowMs;
  }

  /** Return whether a reader failure has just cleared. */
  readSucceeded(): boolean {
    const reconnected = !!this.errorCode;
    this.errorCode = '';
    this.failures = 0;
    this.retryAt = 0;
    return reconnected;
  }

  /** A failed observation breaks stability, not the absolute watch deadline. */
  readFailed(errorCode: string, now: number): boolean {
    this.clearCandidate();
    this.stableAt = 0;
    this.failures = Math.min(this.failures + 1, 4);
    this.retryAt = now + Math.min(15000, 1500 * 2 ** this.failures);
    if (this.errorCode === errorCode) {
      return false;
    }
    this.errorCode = errorCode;
    return true;
  }
}
