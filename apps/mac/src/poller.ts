import type { Pending, RunResult } from './loop';

/** After this many consecutive offline ticks on the same unprinted issue, stop holding on to it. */
export const MAX_OFFLINE_TICKS = 5;

export type PollerDeps = {
  /** One poll step, given the issue we are holding (if any). */
  run(pending: Pending): Promise<RunResult>;
};

/**
 * Owns the in-memory `pending` issue and guarantees ticks never overlap.
 *
 * Offline rule: if the SAME unprinted pending issue is offline MAX_OFFLINE_TICKS ticks in a row it is dropped
 * (the server's sweep fails it; the user can press Print again). An issue that already printed
 * (`printed: true`) is never dropped: only its report is outstanding and a reprint would waste paper.
 */
export function createPoller(deps: PollerDeps) {
  let pending: Pending = null;
  let running = false;
  let offlineId: string | null = null;
  let offlineCount = 0;

  function trackOffline(result: RunResult): void {
    const p = result.pending;
    if (result.outcome !== 'offline' || !p || p.printed) {
      offlineId = null;
      offlineCount = 0;
      return;
    }
    offlineCount = offlineId === p.id ? offlineCount + 1 : 1;
    offlineId = p.id;
    if (offlineCount >= MAX_OFFLINE_TICKS) {
      pending = null;
      offlineId = null;
      offlineCount = 0;
    }
  }

  return {
    /** Returns null when a tick is already running (this call did nothing). */
    async tick(): Promise<RunResult | null> {
      if (running) return null;
      running = true;
      try {
        let result: RunResult;
        try {
          result = await deps.run(pending);
        } catch (err) {
          // runOnce should not throw; if something unexpected does, drop the issue rather than loop on it.
          result = { outcome: 'failed', pending: null, error: err instanceof Error ? err.message : String(err) };
        }
        pending = result.pending;
        trackOffline(result);
        return result;
      } finally {
        running = false;
      }
    },
    /** Forget any held issue (disconnect, unauthorized, re-pair). */
    reset(): void {
      pending = null;
      offlineId = null;
      offlineCount = 0;
    },
    get pending(): Pending {
      return pending;
    },
    get busy(): boolean {
      return running;
    },
  };
}
