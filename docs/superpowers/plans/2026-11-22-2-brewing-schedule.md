# Brewing Schedule Implementation Plan (PR 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user sets brew days, an hour, a time zone and a reading-time budget. At that time the hourly tick creates a queued issue sized to the budget, ready for the print agent (PR 3).

**Architecture:**
- Schedule columns on `users` and a new `issues` table.
- Pure functions decide when a brew is due and which articles fit.
- The `/cron/tick` from PR 1 enqueues `create_issue` jobs for due users.
- Articles in a queued or printing issue are kept out of new issues. Ones left out twice are archived as `skipped`.

**Tech Stack:** Hono, pg, zod, vitest, `luxon` (new; time zones and DST), React.

**Spec:** `docs/superpowers/specs/2026-11-22-autonomous-brew-design.md` (section 2, "Articles already in an open issue", 4).

**Depends on:** PR 1 merged: `src/cron/tick.ts` `tick()`, `Settings.tsx` with one component per section.

## Global Constraints
- Whole hours only (`brew_hour` 0–23). Days `0` = Sunday … `6`.
- Time zone is IANA, validated with `Intl.DateTimeFormat(undefined, { timeZone })` not throwing.
- Budget ∈ {30, 45, 60, 90} minutes; default 60. `brew_enabled` default false.
- Due when the latest scheduled slot ≤ now is after `last_brew_at` (or `last_brew_at` is null) and is less than 6 hours old.
- Picking: ready, non-archived articles not in a `queued`/`printing` issue, oldest `created_at` first. Add while the running total of `reading_minutes` (null counts as 1) ≤ budget. Always include the first. At most 50.
- Rollover: each eligible article left out gets `rollover_count += 1`. At 2 it is archived with `archive_reason = 'skipped'`. Manual archive leaves `archive_reason` null. "Move back" and re-saving reset `rollover_count` to 0 and `archive_reason` to null.
- No candidates: no issue, but `last_brew_at` is still set.
- Issue statuses: `queued` | `printing` | `printed` | `failed`. `layout` is a snapshot of `paper_layout`.
- Schedule fields are open to every signed-in user.
- Same rules as PR 1 on schema idempotency, tests without a DB, and phone-first UI.

