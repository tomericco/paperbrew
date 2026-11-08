# Booklet layout for the brewed PDF

Date: 2026-11-08. Status: draft, awaiting approval. Flat A4 typography and page numbers landed in ac01a42.

## Why

People read the issue on a train or a flight, turning pages with their fingers like a book. Today `GET /brew` only produces flat A4 portrait pages, which you staple in a corner and read like a report. The booklet layout puts two book-sized pages on each side of an A4 landscape sheet, in an order that reads correctly once the stack is printed two-sided, folded in half and stapled on the fold.

## Goals

1. Two paper layouts, both on A4 paper:
   - **Flat A4**: today's output, unchanged (A4 portrait, 16mm top/bottom and 30mm side margins, body text 10.75pt, page numbers centered at the bottom with none on the cover).
   - **Booklet (A4, folded)**: A4 landscape sheets, two half-A4 (A5-sized) pages per side, imposed for saddle-stitch folding.
2. **Reading direction follows the language.** If every article in the issue is right-to-left (Hebrew, Arabic), the booklet binds on the right and pages turn right to left. Otherwise, including mixed issues, it binds on the left and pages turn left to right.
3. **Right-to-left articles read correctly.** Hebrew and Arabic text sets right to left with the right alignment, drop cap, quotes and lists, in a font that actually has those glyphs, in both layouts.
4. **The choice lives in the account.** It's stored in the database and saved the moment the user changes it, so the next brew (on any device) uses it.
5. **A split button picks the layout.** The Brew button gets a split half that opens a drop-down menu with the two layouts. The user can open it any time before clicking Brew.

## Non-goals

- A plain A5 (or any non-A4) download. The A5-sized pages exist only inside the booklet sheets.
- A one-sided/two-sided option for flat A4. That's a printer setting.
- Opening the browser print dialog directly (the v1 Print button). Download only, as today.
- Multiple signatures (separately folded groups of sheets) or a sheet cap. A thick booklet is fine as is (Tomer, 2026-11-08).
- Per-article direction overrides, or changing the binding direction by hand.

## Anti-goals (a failure even if it technically works)

- Pages come out of order, or upside down, once printed two-sided and folded.
- Hebrew or Arabic renders as empty boxes on Vercel (its Chromium ships with almost no fonts).
- The layout choice doesn't stick: it resets on reload, or the brew ignores what the menu shows.
- The flat A4 output changes as a side effect.

## Decided (by Tomer)

- Configured from a drop-down on a split Brew button. Persisted per user in the database whenever the selection changes.
- Only A4 paper. The booklet is A4 landscape with two pages per side, as in the 2026-11-08 spike.
- Direction: all right-to-left → bind right; Latin or mixed → bind left.
- Default layout is Flat A4 for new and existing users.
- No cap on booklet thickness; one folded signature regardless of size.

## Design

### Storage and API (`apps/api`)

- New column `users.paper_layout text not null default 'flat' check (paper_layout in ('flat','booklet'))`, added idempotently in `schema.sql` (`add column if not exists`, plus a named check constraint added the same drop/add way as `inbound_addresses_token_check`).
- `GET /me` also returns `paperLayout: 'flat' | 'booklet'`.
- `PUT /me/settings` with body `{ paperLayout: 'flat' | 'booklet' }` (zod) updates the column and returns `{ paperLayout }`. 400 on a bad value.
- `GET /brew` reads `paper_layout` from the user's row. There is no query parameter: the database is the only source of truth. Booklet filename: `paperbrew-YYYY-MM-DD-booklet.pdf`. Flat keeps `paperbrew-YYYY-MM-DD.pdf`.

### Rendering

- `renderMagazine` takes `layout: 'flat' | 'booklet'`. Flat CSS is today's. Booklet swaps the page geometry and type sizes for a 148×210mm page:
  - `@page { size: A5; margin: 14mm 16mm 16mm; }`
  - cover height 180mm, masthead 60px, headline 28px, byline 15px, cover titles 17px
  - body text stays 10.75pt (about 60 characters per line)
  - page numbers and the unnumbered cover work as in flat
  - The spike's values are the starting point. The builder may tune them after looking at real output.
