# Paperbrew: project context for Claude Code

## Product
Paperbrew turns the articles people save from Hacker News, blogs and newsletters into a magazine they print at home and read away from screens (on a flight, a train, a slow Sunday).
- **ICP:** curious, intelligent readers and analogue/tech geeks who save more than they read.
- **Core benefit:** deliberate, focused reading time that speeds up knowledge-building (career, self-growth, general knowledge).
- **Design canvas** (all screens and print pages): https://claude.ai/artifact/LUnL7nbUXKMJFVzznBP4eC
  Website (home, blog), Web app (Articles, magazine builder 2A/2B), The Issue (print pages).

## v1 scope
1. **Collect.** Forward an email to a private address (built here first), or paste a link in the web app (next).
2. **Articles page.** A list of saved articles.
3. **Build a magazine.** Reorder, remove and rename articles, and pick a look (presets bundle font, heading style, accent color and text size). Cover, contents and notes pages are included by default and can be removed.
4. **Paper.** Booklet (A4 folded, two-sided only) or flat A4 (one- or two-sided).
5. **Output.** A Print button that opens the browser print dialog with pages already in booklet order, or Download PDF.
6. **First run and the desk (done).** New accounts get a guided setup at `/app/welcome`; `/app` is the desk (next issue, reading pile, setup rail). See "Onboarding and the desk".
7. **Out of scope for v1:** article view/edit screen, browser extension, mobile share sheet.

## Repo layout
npm workspaces monorepo. Run scripts from the root, or target one workspace with `-w @paperbrew/<name>`.
- `apps/api` (`@paperbrew/api`): backend, email capture. Paths in the next section are relative to it.
- `apps/web` (`@paperbrew/web`): frontend (website + web app). Vite + React + TypeScript. In dev, `/api/*` is proxied to the API on :8787 with the prefix stripped.
- `apps/mac` (`@paperbrew/mac`): Electron menu-bar app that prints queued issues (pairs with a device token, polls the API, runs `lp`). TypeScript CommonJS, tsc to `dist/`.
- `packages/*`: shared code (e.g. API types) once both apps need it. Don't import across `apps/` directly.
- Shared compiler options live in `tsconfig.base.json`; each workspace extends it.

## apps/api: backend, email capture
- Stack: TypeScript (ESM, NodeNext), Hono on Node 22, Postgres (`pg`), CloudMailin inbound webhook (Postmark adapter kept), Mozilla Readability + jsdom, sanitize-html, zod.
- The job queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED`; there is no Redis.
- Flow: `POST /webhooks/cloudmailin/inbound` (or `/webhooks/postmark/inbound`) normalizes the payload and stores the email in `inbound_emails` and queues `process_email`. `process_email` turns it into article rows: each link gets a `fetch_article` job, and a long newsletter is saved directly. See `apps/api/README.md` for the full rules.
- The decision logic lives in `src/inbound/plan.ts` and is pure, so it's tested without a database.

## Commands
All from the repo root:
- `npm install`: one install for every workspace (single root `package-lock.json`)
- `npm test`: tests in every workspace (api: vitest, no DB needed)
- `npm run typecheck`: every workspace
- `npm run db:migrate`: apply `apps/api/src/db/schema.sql` (idempotent)
- `npm run dev` / `npm run worker`: API and worker
- `npm run dev:web`: web app on :5173
- `npm run dev:mac`: build and start the Mac app (downloads Electron on first run). Root `npm run build` also compiles it.
- `npm run dist:mac`: universal `.dmg` in `apps/mac/release/`. Needs `PAPERBREW_API_URL=https://<real web origin>` at build time (it is baked into the app); unsigned unless `CSC_NAME` is set. See `apps/mac/README.md`.
- `.env` lives in `apps/api/` (copy `apps/api/.env.example`)

## Conventions
- Keep pure logic (planning, link cleaning, extraction) separate from I/O so it stays unit-testable. Add a test with every behavior change.
- Every outbound fetch goes through `src/fetch/safeFetch.ts` (SSRF guard). Never use bare `fetch` for user-supplied URLs.
- Stored article HTML must go through `sanitizeArticleHtml`.
- `sanitize-html` is pinned to 2.17.5 and `htmlparser2` is overridden to v10 in the root `package.json`: newer versions need the ESM-only htmlparser2 v12, which crashes on Vercel (`ERR_REQUIRE_ESM`). Don't bump either without deploying and checking `/health`.
- The webhook returns 200 for anything ignored on purpose and 5xx only for real failures, which the provider retries. Both webhooks use basic auth from `INBOUND_WEBHOOK_USER`/`INBOUND_WEBHOOK_PASSWORD`.
- Schema changes are additive and idempotent (`if not exists`) until a migration tool is adopted.
- The web app is built phone-first: every screen must work at 375px wide with no sideways scroll, touch targets of at least 40px on touch screens, and hover styles only under `@media (hover: hover)`. Check new UI at phone width before calling it done.

