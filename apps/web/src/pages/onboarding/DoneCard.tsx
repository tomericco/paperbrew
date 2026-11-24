import { useEffect, useState } from 'react';
import { Card } from './Card';
import { clearStoredStep } from './steps';

type Me = { paperLayout: 'flat' | 'booklet'; paperLook: string; scheduleAvailable: boolean; macAppUrl: string | null };
type Gmail = { connected: false } | { connected: true; email: string };
type Schedule = { enabled: boolean; days: number[]; hour: number; timezone: string; nextBrewAt: string | null };
type Devices = { devices: { name: string }[] };

type Loaded = { me: Me | null; gmail: Gmail | null; schedule: Schedule | null; devices: Devices | null };

// The looks' display names. Mirrors the API's paper looks until looks.ts exists to share.
const LOOK_NAMES: Record<string, string> = { broadsheet: 'Broadsheet', fieldnotes: 'Field Notes', zine: 'Zine' };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? 'am' : 'pm'}`;

/** A failed or unavailable request is null: the row then says so, and Done still works. */
async function load<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    if (res.status === 401) {
      location.replace('/signin');
      return null;
    }
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function formatNext(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  try {
    const day = date.toLocaleDateString(undefined, { weekday: 'long', timeZone });
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
    return `${day} ${time}`;
  } catch {
    return null;
  }
}

function scheduleText(s: Schedule): string {
  const days = MONDAY_FIRST.filter((d) => s.days.includes(d));
  const names = days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(', ');
  return `${names} at ${hourLabel(s.hour)}`;
}

function Tick({ done }: { done: boolean | null }) {
  return (
    <span className={done ? 'ob-tick is-done' : 'ob-tick'} aria-hidden="true">
      {done && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
        </svg>
      )}
    </span>
  );
}

type Row = { label: string; text: string; done: boolean };

function summarize(d: Loaded): { rows: Row[]; tail: string } {
  const unknown = "Couldn't check";
  const rows: Row[] = [];

  rows.push(
    !d.gmail
      ? { label: 'Newsletters', text: unknown, done: false }
      : d.gmail.connected
        ? { label: 'Newsletters', text: `Gmail, ${d.gmail.email}`, done: true }
        : { label: 'Newsletters', text: 'Not connected', done: false },
  );

  rows.push({
    label: 'Look',
    text: d.me ? `${LOOK_NAMES[d.me.paperLook] ?? d.me.paperLook}, ${d.me.paperLayout === 'booklet' ? 'booklet' : 'flat A4'}` : unknown,
    done: d.me !== null,
  });

  const scheduleOn = !!d.schedule && d.schedule.enabled && d.schedule.days.length > 0;
  if (d.me?.scheduleAvailable !== false) {
    rows.push(
      !d.schedule
        ? { label: 'Schedule', text: unknown, done: false }
        : scheduleOn
          ? { label: 'Schedule', text: scheduleText(d.schedule), done: true }
          : { label: 'Schedule', text: 'Off. You brew by hand.', done: false },
    );
  }

  const mac = d.devices?.devices[0];
  if (d.me === null || d.me.macAppUrl !== null) {
    rows.push(
      !d.devices
        ? { label: 'Printer', text: unknown, done: false }
        : mac
          ? { label: 'Printer', text: mac.name, done: true }
          : { label: 'Printer', text: 'Not connected', done: false },
    );
  }

  let tail = 'You brew by hand whenever you like.';
  if (d.me?.scheduleAvailable !== false && scheduleOn && d.schedule) {
    const next = d.schedule.nextBrewAt ? formatNext(d.schedule.nextBrewAt, d.schedule.timezone) : null;
    tail = mac
      ? next
        ? `Your first paper prints ${next}.`
        : 'Your papers will print on your schedule.'
      : 'Connect a Mac to start the schedule. Until then you can brew by hand.';
  }
  return { rows, tail };
}

export function DoneCard() {
  const [data, setData] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      load<Me>('/api/me'),
      load<Gmail>('/api/me/gmail'),
      load<Schedule>('/api/me/schedule'),
      load<Devices>('/api/me/print-devices'),
    ]).then(([me, gmail, schedule, devices]) => {
      if (!cancelled) setData({ me, gmail, schedule, devices });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function finish() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/me/onboarding/complete', { method: 'POST' });
      if (res.status === 401) {
        location.replace('/signin');
        return;
      }
      if (!res.ok) throw new Error();
      clearStoredStep();
      // Stay busy: the page is leaving.
      location.assign('/app');
    } catch {
      setError("Couldn't finish setup. Try again.");
      setBusy(false);
    }
  }

  const summary = data ? summarize(data) : null;
  return (
    <Card
      skippable={false}
      footer={
        <button type="button" className="btn-primary ob-block" onClick={() => void finish()} disabled={busy}>
          {busy ? 'Opening…' : 'Open my desk'}
        </button>
      }
    >
      <div className="ob-eyebrow">All set</div>
      <h1>You're ready to brew.</h1>
      {summary ? (
        <>
          <ul className="ob-list">
            {summary.rows.map((row) => (
              <li key={row.label}>
                <Tick done={row.done} />
                <span className="ob-grow">
                  <b>{row.label}</b>
                  <br />
                  <span className="ob-muted ob-small">{row.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="ob-muted">{summary.tail}</p>
        </>
      ) : (
        <p className="ob-muted">Checking your setup…</p>
      )}
      <p className="ob-error" role="alert">
        {error}
      </p>
    </Card>
  );
}
