import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusyError, createLimiter, onStreamEnd } from '../src/brew/lifecycle.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createLimiter(1)', () => {
  afterEach(() => vi.useRealTimers());

  it('runs two concurrent jobs one at a time, in arrival order', async () => {
    const slot = createLimiter(1);
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const gates: Array<() => void> = [];

    async function job(name: string) {
      const release = await slot.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await new Promise<void>((r) => gates.push(r));
      log.push(`end ${name}`);
      running--;
      release();
    }

    const a = job('a');
    const b = job('b');
    await tick();
    expect(log).toEqual(['start a']); // b is waiting
    gates.shift()!();
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    gates.shift()!();
    await Promise.all([a, b]);
    expect(maxRunning).toBe(1);
  });

  it('ignores a second release from the same holder', async () => {
    const slot = createLimiter(1);
    const release = await slot.acquire();
    release();
    release();
    const r1 = await slot.acquire();
    let second = false;
    void slot.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false); // the double release didn't free an extra slot
    r1();
    await tick();
    expect(second).toBe(true);
  });

  it('gives up with BusyError when the wait times out, and the slot still works afterwards', async () => {
    vi.useFakeTimers();
    const slot = createLimiter(1);
    const release = await slot.acquire();
    const waiter = slot.acquire(1_000);
    const assertion = expect(waiter).rejects.toBeInstanceOf(BusyError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    release();
    const again = await slot.acquire(10);
    again();
  });
});

function streamOf(chunks: number[][], failAfter?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]));
      else if (failAfter) controller.error(failAfter);
      else controller.close();
    },
  });
}

describe('onStreamEnd', () => {
  it('passes every byte through and calls done once when the stream ends', async () => {
    const done = vi.fn();
    const out = onStreamEnd(streamOf([[1, 2], [3]]), done);
    expect(done).not.toHaveBeenCalled();
    const bytes = new Uint8Array(await new Response(out).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('calls done once when the source errors, and passes the error on', async () => {
    const done = vi.fn();
    const out = onStreamEnd(streamOf([[1]], new Error('browser closed')), done);
    await expect(new Response(out).arrayBuffer()).rejects.toThrow('browser closed');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('calls done once when the consumer cancels (client hung up)', async () => {
    const done = vi.fn();
    const sourceCancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull: () => {}, cancel: sourceCancel });
    const out = onStreamEnd(source, done);
    await out.cancel('client aborted');
    expect(sourceCancel).toHaveBeenCalledWith('client aborted');
    expect(done).toHaveBeenCalledTimes(1);
  });
});
