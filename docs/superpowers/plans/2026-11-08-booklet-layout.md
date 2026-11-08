# Booklet Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user choose Flat A4 or Booklet (A4, folded) from a split Brew button, saved to their account, and have `GET /brew` produce the chosen layout. Booklet pages go in fold order and bind right when every article is Hebrew or Arabic.

**Architecture:** `users.paper_layout` holds the choice, read and written through `/me` and `/me/settings`. `renderMagazine` takes a `layout`: booklet sets the same content on A5-sized pages, and each article carries `dir`/`lang` from a pure script detector. For a booklet, the route buffers Chromium's A5 PDF, then `imposeBooklet` (pdf-lib) places the pages two-up on A4 landscape sheets in saddle-stitch order. The result is streamed back.

**Tech Stack:** Hono, Postgres (`pg`), zod, puppeteer-core with Chromium, pdf-lib 1.17.1 (new), vitest, React and Vite.

**Spec:** `docs/superpowers/specs/2026-11-08-booklet-layout-design.md`

All paths are relative to the repo root. Run API tests with `npm test -w @paperbrew/api` and typecheck everything with `npm run typecheck`.

## Global Constraints

- Layout values are exactly `'flat' | 'booklet'`. The default for new and existing users is `'flat'`.
- Flat output looks the same as today for Latin articles. The CSS may move to logical properties and gain the extra fonts, but nothing visible changes: A4 portrait, `margin: 16mm 30mm`, body 10.75pt, page numbers in `@bottom-center` with none on `:first`.
- Booklet page: `@page { size: A5; margin: 14mm 16mm 16mm; }`, cover height 180mm, masthead 60px, headline 28px, byline 15px, cover titles 17px, body 10.75pt. These are starting values that may be tuned after looking at real output.
- Booklet sheet: A4 landscape, 841.89 × 595.28 pt, two pages per side, each centred in its half. Pages pad to a multiple of 4 with blanks at the end. Print two-sided, flip on short edge.
- Binding: right-to-left only when every piece in the issue is Hebrew or Arabic. Otherwise left-to-right. An empty issue is left-to-right.
- `GET /brew` reads the layout from the database only. There is no query parameter.
- Filenames: flat `paperbrew-YYYY-MM-DD.pdf`, booklet `paperbrew-YYYY-MM-DD-booklet.pdf`.
- Response bodies are streamed with no content-length, because of Vercel's 4.5 MB cap.
- Schema changes are additive and idempotent.
- Every behaviour change gets a test (CLAUDE.md).
- Do not bump `sanitize-html` or `htmlparser2`.

## Review Focus

1. **One-page and empty issues.** A booklet with zero articles (cover only) must produce one sheet with the cover on the front right and blanks elsewhere, not a crash. Covered by Task 4's 1-page case and Task 5's empty-issue test.
2. **Mixed issue with one Hebrew article.** It binds left-to-right, but that one article still sets right-to-left. Covered in Task 2 (`issueDirection`) and Task 3 (render).
3. **Hebrew article whose text is mostly English code or URLs.** It must be detected by letter majority, not by the first character. Task 2 has a test.
4. **A layout save fails, or is still in flight, when Brew is clicked.** The menu must revert, and Brew must wait. Covered by the manual check in Task 6.
5. **An unknown `paper_layout` value from the database** (for example, before the check constraint lands). The route must treat it as `'flat'`. Task 5 has a test.

---

### Task 1: Store the layout and expose it in the API

**Files:**
- Create: `apps/api/src/brew/layout.ts`
- Modify: `apps/api/src/db/schema.sql`: add after the `users` alterations.
- Modify: `apps/api/src/routes/library.ts`: `GET /me` and a new `PUT /me/settings`.
- Test: `apps/api/test/library.test.ts`

**Interfaces:**
- Produces:
  - `export type PaperLayout = 'flat' | 'booklet'`
  - `export const PAPER_LAYOUTS = ['flat', 'booklet'] as const`, in a new file `apps/api/src/brew/layout.ts`. Tasks 3 and 5 import from it.
  - `GET /me` adds `paperLayout: PaperLayout` to its JSON.
  - `PUT /me/settings` takes `{ paperLayout: PaperLayout }` and returns 200 `{ paperLayout }`. A bad body returns 400 `{ error: 'paperLayout must be flat or booklet' }`.

