type FrameScheduler = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
};

export function createAnimationFrames(
  scheduler: FrameScheduler = {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (id) => window.cancelAnimationFrame(id),
  },
) {
  const pending = new Set<number>();

  let disposed = false;

  const schedule = (callback: () => void) => {
    if (disposed) {
      return;
    }

    const id = scheduler.request(() => {
      pending.delete(id);
      if (!disposed) {
        callback();
      }
    });

    pending.add(id);
  };

  const dispose = () => {
    disposed = true;
    for (const id of pending) {
      scheduler.cancel(id);
    }

    pending.clear();
  };

  return { schedule, dispose };
}
