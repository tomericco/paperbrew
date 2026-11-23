import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { BREW_WINDOW_HOURS, isBrewDue, latestSlot, nextBrewAt, type Schedule } from '../src/schedule/schedule.js';

const London = 'Europe/London';
const sat7: Schedule = { days: [6], hour: 7, timezone: London };

/** A wall-clock time in a zone, as the UTC instant. */
function at(iso: string, zone = London): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

describe('isBrewDue', () => {
  // 2026-06-13 is a Saturday.
  it('is due just after the slot when last brew was last week', () => {
    expect(isBrewDue(sat7, at('2026-06-06T07:05'), at('2026-06-13T07:05'))).toBe(true);
  });

  it('is not due before the slot', () => {
    expect(isBrewDue(sat7, at('2026-06-06T07:05'), at('2026-06-13T06:59'))).toBe(false);
  });

  it('is not due when already brewed for this slot', () => {
    expect(isBrewDue(sat7, at('2026-06-13T07:05'), at('2026-06-13T09:00'))).toBe(false);
  });

  it('is not due once the window has passed', () => {
    expect(BREW_WINDOW_HOURS).toBe(6);
    expect(isBrewDue(sat7, at('2026-06-06T07:05'), at('2026-06-13T13:01'))).toBe(false);
  });

  it('is still due just inside the window', () => {
    expect(isBrewDue(sat7, at('2026-06-06T07:05'), at('2026-06-13T12:59'))).toBe(true);
  });

  it('is due when never brewed and the slot was 2 h ago', () => {
    expect(isBrewDue(sat7, null, at('2026-06-13T09:00'))).toBe(true);
  });

  it('has nothing due with no days', () => {
    expect(isBrewDue({ ...sat7, days: [] }, null, at('2026-06-13T09:00'))).toBe(false);
  });

  it('has exactly one slot on the DST end day', () => {
    const sun1: Schedule = { days: [0], hour: 1, timezone: London };
    // 2026-10-25: clocks go back at 02:00 BST, so 01:00-02:00 happens twice.
    const firstPass = new Date('2026-10-25T00:05:00Z');
    const secondPass = new Date('2026-10-25T01:05:00Z');
    expect(DateTime.fromJSDate(firstPass, { zone: London }).toFormat('HH:mm ZZ')).toBe('01:05 +01:00');
    expect(DateTime.fromJSDate(secondPass, { zone: London }).toFormat('HH:mm ZZ')).toBe('01:05 +00:00');
    const lastWeek = at('2026-10-18T01:05');
    expect(isBrewDue(sun1, lastWeek, firstPass)).toBe(true);
    // Brewed during the first pass: the repeated 01:05 is not a new slot.
    expect(isBrewDue(sun1, firstPass, secondPass)).toBe(false);
  });

  it('shifts a nonexistent DST-start slot and fires once', () => {
    const sun1: Schedule = { days: [0], hour: 1, timezone: London };
    // 2026-03-29: 01:00 GMT jumps to 02:00 BST, so 01:00 does not exist.
    const lastWeek = at('2026-03-22T01:05');
    expect(isBrewDue(sun1, lastWeek, at('2026-03-29T00:59'))).toBe(false);
    const slot = latestSlot(sun1, at('2026-03-29T02:30'))!;
    expect(DateTime.fromJSDate(slot, { zone: London }).toISO()).toBe('2026-03-29T02:00:00.000+01:00');
    const now = at('2026-03-29T02:30');
    expect(isBrewDue(sun1, lastWeek, now)).toBe(true);
    expect(isBrewDue(sun1, now, at('2026-03-29T03:30'))).toBe(false);
  });

  it('fires once when the hour is changed inside the window', () => {
    // 2026-06-10 is a Wednesday. Brewed yesterday; schedule changed to an hour 3 h ago.
    const now = at('2026-06-10T10:30');
    const changed: Schedule = { days: [3], hour: 7, timezone: London };
    const yesterday = at('2026-06-09T07:05');
    expect(isBrewDue(changed, yesterday, now)).toBe(true);
    expect(isBrewDue(changed, now, at('2026-06-10T10:35'))).toBe(false);
  });
});

describe('latestSlot', () => {
  it('returns null with no days', () => {
    expect(latestSlot({ ...sat7, days: [] }, at('2026-06-13T09:00'))).toBeNull();
  });

  it('walks back to the previous matching day', () => {
    // Sunday 2026-06-14 -> Saturday 2026-06-13 07:00.
    expect(latestSlot(sat7, at('2026-06-14T12:00'))!.toISOString()).toBe(at('2026-06-13T07:00').toISOString());
  });

  it('finds a slot exactly 7 days back when the weekday is the same and the hour has not come', () => {
    expect(latestSlot(sat7, at('2026-06-13T06:00'))!.toISOString()).toBe(at('2026-06-06T07:00').toISOString());
  });

  it('uses the schedule time zone, not the server zone', () => {
    const tokyo: Schedule = { days: [6], hour: 7, timezone: 'Asia/Tokyo' };
    // Saturday 07:00 in Tokyo is Friday 22:00 UTC.
    expect(latestSlot(tokyo, new Date('2026-06-12T23:00:00Z'))!.toISOString()).toBe('2026-06-12T22:00:00.000Z');
  });
});

describe('nextBrewAt', () => {
  it('returns null with no days', () => {
    expect(nextBrewAt({ ...sat7, days: [] }, new Date())).toBeNull();
  });

  it('gives the next Mon/Thu slot as a UTC instant', () => {
    const s: Schedule = { days: [1, 4], hour: 7, timezone: 'America/New_York' };
    // Tuesday 2026-06-09 12:00 UTC -> Thursday 2026-06-11 07:00 EDT = 11:00 UTC.
    expect(nextBrewAt(s, new Date('2026-06-09T12:00:00Z'))!.toISOString()).toBe('2026-06-11T11:00:00.000Z');
  });

  it('is strictly after now', () => {
    expect(nextBrewAt(sat7, at('2026-06-13T07:00'))!.toISOString()).toBe(at('2026-06-20T07:00').toISOString());
  });

  it('picks later today when the slot has not come', () => {
    expect(nextBrewAt(sat7, at('2026-06-13T06:00'))!.toISOString()).toBe(at('2026-06-13T07:00').toISOString());
  });
});
