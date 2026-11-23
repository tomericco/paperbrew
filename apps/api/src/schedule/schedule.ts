import { DateTime } from 'luxon';

/** Days are 0 = Sunday ... 6 = Saturday; hour is a whole hour 0-23 in the IANA `timezone`. */
export type Schedule = { days: number[]; hour: number; timezone: string };

/** A due slot stays claimable for this long, then it is skipped until the next one. */
export const BREW_WINDOW_HOURS = 6;

const LOOKBACK_DAYS = 8;

/** Luxon weekday is 1 = Monday ... 7 = Sunday; ours is 0 = Sunday ... 6 = Saturday. */
function dayOf(dt: DateTime): number {
  return dt.weekday % 7;
}

/**
 * The slot on the calendar day of `day`, in the schedule's zone. A skipped DST hour shifts forward;
 * a repeated one (clocks going back) counts once, at its first occurrence.
 */
function slotOn(day: DateTime, hour: number): DateTime {
  const slot = day.set({ hour, minute: 0, second: 0, millisecond: 0 });
  const before = slot.minus({ hours: 3 });
  const repeated = before.offset - slot.offset; // minutes the clock was set back, if it was
  if (repeated > 0) {
    const first = slot.minus({ minutes: repeated });
    if (first.hour === slot.hour && first.minute === slot.minute && first.day === slot.day) return first;
  }
  return slot;
}

/** The most recent slot at or before `now`, looking back up to 8 days. Null when there is none. */
export function latestSlot(s: Schedule, now: Date): Date | null {
  if (s.days.length === 0) return null;
  const local = DateTime.fromJSDate(now, { zone: s.timezone });
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const day = local.minus({ days: i });
    if (!s.days.includes(dayOf(day))) continue;
    const slot = slotOn(day, s.hour);
    if (slot.toMillis() <= now.getTime()) return slot.toJSDate();
  }
  return null;
}

/** Due when the latest slot is newer than the last brew and still inside the window. */
export function isBrewDue(s: Schedule, lastBrewAt: Date | null, now: Date): boolean {
  const slot = latestSlot(s, now);
  if (!slot) return false;
  if (lastBrewAt && lastBrewAt.getTime() >= slot.getTime()) return false;
  return now.getTime() - slot.getTime() < BREW_WINDOW_HOURS * 3_600_000;
}

/** The first slot strictly after `now`. Null when `days` is empty. */
export function nextBrewAt(s: Schedule, now: Date): Date | null {
  if (s.days.length === 0) return null;
  const local = DateTime.fromJSDate(now, { zone: s.timezone });
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const day = local.plus({ days: i });
    if (!s.days.includes(dayOf(day))) continue;
    const slot = slotOn(day, s.hour);
    if (slot.toMillis() > now.getTime()) return slot.toJSDate();
  }
  return null;
}