- [ ] **Step 1: Write failing tests** in `library.test.ts`, using the existing `getSession` and `pool.query` spy pattern from the `requireUser` block:
  - `it('GET /me returns paperLayout')`: the `/from users u join inbound_addresses/` mock row gains `paper_layout: 'booklet'`. Expect `(await res.json()).paperLayout === 'booklet'`.
  - `it('PUT /me/settings saves the layout')`: body `{ paperLayout: 'booklet' }`. Expect 200 and `{ paperLayout: 'booklet' }`, and one query matching `/update users set paper_layout = \$1 where id = \$2/` with params `['booklet', 'user-1']`.
  - `it.each([{}, { paperLayout: 'a5' }, null])('PUT /me/settings rejects %j')`: expect 400 and no `update users` query.
  - Add `['PUT', '/me/settings', …]` to the 401 `cases` table.
- [ ] **Step 2: Run** `npm test -w @paperbrew/api -- library`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `schema.sql`:
    ```sql
    alter table users add column if not exists paper_layout text not null default 'flat';
    alter table users drop constraint if exists users_paper_layout_check;
    alter table users add constraint users_paper_layout_check check (paper_layout in ('flat', 'booklet'));
    ```
  - `GET /me`: select `u.paper_layout` and return it as `paperLayout`.
  - `PUT /me/settings`: zod `z.object({ paperLayout: z.enum(PAPER_LAYOUTS) })`.
- [ ] **Step 4: Run** `npm test -w @paperbrew/api && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(api): store each user's paper layout`.

---

### Task 2: Detect each article's script and the issue's direction

**Files:**
- Create: `apps/api/src/brew/direction.ts`
- Test: `apps/api/test/direction.test.ts`

**Interfaces:**
- Produces:
  - `export type Script = 'latin' | 'hebrew' | 'arabic'`
  - `export type Direction = 'ltr' | 'rtl'`
  - `export function detectScript(html: string): Script`. Strips tags (`/<[^>]*>/g` → space), then counts letters:
    - Hebrew: `֐-׿`, `יִ-ﭏ`
    - Arabic: `؀-ۿ`, `ݐ-ݿ`, `ࢠ-ࣿ`, `ﭐ-﷿`, `ﹰ-﻿`
    - Latin: `A-Za-zÀ-ɏ`

    It returns the right-to-left script with the most letters if that count beats the Latin count. Otherwise it returns `'latin'`.
  - `export function directionOf(script: Script): Direction`
  - `export function issueDirection(scripts: Script[]): Direction`. Returns `'rtl'` only when the array is non-empty and every entry is `'hebrew'` or `'arabic'`.

- [ ] **Step 1: Write failing tests:**
  - `detectScript('<p>שלום עולם, זה מאמר</p>') === 'hebrew'`
  - an Arabic sentence returns `'arabic'`
  - `'<p>Hello world</p>'` returns `'latin'`
  - `''` returns `'latin'`
  - Hebrew prose of about 40 letters with one `<code>console.log</code>` and a URL inside returns `'hebrew'` (majority, not first character)
  - mostly English with a single Hebrew word returns `'latin'`
  - `issueDirection(['hebrew', 'arabic']) === 'rtl'`, `issueDirection(['hebrew', 'latin']) === 'ltr'`, `issueDirection([]) === 'ltr'`
