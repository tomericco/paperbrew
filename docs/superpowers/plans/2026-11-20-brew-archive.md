# Brew Success Modal and Article Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a brew, offer to archive exactly the brewed articles; keep an Archived list grouped by issue with "Move back".

**Architecture:** A nullable `articles.archived_at` timestamp. `/brew` skips archived rows and reports the ids it printed in a header; new routes archive/unarchive by id and list archived rows. The Library page shows a `<dialog>` after download and gains Saved/Archived tabs.

**Tech Stack:** Hono + pg + zod + vitest (api), Vite + React 19 + TypeScript (web).

**Spec:** `docs/superpowers/specs/2026-11-20-brew-archive-design.md`

## Global Constraints
- Schema changes additive and idempotent (`if not exists`), in `apps/api/src/db/schema.sql`.
- Every new route is behind `requireUser` and only touches the signed-in user's rows (`user_id = $n`).
- Article ids are UUIDs; reject non-UUIDs with 400 (body) or 404 (path), as `DELETE /articles/:id` does.
- Header name: `x-brew-article-ids`, comma-separated, in brew order. Archive body: `{ ids: string[] }`, 1–50 UUIDs.
- Archived list limit 500, ordered `archived_at desc, created_at asc`. Saved list keeps limit 200 and excludes archived.
- Web is phone-first: works at 375px with no sideways scroll, touch targets ≥ 40px, hover styles only under `@media (hover: hover)`. Animations respect `prefers-reduced-motion`.
- Run everything from the repo root: `npm test`, `npm run typecheck`.

## Review Focus
1. Article archived between brew and clicking "Archive" (or deleted): archive call must still succeed for the rest, not 404 the whole request. → Task 1 test `archives only own, unarchived rows`.
2. Duplicate or foreign ids in the archive body: ignored, never touch another user's rows. → Task 1 same test asserts `user_id` in SQL params.
3. Brew with zero ready articles: header present and empty; modal shows no archive button. → Task 2 test `empty brew sends an empty ids header`; Task 3 step.
4. Forwarding an archived link again: it returns to Saved instead of vanishing. → Task 2 re-save tests.
5. Closing the modal with Esc/backdrop: nothing archived. → Task 3 browser check.

---

### Task 1: Archive column and library routes

**Files:**
- Modify: `apps/api/src/db/schema.sql` (after the `articles` indexes)
- Modify: `apps/api/src/routes/library.ts`
- Test: `apps/api/test/library.test.ts`

**Interfaces:**
- Produces (HTTP):
  - `GET /articles` → `{ articles: Article[] }` where archived rows are excluded (`archived_at is null`).
  - `GET /articles?archived=1` → `{ articles: (Article & { archivedAt: string })[] }`.
  - `POST /articles/archive` body `{ ids: string[] }` → `200 { archived: number, archivedAt: string }`; 400 `{ error }` on bad body.
  - `POST /articles/:id/unarchive` → `204`; 404 if not found / not the user's / not archived.
  - `Article` JSON shape unchanged otherwise: `{ id, title, siteName, sourceUrl, status, wordCount, createdAt }`.

- [ ] **Step 1: Schema.** Add `alter table articles add column if not exists archived_at timestamptz;` and `create index if not exists articles_user_archived_idx on articles (user_id, archived_at desc) where archived_at is not null;`.
- [ ] **Step 2: Write failing tests** in `library.test.ts`, reusing the file's `signedIn()` pool-mock pattern:
  - add `['POST', '/articles/archive', …]` and `['POST', ARTICLE + '/unarchive', undefined]` to the 401 table.
  - `GET /articles excludes archived`: the articles SQL contains `archived_at is null`.
  - `GET /articles?archived=1 lists archived with archivedAt`: SQL contains `archived_at is not null` and `limit 500`; response row has `archivedAt` as ISO string.
  - `archives only own, unarchived rows`: POST `{ ids: [a, b, a] }` → 200, `{ archived: <rowCount>, archivedAt }`; the update SQL has `user_id =` and `archived_at is null`; params include `'user-1'` and the deduped id array `[a, b]`.
  - `rejects a bad archive body`: `{ ids: [] }`, `{ ids: ['nope'] }`, 51 ids, missing body → 400.
  - `unarchive`: rowCount 1 → 204; rowCount 0 → 404; non-UUID id → 404 without a query.
- [ ] **Step 3: Run** `npm test -w @paperbrew/api -- library` → new tests FAIL.
- [ ] **Step 4: Implement** in `library.ts`. Archive is one statement: `update articles set archived_at = now() where user_id = $1 and id = any($2::uuid[]) and archived_at is null returning archived_at` (respond with `now()` if no rows). Body schema `z.object({ ids: z.array(z.string().regex(UUID_RE)).min(1).max(50) })`. Archived list selects `archived_at` and maps it to `archivedAt`.
- [ ] **Step 5: Run** `npm test -w @paperbrew/api && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(api): archive and unarchive saved articles`.

