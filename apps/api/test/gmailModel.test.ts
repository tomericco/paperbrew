import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
