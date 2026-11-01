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
6. **Out of scope for v1:** article view/edit screen, browser extension, mobile share sheet.

## Repo layout
npm workspaces monorepo. Run scripts from the root, or target one workspace with `-w @paperbrew/<name>`.
- `apps/api` (`@paperbrew/api`): backend, email capture. Paths in the next section are relative to it.
- `apps/web` (`@paperbrew/web`): frontend (website + web app). Vite + React + TypeScript. In dev, `/api/*` is proxied to the API on :8787 with the prefix stripped.
- `packages/*`: shared code (e.g. API types) once both apps need it. Don't import across `apps/` directly.
- Shared compiler options live in `tsconfig.base.json`; each workspace extends it.

## apps/api: backend, email capture
- Stack: TypeScript (ESM, NodeNext), Hono on Node 20+, Postgres (`pg`), Postmark inbound webhook, Mozilla Readability + jsdom, sanitize-html, zod.
- The job queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED`; there is no Redis.
- Flow: `POST /webhooks/postmark/inbound` stores the email in `inbound_emails` and queues `process_email`. `process_email` turns it into article rows: each link gets a `fetch_article` job, and a long newsletter is saved directly. See `apps/api/README.md` for the full rules.
- The decision logic lives in `src/inbound/plan.ts` and is pure, so it's tested without a database.

## Commands
All from the repo root:
- `npm install`: one install for every workspace (single root `package-lock.json`)
- `npm test`: tests in every workspace (api: vitest, no DB needed)
- `npm run typecheck`: every workspace
- `npm run db:migrate`: apply `apps/api/src/db/schema.sql` (idempotent)
- `npm run dev` / `npm run worker`: API and worker
- `npm run dev:web`: web app on :5173
- `.env` lives in `apps/api/` (copy `apps/api/.env.example`)

## Conventions
- Keep pure logic (planning, link cleaning, extraction) separate from I/O so it stays unit-testable. Add a test with every behavior change.
- Every outbound fetch goes through `src/fetch/safeFetch.ts` (SSRF guard). Never use bare `fetch` for user-supplied URLs.
- Stored article HTML must go through `sanitizeArticleHtml`.
- The webhook returns 200 for anything ignored on purpose and 5xx only for real failures, which Postmark retries.
- Schema changes are additive and idempotent (`if not exists`) until a migration tool is adopted.

## Hosting (decided)
- Vercel functions for both web and API (Node runtime), Supabase Postgres. The API entry is `apps/api/api/index.ts`, serving the Hono app from `src/app.ts`.
- Vercel has no long-lived worker: after the webhook stores a new email, jobs run inline via `waitUntil(drain(...))`, and a daily cron hits `/cron/run-jobs` to retry anything left over. `npm run worker` is local-only.

## Open decisions
- Inbound provider: Postmark for now. The adapter is isolated in `src/inbound/postmark.ts`.
- `REQUIRE_KNOWN_SENDER` default: currently false, so the random address token is the secret.
- Product name: Paperbrew (decided 2026-11-01). The domain is TBD.

## Next tasks
1. Sign-up: create the user and their inbound address token (random, 8+ chars `[a-z0-9]`).
2. Web paste-a-link endpoint, reusing `fetch_article` with `added_via = 'web'`.
3. Articles API: list, rename, delete.
4. Confirmation reply email ("Saved 2 articles"), and a reply on failure.
5. Magazine model plus print/PDF rendering (booklet imposition for A4).
