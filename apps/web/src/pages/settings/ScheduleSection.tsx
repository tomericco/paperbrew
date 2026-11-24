import { useMemo } from 'react';
import { browserTimeZone, DAYS, useSchedule } from '../useSchedule';
import { SettingsCard, useReportStatus } from './SettingsCard';
import type { SectionStatus } from './SettingsCard';

const BUDGETS = [
  { value: 30, hint: 'A quick read.' },
  { value: 45, hint: 'Under an hour.' },
  { value: 60, hint: 'About an hour.' },
  { value: 90, hint: 'A slow afternoon.' },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 0];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const pad = (n: number) => String(n).padStart(2, '0');

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
  const { schedule, loadError, saving, error, save } = useSchedule();

  const zones = useMemo(() => timeZones(schedule?.timezone ?? 'UTC'), [schedule?.timezone]);

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