## Hosting (decided)
- Vercel functions for both web and API (Node runtime), Supabase Postgres. The API entry is `apps/api/api/index.ts`, serving the Hono app from `src/app.ts`.
- Vercel has no long-lived worker: after the webhook stores a new email, jobs run inline via `waitUntil(drain(...))`, and a daily cron hits `/cron/run-jobs` to retry anything left over. `npm run worker` is local-only.

## Auth and brew
- Auth: Better Auth at `/api/auth` (Google, GitHub, Reddit; a provider is enabled only when both its `*_CLIENT_ID` and `*_CLIENT_SECRET` are set). Env: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the web origin) and `INBOUND_ADDRESS`. OAuth callbacks are `${BETTER_AUTH_URL}/api/auth/callback/<provider>`.
- `GET /brew` returns the signed-in user's saved articles as a PDF magazine (can take 5 to 30 s): at most the 50 oldest ready, unarchived ones, and the `x-brew-article-ids` response header lists what went in. The desk downloads it with the Brew button.
- Brew has two layouts, stored per user as `paper_layout`: `flat` (default, A4 pages) and `booklet` (A5 pages imposed two-up on A4 landscape sheets, printed two-sided and folded; it binds right when every article is Hebrew or Arabic, otherwise left). `PUT /me/settings` with `{ "paperLayout": "flat" | "booklet" }` sets the layout and `GET /brew` uses it.
- Brew also has a look, stored per user as `paper_look`: `broadsheet` (default), `fieldnotes` or `zine`. `PUT /me/settings` accepts `paperLook`; the renderer applies it to web and agent brews. `GET /brew?ids=a,b,c` brews only those articles (max 50 UUIDs, the caller's ready unarchived ones, created_at ascending; 400 on a bad list). The desk and the first issue use it.
- Onboarding (web flow in "Onboarding and the desk"): `GET /me` returns `needsOnboarding`, computed (never stored): `users.onboarded_at` is null and the user has no articles, no Gmail connection, no active print device and brew is not enabled. `POST /me/onboarding/complete` sets `onboarded_at`. `GET /me/next-issue` is a read-only preview of what the next scheduled issue holds (same pick rule as `createIssue`). `GET /articles` rows carry `readingMinutes`.

## Onboarding and the desk (apps/web)
- Pages: `/` home, `/signin`, `/app` desk (`pages/Library.tsx` + `pages/desk/*`), `/app/issues` archive (the old Archived tab; `/app?tab=archived` redirects), `/app/welcome` onboarding (`pages/onboarding/*`), `/app/settings`. Shared: `pages/looks.ts`, `pages/brewClient.ts` (`downloadBrew(ids?)`).
- Redirect: `/app` loads `GET /me`; when `needsOnboarding` is true it goes to `/app/welcome`. `needsOnboarding` is computed server-side (see Auth and brew), so existing users never see it. Signed-out visitors go to `/signin`.
- Cards in order: Welcome, Gmail, Look, First issue, Schedule, Printer, Done. Steps 1 to 5 (Gmail to Printer) show "Step n of 5". A "Skip setup" link on every card but Done jumps to Done; "Skip for now" and "Do this later" buttons just go to the next card. Schedule is passed over when `scheduleAvailable` is false (no scheduler on the server) and Printer when `macAppUrl` is null (no Mac app), both ways, so Back never bounces. A card with no entry in `CARDS` is skipped too. The current step is kept in `sessionStorage` `pb.onboarding.step`; the Google round trip returns to `/app/welcome?gmail=connected|error` and lands on the Gmail card.
- Starter fetch: connecting Gmail queues a one-off `gmail_starter` job (once per connection, so a reconnect does not repeat it) that saves up to 3 editorial newsletters from the last 30 days (scans at most 40 messages). The First issue card polls `GET /me/gmail` (`starter.state` pending or done) every 2 s for up to 60 s, then brews what it found with `GET /brew?ids=` (up to 3 articles shown). With no Gmail or no articles it shows the forwarding address and Check again.
- Done calls `POST /me/onboarding/complete` (sets `onboarded_at`), clears the stored step and opens `/app`.
- Desk: the top card follows the mode. "On a schedule" shows the next issue from `GET /me/next-issue` (`{ ids, minutes, budgetMinutes }`, read-only, same pick rule as `createIssue`); "By hand" shows a Brew button for the ticked articles (all ticked by default) via `GET /brew?ids=`, capped at 50 (`MAX_BREW_IDS`). The mode switch is the schedule's `enabled` flag; accounts without a scheduler are always by hand. The reading pile (oldest first) shows tick boxes by hand and an "In issue / Next time" tag on a schedule. The setup rail (Newsletters, Schedule, Printer, Look, each linking to Settings) leaves out what the account does not have. After a brew the dialog offers to archive the articles that went in (the `x-brew-article-ids` header).

### Printing (agent API)
- Pairing: Settings calls `POST /me/print-devices/pair-code` (one-time, 10 minutes) and opens `paperbrew://pair?code=…&api=<BETTER_AUTH_URL>`; the Mac exchanges the code at `POST /agent/pair` for a bearer token. One Mac per user (pairing revokes the others). `api` is the web origin, so the agent calls `<api>/api/agent/...`.
- `/agent/*` routes use `Authorization: Bearer <token>` (401 = revoked): `POST /agent/jobs/claim`, `GET /agent/issues/:id/pdf`, `POST /agent/issues/:id/result`. Contract in `apps/api/README.md`.
- Issue states: `queued` → `printing` → `printed` | `failed`. The stale sweep in `/cron/tick` fails an issue stuck `printing` for 30 minutes (`timed out`); a late success report still counts.
- `MAC_APP_URL` (API env) is the Mac app download link; Settings shows the Printer section only when it is set. The hosted `.dmg` must be built with the real web origin in `PAPERBREW_API_URL`.
- The Mac app (`apps/mac`) polls every 60 s, pairs via the `paperbrew://` link or **Paste code…**, and is one Mac per user.

## Open decisions
- Inbound provider: CloudMailin (decided 2026-11-01: free, no domain needed; addresses are `<id>+{token}@cloudmailin.net`). Adapter in `src/inbound/cloudmailin.ts`; the Postmark adapter (`src/inbound/postmark.ts`) is kept as the alternative. Both feed one shared handler in `src/app.ts`.
- `REQUIRE_KNOWN_SENDER` default: currently false, so the random address token is the secret.
- Product name: Paperbrew (decided 2026-11-01). The domain is TBD.

## Next tasks
1. ~~Sign-up~~ done: Better Auth creates the user and their three-word inbound address token (see `src/inbound/address.ts`).
2. Web paste-a-link endpoint, reusing `fetch_article` with `added_via = 'web'`.
3. ~~Articles API~~ done: list, remove, and address change. Rename is still to do.
4. Confirmation reply email ("Saved 2 articles"), and a reply on failure.
5. Magazine model plus print/PDF rendering. `GET /brew` already renders up to the 50 oldest ready articles to a PDF, flat or as an imposed A4 booklet (done); looks (presets) exist now (`paper_look`); the rest of the magazine model (reorder, rename, optional pages) is still to do.
6. ~~Gmail newsletters~~ done: opt-in sync into the library (hourly tick queues `gmail_sync`); the first connect also queues a one-off `gmail_starter` that saves up to 3 newsletters from the last 30 days.
7. ~~Brewing schedule (PR 2)~~ done: per-user days, hour, time zone and reading-time budget; the hourly tick queues `create_issue`, which stores a queued `issues` row. It is gated by `AUTOBREW_ENABLED` (default off, which also hides the Schedule settings) until printing exists.
8. ~~Print API and pairing~~ done (PR 3). ~~Mac app~~ built (PR 4). Remaining: Apple signing and notarization before giving it to non-technical users; hosting the `.dmg` and setting `MAC_APP_URL`. Follow-ups: the pairing dialog should show which account a code belongs to (needs a server code-preview endpoint: a link can carry an attacker's own code with the real host); show a 'printing' state; `createIssue` should check for a paired device before scheduling brews.
9. ~~First-run onboarding and the desk~~ done: `/app/welcome`, the desk at `/app` (scheduled and by-hand modes), `/app/issues`.