### Task 2: Brew skips archived and reports its ids; re-saving un-archives

**Files:**
- Modify: `apps/api/src/brew/route.ts`
- Modify: `apps/api/src/pipeline/processEmail.ts`, `apps/api/src/pipeline/fetchArticle.ts`
- Test: `apps/api/test/brewRoute.test.ts`; new `apps/api/test/resave.test.ts`

**Interfaces:**
- Produces: `GET /brew` response header `x-brew-article-ids: <id>,<id>,…` (empty string when none), ids of exactly the rows passed to `renderMagazine`, same order. The articles query adds `id` and `archived_at is null`.
- Consumes: `archived_at` column from Task 1.

- [ ] **Step 1: Failing brew tests** (in `brewRoute.test.ts`, existing `mockDb`):
  - `brews only unarchived articles`: the articles SQL contains `archived_at is null`.
  - `reports brewed ids in a header`: rows with ids `['a1','a2']` → header `a1,a2` on the flat and booklet paths.
  - `empty brew sends an empty ids header`: no rows → header present and `''`.
- [ ] **Step 2: Failing re-save tests** in `resave.test.ts`, mocking `../src/db/client.js` (pool + `pool.connect()` client) the way `brewRoute.test.ts` does, and mocking fetch/extract modules as needed:
  - `processEmail clears archived_at when a forwarded link already exists`: link insert returns no row → an `update articles set archived_at = null where user_id = $1 and canonical_url = $2 and archived_at is not null` is issued with `[user, url]`; no `fetch_article` job is enqueued for it.
  - `fetchArticle un-archives the existing copy on a canonical duplicate`: the `update … status = 'ready'` throws a unique violation → an update clearing `archived_at` for `(user_id, canonical)` runs before the `delete from articles where id = $1`.
- [ ] **Step 3: Run** `npm test -w @paperbrew/api -- brewRoute resave` → FAIL.
- [ ] **Step 4: Implement.** In `route.ts` set the header in the final `c.body(...)` headers. In `processEmail.ts`, when the link insert returns no row, run the un-archive update in the same transaction client. In `fetchArticle.ts`, the article's `user_id` must be known (select it with the row if not already) for the un-archive update.
- [ ] **Step 5: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(api): brew skips archived articles and reports what it printed`.

### Task 3: Success modal and Archived tab (web)

**Files:**
- Create: `apps/web/src/pages/BrewedDialog.tsx`
- Create: `apps/web/src/pages/ArchivedList.tsx`
- Modify: `apps/web/src/pages/Library.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 1 routes, Task 2 header.
- Produces:
  - `BrewedDialog({ count: number, onArchive: () => Promise<void>, onClose: () => void })` — native `<dialog>` opened with `showModal()` on mount. Uses `LogoMark` from `../Logo` with `pouring` (static under reduced motion). Headline picked at random from: "Fresh off the press.", "Your issue is brewed.", "Hot off the press, ready to pour." Sub-line: "`{count}` articles, ready to print. Archive them to start your next issue fresh." Buttons: primary "Archive these `{count}` articles" (hidden when `count === 0`), secondary "Keep in queue". While archiving: primary shows "Archiving…" and both disable. On success: show "Archived. Your queue is clear." for ~1.2 s, then `onClose`. On error: inline `role="alert"` "Couldn't archive. Try again." and stay open. Esc / backdrop click / Keep → `onClose` without archiving.
  - `ArchivedList({ onMovedBack: (article) => void })` — fetches `/api/articles?archived=1`, groups consecutive rows by identical `archivedAt`, each group headed "Brewed `{Mon D}` · `{n}` article(s)". Rows reuse `.list`/`.list-item` styles: title links to `sourceUrl`, meta line like Saved, button "Move back" → `POST /api/articles/:id/unarchive`, removes the row and calls `onMovedBack`. Empty state: "Nothing archived yet. After you brew an issue, archive it here to keep a record of what you read."
- In `Library.tsx`: after a successful download, read `x-brew-article-ids` (split, drop empties) and open `BrewedDialog` with that count. `onArchive` POSTs `/api/articles/archive` with those ids, then drops those ids from `articles` state. Add Saved/Archived tabs (`role="tablist"`, buttons ≥ 40px tall) under the page head; tab state in the URL as `?tab=archived` via `history.replaceState`. Brew button and layout menu show only on Saved. Moving back re-adds the article to the Saved list (refetch `/api/articles` is fine).

- [ ] **Step 1: Implement** the two components and the Library wiring; styles in `styles.css` using existing tokens, dialog `max-width: min(440px, calc(100vw - 32px))`.
- [ ] **Step 2: Run** `npm run typecheck && npm run build -w @paperbrew/web` → PASS.
- [ ] **Step 3: Commit** `feat(web): brewed modal with archive, and an Archived tab`.

Browser verification (375px and desktop, modal open/archive/keep/Esc, tab switch, Move back) is done by the controller after Task 3.
