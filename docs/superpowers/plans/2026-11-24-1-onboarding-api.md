# Onboarding API Implementation Plan (PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server side of guided onboarding: a saved look, an onboarding flag, brewing a chosen set of articles, and a starter fetch of up to 3 Gmail newsletters, and a read-only preview of the next scheduled issue.

**Architecture:** Additive, idempotent schema. Pure logic stays separate from I/O and is tested without a database (the existing vitest mock style in `apps/api/test`). The renderer takes a `look`; routes read it from `users`. The starter fetch is a queued job that reuses the Gmail message pipeline.

**Tech Stack:** Hono, pg, zod, vitest, existing Gmail client.

**Spec:** `docs/superpowers/specs/2026-11-24-onboarding-design.md` (sections "Server changes" and "The flow").

## Global Constraints
- Schema changes are additive and idempotent (`if not exists`); RLS enabled on any new table (none expected).
- Every outbound fetch uses `src/fetch/safeFetch.ts`; stored article HTML goes through `sanitizeArticleHtml` (the starter fetch reuses `processMessage`, which already does).
- Do not bump `sanitize-html` or `htmlparser2`.
- Looks: `PAPER_LOOKS = ['broadsheet','fieldnotes','zine']`, default `broadsheet`. The `broadsheet` output must stay byte-identical to today's renderer output (existing snapshots/tests keep passing).
- `GET /brew?ids=` accepts at most 50 UUIDs (`UUID_RE`), only the caller's `status='ready'` and unarchived articles, ordered by `created_at asc`. A bad id list is 400.
- `needsOnboarding` is computed, never stored: `onboarded_at is null` and no articles, no `gmail_connections` row, no non-revoked `print_devices` row, and `brew_enabled = false`.
- Tests run without a database. Add a test with every behavior change.

## Review Focus
1. **Existing user opens `/me`.** One with articles, a Gmail connection, a device or brew on must get `needsOnboarding: false` (Task 1 test).
2. **`ids` with someone else's article id, an archived id, or a non-UUID.** Others' and archived ids are silently dropped; a non-UUID is 400 (Task 3 tests).
3. **Starter fetch finds nothing, or Gmail revokes mid-job.** `starter_done_at` is still set when nothing was found; a `GmailAuthError` flags the connection like `syncGmail` does and does not loop (Task 4 tests).
4. **Reconnect.** Reconnecting Gmail must not re-run the starter fetch for a user whose `starter_done_at` is set (Task 4 test).
5. **Callback return target.** Only `welcome` or `settings` is honored; anything else falls back to settings (Task 4 test).

---

## File Structure
- `apps/api/src/brew/look.ts`: `PAPER_LOOKS`, `PaperLook`, the CSS overrides per look. Pure.
- `apps/api/src/gmail/starter.ts`: `fetchStarterArticles`.
- Modified: `src/db/schema.sql`, `src/brew/render.ts`, `src/brew/issuePdf.ts`, `src/brew/route.ts`, `src/print/agent.ts`, `src/routes/library.ts`, `src/gmail/routes.ts`, `src/gmail/sync.ts` (export `processMessage`), `src/jobs/queue.ts`, `src/jobs/runner.ts`, `README.md`.

---

### Task 1: Look and onboarding columns, settings and `/me`

**Files:**
- Modify: `apps/api/src/db/schema.sql`, `apps/api/src/routes/library.ts`
- Create: `apps/api/src/brew/look.ts`
- Test: `apps/api/test/look.test.ts`, extend the existing library/settings route tests

**Interfaces:**
- Produces:
  - `PAPER_LOOKS`, `type PaperLook`, `isPaperLook(v: unknown): v is PaperLook` in `brew/look.ts`.
  - Columns: `users.paper_look text not null default 'broadsheet'` (+ check), `users.onboarded_at timestamptz`, `gmail_connections.starter_done_at timestamptz`.
  - `PUT /me/settings` also accepts `paperLook`; its response and `GET /me` include `paperLook`.
  - `GET /me` also returns `needsOnboarding: boolean` (rule in Global Constraints).
  - `POST /me/onboarding/complete` → 204, sets `onboarded_at = coalesce(onboarded_at, now())`.

