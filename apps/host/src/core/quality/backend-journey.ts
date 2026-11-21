import type { BrowserJourney } from './browser-contract.js';

/** Track server responses without keeping application payloads in reports. */
export class BackendActivity {
  private candidates = new Set<string>();
  private initialValues = new Set<string>();
  private entered = new Set<string>();
  private readAfterReload = new Set<string>();
  private wrote = false;
  private reloaded = false;
  verified = false;

  start(steps: BrowserJourney['steps'] = []): void {
    this.candidates = new Set(
      steps.flatMap((step) => {
        if (step.type === 'fill' && step.value.trim()) {
          return [step.value];
        }
        return [];
      }),
    );
    this.initialValues.clear();
    this.entered.clear();
    this.readAfterReload.clear();
    this.wrote = false;
    this.reloaded = false;
    this.verified = false;
  }

  readonly response = (method: string, _path: string, status: number, body: string): void => {
    if (status < 200 || status >= 300) {
      return;
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      this.wrote = true;
      this.reloaded = false;
      this.readAfterReload.clear();
      return;
    }
    if (method !== 'GET' || !body || !this.candidates.size) {
      return;
    }
    // Match JSON field values. A property name or a pre-existing record is not a saved field.
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      // Framework routes can return a successful status with malformed JSON.
      // Such a response cannot establish that a record was read from storage.
      return;
    }
    const pending: unknown[] = [value];
    while (pending.length) {
      const data = pending.pop();
      if (data && typeof data === 'object') {
        pending.push(...Object.values(data));
        continue;
      }
      for (const value of this.candidates) {
        if ((typeof data !== 'string' || !data.includes(value)) && data !== Number(value)) {
          continue;
        }
        if (!this.wrote) {
          this.initialValues.add(value);
        } else if (this.reloaded && this.entered.has(value) && !this.initialValues.has(value)) {
          this.readAfterReload.add(value);
        }
      }
    }
  };

  beginReload(): boolean {
    this.reloaded = this.wrote && this.entered.size > 0;
    this.readAfterReload.clear();
    return this.reloaded;
  }

  completed(step: BrowserJourney['steps'][number]): boolean {
    if (step.type === 'fill' && !this.reloaded) {
      this.entered.add(step.value);
    }
    if (step.type === 'expect' && step.visible !== false && step.count !== 0) {
      for (const value of this.readAfterReload) {
        if (step.text?.includes(value) || step.value === value) {
          this.verified = true;
          return true;
        }
      }
    }
    return false;
  }
}
