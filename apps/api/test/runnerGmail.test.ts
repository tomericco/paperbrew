import { beforeEach, describe, expect, it, vi } from 'vitest';

// runOne is exercised with a fake queue and a fake syncGmail: only the arguments matter here.
const claim = vi.fn();
const complete = vi.fn();
const fail = vi.fn();
const syncGmail = vi.fn();
const fetchStarterArticles = vi.fn();

vi.mock('../src/db/client.js', () => ({ pool: {} }));
vi.mock('../src/jobs/queue.js', () => ({ claim, complete, fail }));
vi.mock('../src/gmail/sync.js', () => ({ syncGmail }));
vi.mock('../src/gmail/starter.js', () => ({ fetchStarterArticles }));
vi.mock('../src/pipeline/processEmail.js', () => ({ processEmail: vi.fn() }));
vi.mock('../src/pipeline/fetchArticle.js', () => ({ fetchArticle: vi.fn() }));

const { runOne } = await import('../src/jobs/runner.js');

beforeEach(() => {
  vi.clearAllMocks();
  syncGmail.mockResolvedValue({ seen: 0, saved: 0 });
  fetchStarterArticles.mockResolvedValue({ scanned: 0, saved: 0 });
  fail.mockResolvedValue(false);
});

const job = (attempts: number) => ({ id: 'j1', type: 'gmail_sync', payload: { id: 'user-1' }, attempts, max_attempts: 5 });

describe('runOne gmail_sync', () => {
  it('is not the last attempt before max_attempts', async () => {
    claim.mockResolvedValue(job(4));
    await runOne();
    expect(syncGmail).toHaveBeenCalledWith('user-1', { lastAttempt: false });
  });

  it('is the last attempt when attempts reaches max_attempts', async () => {
    claim.mockResolvedValue(job(5));
    await runOne();
    expect(syncGmail).toHaveBeenCalledWith('user-1', { lastAttempt: true });
  });
});

describe('runOne gmail_starter', () => {
  const starterJob = (attempts: number) => ({ ...job(attempts), type: 'gmail_starter' });

  it('is not the last attempt before max_attempts', async () => {
    claim.mockResolvedValue(starterJob(1));
    await runOne();
    expect(fetchStarterArticles).toHaveBeenCalledWith('user-1', { lastAttempt: false });
    expect(syncGmail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalled();
  });

  it('is the last attempt when attempts reaches max_attempts', async () => {
    claim.mockResolvedValue(starterJob(5));
    await runOne();
    expect(fetchStarterArticles).toHaveBeenCalledWith('user-1', { lastAttempt: true });
  });
});
