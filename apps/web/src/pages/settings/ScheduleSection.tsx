import { useEffect, useMemo, useState } from 'react';
import { errorText } from '../layouts';

type Schedule = {
  enabled: boolean;
  days: number[];
  hour: number;
  timezone: string;
  budgetMinutes: number;
  nextBrewAt: string | null;
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

export function ScheduleSection() {
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

  let body;
  if (loadError) body = <p className="error">{loadError}</p>;
  else if (!schedule) body = <p className="muted">Loading…</p>;
  else {
    const next = schedule.enabled && schedule.nextBrewAt ? `Next issue: ${formatNext(schedule.nextBrewAt, schedule.timezone)}` : 'No issue scheduled';
    body = (
      <div className="schedule-controls" aria-busy={saving}>
        <label className="choice">
          <input type="checkbox" role="switch" checked={schedule.enabled} onChange={(e) => void save({ brewEnabled: e.target.checked })} />
          <span className="choice-text">
            <span className="choice-label">Brew automatically</span>
            <span className="choice-hint">Paperbrew puts an issue together for you on the days below.</span>
          </span>
        </label>

        <div className="field" role="group" aria-labelledby="schedule-days">
          <span className="field-label" id="schedule-days">
            Days
          </span>
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

        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="schedule-hour">
              Time
            </label>
            <select id="schedule-hour" value={schedule.hour} onChange={(e) => void save({ brewHour: Number(e.target.value) })}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {pad(h)}:00
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="schedule-zone">
              Time zone
            </label>
            <select id="schedule-zone" value={schedule.timezone} onChange={(e) => void save({ brewTimezone: e.target.value })}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="field choices">
          <legend className="field-label">Reading time</legend>
          {BUDGETS.map((option) => (
            <label key={option.value} className="choice">
              <input
                type="radio"
                name="brew-budget"
                value={option.value}
                checked={schedule.budgetMinutes === option.value}
                onChange={() => void save({ brewBudgetMinutes: option.value })}
              />
              <span className="choice-text">
                <span className="choice-label">{option.value} min</span>
                <span className="choice-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="schedule-next" role="status">
          {next}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="settings-section" aria-labelledby="settings-schedule">
      <h2 id="settings-schedule">Schedule</h2>
      {body}
    </section>
  );
}
