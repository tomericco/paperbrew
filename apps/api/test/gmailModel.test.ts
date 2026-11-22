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
    vi.useFakeTimers();
    pipelineMock
      .mockReturnValueOnce(new Promise(() => {})) // never settles
      .mockResolvedValueOnce(async () => RESULT);
    const { zeroShot, LOAD_TIMEOUT_MS } = await freshModel();

    const hung = zeroShot('text', ['a', 'b']);
    const caught = hung.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1);
    expect(((await caught) as Error).message).toMatch(/timed out/i);

    await expect(zeroShot('text', ['a', 'b'])).resolves.toEqual(RESULT);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('does not reject a load that finishes in time, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    pipelineMock.mockResolvedValue(async () => RESULT);
    const { zeroShot } = await freshModel();
    await expect(zeroShot('text', ['a', 'b'])).resolves.toEqual(RESULT);
    expect(vi.getTimerCount()).toBe(0);
  });
});
