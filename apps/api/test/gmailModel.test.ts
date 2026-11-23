import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineMock = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

const RESULT = { labels: ['b', 'a'], scores: [0.9, 0.1] };

async function freshModel() {
  vi.resetModules(); // drop the cached classifier promise between cases
  return import('../src/gmail/model.js');
}

describe('zeroShot loader', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries the build after a failed load', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('download failed'))
      .mockResolvedValueOnce(async () => RESULT);
    const { zeroShot } = await freshModel();

    await expect(zeroShot('text', ['a', 'b'])).rejects.toThrow('download failed');
    await expect(zeroShot('text', ['a', 'b'])).resolves.toEqual(RESULT);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('shares one build between concurrent calls and later ones', async () => {
    pipelineMock.mockResolvedValue(async () => RESULT);
    const { zeroShot } = await freshModel();

    const [x, y] = await Promise.all([zeroShot('one', ['a', 'b']), zeroShot('two', ['a', 'b'])]);
    await zeroShot('three', ['a', 'b']);

    expect(x).toEqual(RESULT);
    expect(y).toEqual(RESULT);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('pins the model to a fixed revision', async () => {
    pipelineMock.mockResolvedValue(async () => RESULT);
    const { zeroShot, MODEL_ID, MODEL_REVISION } = await freshModel();
    await zeroShot('text', ['a', 'b']);
    expect(MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(pipelineMock).toHaveBeenCalledWith('zero-shot-classification', MODEL_ID, {
      dtype: 'q8',
      revision: MODEL_REVISION,
    });
  });

  it('rejects when the download hangs, then rebuilds on the next call', async () => {
    // Only the timeout timers are fake: real setImmediate lets the test wait for the real async import.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Keyed by call count, so the first build hangs and the second succeeds whatever the interleaving.
    pipelineMock.mockImplementation((() => {
      let calls = 0;
      return () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve(async () => RESULT));
    })());
    const { zeroShot, LOAD_TIMEOUT_MS } = await freshModel();

    const caught = zeroShot('text', ['a', 'b']).catch((e: Error) => e);
    // The first build must be inside pipeline() (past its dynamic import) before time moves on.
    // Bounded by real time (Date is not faked), not by a loop count, so a loaded machine cannot cut it short.
    for (const deadline = Date.now() + 20_000; pipelineMock.mock.calls.length < 1 && Date.now() < deadline; ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1);
    expect(((await caught) as Error).message).toMatch(/timed out/i);
    expect(vi.getTimerCount()).toBe(0);

    await expect(zeroShot('text', ['a', 'b'])).resolves.toEqual(RESULT);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);

  it('does not reject a load that finishes in time, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    pipelineMock.mockResolvedValue(async () => RESULT);
    const { zeroShot } = await freshModel();
    await expect(zeroShot('text', ['a', 'b'])).resolves.toEqual(RESULT);
    expect(vi.getTimerCount()).toBe(0);
  });
});
