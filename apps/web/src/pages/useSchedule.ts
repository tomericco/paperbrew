import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './layouts';

/** `GET /api/me/schedule`. Days are 0 = Sunday ... 6 = Saturday. */
export type Schedule = {
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
export type SchedulePatch = Partial<{
  brewEnabled: boolean;
  brewDays: number[];
  brewHour: number;
  brewTimezone: string;
  brewBudgetMinutes: number;
}>;

// 0 = Sunday ... 6 = Saturday; the chips read Monday first.
export const DAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
];

export const SAVE_ERROR = 'Could not save your schedule.';

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

async function fetchSchedule(): Promise<Schedule | null> {
  const res = await fetch('/api/me/schedule');
  if (res.status === 401) {
    location.replace('/signin');
    return null;
  }
  if (!res.ok) throw new Error();
  return (await res.json()) as Schedule;
}

function applyPatch(schedule: Schedule, patch: SchedulePatch): Schedule {
  return {
    ...schedule,
    ...(patch.brewEnabled !== undefined && { enabled: patch.brewEnabled }),
    ...(patch.brewDays !== undefined && { days: patch.brewDays }),
    ...(patch.brewHour !== undefined && { hour: patch.brewHour }),
    ...(patch.brewTimezone !== undefined && { timezone: patch.brewTimezone }),
    ...(patch.brewBudgetMinutes !== undefined && { budgetMinutes: patch.brewBudgetMinutes }),
  };
}

/**
 * The user's brewing schedule: loads it, and saves a change optimistically (rolled back with an error when the
 * save fails), then re-reads it so `nextBrewAt` is the server's. Shared by the Settings section and the
 * onboarding card.
 *
 * A change made while a save is in flight is dropped by default (Settings disables its controls then). With
 * `queue` it is shown at once and sent right after, merged with any others, so a slider can be dragged freely.
 * `save` resolves true when the change was saved (or queued), false when it failed or was dropped.
 */
export function useSchedule({ queue = false }: { queue?: boolean } = {}) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The latest schedule (with changes still being saved), for callbacks that must not act on a render's stale copy,
  // and what the server last confirmed, which a failed save puts back.
  const current = useRef<Schedule | null>(null);
  const confirmed = useRef<Schedule | null>(null);
  const busy = useRef(false);
  const pending = useRef<SchedulePatch | null>(null);

  const update = useCallback((next: Schedule) => {
    current.current = next;
    setSchedule(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSchedule()
      .then((body) => {
        if (!body || cancelled) return;
        confirmed.current = body;
        update(body);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your schedule.');
      });
    return () => {
      cancelled = true;
    };
  }, [update]);

  /** One round trip: optimistic change, PUT, then the server's own copy. False when the save failed. */
  const send = useCallback(
    async (patch: SchedulePatch): Promise<boolean> => {
      const previous = confirmed.current;
      if (!previous) return false;
      // Turning on while the zone is still the UTC default: take the browser's zone instead.
      const browser = browserTimeZone();
      if (patch.brewEnabled && previous.timezone === 'UTC' && browser !== 'UTC') patch = { ...patch, brewTimezone: browser };

      update(applyPatch(current.current ?? previous, patch));
      setError('');
      try {
        const res = await fetch('/api/me/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          update(previous);
          setError(await errorText(res, SAVE_ERROR));
          return false;
        }
        // The saved change is in; the next issue time comes from the server.
        confirmed.current = applyPatch(previous, patch);
        try {
          const fresh = await fetchSchedule();
          if (fresh) {
            confirmed.current = fresh;
            update(fresh);
          }
        } catch {
          setError('Saved, but could not refresh the next issue time. Reload to see it.');
        }
        return true;
      } catch {
        update(previous);
        setError(SAVE_ERROR);
        return false;
      }
    },
    [update],
  );

  const save = useCallback(
    async (patch: SchedulePatch): Promise<boolean> => {
      const base = current.current;
      if (!base) return false;
      if (busy.current) {
        if (!queue) return false;
        pending.current = { ...pending.current, ...patch };
        update(applyPatch(base, patch));
        return true;
      }
      busy.current = true;
      setSaving(true);
      let ok = true;
      try {
        let next: SchedulePatch | null = patch;
        while (next) {
          ok = await send(next);
          next = ok ? pending.current : null;
          pending.current = null;
        }
      } finally {
        busy.current = false;
        setSaving(false);
      }
      return ok;
    },
    [queue, send, update],
  );

  return { schedule, loadError, saving, error, save };
}
