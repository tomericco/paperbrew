// Local dev only. On Vercel, jobs run via drain() after the webhook and from the daily cron.
import { pool } from '../db/client.js';
import { runOne } from './runner.js';

const IDLE_MS = 2000;
const CONCURRENCY = 4;
let stopping = false;

async function loop(): Promise<void> {
  while (!stopping) {
    const didWork = await runOne().catch((err) => {
      console.error('[worker] claim failed', err);
      return false;
    });
    if (!didWork) await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

console.log(`Worker started (${CONCURRENCY} lanes)`);
await Promise.all(Array.from({ length: CONCURRENCY }, loop));
await pool.end();
