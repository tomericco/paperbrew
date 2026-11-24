import type { Article } from '../article';

/** `GET /api/brew?ids=` and `POST /api/articles/archive` take at most this many ids. */
export const MAX_BREW_IDS = 50;

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAYS = [1, 2, 3, 4, 5];

export const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? 'am' : 'pm'}`;

/** "Sunday at 8:00 am", in the zone the schedule runs in. */
export function formatWhen(iso: string, timeZone: string): string | null {
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

/** The calendar day of `date` in `timeZone`, as a UTC midnight timestamp, so two days can be subtracted. */
function dayIn(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
}

/** "today", "tomorrow" or "in 3 days", counted in calendar days in the schedule's zone. */
export function relativeDay(iso: string, timeZone: string, now = new Date()): string | null {
  try {
    const days = Math.round((dayIn(new Date(iso), timeZone) - dayIn(now, timeZone)) / 864e5);
    if (Number.isNaN(days)) return null;
    return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  } catch {
    return null;
  }
}

/** "Sat, Sun at 8:00 am", "Weekdays at 7:00 am", "Sunday at 8:00 am". */
export function scheduleText(days: number[], hour: number): string {
  const picked = MONDAY_FIRST.filter((d) => days.includes(d));
  let names: string;
  if (picked.length === 7) names = 'Every day';
  else if (picked.length === WEEKDAYS.length && WEEKDAYS.every((d) => picked.includes(d))) names = 'Weekdays';
  else if (picked.length === 1) names = DAY_LONG[picked[0]];
  else names = picked.map((d) => DAY_SHORT[d]).join(', ');
  return `${names} at ${hourLabel(hour)}`;
}

/** An article's reading time in minutes: the server's figure, else worked out from the word count. */
export function minutesOf(article: Article): number {
  if (article.readingMinutes) return article.readingMinutes;
  return article.wordCount ? Math.max(1, Math.round(article.wordCount / 230)) : 0;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