- [ ] **Step 1: Failing tests.**
  - `isPaperLook('zine')` true, `'x'` false.
  - `PUT /me/settings {paperLook:'zine'}` sets `paper_look`; `{paperLook:'x'}` is 400.
  - `GET /me` returns `needsOnboarding: true` for a bare user and `false` when each of the four conditions holds (one test per condition).
  - `POST /me/onboarding/complete` is 204 and the update uses `coalesce`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `look.ts`, the three columns (additive, idempotent, with the check constraint written like `paper_layout`'s), the settings and `/me` changes, and the new route (behind `requireUser` via the existing `/me/*` guard).
- [ ] **Step 4: Run** `npm test -w @paperbrew/api` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): paper look, onboarding flag and needsOnboarding`.

### Task 2: Looks in the renderer

**Files:**
- Modify: `apps/api/src/brew/render.ts`, `apps/api/src/brew/issuePdf.ts`, `apps/api/src/brew/route.ts`, `apps/api/src/print/agent.ts`
- Modify: `apps/api/src/brew/look.ts`
- Test: `apps/api/test/brewRender.test.ts` (or the existing render test file), `brewRoute.test.ts`, `printAgent.test.ts`

**Interfaces:**
- Consumes: `PaperLook` (Task 1).
- Produces:
  - `renderMagazine({ date, articles, layout, look? })`: `look` defaults to `'broadsheet'`.
  - `lookCss(look: PaperLook): string` in `look.ts`: CSS appended after the base CSS. `broadsheet` returns `''`. `fieldnotes`: DM Sans body and headings, accent `#d9480f` for the cover rule, blockquote rule and kicker. `zine`: Space Mono headings, Source Serif 4 body, accent `#1d4ed8` likewise. Add the extra Google Fonts families to the `FONTS` URL only for those looks (the font link must stay unchanged for `broadsheet`).
  - `renderIssuePdf(articles, layout, date, look?: PaperLook)`.
  - `GET /brew` and the agent PDF route read `users.paper_look` and pass it.

- [ ] **Step 1: Failing tests.**
  - `renderMagazine` with `look:'broadsheet'` equals the output with no `look` (byte-identical).
  - With `fieldnotes`, the HTML contains `DM Sans` and `#d9480f` and the fonts link includes DM Sans; with `zine`, `Space Mono` and `#1d4ed8`.
  - `GET /brew` queries `paper_look` and passes it to `renderIssuePdf`; an unknown stored value falls back to `broadsheet`.
  - The agent PDF route does the same for the issue's user.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the base CSS untouched; looks only add overrides. Right-to-left articles keep their fonts (do not override `Frank Ruhl Libre` or `Noto Naskh Arabic` in the fallback stacks).
- [ ] **Step 4: Run** `npm test -w @paperbrew/api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): brew looks`.

### Task 3: Brew only chosen articles

**Files:**
- Modify: `apps/api/src/brew/route.ts`
- Test: `apps/api/test/brewRoute.test.ts`

**Interfaces:**
- Produces: `GET /brew?ids=<uuid>,<uuid>` brews only those articles. Without `ids`, behavior is unchanged. The `x-brew-article-ids` header lists exactly the ones brewed.

- [ ] **Step 1: Failing tests.**
  - With `ids`, the query is `... and id = any($2) ...` ordered by `created_at asc`, still `user_id = $1`, `status = 'ready'`, `archived_at is null`.
  - A non-UUID, more than 50 ids, or an empty `ids=` is 400 with `{ error }`.
  - Without `ids`, the existing query runs unchanged.
  - No matching rows brews the existing empty-issue response (same as today).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with a zod parse of the comma list.
- [ ] **Step 4: Run** `npm test -w @paperbrew/api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): brew a chosen set of articles`.

### Task 4: Starter fetch and the callback return target

