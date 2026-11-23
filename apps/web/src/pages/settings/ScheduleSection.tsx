import { useEffect, useMemo, useState } from 'react';
import { errorText } from '../layouts';
import { SettingsCard, useReportStatus } from './SettingsCard';
import type { SectionStatus } from './SettingsCard';

type Schedule = {
  enabled: boolean;
  days: number[];
  hour: number;
  timezone: string;
  budgetMinutes: number;
  nextBrewAt: string | null;
  /** An open slot the next hourly tick will brew for. */
  brewDue: boolean;
};

/** The fields a change can touch, named as the settings API names them. */
type Patch = Partial<{
  brewEnabled: boolean;
  brewDays: number[];
  brewHour: number;
  brewTimezone: string;
  brewBudgetMinutes: number;
}>;

// 0 = Sunday ... 6 = Saturday; the chips read Monday first.
const DAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
];

const BUDGETS = [
  { value: 30, hint: 'A quick read.' },
  { value: 45, hint: 'Under an hour.' },
  { value: 60, hint: 'About an hour.' },
  { value: 90, hint: 'A slow afternoon.' },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 0];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const SAVE_ERROR = 'Could not save your schedule.';

const pad = (n: number) => String(n).padStart(2, '0');

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers: fall back to the zones we know about.
  }
  // Some browsers leave UTC out of the list; the saved and browser zones must always be choosable.
  return [...new Set([...zones, 'UTC', browserTimeZone(), current])].sort();
}

