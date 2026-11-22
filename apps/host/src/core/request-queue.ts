/** Bounded inbound scheduling. Ordinary RPCs remain FIFO. Cancellation has a
 * separate lane so blocked reads or folder dialogs cannot prevent Stop. There
 * are no automatic retries: rejected requests were not executed. */

export class RequestQueue {
  private normal: (() => Promise<void>)[] = [];
  private running = false;
  private controls = 0;
  private dialogs = 0;
  private terminals = 0;
  private appStarts = 0;
  private closed = false;

  constructor(
    private onError: (error: unknown) => void,
    private limit = 64,
    private controlLimit = 8,
  ) {}

  submit(method: string, execute: () => Promise<void>): boolean {
    if (this.closed) {
      return false;
    }

    if (
      [
        'worker.stop',
        'worker.pause',
        'worker.cancel',
        'worker.steer',
        'worker.steerValidate',
        'worker.previewStop',
        'worker.cancelPick',
        'workflow.cancel',
      ].includes(method)
    ) {
      if (this.controls >= this.controlLimit) {
        return false;
      }
      this.controls++;
      void this.run(execute).finally(() => this.controls--);
    } else if (
      ['worker.previewStart', 'worker.pickElement', 'workflow.record', 'workflow.replay'].includes(method)
    ) {
      // pnpm may take minutes. Keep project operations and its terminal usable during setup.
      if (this.appStarts >= 4) {
        return false;
      }
      this.appStarts++;
      void this.run(execute).finally(() => this.appStarts--);
    } else if (
      method.startsWith('terminal.') ||
      method === 'project.appRuns' ||
      method === 'worker.previewStatus'
    ) {
      if (this.terminals >= 24) {
        return false;
      }
      this.terminals++;
      void this.run(execute).finally(() => this.terminals--);
    } else if (method === 'project.pickFolder' || method === 'settings.pickModel') {
      // One native chooser at a time; a chooser never consumes the Stop lane.
      if (this.dialogs) {
        return false;
      }
      this.dialogs++;
      void this.run(execute).finally(() => this.dialogs--);
    } else {
      let occupied = this.normal.length;

      if (this.running) {
        occupied++;
      }

      if (occupied >= this.limit) {
        return false;
      }
      this.normal.push(execute);
      void this.flush();
    }

    return true;
  }

  async whenIdle(timeoutMs = 135000): Promise<void> {
    const until = Date.now() + timeoutMs;

    while (
      this.running ||
      this.normal.length ||
      this.controls ||
      this.dialogs ||
      this.terminals ||
      this.appStarts
    ) {
      if (Date.now() >= until) {
        throw Error(
          'Host requests did not stop. Close any folder chooser and retry; state ' + 'was not deleted.',
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.closed = true;
    this.normal = [];
  }

  private async run(execute: () => Promise<void>): Promise<void> {
    try {
      await execute();
    } catch (error) {
      this.onError(error);
    }
  }

  private async flush(): Promise<void> {
    if (this.running || this.closed) {
      return;
    }
    this.running = true;

    try {
      while (this.normal.length && !this.closed) {
        const execute = this.normal.shift();

        if (!execute) {
          break;
        }

        await this.run(execute);
      }
    } finally {
      this.running = false;
    }
  }
}
