import { pool } from '../db/client.js';
import { claim, complete, fail } from './queue.js';
import { processEmail } from '../pipeline/processEmail.js';
import { fetchArticle } from '../pipeline/fetchArticle.js';
import { FetchError } from '../fetch/safeFetch.js';

/** Claim and run one due job. Returns false when no job is due. */
export async function runOne(): Promise<boolean> {
  const job = await claim(pool);
  if (!job) return false;
  try {
    if (job.type === 'process_email') await processEmail(job.payload.id);
    else if (job.type === 'fetch_article') await fetchArticle(job.payload.id, job.attempts >= job.max_attempts);
    else throw new Error(`Unknown job type ${job.type}`);
    await complete(pool, job.id);
  } catch (err) {
    const retryable = err instanceof FetchError ? err.retryable : true;
    const willRetry = await fail(pool, job, (err as Error).stack ?? String(err), retryable);
    console.error(`[job ${job.id} ${job.type}] ${(err as Error).message}${willRetry ? ' (will retry)' : ''}`);
  }
  return true;
}

export interface DrainOptions {
  budgetMs: number;
  concurrency: number;
  /** Injectable for tests. */
  runOne?: () => Promise<boolean>;
}

/**
 * Run `concurrency` lanes until no job is due or the budget is spent (a job already started
 * finishes past it). Resolves with the number of jobs run; rejects with the first lane error.
 */
export async function drain({ budgetMs, concurrency, runOne: run = runOne }: DrainOptions): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let ran = 0;
  const lane = async () => {
    while (Date.now() < deadline && (await run())) ran++;
  };
  const results = await Promise.allSettled(Array.from({ length: concurrency }, lane));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return ran;
}