- **Direction detection** (pure, unit-tested): `textDirection(text): 'rtl' | 'ltr'` counts strong right-to-left letters (Hebrew and Arabic blocks) against Latin letters in the article's plain text (strip tags from `content_html`, or select `text_content`). Right-to-left wins only with a clear majority. The issue is right-to-left when every piece is right-to-left. An empty issue is left-to-right.
- **Right-to-left articles**: the `<article>` gets `dir="rtl"`. The furniture stays in English ("01 · site · 12 min read", "Read it online:"), and each English run is wrapped in `<bdi>`/`unicode-bidi: isolate` so it doesn't scramble inside right-to-left text (my call). The drop cap applies to Hebrew but not Arabic, because Arabic letters join and a split first letter would print in the wrong form (my call). The CSS uses logical properties so the same rules serve both directions: drop cap `float: inline-start`, blockquote `border-inline-start`/`padding-inline-start`, list `padding-inline-start`, and `text-align: start` wherever it's `left` today. The source link line stays `dir="ltr"` (it's a URL). Cover titles use `dir="auto"`. The masthead and cover chrome stay as they are.
- **Fonts**: add Google Fonts with Hebrew and Arabic glyphs to the existing `FONTS` URL, placed after Source Serif 4 in the font stack: *Frank Ruhl Libre* (Hebrew serif) and *Noto Naskh Arabic*. The renderer's request policy already allows fonts.googleapis.com and fonts.gstatic.com.

### Imposition (booklet only)

- New dependency `pdf-lib` in `apps/api`. It's pure JS, so first check it bundles and loads on Vercel (`/health` and one real brew after deploy), as with the `sanitize-html` pin.
- Pure, unit-tested `bookletSheets(pageCount, direction)` returns one entry per sheet: `{ front: [left, right], back: [left, right] }`. Each value is a 0-based page index, or `null` for a blank. Pages pad to a multiple of 4, and the blanks go at the end. Left-to-right, for N pages and sheet s: front = [N−1−2s, 2s], back = [2s+1, N−2−2s]. Right-to-left swaps left and right on both sides.
- `pdf.ts` prints the A5 HTML to a buffer, then builds the A4 landscape document (841.89×595.28pt) with `embedPages`/`drawPage`, each page centred in its half. Flat stays streamed straight from Chromium. The booklet buffers the A5 PDF in memory and streams the imposed result without a content-length, so Vercel's 4.5 MB response cap doesn't apply. Keep all of it inside the existing render budget and single browser slot.
- The booklet must print with "two-sided, flip on short edge".
- Timing: a 50-article booklet is roughly twice the pages of today's flat output, and it adds pdf-lib work on top. Measure the worst case (50 long articles) locally and on Vercel against the 45 s print timeout and 120 s budget before shipping. Raise them only if needed, and stay under the function's 300 s maximum.
- Verifying pdf-lib on Vercel: deploy the branch as a Vercel preview, then check `/health` and run one brew (my call). If the preview can't sign in or reach the database, Tomer runs that check on production after merging.

### Web app (`apps/web`, Library page)

- The Brew button becomes a split button. The main half brews (unchanged behaviour). A caret half opens a menu with two radio items:
  - **Flat A4**: "Single pages, staple in the corner."
  - **Booklet (A4, folded)**: "Print two-sided, flip on short edge, fold and staple."
  The current choice is checked.
- Picking an item saves it at once with `PUT /api/me/settings`: optimistic update, revert and show the error line if it fails. The menu closes on selection, Escape, or a click outside. Keyboard: the caret is a button with `aria-haspopup="menu"`, and the items are `menuitemradio`.
- The initial value comes from `GET /api/me`.
- If a save is still in flight, Brew waits for it, so the brew never uses the previous layout.
- Styling follows the existing `btn-primary` and small-button size. Visual details are left to the builder, matching the design canvas's tone.

## Testing

- API (vitest, no DB): `bookletSheets` (1, 4, 5, 7, 8 and 9 pages, both directions, every page index appears exactly once); `textDirection` (Hebrew, Arabic, English, mixed, empty); `renderMagazine` booklet CSS and `dir` attributes; settings route validation; the brew route picks the layout from the user row and sets the booklet filename.
- One imposition test that builds a small A5 PDF with pdf-lib and checks the output has A4 landscape pages in the expected count.
- Manual: brew both layouts locally, print or preview the booklet folded, and check one Hebrew article.

## Left to the builder

- Exact A5 type sizes and margins after looking at real output.
- The thresholds in `textDirection`.
- Split button visuals.