**Files:**
- Create: `apps/api/src/gmail/starter.ts`
- Modify: `apps/api/src/gmail/sync.ts` (export `processMessage` and the `Deps`/`Decision` types it needs), `apps/api/src/gmail/routes.ts`, `apps/api/src/jobs/queue.ts`, `apps/api/src/jobs/runner.ts`, `apps/api/README.md`, `CLAUDE.md` (Next tasks note)
- Test: `apps/api/test/gmailStarter.test.ts`, extend the Gmail routes tests

**Interfaces:**
- Consumes: `processMessage` (existing, per message), `gmail.listMessages(token, query, max)`, `refreshAccessToken`, `decryptToken`.
- Produces:
  - `STARTER_QUERY = 'newer_than:30d -in:sent -in:chats -in:drafts'`, `STARTER_MAX_SCAN = 40`, `STARTER_TARGET = 3`.
  - `fetchStarterArticles(userId: string, deps?: Deps): Promise<{ scanned: number; saved: number }>`: lists up to `STARTER_MAX_SCAN` messages, skips ids already in `gmail_messages`, runs `processMessage` on each until `STARTER_TARGET` are saved or the list ends, then sets `gmail_connections.starter_done_at = now()` (also when nothing was found). A `GmailAuthError` sets `status='needs_reconnect'` exactly like `syncGmail` and still returns. It does nothing if `starter_done_at` is already set.
  - Job type `gmail_starter` (payload `{ id: userId }`) in `queue.ts` and `runner.ts`.
  - `GET /me/gmail` adds `starter: { state: 'pending' | 'done'; saved: number }` where `saved` counts the user's articles with `added_via='gmail'`.
  - The callback enqueues `gmail_starter` (and still `gmail_sync`) only when `starter_done_at` is null. `GET /gmail/connect?from=welcome|settings` signs the return target into the state (extend `signState`/`verifyState` payload or add a second signed field), and the callback redirects to `/app/welcome?gmail=connected|error` or `/app/settings?gmail=...`. Anything else is `settings`.

- [ ] **Step 1: Failing tests** (mock Gmail client and `classify`, as the existing sync tests do).
  - Finds 5 editorial of 8 listed: stops at 3 saved, sets `starter_done_at`.
  - Finds none: `saved: 0`, `starter_done_at` set.
  - Skips ids already in `gmail_messages`.
  - Already done: returns `{ scanned: 0, saved: 0 }` without calling Gmail.
  - `GmailAuthError`: connection flagged `needs_reconnect`, resolves.
  - Callback: reconnect with `starter_done_at` set enqueues only `gmail_sync`; `from=welcome` redirects to `/app/welcome?gmail=connected`; `from=evil` redirects to settings; a tampered state is still rejected.
  - `GET /me/gmail` returns `starter` pending (null) and done (set).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `processMessage`; do not copy it. The job's last attempt behaves like `syncGmail` (`lastAttempt`).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` from the root. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): starter fetch after connecting Gmail`.

### Task 5: Next-issue preview and reading minutes

**Files:**
- Modify: `apps/api/src/schedule/createIssue.ts` (export `CANDIDATES_SQL`), `apps/api/src/routes/library.ts`
- Test: `apps/api/test/nextIssue.test.ts`, extend the articles route test

**Interfaces:**
- Consumes: `planIssue`, `CANDIDATES_SQL`, `MAX_ISSUE_ARTICLES`.
- Produces:
  - `GET /me/next-issue` → `{ ids: string[]; minutes: number; budgetMinutes: number }`. Read-only: the same candidates and `planIssue(candidates, brew_budget_minutes)` as `createIssue`, no writes, no rollover. `minutes` sums `reading_minutes` (null counts 1). Works whether or not the schedule is on.
  - `GET /articles` items gain `readingMinutes: number | null`.

- [ ] **Step 1: Failing tests.**
  - Candidates of 9, 12, 15 min with budget 20: `ids` are the first one only plus none more (9 fits, 12 would pass 20) and `minutes` is 9; the first article is always included even if it exceeds the budget.
  - No articles: `{ ids: [], minutes: 0, budgetMinutes }`.
  - The handler issues no `insert`/`update`.
  - `/articles` includes `readingMinutes`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Do not copy the pick rule: call `planIssue`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` from the root. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): preview the next issue`.
