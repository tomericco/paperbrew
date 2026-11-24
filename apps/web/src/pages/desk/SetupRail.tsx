import type { Device } from '../usePairing';
import type { Schedule } from '../useSchedule';
import { lookInfo, toPaperLook } from '../looks';
import { scheduleText } from './format';

export type Gmail = { connected: false } | { connected: true; email: string };

/** What the rail needs from `GET /api/me`. */
export type SetupMe = {
  paperLayout: 'flat' | 'booklet';
  paperLook: string;
  gmailAvailable: boolean;
  scheduleAvailable: boolean;
  macAppUrl: string | null;
};

type Row = { key: string; label: string; status: string; done: boolean };

const UNKNOWN = "Couldn't check";
const LOADING = 'Checking…';

/** "Broadsheet, booklet" */
export function lookText(me: SetupMe): string {
  return `${lookInfo(toPaperLook(me.paperLook)).label}, ${me.paperLayout === 'booklet' ? 'booklet' : 'flat A4'}`;
}

/**
 * "Your setup": Newsletters, Schedule, Printer and Look, each with its status and a link to Settings.
 * A part this account does not have (no Gmail, no schedule, no Mac app) is left out, as Settings leaves it out.
 * `undefined` is still loading; `null` failed to load.
 */
export function SetupRail({
  me,
  gmail,
  schedule,
  scheduleFailed,
  devices,
}: {
  me: SetupMe;
  gmail: Gmail | null | undefined;
  schedule: Schedule | null;
  scheduleFailed: boolean;
  devices: Device[] | null | undefined;
}) {
  const rows: Row[] = [];

  if (me.gmailAvailable) {
    rows.push({
      key: 'newsletters',
      label: 'Newsletters',
      status: gmail === undefined ? LOADING : gmail === null ? UNKNOWN : gmail.connected ? `Gmail, ${gmail.email}` : 'Gmail not connected. Forwarding works.',
      done: !!gmail?.connected,
    });
  }

  if (me.scheduleAvailable) {
    rows.push({
      key: 'schedule',
      label: 'Schedule',
      status: scheduleFailed
        ? UNKNOWN
        : !schedule
          ? LOADING
          : schedule.enabled && schedule.days.length > 0
            ? scheduleText(schedule.days, schedule.hour)
            : 'Off. You brew by hand.',
      done: !!schedule?.enabled && schedule.days.length > 0,
    });
  }

  if (me.macAppUrl !== null) {
    const mac = devices?.[0];
    rows.push({
      key: 'printer',
      label: 'Printer',
      status: devices === undefined ? LOADING : devices === null ? UNKNOWN : mac ? mac.name : 'No Mac connected',
      done: !!mac,
    });
  }

  rows.push({ key: 'look', label: 'Look', status: lookText(me), done: true });

  return (
    <section className="desk-card desk-setup" aria-labelledby="desk-setup-title">
      <h2 id="desk-setup-title">Your setup</h2>
      <ul className="desk-setup-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span className={row.done ? 'desk-tick is-done' : 'desk-tick'} aria-hidden="true">
              {row.done && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
                </svg>
              )}
            </span>
            <span className="desk-setup-text">
              <b>{row.label}</b>
              <span className="desk-soft desk-small">{row.status}</span>
            </span>
            <a className="desk-link" href="/app/settings">
              {/* "Set up" only once a part is known to be missing, never while it is loading or unknown. */}
              {row.done || row.status === LOADING || row.status === UNKNOWN ? 'Change' : 'Set up'}
              <span className="visually-hidden"> {row.label.toLowerCase()}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
