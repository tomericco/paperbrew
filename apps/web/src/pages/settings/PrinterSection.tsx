import { useEffect, useState } from 'react';
import { errorText } from '../layouts';
import { relativeTime } from './GmailSection';

type Device = { id: string; name: string; createdAt: string; lastSeenAt: string | null };

type IssueStatus = 'queued' | 'printing' | 'printed' | 'failed';

type Issue = { id: string; createdAt: string; status: IssueStatus; articleCount: number; printedAt: string | null; error: string | null };

type Pairing = { code: string };

const STATUS_LABELS: Record<IssueStatus, string> = {
  queued: 'Waiting',
  printing: 'Printing',
  printed: 'Printed',
  failed: 'Failed',
};

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60 * 1000;
const HELP_AFTER_MS = 5000;

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function PrinterSection({ macAppUrl }: { macAppUrl: string | null }) {
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
      setError('Could not refresh your issues.');
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

  let body;
  if (loadError) body = <p className="error">{loadError}</p>;
  else if (!devices || !issues) body = <p className="muted">Loading…</p>;
  else {
    const device = devices[0];
    body = (
      <>
        {device ? (
          <div className="gmail-account">
            <div className="gmail-who">
              <span className="gmail-address">{device.name}</span>
              <span className="muted">{device.lastSeenAt ? `Last seen ${relativeTime(device.lastSeenAt)}` : 'Not seen yet'}</span>
            </div>
            <button type="button" onClick={() => void removeDevice(device)} disabled={removing}>
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        ) : (
          <>
            <p>Install the Paperbrew app on your Mac and your issues print on your printer by themselves.</p>
            <div className="printer-actions">
              {macAppUrl && (
                <a className="btn" href={macAppUrl}>
                  Download for Mac
                </a>
              )}
              <button type="button" className="btn-primary" onClick={() => void connect()} disabled={connecting}>
                Connect this Mac
              </button>
            </div>
            {pairing && (
              <div role="status">
                <p className="muted">Waiting for the Paperbrew app…</p>
                {showHelp && (
                  <div className="printer-help">
                    <p>Didn't open? Install the app first, then click Connect again.</p>
                    <p className="muted">Or open the app and paste this code:</p>
                    <div className="printer-code-row">
                      <code className="printer-code">{pairing.code}</code>
                      <button type="button" onClick={() => void copyCode(pairing.code)}>
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {timedOut && <p className="muted">The app didn't connect. Click Connect this Mac to try again.</p>}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <h3>Issues</h3>
        {issues.length === 0 ? (
          <p className="muted">No issues yet. They show up here once Paperbrew puts one together.</p>
        ) : (
          <ul className="decisions">
            {issues.map((issue) => (
              <li key={issue.id} className="decision">
                <span className={issue.status === 'printed' ? 'badge badge-kept' : issue.status === 'failed' ? 'badge badge-failed' : 'badge'}>
                  {STATUS_LABELS[issue.status]}
                </span>
                <div className="decision-body">
                  <span className="decision-subject">{formatDate(issue.createdAt)}</span>
                  <span className="decision-from muted">{issue.articleCount === 1 ? '1 article' : `${issue.articleCount} articles`}</span>
                  {issue.status === 'failed' && issue.error && <span className="decision-reason error">{issue.error}</span>}
                  {issueNotes[issue.id] && (
                    <span className="decision-reason muted" role="status">
                      {issueNotes[issue.id]}
                    </span>
                  )}
                  {issue.status === 'failed' && (
                    <button type="button" onClick={() => void reprint(issue)} disabled={reprinting !== null}>
                      {reprinting === issue.id ? 'Sending…' : 'Print again'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="settings-section" aria-labelledby="settings-printer">
      <h2 id="settings-printer">Printer</h2>
      {body}
    </section>
  );
}
