/** An article that is ready and not yet in a queued or printing issue. Oldest first. */
export type Candidate = { id: string; readingMinutes: number | null; rolloverCount: number };

/** An issue never holds more articles than this. */
export const MAX_ISSUE_ARTICLES = 50;

/** An article left out this many times in a row is archived as skipped. */
export const ROLLOVER_LIMIT = 2;

/** Null reading time counts as one minute. */
export const DEFAULT_MINUTES = 1;

/**
 * Picks articles in order until the next one would exceed the budget or the cap. The first article is
 * always picked. Once the walk stops, every later candidate is left out, even smaller ones.
 * Left-out candidates are `skipped` when this rollover reaches `ROLLOVER_LIMIT`, else `rolledOver`.
 */
export function planIssue(
  candidates: Candidate[],
  budgetMinutes: number,
): { picked: string[]; rolledOver: string[]; skipped: string[] } {
  const picked: string[] = [];
  const leftOut: Candidate[] = [];
  let total = 0;
  let stopped = false;

  for (const c of candidates) {
    if (!stopped) {
      const minutes = c.readingMinutes ?? DEFAULT_MINUTES;
      const fits = picked.length === 0 || (picked.length < MAX_ISSUE_ARTICLES && total + minutes <= budgetMinutes);
      if (fits) {
        picked.push(c.id);
        total += minutes;
        continue;
      }
      stopped = true;
    }
    leftOut.push(c);
  }

  const rolledOver: string[] = [];
  const skipped: string[] = [];
  for (const c of leftOut) {
    if (c.rolloverCount + 1 >= ROLLOVER_LIMIT) skipped.push(c.id);
    else rolledOver.push(c.id);
  }

  return { picked, rolledOver, skipped };
}
