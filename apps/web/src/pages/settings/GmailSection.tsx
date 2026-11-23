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

// Rule codes from apps/api/src/gmail/rules.ts, in plain words.
const REASONS: Record<string, string> = {
  'not-a-list': 'Not a mailing list',
  'blocked-sender': 'You asked to skip this sender',
  'too-short': 'Too short to print',
  'mostly-links': 'Mostly links',
  error: "Couldn't read this one",
  'rules-only (non-English)': 'Not in English, so we kept it',
};

// The classifier's reason is "<label> <score>" (apps/api/src/gmail/classify.ts); the score stays out of sight.
const LABEL_REASONS: Record<string, string> = {
  promotion: 'Looks like a promotion',
  update: 'Looks like a product update',
  notification: 'Looks like a receipt or alert',
  links: 'Mostly links',
};

/** A plain-words reason, or the raw code when it is one we don't know. */
export function reasonText(reason: string, kept: boolean): string {
  if (Object.hasOwn(REASONS, reason)) return REASONS[reason];
  const match = /^([a-z-]+) \d+(\.\d+)?$/.exec(reason);
  if (!match) return reason;
  const label = match[1];
  if (label === 'editorial') return kept ? 'Reads like an article' : 'Not clearly an article';
  return LABEL_REASONS[label] ?? reason;
}

/** "Stratechery <ben@stratechery.com>" reads as "Stratechery"; a bare address stays as it is. */
function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return match && match[1] ? match[1] : from;
}

const SHORT_LIST = 5;

function MailGlyph() {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      <rect x="1" y="1" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.8 2l7.2 5.6L16.2 2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

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
  const [showAll, setShowAll] = useState(false);

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
      <div className="card-start">
        <p className="card-lead">Paperbrew only reads. It never sends, changes or deletes your email, and you can disconnect any time.</p>
        <a className="btn btn-primary card-action" href={CONNECT_URL}>
          Connect Gmail
        </a>
      </div>
    );
  else {
    const rows = showAll ? state.recent : state.recent.slice(0, SHORT_LIST);
    const hidden = state.recent.length - SHORT_LIST;
    body = (
      <>
        <div className="card-group">
          <div className="account-row">
            <span className="account-glyph" aria-hidden="true">
              <MailGlyph />
            </span>
            <div className="account-who">
              <span className="account-name">{state.email}</span>
              <span className="muted">{state.lastSyncedAt ? `Checked ${relativeTime(state.lastSyncedAt)}` : 'Not checked yet'}</span>
            </div>
            <button type="button" className="card-action" onClick={() => void disconnect()} disabled={disconnecting}>
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          {state.status === 'needs_reconnect' && (
            <div className="card-alert">
              <p className="card-alert-title">Google asked us to sign in again</p>
              <p>Until you do, Paperbrew can't check your newsletters. It only takes a moment.</p>
              <a className="btn btn-primary card-action" href={CONNECT_URL}>
                Reconnect Gmail
              </a>
            </div>
          )}
        </div>
        <div className="card-group">
          <h3 className="group-title">What Paperbrew found lately</h3>
          {state.recent.length === 0 ? (
            <p className="muted">Nothing checked yet. New newsletters show up here within the hour.</p>
          ) : (
            <>
              <ul className="found-list" id="gmail-found">
                {rows.map((row, i) => {
                  const kept = row.decision === 'editorial';
                  const meta = [row.from && senderName(row.from), row.reason && reasonText(row.reason, kept)].filter(Boolean);
                  return (
                    <li key={i} className="found-row">
                      <span className="found-subject" dir="auto">
                        {row.subject || '(no subject)'}
                      </span>
                      <span className={kept ? 'tag tag-ink' : 'tag'}>{kept ? 'Saved' : 'Skipped'}</span>
                      {meta.length > 0 && (
                        <span className="found-meta muted" title={row.from ?? undefined}>
                          {meta.map((part, j) => (
                            <span key={j} dir="auto">
                              {part}
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {hidden > 0 && (
                <button type="button" className="btn-quiet card-more" aria-expanded={showAll} aria-controls="gmail-found" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show ${hidden} more`}
                </button>
              )}
            </>
          )}
        </div>
      </>
    );
  }

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
