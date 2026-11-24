import { useState } from 'react';
import { browserTimeZone, DAYS, useSchedule } from '../useSchedule';
import type { Schedule, SchedulePatch } from '../useSchedule';
import { Card } from './Card';
import type { CardProps } from './steps';

// The settings API takes these four lengths (Settings offers the same ones).
const BUDGETS = [30, 45, 60, 90];

const MONDAY_FIRST = DAYS.map((d) => d.value);
const WEEKDAYS = [1, 2, 3, 4, 5];

/** A schedule that has not been saved yet: Sunday at 8:00 in the user's own zone, 45 minutes of reading. */
const DEFAULT_DAYS = [0];
const DEFAULT_HOUR = 8;
const DEFAULT_BUDGET = 45;

const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? 'am' : 'pm'}`;

/** "Sunday at 8:00 am", in the zone the schedule runs in. */
function formatNext(iso: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(
      new Date(iso),
    );
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('weekday')} at ${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`;
  } catch {
    return null;
  }
}

/** What the picks say before the server has worked out a date: "Sunday at 8:00 am", "Weekdays at 7:00 am". */
function describe(days: number[], hour: number): string {
  const picked = MONDAY_FIRST.filter((d) => days.includes(d));
  const long = (d: number) => DAYS.find((x) => x.value === d)?.long ?? '';
  const short = (d: number) => DAYS.find((x) => x.value === d)?.short ?? '';
  let names: string;
  if (picked.length === 7) names = 'Every day';
  else if (picked.length === WEEKDAYS.length && WEEKDAYS.every((d) => picked.includes(d))) names = 'Weekdays';
  else if (picked.length === 1) names = long(picked[0]);
  else names = picked.map(short).join(', ');
  return `${names} at ${hourLabel(hour)}`;
}

/**
 * Aha 2: when the paper gets made. Picks are saved as they change (the first one saves the whole schedule, switched
 * on); a schedule that was never saved shows Sunday at 8:00 and is only saved once the user picks or continues.
 */
export function ScheduleCard({ next, back }: CardProps) {
  const { schedule, loadError, saving, error, save } = useSchedule({ queue: true });
  const [leaving, setLeaving] = useState(false);

  // What the controls show: the saved schedule, or the defaults for one that is off.
  const view: Schedule | null = schedule
    ? schedule.enabled
      ? schedule
      : {
          ...schedule,
          days: DEFAULT_DAYS,
          hour: DEFAULT_HOUR,
          budgetMinutes: DEFAULT_BUDGET,
          timezone: schedule.timezone !== 'UTC' ? schedule.timezone : browserTimeZone(),
        }
    : null;

  /** A change; on a schedule that is off, it carries the rest of the defaults and switches it on. */
  function change(patch: SchedulePatch): Promise<boolean> {
    if (!schedule || !view) return Promise.resolve(false);
    if (schedule.enabled) return save(patch);
    return save({
      brewEnabled: true,
      brewDays: view.days,
      brewHour: view.hour,
      brewTimezone: view.timezone,
      brewBudgetMinutes: view.budgetMinutes,
      ...patch,
    });
  }

  function toggleDay(day: number) {
    if (!view) return;
    void change({ brewDays: view.days.includes(day) ? view.days.filter((d) => d !== day) : [...view.days, day] });
  }

  async function keep() {
    if (!schedule) return next();
    setLeaving(true);
    // Continuing on an untouched schedule saves the defaults; anything saved already needs nothing more.
    const ok = schedule.enabled || (await change({}));
    if (ok) next();
    else setLeaving(false);
  }

  async function byHand() {
    if (!schedule || !schedule.enabled) return next();
    setLeaving(true);
    if (await save({ brewEnabled: false })) next();
    else setLeaving(false);
  }

  const noDays = !!view && schedule?.enabled === true && view.days.length === 0;
  const busy = saving || leaving;

  let when = '';
  if (view) {
    const fresh = schedule?.enabled && !saving && schedule.nextBrewAt ? formatNext(schedule.nextBrewAt, schedule.timezone) : null;
    when = noDays ? 'Pick at least one day' : schedule?.enabled && !saving && schedule.brewDue ? 'Within the hour' : (fresh ?? describe(view.days, view.hour));
  }

  const budgetIndex = view ? Math.max(0, BUDGETS.indexOf(view.budgetMinutes)) : 0;

  const footer = (
    <>
      <button type="button" className="ob-link" onClick={back} disabled={busy}>
        Back
      </button>
      <span className="ob-grow" />
      <button type="button" className="btn-primary" onClick={() => void keep()} disabled={busy || noDays}>
        Continue
      </button>
    </>
  );

  return (
    <Card step={4} footer={footer}>
      <h2>When should a new issue get printed?</h2>
      <p className="ob-muted">A weekly magazine on weekends, or a fresh issue every morning.</p>
      {loadError ? (
        <p className="ob-error" role="alert">
          Couldn't load your schedule. You can set this later in Settings.
        </p>
      ) : !view ? (
        <p className="ob-muted" role="status">
          Loading…
        </p>
      ) : (
        <>
          <div role="group" aria-labelledby="ob-days-label">
            <div className="ob-eyebrow ob-group-label" id="ob-days-label">
              Days
            </div>
            <div className="ob-days">
              {DAYS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  className="ob-day"
                  aria-pressed={view.days.includes(day.value)}
                  aria-label={day.long}
                  onClick={() => toggleDay(day.value)}
                  disabled={leaving}
                >
                  {day.short}
                </button>
              ))}
            </div>
          </div>

          <div className="ob-field">
            <label className="ob-eyebrow" htmlFor="ob-hour">
              Time
            </label>
            <select id="ob-hour" className="ob-select" value={view.hour} onChange={(e) => void change({ brewHour: Number(e.target.value) })} disabled={leaving}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            <p className="ob-muted ob-small">In the {view.timezone.replaceAll('_', ' ')} time zone.</p>
          </div>

          <div className="ob-field">
            <label className="ob-eyebrow" htmlFor="ob-budget">
              How much to read: <span className="ob-budget-value">{view.budgetMinutes} minutes</span>
            </label>
            <input
              id="ob-budget"
              className="ob-range"
              type="range"
              min={0}
              max={BUDGETS.length - 1}
              step={1}
              value={budgetIndex}
              aria-valuetext={`${view.budgetMinutes} minutes`}
              onChange={(e) => void change({ brewBudgetMinutes: BUDGETS[Number(e.target.value)] })}
              disabled={leaving}
            />
            <div className="ob-range-ticks ob-muted ob-small" aria-hidden="true">
              {BUDGETS.map((m) => (
                <span key={m}>{m}</span>
              ))}
            </div>
            <p className="ob-muted ob-small">Paperbrew fills each issue with your saved articles, up to this much reading.</p>
          </div>

          <div className="ob-callout" role="status" aria-live="polite">
            <span className="ob-eyebrow">Your next paper</span>
            <span className={noDays ? 'ob-big is-todo' : 'ob-big'}>{when}</span>
          </div>

          <p className="ob-error" role="alert">
            {error}
          </p>

          <p className="ob-center">
            <button type="button" className="ob-link" onClick={() => void byHand()} disabled={busy}>
              I'll brew by hand
            </button>
          </p>
        </>
      )}
    </Card>
  );
}
