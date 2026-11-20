# Brew success modal and article archive

## Why
After printing an issue, the reader wants two things:
1. The queue cleared, so the next issue holds only new articles.
2. A lasting history of what they read on paper, to come back to any time.

## Goals
- When a brew download finishes, show a modal with a celebratory success message and an "Archive these N articles" action.
- Archive exactly the articles that went into that PDF, not ones that arrived mid-brew or were pending/failed.
- An Archived list in the app, grouped by issue, with links to each article's source.
- Archived articles are left out of the Saved list and of every future brew.
- "Move back" returns an archived article to Saved.

## Non-goals
- Per-row "Archive" in the Saved list (only the modal archives, for now).
- Issue numbering, re-downloading an old issue, search in the archive.
- Pagination of the archive (capped at 500 rows for now).

## Anti-goals
- Archiving an article the reader never got on paper.
- Losing an article: archive is a soft state, never a delete.

## Approaches
- **A (picked): `archived_at timestamptz` on `articles`.** One archive action stamps every article with the same time; the Archived tab groups by that timestamp. No new table.
- B: an `issues` table recording each brew. Gives issue numbers and re-download later, but writes a record on every brew, archived or not. More than asked for.
- C: move archived rows to their own table. Rejected: breaks the dedupe indexes and makes "Move back" a cross-table copy.

## Design

### Data
- `alter table articles add column if not exists archived_at timestamptz;`
- Index `(user_id, archived_at desc) where archived_at is not null` for the Archived list.

### API (`apps/api`)
- `GET /brew`: only `archived_at is null` articles. Selects `id` too and returns the included ids in a response header `x-brew-article-ids` (comma-separated; 50 UUIDs ≈ 1.9 KB).
- `GET /articles`: unchanged shape, excludes archived. `GET /articles?archived=1`: archived only, ordered `archived_at desc, created_at asc`, limit 500, each with `archivedAt`.
- `POST /articles/archive` `{ ids: uuid[] }` (1 to 50, zod-validated): sets `archived_at = now()` on the user's own, not-yet-archived rows. Returns `{ archived: number, archivedAt }`.
- `POST /articles/:id/unarchive`: sets `archived_at = null`. 404 if not the user's.
- **Re-saving an archived article moves it back to Saved** (my call): in `processEmail`, when a link insert hits the duplicate index, clear `archived_at` on the existing row; in `fetchArticle`'s duplicate-canonical path, do the same before deleting the new row.

### Web (`apps/web`, Library page)
- After the PDF download starts, open a native `<dialog>` (`showModal`) modal:
  - Celebratory headline + short line with the article count, using the espresso logo with its pour animation (static under `prefers-reduced-motion`).
  - Primary: "Archive these N articles". Secondary: "Keep in queue". Esc / backdrop close = keep.
  - On archive: rows leave Saved, a brief success state, then close. On failure: inline error in the modal, rows stay.
  - The archive button is hidden when the brew included zero articles.
- Tabs on the Library page: "Saved" and "Archived". Archived shows groups headed "Brewed Nov 20 · 8 articles", rows with title linking to source, meta line, and "Move back".
- Phone-first: works at 375px, 40px touch targets, hover styles only under `@media (hover: hover)`.

### Tests
- API: archive/unarchive/list-filter routes (ownership, validation, idempotency), brew excludes archived and sets the ids header, re-save un-archives.
- Web: verified in the browser at phone and desktop width.

## Left to the builder
- Exact success copy (a few rotating headlines in the product's voice is fine), modal styling within the existing design tokens.
- Whether the tab state lives in the URL (`/library?tab=archived`).
