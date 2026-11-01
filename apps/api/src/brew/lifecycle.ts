// Small, pure helpers that keep one Chromium per instance and close it when its PDF stream ends.

/** Thrown by `acquire` when no slot frees up in time. */
export class BusyError extends Error {
  constructor() {
    super('busy');
    this.name = 'BusyError';
  }
}

export interface Limiter {
  /** Resolves with a `release` function once a slot is free; rejects with BusyError after `timeoutMs`. */
  acquire(timeoutMs?: number): Promise<() => void>;
}

/** An in-process semaphore: at most `size` holders at once, the rest wait in arrival order. */
export function createLimiter(size: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  function handBack() {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else active--;
  }

  function releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      handBack();
    };
  }

  return {
    acquire(timeoutMs) {
      if (active < size) {
        active++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const grant = () => {
          clearTimeout(timer);
          resolve(releaser());
        };
        waiting.push(grant);
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            const i = waiting.indexOf(grant);
            if (i >= 0) waiting.splice(i, 1);
            reject(new BusyError());
          }, timeoutMs);
        }
      });
    },
  };
}

/**
 * Passes `source` through unchanged and calls `done` exactly once: when it ends, when it errors,
 * or when the consumer cancels (e.g. the client hung up).
 */
export function onStreamEnd<T>(source: ReadableStream<T>, done: () => Promise<void> | void): ReadableStream<T> {
  const reader = source.getReader();
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await done();
  };
  return new ReadableStream<T>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<T>;
        try {
          chunk = await reader.read();
        } catch (err) {
          controller.error(err);
          await finish();
          return;
        }
        if (chunk.done) {
          controller.close();
          await finish();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        await finish();
      },
    },
    { highWaterMark: 0 },
  );
}
