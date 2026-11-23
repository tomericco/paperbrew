import type { Pending, RunResult } from './loop';

/** After this many consecutive offline ticks on the same unprinted issue, stop holding on to it. */
export const MAX_OFFLINE_TICKS = 5;

export type PollerDeps<C = void> = {
  /** One poll step, given the issue we are holding (if any) and whatever the caller passed to `tick`. */
  run(pending: Pending, ctx: C): Promise<RunResult>;
  /** Called whenever the held issue changes (not for `restore`), so the caller can persist it. */
  onPendingChange?(pending: Pending): void;
};

/**
 * Owns the in-memory `pending` issue and guarantees ticks never overlap.
 *
 * Connection generation: `reset()` (pair, disconnect, unauthorized) bumps it. A tick that was started under an
 * older generation is DISCARDED when it finishes (`tick` returns null and nothing is updated), so a tick that began
 * with the old token can never clear the new token, restore `pending`, or report into the new connection.
 *
 * Offline rule: if the SAME unprinted pending issue is offline MAX_OFFLINE_TICKS ticks in a row it is dropped
 * (the server's sweep fails it; the user can press Print again). An issue that already printed
 * (`printed: true`) is never dropped: only its report is outstanding and a reprint would waste paper.
 */
export function createPoller<C = void>(deps: PollerDeps<C>) {
  let pending: Pending = null;
  let running = false;
  let offlineId: string | null = null;
  let offlineCount = 0;
  let generation = 0;

  function setPending(next: Pending): void {
    const same =
      pending === next ||
      (pending !== null && next !== null && pending.id === next.id && pending.layout === next.layout && !!pending.printed === !!next.printed);
    pending = next;
    if (!same) deps.onPendingChange?.(pending);
  }

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
      setPending(null);
      offlineId = null;
      offlineCount = 0;
    }
  }

  return {
    /** Returns null when a tick is already running (this call did nothing) or when the result was discarded as stale. */
    async tick(ctx: C): Promise<RunResult | null> {
      if (running) return null;
      running = true;
      const startedIn = generation;
      try {
        let result: RunResult;
        try {
          result = await deps.run(pending, ctx);
        } catch (err) {
          // runOnce should not throw; if something unexpected does, drop the issue rather than loop on it.
          result = { outcome: 'failed', pending: null, error: err instanceof Error ? err.message : String(err) };
        }
        if (generation !== startedIn) return null;
        setPending(result.pending);
        trackOffline(result);
        return result;
      } finally {
        running = false;
      }
    },
    /** Forget any held issue and invalidate a tick that is running right now (disconnect, unauthorized, re-pair). */
    reset(): void {
      generation++;
      setPending(null);
      offlineId = null;
      offlineCount = 0;
    },
    /** Put back an issue loaded from disk at startup (does not call onPendingChange: it is already persisted). */
    restore(held: Pending): void {
      pending = held;
    },
    get pending(): Pending {
      return pending;
    },
    get generation(): number {
      return generation;
    },
    get busy(): boolean {
      return running;
    },
  };
}

/**
 * Serializes whole ticks (the poller step plus whatever the caller does around it). A `force` request that arrives
 * while a tick is running is not lost: the tick runs again right after the current one finishes. A plain request
 * during a running tick is dropped (the timer will come around again).
 */
export function createTickLoop(once: () => Promise<void>) {
  let ticking = false;
  let rerun = false;
  return async function request(force = false): Promise<void> {
    if (ticking) {
      if (force) rerun = true;
      return;
    }
    ticking = true;
    try {
      do {
        rerun = false;
        await once();
      } while (rerun);
    } finally {
      ticking = false;
    }
  };
}