- [ ] **Step 2: Run** `npm test -w @paperbrew/api -- direction`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `direction.ts` as specified.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(api): detect article script and issue direction`.

---

### Task 3: Render the booklet page and right-to-left articles

**Files:**
- Modify: `apps/api/src/brew/render.ts`
- Test: `apps/api/test/brew.test.ts`

**Interfaces:**
- Consumes: `PaperLayout` (Task 1), and `detectScript`, `directionOf`, `issueDirection`, `Direction` (Task 2).
- Produces:
  - `renderMagazine(input: { articles: BrewArticle[]; date: Date; layout?: PaperLayout }): string`. `layout` defaults to `'flat'`, so existing callers and tests are unchanged.
  - `export function magazineDirection(articles: BrewArticle[]): Direction`. It applies the same empty-content filter as `toPieces`, then `issueDirection` over each remaining piece's `detectScript(contentHtml)`.

- [ ] **Step 1: Write failing tests** in `brew.test.ts`:
  - `it('flat layout keeps the A4 page')`: `renderMagazine({ articles: [first], date: DATE })` matches `/size:\s*A4/` and does not match `/size:\s*A5/`.
  - `it('booklet layout sets an A5 page with the booklet sizes')`: with `layout: 'booklet'`, the output matches `/size:\s*A5;\s*margin:\s*14mm 16mm 16mm/` and `/\.cover\s*\{[^}]*height:\s*180mm/`, still contains `counter(page)`, and does not match `/size:\s*A4/`.
  - `it('marks Hebrew articles rtl with lang he, Latin ones without dir')`: a Hebrew article renders `<article class="article" dir="rtl" lang="he">`, and the English one renders `<article class="article">`.
  - `it('marks Arabic articles lang ar and turns off their drop cap')`: the output contains `lang="ar"` and the CSS matches `/\.article:lang\(ar\)\s*\.body > p:first-of-type::first-letter\s*\{[^}]*float:\s*none/`.
  - `it('isolates the English kicker and keeps the source link ltr')`: in a Hebrew article, the kicker's parts are each wrapped in `<bdi>`, and the source line is `<p class="source mono" dir="ltr">`.
  - `it('uses logical properties so rtl mirrors')`: the CSS contains `float: inline-start`, `border-inline-start`, `padding-inline-start`, and no `text-align: left`, `float: left`, `border-left` or `padding-left`.
  - `it('loads Hebrew and Arabic fonts')`: the fonts link includes `Frank+Ruhl+Libre` and `Noto+Naskh+Arabic`. The body `font-family` lists them after `'Source Serif 4'`.
  - `it('magazineDirection')`: all Hebrew returns `'rtl'`, Hebrew plus English returns `'ltr'`, no articles returns `'ltr'`.
- [ ] **Step 2: Run** `npm test -w @paperbrew/api -- brew.test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Split `CSS` into the shared rules plus a page block chosen by `layout`. Flat keeps today's `@page` and `.cover { height: 264mm }`. Booklet uses the A5 values from Global Constraints, as overrides placed after the shared rules.
  - Replace the left-oriented rules with logical equivalents:
    - `text-align: left` → `start`
    - drop cap: `float: inline-start; padding-block-start: 0.06em; padding-inline-end: 0.08em`
    - blockquote: `padding-inline-start` and `border-inline-start`
    - lists: `padding-inline-start: 1.2em`
  - Add the `:lang(ar)` drop-cap reset (`float: none; font-size: inherit; line-height: inherit; font-weight: inherit; padding: 0`).
  - `Piece` gains `script: Script`. `article()` sets `dir="rtl" lang="he|ar"` for right-to-left scripts and adds no attributes for Latin. Wrap each kicker part in `<bdi>` for right-to-left pieces only, so Latin markup stays unchanged. Give the source `<p>` `dir="ltr"` for right-to-left pieces.
  - The cover title `<span class="t">` gets `dir="auto"`.
  - FONTS: append `&family=Frank+Ruhl+Libre:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700` before `&display=block`. Body stack: `'Source Serif 4', 'Frank Ruhl Libre', 'Noto Naskh Arabic', Georgia, serif`.
- [ ] **Step 4: Run** `npm test -w @paperbrew/api && npm run typecheck`. Expected: PASS, with every pre-existing brew test unchanged.
- [ ] **Step 5: Commit** with `feat(api): booklet page geometry and right-to-left articles in the magazine HTML`.

---

### Task 4: Impose A5 pages onto A4 booklet sheets

**Files:**
- Modify: `apps/api/package.json`: add `"pdf-lib": "1.17.1"` (exact pin), then run `npm install` from the root.
- Create: `apps/api/src/brew/booklet.ts`
- Test: `apps/api/test/booklet.test.ts`

