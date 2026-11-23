import { describe, expect, it } from 'vitest';
import { MAX_ISSUE_ARTICLES, planIssue, ROLLOVER_LIMIT, type Candidate } from '../src/schedule/pick.js';

/** Build candidates oldest-first with the given minutes (null = unknown). */
function cands(minutes: (number | null)[], rolloverCount = 0): Candidate[] {
  return minutes.map((readingMinutes, i) => ({ id: `a${i + 1}`, readingMinutes, rolloverCount }));
}

describe('planIssue', () => {
  it('uses a rollover limit of 2 and a cap of 50', () => {
    expect(ROLLOVER_LIMIT).toBe(2);
    expect(MAX_ISSUE_ARTICLES).toBe(50);
  });

  it('picks the first two and rolls the third over when the budget is 60', () => {
    expect(planIssue(cands([20, 30, 20]), 60)).toEqual({
      picked: ['a1', 'a2'],
      rolledOver: ['a3'],
      skipped: [],
    });
  });

  it('always includes the first article even when it exceeds the budget', () => {
    expect(planIssue(cands([120, 10]), 60)).toEqual({
      picked: ['a1'],
      rolledOver: ['a2'],
      skipped: [],
    });
  });

  it('stops at the first article that would exceed the budget, leaving smaller later ones out', () => {
    expect(planIssue(cands([20, 50, 5]), 60)).toEqual({
      picked: ['a1'],
      rolledOver: ['a2', 'a3'],
      skipped: [],
    });
  });

  it('counts a null reading time as 1 minute', () => {
    // 1 + 1 + 58 = 60 fits exactly; the trailing null (1) would make 61 and is left out.
    expect(planIssue(cands([null, null, 58, null]), 60)).toEqual({
      picked: ['a1', 'a2', 'a3'],
      rolledOver: ['a4'],
      skipped: [],
    });
  });

  it('caps the issue at 50 articles, rolling the rest over', () => {
    const plan = planIssue(cands(Array(60).fill(1)), 1000);
    expect(plan.picked).toHaveLength(50);
    expect(plan.picked[0]).toBe('a1');
    expect(plan.picked[49]).toBe('a50');
    expect(plan.rolledOver).toHaveLength(10);
    expect(plan.rolledOver[0]).toBe('a51');
    expect(plan.skipped).toEqual([]);
  });

  it('archives a left-out article as skipped when its rollover count reaches the limit', () => {
    const candidates: Candidate[] = [
      { id: 'big', readingMinutes: 100, rolloverCount: 0 },
      { id: 'old', readingMinutes: 30, rolloverCount: 1 },
      { id: 'new', readingMinutes: 30, rolloverCount: 0 },
    ];
    expect(planIssue(candidates, 60)).toEqual({
      picked: ['big'],
      rolledOver: ['new'],
      skipped: ['old'],
    });
  });

  it('returns empty lists for no candidates', () => {
    expect(planIssue([], 60)).toEqual({ picked: [], rolledOver: [], skipped: [] });
  });
});