## Review Focus
1. **A DST change day** (Europe/London, last Sunday of October, brew at 01:00, which happens twice; and late March, when 01:00 doesn't exist). Must brew exactly once, never zero times or twice (Task 1 tests).
2. **The tick fires twice in an hour, or a job retries after the issue insert committed.** Must create one issue (Task 4 test `second run in the same slot creates nothing`).
3. **The user changes the time zone or hour after `last_brew_at`.** The next slot is computed fresh; a slot already in the past of the new schedule but within 6 h fires once (Task 1 test `changed hour within window fires once`).
4. **An article with null `reading_minutes`** (Gmail newsletters always have it; link fetches may fail to). Counts as 1 minute, never NaN (Task 2 test).
5. **Every saved article is still pending (not ready) at brew time.** No issue; the pending articles aren't counted as rolled over (Task 2 test `pending is not a candidate`).

---

## File Structure
- `apps/api/src/schedule/schedule.ts`: `isBrewDue`, `nextBrewAt`. Pure.
- `apps/api/src/schedule/pick.ts`: `planIssue`. Pure.
- `apps/api/src/schedule/createIssue.ts`: the `create_issue` job.
- `apps/api/src/cron/tick.ts`: extended.
- `apps/web/src/pages/settings/ScheduleSection.tsx`.

---

### Task 1: Schema and schedule math

**Files:**
- Modify: `apps/api/src/db/schema.sql`, `apps/api/package.json` (`luxon`, `@types/luxon`)
- Create: `apps/api/src/schedule/schedule.ts`
- Test: `apps/api/test/schedule.test.ts`

**Interfaces:**
- Produces:
  - `type Schedule = { days: number[]; hour: number; timezone: string }`
  - `latestSlot(s: Schedule, now: Date): Date | null`: the most recent slot ≤ now within the last 8 days.
  - `isBrewDue(s: Schedule, lastBrewAt: Date | null, now: Date): boolean`
  - `nextBrewAt(s: Schedule, now: Date): Date | null` (null when `days` is empty)
  - `BREW_WINDOW_HOURS = 6`

- [ ] **Step 1: Schema.**
  - `users`: `brew_enabled boolean not null default false`, `brew_days smallint[] not null default '{}'`, `brew_hour smallint not null default 7 check (brew_hour between 0 and 23)`, `brew_timezone text not null default 'UTC'`, `brew_budget_minutes int not null default 60 check (brew_budget_minutes in (30,45,60,90))`, `last_brew_at timestamptz`.
  - `articles`: `rollover_count int not null default 0`, `archive_reason text check (archive_reason in ('printed','skipped'))`.
  - `issues`: `id uuid pk default gen_random_uuid()`, `user_id uuid not null references users on delete cascade`, `created_at timestamptz not null default now()`, `layout text not null check (layout in ('flat','booklet'))`, `article_ids uuid[] not null`, `status text not null default 'queued' check (status in ('queued','printing','printed','failed'))`, `claimed_by uuid`, `claimed_at timestamptz`, `printed_at timestamptz`, `error text`.
  - Index `issues (user_id, created_at desc)`.
  - RLS enabled.
- [ ] **Step 2: Failing tests** (all with `timezone: 'Europe/London'` unless stated):
  - Saturday 07:00 schedule, now = Sat 07:05 local, last = previous Sat 07:05 → due.
  - Now = Sat 06:59 → not due.
  - Last = Sat 07:05 today → not due.
  - Now = Sat 13:01 (6 h later), last = last week → not due (window passed).
  - `last_brew_at` null and the slot is 2 h ago → due.
  - DST end (2026-10-25, brew Sunday 01:00): exactly one slot that day; due at 01:05 BST, then not due at 01:05 GMT after `last_brew_at` is set.
  - DST start (2026-03-29, brew Sunday 01:00, which doesn't exist): luxon shifts it to 02:00 BST; due once.
  - `changed hour within window fires once`: last = yesterday, schedule changed to an hour 3 h ago → due, then not due after it is set.
  - `nextBrewAt` for Mon+Thu 07:00 `America/New_York` from a Tuesday → Thursday 07:00 local as a UTC instant.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** with luxon `DateTime.fromJSDate(now, { zone })`. Walk back day by day (≤ 8) to the latest weekday in `days` whose `set({ hour, minute: 0 })` ≤ now.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(api): brewing schedule math and issues table`.

### Task 2: Picking an issue

**Files:**
- Create: `apps/api/src/schedule/pick.ts`
- Test: `apps/api/test/pick.test.ts`

**Interfaces:**
- Produces:
  - `type Candidate = { id: string; readingMinutes: number | null; rolloverCount: number }`
  - `MAX_ISSUE_ARTICLES = 50`
  - `ROLLOVER_LIMIT = 2`
  - `planIssue(candidates: Candidate[], budgetMinutes: number): { picked: string[]; rolledOver: string[]; skipped: string[] }`. Candidates come in oldest-first order. `rolledOver` = left out, new count < 2. `skipped` = left out, new count reaches 2.

- [ ] **Step 1: Failing tests:**
  - Budget 60 with [20, 30, 20] → picks the first two; the third rolled over.
  - First article 120 min with budget 60 → picks only it.
  - Null minutes count as 1.
  - 60 one-minute articles → 50 picked.
  - Left-out candidate with `rolloverCount: 1` → `skipped`.
  - Empty → all empty.
  - `pending is not a candidate` is enforced by the SQL in Task 4; here assert `planIssue([])` returns empty.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Stop adding at the first article that would exceed the budget (don't skip ahead to smaller ones), so order stays oldest-first.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): pick issue articles within the reading budget`.

### Task 3: Schedule settings API

**Files:**
- Modify: `apps/api/src/routes/library.ts` (`PUT /me/settings`; new `GET /me/schedule`)
- Test: `apps/api/test/library.test.ts`

**Interfaces:**
- Consumes: `nextBrewAt`.
- Produces:
  - `PUT /me/settings` body: all optional, at least one of `{ paperLayout, brewEnabled, brewDays: number[] (0–6, unique, ≤ 7), brewHour, brewTimezone, brewBudgetMinutes }`. Returns the full saved settings.
  - `GET /me/schedule` → `{ enabled, days, hour, timezone, budgetMinutes, nextBrewAt: string | null }`. `nextBrewAt` is null when disabled.

- [ ] **Step 1: Failing tests:**
  - `{ paperLayout: 'booklet' }` still works on its own.
  - `{ brewTimezone: 'Mars/Base' }` → 400.
  - `{ brewBudgetMinutes: 50 }` → 400.
  - `{}` → 400.
  - A valid full body updates only the given columns (assert the SQL params).
  - `GET /me/schedule` returns `nextBrewAt` as ISO.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Build the `update users set …` from the provided keys only.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): brewing schedule settings`.

### Task 4: `create_issue` job and the tick

**Files:**
- Create: `apps/api/src/schedule/createIssue.ts`
- Modify: `apps/api/src/jobs/queue.ts` (add `'create_issue'`, payload `{ id: userId }`), `apps/api/src/jobs/runner.ts`, `apps/api/src/cron/tick.ts`
- Test: `apps/api/test/createIssue.test.ts`, `apps/api/test/tick.test.ts`

**Interfaces:**
- Consumes: `isBrewDue`, `planIssue`.
- Produces:
  - `createIssue(userId: string, now?: Date): Promise<{ issueId: string | null }>`
  - `tick()` returns `{ gmail, brews, ran }`

In one transaction:
1. `select … from users where id = $1 for update`. If `!brew_enabled` or `!isBrewDue(...)`, return `{ issueId: null }` (this makes retries and double ticks safe).
2. Load candidates: `status='ready' and archived_at is null and not exists (select 1 from issues i where i.user_id = a.user_id and i.status in ('queued','printing') and a.id = any(i.article_ids))`, order `created_at asc`.
3. `planIssue`.
4. Insert the issue if `picked` is non-empty. Bump `rollover_count` for `rolledOver`. Set `archived_at = now()`, `archive_reason = 'skipped'`, `rollover_count = 2` for `skipped`.
5. Set `last_brew_at = now`.

- [ ] **Step 1: Failing tests** (`pool.connect` client spy):
  - A due user with 3 candidates → one `insert into issues` with `article_ids` in order and the user's `paper_layout`.
  - `second run in the same slot creates nothing`: `last_brew_at` is already after the slot → no insert.
  - Disabled → no insert.
  - No candidates → no insert, `last_brew_at` updated.
  - The candidates SQL excludes open issues (assert the query text contains `status in ('queued','printing')`).
  - Tick: enqueues `create_issue` for enabled users where `isBrewDue` is true and no undone `create_issue` job exists. Users are loaded with their schedule fields; the due check runs in JS.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): scheduled brews create queued issues`.

### Task 5: Archive reasons in the Archived list

**Files:**
- Modify: `apps/api/src/routes/library.ts` (archived list returns `archiveReason`; unarchive resets `rollover_count` and `archive_reason`), `apps/api/src/pipeline/processEmail.ts` and `apps/api/src/pipeline/fetchArticle.ts` (re-save resets both), `apps/web/src/pages/article.tsx` (`ArchivedArticle.archiveReason`), `apps/web/src/pages/ArchivedList.tsx` ("Not printed" badge when `skipped`)
- Test: `apps/api/test/library.test.ts`, `apps/api/test/resave.test.ts`

- [ ] **Step 1: Failing tests:**
  - `GET /articles?archived=1` rows include `archiveReason`.
  - Unarchive SQL sets `rollover_count = 0, archive_reason = null`.
  - Re-save of an archived link does the same.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run.** Expected: PASS.
- [ ] **Step 4: Commit** `feat: mark skipped articles as not printed`.

### Task 6: Schedule section in Settings

**Files:**
- Create: `apps/web/src/pages/settings/ScheduleSection.tsx`
- Modify: `apps/web/src/pages/Settings.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `GET /api/me/schedule`, `PUT /api/me/settings`.

- [ ] **Step 1: Build it.** Always shown. It has:
  - an on/off switch ("Brew automatically");
  - seven day chips (Mon … Sun, toggle buttons with `aria-pressed`, ≥ 40 px);
  - an hour `<select>` (00:00 … 23:00);
  - a time zone `<select>` from `Intl.supportedValuesOf('timeZone')`. When the saved zone is `UTC` and the browser's differs, prefill and save the browser's zone on first enable.
  - a budget radio (30 / 45 / 60 / 90 min, "about an hour" style hints are fine);
  - the line `Next issue: Saturday, 07:00` from `nextBrewAt`, formatted in the chosen zone, or `No issue scheduled` when off.

  Each change saves immediately with the same in-flight/revert pattern Library uses for layout.
- [ ] **Step 2: Verify in the browser.**
  - Check at 375 px and desktop: no sideways scroll; chips wrap.
  - Set a brew for the current hour, run `curl /cron/tick` with the bearer, then check `select status, array_length(article_ids,1) from issues` shows one `queued` issue.
  - Take a screenshot as proof.
- [ ] **Step 3: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): brewing schedule settings`.
