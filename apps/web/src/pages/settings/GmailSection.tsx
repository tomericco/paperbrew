import { useEffect, useState } from 'react';
import { errorText } from '../layouts';
import { SettingsCard, useReportStatus } from './SettingsCard';
import type { SectionStatus } from './SettingsCard';

type Decision = 'rule_skip' | 'not_editorial' | 'editorial';

type Recent = { from: string | null; subject: string | null; decision: Decision; reason: string | null; seenAt: string };

type GmailState =
  | { connected: false }
  | { connected: true; email: string; status: 'active' | 'needs_reconnect'; lastSyncedAt: string | null; recent: Recent[] };

const CONNECT_URL = '/api/gmail/connect';

const REASONS: Record<string, string> = {
  'not-a-list': 'Not a mailing list',
  'blocked-sender': 'Sender blocked',
  'too-short': 'Too short',
  'mostly-links': 'Mostly links',
};

/** "5 minutes ago", "yesterday", "just now". */
export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

export function GmailSection({ step, onStatus }: { step?: number; onStatus?: (s: SectionStatus) => void }) {
  const [state, setState] = useState<GmailState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me/gmail')
      .then(async (res) => {
        if (res.status === 401) {
          location.replace('/signin');
          return;
        }
        if (!res.ok) throw new Error();
        const body = (await res.json()) as GmailState;
        if (!cancelled) setState(body);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your Gmail connection.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function disconnect() {
    if (!confirm('Disconnect Gmail? Paperbrew stops checking your newsletters. Articles already saved stay.')) return;
    setDisconnecting(true);
    setActionError('');
    try {
      const res = await fetch('/api/me/gmail', { method: 'DELETE' });
      if (res.ok) setState({ connected: false });
      else setActionError(await errorText(res, "Couldn't disconnect Gmail. Try again."));
    } catch {
      setActionError("Couldn't disconnect Gmail. Try again.");
    } finally {
      setDisconnecting(false);
    }
  }

  // Done only while Paperbrew can actually read the inbox; a lost connection is still a step to take.
  const status: SectionStatus | null = !state
    ? null
    : !state.connected
      ? { state: 'todo', tone: 'off', label: 'Not set up' }
      : state.status === 'needs_reconnect'
        ? { state: 'todo', tone: 'warn', label: 'Reconnect' }
        : { state: 'done', tone: 'on', label: 'Connected' };
  useReportStatus(status, onStatus);

  let body;
  if (loadError) body = <p className="error">{loadError}</p>;
  else if (!state) body = <p className="muted">Loading…</p>;
  else if (!state.connected)
    body = (
      <>
        <p>Paperbrew reads your newsletters and saves the long, editorial ones as articles. Read-only; you can disconnect any time.</p>
        <p>
          <a className="btn btn-primary" href={CONNECT_URL}>
            Connect Gmail
          </a>
        </p>
      </>
    );
  else
    body = (
      <>
        <div className="gmail-account">
          <div className="gmail-who">
            <span className="gmail-address">{state.email}</span>
            <span className="muted">
              {state.lastSyncedAt ? `Last checked ${relativeTime(state.lastSyncedAt)}` : 'Not checked yet'}
            </span>
          </div>
          <button type="button" onClick={() => void disconnect()} disabled={disconnecting}>
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        {state.status === 'needs_reconnect' && (
          <div className="warning">
            <span>Paperbrew lost access to your Gmail.</span>
            <a className="btn" href={CONNECT_URL}>
              Reconnect Gmail
            </a>
          </div>
        )}
        <h3>Recent decisions</h3>
        {state.recent.length === 0 ? (
          <p className="muted">Nothing checked yet. New newsletters show up here within the hour.</p>
        ) : (
          <ul className="decisions">
            {state.recent.map((row, i) => {
              const kept = row.decision === 'editorial';
              return (
                <li key={i} className="decision">
                  <span className={kept ? 'badge badge-kept' : 'badge'}>{kept ? 'Kept' : 'Skipped'}</span>
                  <div className="decision-body">
                    <span className="decision-subject" dir="auto">
                      {row.subject || '(no subject)'}
                    </span>
                    <span className="decision-from muted">{row.from}</span>
                    {row.reason && <span className="decision-reason muted">{REASONS[row.reason] ?? row.reason}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );

  return (
    <SettingsCard
      id="newsletters"
      step={step}
      title="Your newsletters"
      description="Paperbrew finds the good ones in your Gmail and saves them for you."
      status={status ?? undefined}
    >
      {body}
    </SettingsCard>
  );
}
