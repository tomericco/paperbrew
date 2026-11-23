import { useEffect, useState } from 'react';
import { shortDate } from '../article';
import { errorText } from '../layouts';
import { relativeTime } from './GmailSection';
import { SettingsCard, StatusPill, useReportStatus } from './SettingsCard';
import type { SectionStatus } from './SettingsCard';

type Device = { id: string; name: string; createdAt: string; lastSeenAt: string | null };

type IssueStatus = 'queued' | 'printing' | 'printed' | 'failed';

type Issue = { id: string; createdAt: string; status: IssueStatus; articleCount: number; printedAt: string | null; error: string | null };

type Pairing = { code: string };

const STATUS_LABELS: Record<IssueStatus, string> = {
  queued: 'Waiting',
  printing: 'Printing',
  printed: 'Printed',
  failed: "Couldn't print",
};

const STATUS_TAGS: Record<IssueStatus, string> = {
  queued: 'tag',
  printing: 'tag tag-outline',
  printed: 'tag tag-ink',
  failed: 'tag tag-warn',
};

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60 * 1000;
const HELP_AFTER_MS = 5000;
const SEEN_RECENTLY_MS = 15 * 60 * 1000;

const CONNECT_ERROR = "Couldn't start the connection. Try again.";

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(path);
  if (res.status === 401) {
    location.replace('/signin');
    return null;
  }
  if (!res.ok) throw new Error();
  return (await res.json()) as T;
}

/** "Today 7:00 AM", "Yesterday 7:00 AM", then "Nov 22, 7:00 AM" (with the year when it isn't this year). */
export function friendlyDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((day(now) - day(date)) / 86400000);
  if (daysAgo === 0) return `Today ${time}`;
  if (daysAgo === 1) return `Yesterday ${time}`;
  return `${shortDate(iso)}, ${time}`;
}

