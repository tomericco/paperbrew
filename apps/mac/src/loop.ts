import { GoneError, OfflineError, UnauthorizedError, type Api } from './api';
import type { Layout } from './lp';

export type LoopDeps = {
  api: Api;
  print(file: string, layout: Layout, printer: string | null): Promise<void>;
  writeTemp(bytes: Uint8Array): Promise<string>;
  removeTemp(file: string): Promise<void>;
  printer: string | null;
};

/** An issue we claimed but have not finished. `printed: true` means lp succeeded and only the report is left. */
export type Pending = { id: string; layout: Layout; printed?: true } | null;

export type RunResult = {
  outcome: 'idle' | 'printed' | 'failed' | 'unauthorized' | 'offline';
  pending: Pending;
  error?: string;
  printerMissing?: boolean;
  /** The issue a 'failed' result is about, when one was claimed (lets callers tell two failures apart). */
  issueId?: string;
  /** 'printed' because the server said there was nothing left to print: nothing went to the printer. */
  nothingToPrint?: true;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One poll step: claim (or retry the pending issue), download, print, report.
 *
 * - Unauthorized anywhere -> 'unauthorized', pending dropped.
 * - GoneError (404: the issue timed out or was reprinted) -> 'idle', pending dropped, never a failure.
 * - Offline before printing keeps the pending job so the next tick retries it.
 * - No double print: once lp succeeds, an offline `report(ok)` keeps `pending = { ..., printed: true }`;
 *   the next call only retries the report and never downloads or prints again.
 * - If reporting a print failure (`ok: false`) is itself offline, we return 'failed' with pending null:
 *   the server's 30-minute stale sweep marks the issue failed anyway, and retrying a failed print is wrong.
 * - An unexpected plain Error from claim or download (e.g. a 400) -> 'failed' with its message, pending
 *   dropped, and no report (we never started printing; the sweep cleans up the claimed issue).
 */
export async function runOnce(deps: LoopDeps, pending: Pending): Promise<RunResult> {
  const { api } = deps;

  if (pending?.printed) return reportPrinted(api, pending);

  let job: NonNullable<Pending>;
  try {
    const claimed = pending ?? (await api.claim());
    if (!claimed) return { outcome: 'idle', pending: null };
    job = claimed;
  } catch (err) {
    // Nothing was claimed, so there is nothing to keep.
    return mapPhaseError(err, null);
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await api.downloadPdf(job.id);
  } catch (err) {
    return mapPhaseError(err, job);
  }
  // Nothing left to print: the server already marked the issue printed, so we must not report.
  if (bytes === null) return { outcome: 'printed', pending: null, nothingToPrint: true };

  let file: string | null = null;
  let printError: string | null = null;
  try {
    file = await deps.writeTemp(bytes);
    await deps.print(file, job.layout, deps.printer);
  } catch (err) {
    printError = message(err);
  } finally {
    if (file !== null) await deps.removeTemp(file).catch(() => {});
  }

  if (printError === null) return reportPrinted(api, job);

  try {
    await api.report(job.id, { ok: false, error: printError });
  } catch (err) {
    if (err instanceof UnauthorizedError) return { outcome: 'unauthorized', pending: null };
    // Offline or Gone or anything else: fall through to 'failed' (see the doc comment).
  }
  const result: RunResult = { outcome: 'failed', pending: null, error: printError, issueId: job.id };
  if (/does not exist/i.test(printError)) result.printerMissing = true;
  return result;
}

async function reportPrinted(api: Api, job: NonNullable<Pending>): Promise<RunResult> {
  try {
    await api.report(job.id, { ok: true });
    return { outcome: 'printed', pending: null };
  } catch (err) {
    if (err instanceof OfflineError) return { outcome: 'offline', pending: { id: job.id, layout: job.layout, printed: true } };
    if (err instanceof GoneError) return { outcome: 'idle', pending: null };
    if (err instanceof UnauthorizedError) return { outcome: 'unauthorized', pending: null };
    return { outcome: 'failed', pending: null, error: message(err), issueId: job.id };
  }
}

// Errors from claim or download, before anything was printed.
function mapPhaseError(err: unknown, job: Pending): RunResult {
  if (err instanceof UnauthorizedError) return { outcome: 'unauthorized', pending: null };
  if (err instanceof GoneError) return { outcome: 'idle', pending: null };
  if (err instanceof OfflineError) return { outcome: 'offline', pending: job };
  const failed: RunResult = { outcome: 'failed', pending: null, error: message(err) };
  if (job) failed.issueId = job.id;
  return failed;
}