**Interfaces:**
- Consumes: `Direction` (Task 2).
- Produces:
  - `export type Sheet = { front: [number | null, number | null]; back: [number | null, number | null] }`. Each pair is `[left, right]`, holding 0-based page indices, or `null` for a blank.
  - `export function bookletSheets(pageCount: number, direction: Direction): Sheet[]`
  - `export async function imposeBooklet(a5Pdf: Uint8Array, direction: Direction): Promise<Uint8Array>`

- [ ] **Step 1: Write failing tests:**
  - `bookletSheets(8, 'ltr')` toEqual `[{ front: [7, 0], back: [1, 6] }, { front: [5, 2], back: [3, 4] }]`
  - `bookletSheets(8, 'rtl')` toEqual `[{ front: [0, 7], back: [6, 1] }, { front: [2, 5], back: [4, 3] }]`
  - `bookletSheets(1, 'ltr')` toEqual `[{ front: [null, 0], back: [null, null] }]`
  - `bookletSheets(7, 'ltr')[0].front` toEqual `[null, 0]` (page index 7 is padding)
  - For n in [1, 4, 5, 7, 8, 9, 50], in both directions, every index 0..n−1 appears exactly once, and the sheet count is `Math.ceil(n / 4)`
  - `bookletSheets(0, 'ltr')` toEqual `[]`
  - `imposeBooklet`: build a 5-page A5 PDF (419.53 × 595.28 pt) with pdf-lib in the test. Expect the output to have 4 pages (2 sheets × 2 sides), each 841.89 × 595.28 within 0.01.
- [ ] **Step 2: Run** `npm test -w @paperbrew/api -- booklet`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `bookletSheets`: `n = ceil(pageCount / 4) * 4`. For sheet `s`, left-to-right is `front = [n−1−2s, 2s]` and `back = [2s+1, n−2−2s]`. Right-to-left swaps each pair. Any index ≥ `pageCount` becomes `null`.
  - `imposeBooklet`:
    - `PDFDocument.load`, then `embedPages(src.getPages())`
    - for each sheet, add a front page and a back page (in that order) at 841.89 × 595.28
    - `drawPage` each non-null page at `x = side * 420.945 + (420.945 − w) / 2` and `y = (595.28 − h) / 2`
    - `save()`
- [ ] **Step 4: Run** `npm test -w @paperbrew/api && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `package.json`, the root `package-lock.json`, `booklet.ts` and the test, with `feat(api): impose A5 pages into A4 booklet sheets`.

---

### Task 5: Serve the user's layout from GET /brew

**Files:**
- Modify: `apps/api/src/brew/route.ts`
- Test: `apps/api/test/brewRoute.test.ts`

**Interfaces:**
- Consumes:
  - `renderMagazine({ …, layout })` and `magazineDirection` (Task 3)
  - `imposeBooklet` (Task 4)
  - `PaperLayout` (Task 1)
- Produces: no new exports. Behaviour:
  - After the articles query, run `select paper_layout from users where id = $1`.
  - `layout = rows[0]?.paper_layout === 'booklet' ? 'booklet' : 'flat'`
  - Booklet: read the `htmlToPdf` stream fully into a `Uint8Array`, `imposeBooklet(bytes, magazineDirection(articles))`, then return the bytes as a `ReadableStream` (one chunk, no content-length) with filename `paperbrew-${day}-booklet.pdf`.
  - Flat: unchanged.
  - An imposition failure takes the existing 500 path.

- [ ] **Step 1: Write failing tests.** Route the `query` mock by SQL: `/from articles/` returns the articles, and `/from users/` returns `{ rows: [{ paper_layout }] }`.
  - `it('flat by default')`: users row `{ paper_layout: 'flat' }`. Filename is `paperbrew-2026-11-01.pdf`, the body equals the mocked bytes, and `htmlToPdf` got HTML containing `size: A4`.
  - `it('treats an unknown layout as flat')`: `paper_layout: 'weird'` gives the flat filename.
  - `it('booklet: renders A5 and returns imposed A4 sheets')`: `htmlToPdf` returns a real 2-page A5 PDF built with pdf-lib. The HTML passed contains `size: A5`. The response has filename `paperbrew-2026-11-01-booklet.pdf` and no `content-length`. The body loads with pdf-lib as 2 pages of 841.89 × 595.28.
  - `it('booklet with no articles still returns one sheet')`: the articles query returns `[]` and `htmlToPdf` returns a 1-page A5 PDF (the cover). The body has 2 pages.
  - `it('booklet imposition failure returns 500')`: `htmlToPdf` returns non-PDF bytes. Expect 500 `{ error: "Couldn't brew the magazine. Try again." }`.
- [ ] **Step 2: Run** `npm test -w @paperbrew/api -- brewRoute`. Expected: the new tests FAIL. Update existing tests' `query` mocks to the SQL-routed form where needed.
- [ ] **Step 3: Implement** in `route.ts`. Keep `htmlToPdf` and `BusyError` handling as is, and move the imposition inside the existing try.
- [ ] **Step 4: Run** `npm test -w @paperbrew/api && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(api): GET /brew serves the user's chosen paper layout`.

