import { afterEach, describe, expect, it, vi } from 'vitest';

// runner.ts imports the DB pool, which reads config at import time. Nothing connects in these tests.
vi.mock('../src/config.js', () => ({
  config: {
    DATABASE_URL: 'postgres://localhost:5432/test',
    INBOUND_DOMAIN: 'save.example.com',
    FETCH_TIMEOUT_MS: 1000,
    FETCH_MAX_BYTES: 1000,
  },
}));

const { drain } = await import('../src/jobs/runner.js');

afterEach(() => {
  vi.useRealTimers();
});

describe('drain', () => {
  it('stops when no job is due', async () => {
    let left = 5;
    const runOne = vi.fn(async () => left-- > 0);
    const ran = await drain({ budgetMs: 60_000, concurrency: 3, runOne });
    expect(ran).toBe(5);
    expect(runOne).toHaveBeenCalledTimes(8); // 5 jobs + one empty claim per lane
  });

  it('stops at the time budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Every job takes 10 ms of (fake) time and the queue never empties.
    const runOne = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 10);
      return true;
    });
    const ran = await drain({ budgetMs: 100, concurrency: 2, runOne });
    expect(ran).toBe(10);
  });

  it('rejects with a lane error after the other lanes stop', async () => {
    let calls = 0;
    const runOne = async () => {
      calls++;
      if (calls === 1) throw new Error('db down');
      return false;
    };
    await expect(drain({ budgetMs: 1000, concurrency: 2, runOne })).rejects.toThrow('db down');
  });
});