/** "Saturday, 07:00" in the chosen zone, 24-hour. */
function formatNext(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(date);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('weekday')}, ${part('hour')}:${part('minute')}`;
  } catch {
    return date.toLocaleString();
  }
}

/** "14:05", the time now in the zone, to check the zone at a glance. */
function nowIn(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date());
  } catch {
    return null;
  }
}

export function ScheduleSection({ step, onStatus }: { step?: number; onStatus?: (s: SectionStatus) => void }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function fetchSchedule(): Promise<Schedule | null> {
    const res = await fetch('/api/me/schedule');
    if (res.status === 401) {
      location.replace('/signin');
      return null;
    }
    if (!res.ok) throw new Error();
    return (await res.json()) as Schedule;
  }

  useEffect(() => {
    let cancelled = false;
    fetchSchedule()
      .then((body) => {
        if (body && !cancelled) setSchedule(body);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your schedule.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const zones = useMemo(() => timeZones(schedule?.timezone ?? 'UTC'), [schedule?.timezone]);

  async function save(patch: Patch) {
    if (!schedule || saving) return;
    const previous = schedule;
    // Turning on while the zone is still the UTC default: take the browser's zone instead.
    const browser = browserTimeZone();
    if (patch.brewEnabled && schedule.timezone === 'UTC' && browser !== 'UTC') patch = { ...patch, brewTimezone: browser };

    setSchedule({
      ...schedule,
      ...(patch.brewEnabled !== undefined && { enabled: patch.brewEnabled }),
      ...(patch.brewDays !== undefined && { days: patch.brewDays }),
      ...(patch.brewHour !== undefined && { hour: patch.brewHour }),
      ...(patch.brewTimezone !== undefined && { timezone: patch.brewTimezone }),
      ...(patch.brewBudgetMinutes !== undefined && { budgetMinutes: patch.brewBudgetMinutes }),
    });
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/me/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSchedule(previous);
        setError(await errorText(res, SAVE_ERROR));
        return;
      }
      // The saved change is in; the next issue time comes from the server.
      try {
        const fresh = await fetchSchedule();
        if (fresh) setSchedule(fresh);
      } catch {
        setError('Saved, but could not refresh the next issue time. Reload to see it.');
      }
    } catch {
      setSchedule(previous);
      setError(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(day: number) {
    if (!schedule) return;
    const days = schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day];
    void save({ brewDays: days });
  }

  // On with no days picked brews nothing, so it is not done yet.
  const status: SectionStatus | null = loadError
    ? { state: 'todo', tone: 'warn', label: "Couldn't load" }
    : !schedule
      ? null
      : !schedule.enabled
        ? { state: 'todo', tone: 'off', label: 'Off' }
        : schedule.days.length === 0
          ? { state: 'todo', tone: 'warn', label: 'No days' }
          : { state: 'done', tone: 'on', label: 'On' };
  useReportStatus(status, onStatus);

  let body;
  if (loadError) body = <p className="error">{loadError}</p>;
  else if (!schedule) body = <p className="muted">Loading…</p>;
  else {
    let next = 'No issue scheduled';
    if (schedule.enabled && schedule.days.length === 0) next = 'Pick at least one day';
    else if (schedule.enabled && schedule.brewDue) next = 'Within the hour';
    else if (schedule.enabled && schedule.nextBrewAt) next = formatNext(schedule.nextBrewAt, schedule.timezone);
    const zoneNow = nowIn(schedule.timezone);
    body = (
      <div className="schedule-controls" aria-busy={saving}>
        <label className="switch-row">
          <span className="switch-text">
            <span className="switch-label" id="schedule-switch-label">
              Make my paper automatically
            </span>
            <span className="group-hint" id="schedule-switch-hint">
              Paperbrew puts an issue together on the days you pick.
            </span>
          </span>
          {/* Named by the label line alone; the hint is its description. */}
          <input
            className="switch"
            type="checkbox"
            role="switch"
            aria-labelledby="schedule-switch-label"
            aria-describedby="schedule-switch-hint"
            checked={schedule.enabled}
            onChange={(e) => void save({ brewEnabled: e.target.checked })}
          />
        </label>

        {schedule.enabled && (
          <div className="schedule-groups">
            <div className="card-group" role="group" aria-labelledby="schedule-days">
              <div className="group-head">
                <h3 className="group-title" id="schedule-days">
                  Which days
                </h3>
                <div className="quick-picks">
                  <button type="button" className="btn-quiet" onClick={() => void save({ brewDays: WEEKDAYS })}>
                    Weekdays
                  </button>
                  <button type="button" className="btn-quiet" onClick={() => void save({ brewDays: EVERY_DAY })}>
                    Every day
                  </button>
                </div>
              </div>
              <div className="day-chips">
                {DAYS.map((day) => (
                  <button
                    key={day.value}
                    type="button"
                    className="day-chip"
                    aria-pressed={schedule.days.includes(day.value)}
                    aria-label={day.long}
                    onClick={() => toggleDay(day.value)}
                  >
                    {day.short}
                  </button>
                ))}
              </div>
            </div>

            <div className="card-group" role="group" aria-labelledby="schedule-time">
              <h3 className="group-title" id="schedule-time">
                What time
              </h3>
              <div className="field-row">
                <label className="field" htmlFor="schedule-hour">
                  <span className="field-name">Time</span>
                  <select id="schedule-hour" value={schedule.hour} onChange={(e) => void save({ brewHour: Number(e.target.value) })}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {pad(h)}:00
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" htmlFor="schedule-zone">
                  <span className="field-name">Time zone</span>
                  <select id="schedule-zone" value={schedule.timezone} onChange={(e) => void save({ brewTimezone: e.target.value })}>
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {zoneNow && <p className="group-hint">It's {zoneNow} there now.</p>}
            </div>

            <div className="card-group">
              <fieldset className="budget-group">
                <legend className="group-title">How much to read</legend>
                <div className="budget-choices">
                  {BUDGETS.map((option) => (
                    <label key={option.value} className="budget-choice">
                      <input
                        className="paper-radio"
                        type="radio"
                        name="brew-budget"
                        value={option.value}
                        checked={schedule.budgetMinutes === option.value}
                        onChange={() => void save({ brewBudgetMinutes: option.value })}
                      />
                      <span className="budget-minutes">{option.value} min</span>
                      <span className="budget-hint">{option.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
        )}

        <div className={schedule.enabled ? 'next-paper' : 'visually-hidden'}>
          <span className="next-paper-label">Your next paper</span>
          <p className={schedule.enabled && schedule.days.length === 0 ? 'next-paper-when is-todo' : 'next-paper-when'} role="status">
            {next}
          </p>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <SettingsCard
      id="schedule"
      step={step}
      title="Your schedule"
      description="Pick when your paper gets made. We'll fit as much reading as you have time for."
      status={status ?? undefined}
    >
      {body}
    </SettingsCard>
  );
}