---

### Task 6: Split Brew button with a saved layout menu

**Files:**
- Modify: `apps/web/src/pages/Library.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `GET /api/me` → `paperLayout`, and `PUT /api/me/settings` (Task 1).
- Produces: the UI only.

- [ ] **Step 1: Implement.**
  - `Me` gains `paperLayout: 'flat' | 'booklet'`.
  - Replace the Brew button with a split button. The main half keeps today's `brew()` and label. The caret half is `<button aria-haspopup="menu" aria-expanded aria-label="Paper layout">`, and opens a `role="menu"` with two `role="menuitemradio" aria-checked` items:
    - **Flat A4**: "Single pages, staple in the corner."
    - **Booklet (A4, folded)**: "Print two-sided, flip on short edge, fold and staple."
  - Picking an item:
    - set state optimistically, close the menu
    - `PUT /api/me/settings`
    - on a non-OK response, revert and show the response's error (via `errorText`) in the existing `brewError` line
    - keep the pending save's promise in a ref; `brew()` awaits it before fetching `/api/brew`
  - Close the menu on Escape (return focus to the caret) and on a click outside.
  - CSS: the two halves read as one `btn-primary` control (shared border, a hairline divider). The menu is absolutely positioned, right-aligned under the button, and uses the existing hairline border and background tokens.
- [ ] **Step 2: Run** `npm run typecheck && npm run build -w @paperbrew/web`. Expected: PASS.
- [ ] **Step 3: Verify in the browser.** Start the dev servers via `.claude/launch.json` (web on :5173, API on :8787 with a local `.env`). If no database is available locally, say so in the report and skip to typecheck-only. Then check:
  - the menu opens, closes on Escape and outside click, and shows the current choice checked
  - picking Booklet sends `PUT /api/me/settings` and survives a reload
  - Brew downloads `…-booklet.pdf`
  - a forced failed save (stop the API) reverts the check and shows the error
- [ ] **Step 4: Commit** with `feat(web): split Brew button with a saved paper layout`.

---

### Task 7: End-to-end checks before shipping

**Files:** none committed. Scripts go in the scratchpad.

- [ ] **Step 1: Render and look.** Render samples locally through `renderMagazine` → `htmlToPdf` → `imposeBooklet`, using `CHROME_PATH` and `.env.example`:
  - (a) English, 2 articles, booklet
  - (b) Hebrew, 2 articles, booklet: binds right, Hebrew glyphs render, kicker reads correctly
  - (c) mixed Hebrew plus English, booklet: binds left, and the Hebrew article sets right-to-left
  - (d) flat English: identical layout to before

  Read the PDFs and confirm the page order by eye: fold order for the 8-page case. Tune the A5 sizes only if something is clearly off.
- [ ] **Step 2: Worst-case timing.** Booklet with 50 articles of about 3,000 words each. Record print time and total time locally, and confirm they're under the 45 s print and 120 s budget limits. If they aren't, report the numbers. Don't raise the limits without saying so.
- [ ] **Step 3: Vercel preview.** This needs Tomer's OK before pushing: push the branch, then on the preview deployment check that `/health` returns 200 and that one booklet brew downloads. If the preview can't sign in or reach the database, report that, so Tomer can run the check on production after merging.
- [ ] **Step 4:** Update `CLAUDE.md`: Next task 5 and the "Auth and brew" section should describe the two layouts and `PUT /me/settings`. Commit with `docs: booklet layout in CLAUDE.md`.