function PrinterGlyph() {
  return (
    <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">
      <path d="M4.5 5V1.5h9V5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="1" y="5" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 9.5h9v5h-9z" fill="#fff" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.5 12h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function PrinterSection({
  macAppUrl,
  step,
  onStatus,
}: {
  macAppUrl: string;
  step?: number;
  onStatus?: (s: SectionStatus) => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reprinting, setReprinting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [issueNotes, setIssueNotes] = useState<Record<string, string>>({});

  async function refreshIssues() {
    try {
      const body = await getJson<{ issues: Issue[] }>('/api/me/issues');
      if (body) setIssues(body.issues);
    } catch {
      setError('Could not refresh your recent prints.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([getJson<{ devices: Device[] }>('/api/me/print-devices'), getJson<{ issues: Issue[] }>('/api/me/issues')])
      .then(([d, i]) => {
        if (cancelled || !d || !i) return;
        setDevices(d.devices);
        setIssues(i.issues);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your printer.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // After Connect: ask for the device every 2 s until it shows up, for at most 10 minutes. Stops on unmount too.
  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        clearInterval(timer);
        setPairing(null);
        setTimedOut(true);
        return;
      }
      getJson<{ devices: Device[] }>('/api/me/print-devices')
        .then((body) => {
          if (stopped || !body || body.devices.length === 0) return;
          clearInterval(timer);
          setDevices(body.devices);
          setPairing(null);
          void refreshIssues();
        })
        .catch(() => {
          // A missed poll is fine; the next one tries again.
        });
    }, POLL_MS);
    const help = setTimeout(() => setShowHelp(true), HELP_AFTER_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(help);
    };
  }, [pairing]);

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setError('');
    setTimedOut(false);
    setShowHelp(false);
    setCopied(false);
    try {
      const res = await fetch('/api/me/print-devices/pair-code', { method: 'POST' });
      if (res.status === 401) {
        location.replace('/signin');
        return;
      }
      if (!res.ok) {
        setError(await errorText(res, CONNECT_ERROR));
        return;
      }
      const body = (await res.json()) as { code: string; link: string };
      setPairing({ code: body.code });
      // Hands over to the Paperbrew app when it is installed; otherwise nothing happens and the page says so.
      location.href = body.link;
    } catch {
      setError(CONNECT_ERROR);
    } finally {
      setConnecting(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the code and copy it by hand.');
    }
  }

  async function removeDevice(device: Device) {
    if (!confirm(`Remove ${device.name}? It stops printing your issues. You can connect it again any time.`)) return;
    setRemoving(true);
    setError('');
    try {
      const res = await fetch(`/api/me/print-devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      // 404: already removed somewhere else, which is what was asked for.
      if (res.ok || res.status === 404) setDevices((list) => (list ?? []).filter((d) => d.id !== device.id));
      else setError(await errorText(res, "Couldn't remove the Mac. Try again."));
    } catch {
      setError("Couldn't remove the Mac. Try again.");
    } finally {
      setRemoving(false);
    }
  }

  async function reprint(issue: Issue) {
    if (reprinting) return;
    setReprinting(issue.id);
    setError('');
    setIssueNotes(({ [issue.id]: _dropped, ...rest }) => rest);
    try {
      const res = await fetch(`/api/me/issues/${encodeURIComponent(issue.id)}/reprint`, { method: 'POST' });
      if (res.status === 409) setIssueNotes((notes) => ({ ...notes, [issue.id]: 'Nothing left to print' }));
      else if (res.ok || res.status === 404) await refreshIssues();
      else setError(await errorText(res, "Couldn't print again. Try again."));
    } catch {
      setError("Couldn't print again. Try again.");
    } finally {
      setReprinting(null);
    }
  }

  // The app checks in every minute, so a Mac quiet for 15 minutes is not ready to print.
  const device = devices?.[0];
  const fresh = !!device?.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < SEEN_RECENTLY_MS;
  const status: SectionStatus | null = loadError
    ? { state: 'todo', tone: 'warn', label: "Couldn't load" }
    : !devices
      ? null
      : !device
        ? { state: 'todo', tone: 'off', label: 'Not set up' }
        : fresh
          ? { state: 'done', tone: 'on', label: 'Ready' }
          : { state: 'todo', tone: 'warn', label: 'Not seen lately' };
  useReportStatus(status, onStatus);

  let body;
  if (loadError) body = <p className="error">{loadError}</p>;
  else if (!devices || !issues) body = <p className="muted">Loading…</p>;
  else {
    body = (
      <>
        <div className="card-group">
          {device ? (
            <>
              <div className="account-row">
                <span className="account-glyph" aria-hidden="true">
                  <PrinterGlyph />
                </span>
                <div className="account-who">
                  <span className="account-name">{device.name}</span>
                  <span className="muted">{device.lastSeenAt ? `Last seen ${relativeTime(device.lastSeenAt)}` : 'Not seen yet'}</span>
                </div>
                <StatusPill status={fresh ? { tone: 'on', label: 'Connected' } : { tone: 'warn', label: 'Not seen lately' }} />
                <button type="button" className="card-action" onClick={() => void removeDevice(device)} disabled={removing}>
                  {removing ? 'Removing…' : 'Remove'}
                </button>
              </div>
              {!fresh && <p className="account-hint">Open the Paperbrew app on your Mac so it can print.</p>}
            </>
          ) : (
            <ol className="guide-steps">
              <li className="guide-step">
                <span className="guide-step-num" aria-hidden="true">
                  1
                </span>
                <div className="guide-step-body">
                  <p className="guide-step-title">Download the Paperbrew app</p>
                  <div className="guide-step-action">
                    <a className="btn card-action" href={macAppUrl}>
                      Download for Mac
                    </a>
                    <span className="group-hint">Mac only for now.</span>
                  </div>
                </div>
              </li>
              <li className="guide-step">
                <span className="guide-step-num" aria-hidden="true">
                  2
                </span>
                <div className="guide-step-body">
                  <p className="guide-step-title">Open it</p>
                  <p className="group-hint">You'll find Paperbrew in your Applications folder.</p>
                </div>
              </li>
              <li className="guide-step">
                <span className="guide-step-num" aria-hidden="true">
                  3
                </span>
                <div className="guide-step-body">
                  <p className="guide-step-title">Click Connect this Mac</p>
                  <div className="guide-step-action">
                    <button type="button" className="btn-primary card-action" onClick={() => void connect()} disabled={connecting}>
                      Connect this Mac
                    </button>
                  </div>
                  {pairing && (
                    <div className="pairing" role="status">
                      <p className="pairing-wait">
                        <span className="pairing-dot" aria-hidden="true" />
                        Waiting for the Paperbrew app…
                      </p>
                      {showHelp && (
                        <div className="pairing-help">
                          <p>Didn't open? Install the app first, then click Connect again.</p>
                          <p className="muted">Or open the app and paste this code:</p>
                          <div className="pairing-code-row">
                            <code className="pairing-code">{pairing.code}</code>
                            <button type="button" className="card-action" onClick={() => void copyCode(pairing.code)}>
                              {copied ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {timedOut && <p className="muted">The app didn't connect. Click Connect this Mac to try again.</p>}
                </div>
              </li>
            </ol>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="card-group">
          <h3 className="group-title">Recent prints</h3>
          {issues.length === 0 ? (
            <p className="muted">Nothing printed yet. Your first paper will show up here.</p>
          ) : (
            <ul className="print-list">
              {issues.map((issue) => (
                <li key={issue.id} className={`print-row is-${issue.status}`}>
                  <span className="print-dot" aria-hidden="true" />
                  <div className="print-body">
                    <div className="print-line">
                      <time className="print-date" dateTime={issue.createdAt} title={new Date(issue.createdAt).toLocaleString()}>
                        {friendlyDate(issue.createdAt)}
                      </time>
                      <span className={STATUS_TAGS[issue.status]}>{STATUS_LABELS[issue.status]}</span>
                    </div>
                    <span className="muted">{issue.articleCount === 1 ? '1 article' : `${issue.articleCount} articles`}</span>
                    {issue.status === 'failed' && issue.error && <span className="print-error">{issue.error}</span>}
                    {issueNotes[issue.id] && (
                      <span className="muted" role="status">
                        {issueNotes[issue.id]}
                      </span>
                    )}
                    {issue.status === 'failed' && (
                      <button type="button" className="card-action print-again" onClick={() => void reprint(issue)} disabled={reprinting !== null}>
                        {reprinting === issue.id ? 'Sending…' : 'Print again'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </>
    );
  }

  return (
    <SettingsCard
      id="printer"
      step={step}
      title="Your printer"
      description="Install the Paperbrew app on your Mac and your paper prints by itself."
      status={status ?? undefined}
    >
      {body}
    </SettingsCard>
  );
}
