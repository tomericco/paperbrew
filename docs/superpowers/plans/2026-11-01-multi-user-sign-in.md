# Multi-user sign-in, addresses and /brew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can sign in with Google, GitHub or Reddit and gets a private forwarding address made of random words, which they can change. They see and remove their saved articles. A Brew button downloads a PDF magazine of all of them, in a newspaper style, from `/brew`.

**Architecture:** Better Auth runs inside the existing Hono API on the existing Postgres pool, in its own `auth_*` tables. When it creates a user, a hook creates our `users` row plus an `inbound_addresses` row with a word token such as `amber-otter-lantern`. Addresses come from a template, so they work on Postmark's default inbound address now and on our own domain later. `/brew` renders one print-ready HTML document from the user's ready articles with a pure renderer. Headless Chromium (`@sparticuz/chromium` + `puppeteer-core` on Vercel, local Chrome in dev) turns it into a PDF, which is returned as a download. The web app is three unstyled React pages, served on the same origin as `/api/auth/*`, so session cookies are first-party.

**Tech Stack:** Hono, `pg`, zod, vitest (existing); `better-auth` 1.7.x (new: API, plus `better-auth/react` on the web); Vite + React 19 (existing).

**Spec:** the user's requests in this session, with these decisions:
- Pages, all unstyled: **Home** (`/`) shows a short line and a Sign in button. **Sign in** (`/signin`) offers Google, GitHub and Reddit. **Library** (`/app`) shows the forwarding address with a way to change it, a link to brew the magazine, and the saved articles, each with a Remove button.
- There's no Hacker News sign-in.
- Every user gets their own address. Multi-tenant means every article query is scoped to the signed-in user.
- Address token = 3 random words joined by `-`. The user can change it, and it's unique across all users.
- `/brew` collects all the user's ready articles into one magazine in a newspaper-like default style, based on the print designs in `docs/design/the-issue/` (cover, contents, article opener). It returns a **PDF file** that the browser downloads when the user clicks Brew on the library page.
- Until there's a domain, addresses use Postmark's inbound address with a plus-tag, e.g. `a1b2c3+amber-otter-lantern@inbound.postmarkapp.com`. Later they become `amber-otter-lantern@save.paperbrew.com`. A config template covers both.

## Global Constraints

- Better Auth tables are `auth_users`, `auth_sessions`, `auth_accounts` and `auth_verifications` (via `modelName`). Never use a table named `user`.
- Better Auth `basePath` is `/api/auth`, and the API serves it at that exact path. All other API routes stay unprefixed (`/health`, `/me`, `/articles`, `/brew`), because the web rewrite strips `/api`.
- `BETTER_AUTH_URL` is the **web** origin (prod `https://paperbrew-web.vercel.app`, local `http://localhost:5173`). OAuth callbacks are `${BETTER_AUTH_URL}/api/auth/callback/{google|github|reddit}`.
- A social provider is enabled only when both of its env vars are set: `GOOGLE_CLIENT_ID`/`_SECRET`, `GITHUB_CLIENT_ID`/`_SECRET`, `REDDIT_CLIENT_ID`/`_SECRET`.
- Token format:
  - `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–40 chars, always lowercase.
  - Generated tokens are 3 words from `apps/api/src/inbound/words.ts`, picked with `crypto.randomInt`.
  - The list holds at least 1,024 distinct, common, inoffensive English words of 3–7 letters, a–z only (about 30 bits per token).
  - Reserved tokens are refused: `admin`, `abuse`, `postmaster`, `hostmaster`, `webmaster`, `root`, `support`, `help`, `info`, `hello`, `noreply`, `no-reply`, `security`, `billing`, `mail`, `paperbrew`.
- Tokens are unique across **all** rows, disabled ones included. A released address is never reassigned to another user.
- Providers without an email (Reddit) get a placeholder auth email `<provider>-<id>@users.paperbrew.invalid`. Our `users.email` stores `null` for those.
- Schema changes stay idempotent in `apps/api/src/db/schema.sql`. Every new table gets `enable row level security`.
- Keep pure logic in its own files with vitest tests, and no DB in tests. Article HTML is already sanitized. Every other user-derived string rendered into HTML (titles, authors, site names, URLs) is escaped.
- Do not bump `sanitize-html` or `htmlparser2` (see CLAUDE.md).

## Review Focus

1. **Someone lists, removes or brews another user's articles**, for example by guessing an id: they get 404 or only their own data. Every query includes `user_id = $currentUser`. Covered in Tasks 3–4 by reviewing the SQL.
2. **Two users want the same address, or a user picks one that differs only in case or spacing** (`Amber-Otter`): it's normalized to lowercase and trimmed, and the second claim gets 409 "That address is taken." Tests in Task 1 (normalize) and Task 3 (409 path, by reviewing the unique-violation handling).
3. **Mail to `A1B2C3+Amber-Otter-Lantern+Trip@Inbound.Postmarkapp.com`** (mixed case, extra tag) reaches `amber-otter-lantern`. Test in Task 1.
4. **An article title or author containing `<script>` or `&`** renders as text in `/brew`, and an article whose body is empty or still pending is left out. Test in Task 4.
6. **Article HTML holds an image pointing at an internal address** (`http://169.254.169.254/…`, `http://localhost`, a hostname that resolves to a private IP): the PDF renderer blocks the request, and the image is just missing. Chromium runs no JavaScript and loads nothing but images, fonts and the page itself. Test in Task 4.
5. **The same person signs in a second time:** no second `users` row and no second address. Provisioning runs only in the `user.create.after` hook. Covered in Task 2 by reviewing the hook.

---

### Task 1: Word tokens and the address template

**Files:**
- Create: `apps/api/src/inbound/address.ts`, `apps/api/src/inbound/words.ts`
- Delete: `apps/api/src/inbound/recipients.ts` (replaced; move or remove its tests)
- Modify:
  - `apps/api/src/config.ts`
  - `apps/api/src/app.ts` (webhook)
  - `apps/api/src/db/schema.sql`: replace the token check. Run `alter table inbound_addresses drop constraint if exists inbound_addresses_token_check`, then add `check (token ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(token) between 3 and 40)` under the same name.
  - `apps/api/.env.example`
- Test: `apps/api/test/address.test.ts`

**Interfaces:**
- Produces:
  - `formatAddress(template: string, token: string): string`
  - `addressTokens(recipients: string[], template: string): string[]`
  - `newToken(): string`
  - `normalizeToken(input: string): { ok: true; token: string } | { ok: false; error: string }`
  - `WORDS: readonly string[]`
  - Config `INBOUND_ADDRESS: string`: the template, lowercased; must contain `{token}` exactly once.

- [ ] **Step 1: Write failing tests:**
  - `formatAddress('a1b2c3+{token}@inbound.postmarkapp.com', 'amber-otter-lantern')` → `'a1b2c3+amber-otter-lantern@inbound.postmarkapp.com'`
  - `addressTokens(['A1B2C3+Amber-Otter-Lantern+Trip@Inbound.Postmarkapp.com'], 'a1b2c3+{token}@inbound.postmarkapp.com')` → `['amber-otter-lantern']`
  - `addressTokens(['amber-otter@save.paperbrew.com', 'AMBER-OTTER+x@save.paperbrew.com', 'friend@gmail.com', 'ab@save.paperbrew.com'], '{token}@save.paperbrew.com')` → `['amber-otter']` (deduped; `ab` is too short)
  - `addressTokens(['zzz+amber-otter@inbound.postmarkapp.com'], 'a1b2c3+{token}@inbound.postmarkapp.com')` → `[]`
  - `newToken()` matches `/^[a-z]{3,7}-[a-z]{3,7}-[a-z]{3,7}$/`, and 1,000 calls give at least 999 distinct values.
  - `WORDS` has at least 1,024 entries, all distinct, all matching `/^[a-z]{3,7}$/`.
  - `normalizeToken('  Amber-Otter ')` → `{ ok: true, token: 'amber-otter' }`
  - `normalizeToken('ab')`, `('-amber')`, `('amber--otter')`, `('amber otter')`, `('x'.repeat(41))` and `('postmaster')` → `ok: false`
- [ ] **Step 2:** Run `npm test -w @paperbrew/api`. Expected: FAIL.
- [ ] **Step 3: Implement `address.ts` and `words.ts`.**
  - Split the template at `{token}` into prefix and suffix. A lowercased recipient matches when it starts with the prefix and ends with the suffix.
  - The middle, cut at its first `+`, is the token if `normalizeToken` accepts it.
  - The error messages from `normalizeToken`:
    - "Use 3–40 letters, numbers and single hyphens."
    - "That address is reserved."
- [ ] **Step 4: Config and webhook.**
  - Replace `INBOUND_DOMAIN` with `INBOUND_ADDRESS` (zod: string, lowercased, refine "contains `{token}` once"). In `.env.example`, set `INBOUND_ADDRESS={token}@save.example.com`, with a comment showing the Postmark form.
  - The webhook uses `addressTokens(email.recipients, config.INBOUND_ADDRESS)`.
  - In the `REQUIRE_KNOWN_SENDER` branch, a null `account_email` means only `sender_aliases` can match.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck` from the root. Expected: pass.
- [ ] **Step 6: Commit** with the message `feat(api): word-based address tokens and configurable address template`.

### Task 2: Better Auth, user provisioning, social providers

**Files:**
- Create: `apps/api/src/auth/auth.ts` (the Better Auth instance), `apps/api/src/auth/providers.ts` (pure), `apps/api/src/auth/provision.ts`
- Modify: `apps/api/src/db/schema.sql`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/.env.example`, `apps/web/vercel.json`, `apps/web/vite.config.ts`
- Test: `apps/api/test/providers.test.ts`

**Interfaces:**
- Consumes: `newToken()` from Task 1.
- Produces:
  - `auth` (exported from `auth/auth.ts`).
  - `socialProviders(env: Record<string, string | undefined>)`, which returns the Better Auth `socialProviders` object containing only configured providers.
  - `enabledProviders(env): Array<'google' | 'github' | 'reddit'>`.
  - `accountEmail(authEmail: string): string | null`.
  - `placeholderEmail(provider: string, id: string): string`.
  - `provisionUser(authUser: { id: string; email: string }): Promise<void>`.
  - Route `GET /providers` → `{ providers: [...] }`, and Better Auth mounted at `/api/auth/*`.

- [ ] **Step 1: Write failing tests:**
  - `enabledProviders({})` → `[]`
  - `enabledProviders({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y', GOOGLE_CLIENT_ID: 'x' })` → `['github']`
  - `Object.keys(socialProviders({ REDDIT_CLIENT_ID: 'x', REDDIT_CLIENT_SECRET: 'y' }))` → `['reddit']`
  - `placeholderEmail('reddit', 'T2_Abc')` → `'reddit-t2_abc@users.paperbrew.invalid'`
  - `accountEmail('reddit-t2_abc@users.paperbrew.invalid')` → `null`, and `accountEmail('Me@Gmail.com')` → `'me@gmail.com'`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement `providers.ts`.** For Reddit, use `mapProfileToUser` to set `email: placeholderEmail('reddit', profile.id)` when the profile has no email. Check the installed `better-auth` types.
- [ ] **Step 4: Schema.**
  - Add idempotent SQL for the four `auth_*` tables. Generate the columns with `npx @better-auth/cli generate` against the config and adapt them to `create table if not exists`.
  - Run `alter table users alter column email drop not null` and `alter table users add column if not exists auth_user_id text unique`.
  - Enable RLS on the new tables.
- [ ] **Step 5: Implement `auth.ts`.**
  - Settings: `betterAuth({ database: pool, basePath: '/api/auth', secret, baseURL: BETTER_AUTH_URL, trustedOrigins: [BETTER_AUTH_URL], socialProviders: socialProviders(process.env), modelName mapping, databaseHooks.user.create.after: provisionUser })`.
  - Add `BETTER_AUTH_SECRET` (min 32) and `BETTER_AUTH_URL` (url) to the zod config and `.env.example`.
- [ ] **Step 6: Implement `provisionUser`.**
  - In one transaction, insert `users (auth_user_id, email = accountEmail(...))` with `on conflict (auth_user_id) do nothing`, then insert `inbound_addresses (user_id, token = newToken())`.
  - Retry with a fresh token up to 5 times on a unique violation (`isUniqueViolation`).
- [ ] **Step 7: Routes.**
  - Add `app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))`.
  - Add `app.get('/providers', ...)`.
- [ ] **Step 8: Keep the auth prefix through the proxies.**
  - In `apps/web/vercel.json`, add `{ "source": "/api/auth/(.*)", "destination": "https://paperbrew-api.vercel.app/api/auth/$1" }` **before** the general `/api/(.*)` rule.
  - In `vite.config.ts`, add a `/api/auth` proxy without the rewrite, ordered before `/api`.
- [ ] **Step 9:** Run `npm test` and `npm run typecheck`. Expected: pass.
- [ ] **Step 10: Commit** with the message `feat(api): Better Auth with Google, GitHub, Reddit and user provisioning`.

### Task 3: Signed-in user API: address and articles

**Files:**
- Create: `apps/api/src/routes/library.ts` (also exports `requireUser`)
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/library.test.ts`

**Interfaces:**
- Consumes: `auth` (Task 2) and `formatAddress`/`normalizeToken` (Task 1).
- Produces:
  - `requireUser`: Hono middleware that sets `c.get('userId'): string`, or returns 401 `{ error: 'unauthorized' }`.
  - `GET /me` → `{ address: string, token: string, email: string | null }`.
  - `PUT /me/address { token }` → 200 `{ address, token }`, 400 `{ error }` (from `normalizeToken`), or 409 `{ error: 'That address is taken.' }`.
  - `GET /articles` → `{ articles: Array<{ id, title, siteName, sourceUrl, status, wordCount, createdAt }> }`, newest first, max 200.
  - `DELETE /articles/:id` → 204, or 404.

- [ ] **Step 1: Write failing tests** with Hono `app.request` (no cookie, so no DB query is reached): `GET /me`, `PUT /me/address`, `GET /articles` and `DELETE /articles/00000000-0000-0000-0000-000000000000` each → 401.
- [ ] **Step 2:** Run the tests. Expected: FAIL (404).
- [ ] **Step 3: Implement `requireUser`.** It calls `auth.api.getSession({ headers: c.req.raw.headers })`, resolves `users.id` by `auth_user_id`, and sets `userId`.
- [ ] **Step 4: Implement the routes.**
  - `/me` returns the user's active address (`disabled_at is null`).
  - `PUT /me/address`:
    - Run `normalizeToken`. If the token is already the user's active one, return 200 unchanged.
    - In one transaction: if the token exists as one of this user's own disabled rows, re-enable it. Otherwise insert a new row; a unique violation → 409. Then set `disabled_at = now()` on the previous active row.
  - `DELETE /articles/:id` validates the uuid (anything else → 404) and runs `delete from articles where id = $1 and user_id = $2`. `rowCount` 0 → 404.
  - Every query is filtered by `user_id`.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck`. Expected: pass.
- [ ] **Step 6: Commit** with the message `feat(api): address change and articles list/remove for the signed-in user`.

### Task 4: `/brew` magazine PDF

**Files:**
- Create:
  - `apps/api/src/brew/render.ts` (pure)
  - `apps/api/src/brew/pdf.ts` (Chromium)
  - `apps/api/src/brew/requestPolicy.ts` (pure)
  - `apps/api/src/brew/route.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/vercel.json` (set the function's `memory: 2048` and `maxDuration: 60`), `apps/api/.env.example` (`CHROME_PATH`, local only)
- Add dependencies: `npm install puppeteer-core @sparticuz/chromium -w @paperbrew/api`, with versions that match each other per the `@sparticuz/chromium` README.
- Test: `apps/api/test/brew.test.ts`, `apps/api/test/requestPolicy.test.ts`
- Reference (read first): `docs/design/the-issue/Cover.dc.html`, `Contents.dc.html` and `ArticleOpener.dc.html`. These are design mockups; take their typography, spacing and structure, not their markup format.

**Interfaces:**
- Consumes: `requireUser` (Task 3).
- Produces:
  - `renderMagazine(input: { articles: BrewArticle[]; date: Date }): string`, where `BrewArticle = { title: string | null; author: string | null; siteName: string | null; sourceUrl: string | null; readingMinutes: number | null; contentHtml: string | null }`.
  - `htmlToPdf(html: string): Promise<Uint8Array>`.
  - `allowRendererRequest(url: string, resolvedAddresses: string[]): boolean`.
  - `GET /brew` → `application/pdf` with `content-disposition: attachment; filename="paperbrew-YYYY-MM-DD.pdf"`. The PDF holds the signed-in user's `status = 'ready'` articles, oldest first, max 50. With zero articles, it holds the cover plus "Nothing to brew yet. Forward some articles first."

- [ ] **Step 1: Write failing tests:**
  - With two articles, the output contains `<h1` "Paperbrew", both titles in the contents in order, and both article bodies.
  - The date renders as `Sunday, 1 November 2026` for `new Date('2026-11-01T12:00:00Z')`.
  - A title `<script>alert(1)</script> & co` renders as `&lt;script&gt;alert(1)&lt;/script&gt; &amp; co`.
  - Articles with null or empty `contentHtml` are skipped, in both the contents and the body.
  - The output contains `@page` with `size: A4`.
  - Reading time: the total shows on the cover as `About 1 h 25 min`, or `N min` when under an hour, and each article opener shows `N min read`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement `renderMagazine`.** It produces one self-contained HTML document with inline CSS and the designs' Google Fonts link (Source Serif 4 and IBM Plex Mono). The newspaper look:
  - `@page { size: A4; margin: 16mm 18mm }`, white paper, `#111` ink.
  - **Cover page:**
    - A mono uppercase line with "Issue" and the date. A 3px rule, then the masthead "Paperbrew" (serif 700, ~88px, tight tracking), a 1px rule, and the mono tagline "Your reading, collected and printed".
    - At the bottom: up to the first 3 titles with authors, "and N more" if there are more, then a 1px rule and a mono stats row: "N pieces" and the total reading time.
  - **Contents page:** a "Contents" heading over a 1px rule, then one row per article: index number (mono), the title (600) with "author · site" in grey, and reading minutes (mono).
  - **Each article** starts on a new page:
    - A mono kicker `02 · site · 9 min read`, an h1 of ~40px/700 with balanced wrapping, the author in italic, and a 1px rule.
    - The body is set in **two newspaper columns**: `column-count: 2; column-gap: 8mm; column-rule: 0.5pt solid #111`, serif ~10.5pt / 1.45, justified with hyphens.
    - The first paragraph gets a drop cap. Images are max 100% wide and avoid column breaks. `h2`/`h3` and figures avoid breaking inside.
    - It ends with a mono "Read it online: <url>" line.
  - Escape all text fields. Insert `contentHtml` as is, because it's sanitized at save time.
- [ ] **Step 4: Write failing tests for `allowRendererRequest`:**
  - Allowed: `('https://fonts.googleapis.com/css2?x', ['142.250.0.1'])` and `('https://example.com/a.jpg', ['93.184.216.34'])`. The `data:` image `('data:image/png;base64,AAAA', [])` is also allowed.
  - Refused:
    - `('http://169.254.169.254/latest', ['169.254.169.254'])`
    - `('http://localhost/x.png', ['127.0.0.1'])`
    - `('https://evil.test/x.png', ['10.0.0.5'])`
    - `('https://ok.test/x.png', ['93.184.216.34', '192.168.1.1'])` (any private answer refuses)
    - `('file:///etc/passwd', [])`
    - `('ftp://x.test/a', ['93.184.216.34'])`
  - Reuse the private-range checks in `apps/api/src/fetch/ip.ts`.
- [ ] **Step 5:** Run the tests. Expected: FAIL. Then implement `requestPolicy.ts` and run the tests again. Expected: PASS.
- [ ] **Step 6: Implement `htmlToPdf` in `pdf.ts`.**
  - Launching Chromium:
    - On Vercel (`process.env.VERCEL`): `puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true })`.
    - Locally: `executablePath: config.CHROME_PATH`. Default it to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
  - The page:
    - `setJavaScriptEnabled(false)` and `setRequestInterception(true)`.
    - For each request: let the initial `about:blank`/document through. For anything else, resolve the host with `dns.promises.lookup(host, { all: true })` and `continue()` only when `allowRendererRequest` passes, otherwise `abort()`. Cap the lookup at 3 s.
  - Rendering: `page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 })`, then `page.pdf({ preferCSSPageSize: true, printBackground: true })`.
  - Always close the browser in `finally`.
- [ ] **Step 7: Implement `route.ts`.** Add `GET /brew` behind `requireUser`.
  - It selects `title, author, site_name, source_url, reading_minutes, content_html` from `articles where user_id = $1 and status = 'ready'`, ordered by `created_at asc`, limit 50.
  - It renders, converts with `htmlToPdf`, and returns the bytes with `content-type: application/pdf`, the attachment `content-disposition` (date in UTC), and `cache-control: private, no-store`.
  - When rendering fails: 500 `{ error: "Couldn't brew the magazine. Try again." }`, with the error logged.
- [ ] **Step 8:** Run `npm test` and `npm run typecheck`. Expected: pass. If local Chrome exists, also run a one-off script (not committed) that calls `htmlToPdf(renderMagazine(<2 sample articles>))` and writes the PDF to a scratch path, then report the path and page count. Say so if Chrome isn't available.
- [ ] **Step 9: Commit** with the message `feat(api): /brew downloads saved articles as a newspaper-style PDF magazine`.

### Task 5: Web pages

**Files:**
- Create: `apps/web/src/auth.ts` (`export const authClient = createAuthClient()` from `better-auth/react`; the default base URL is same-origin `/api/auth`), `apps/web/src/pages/Home.tsx`, `SignIn.tsx`, `Library.tsx`
- Modify: `apps/web/src/App.tsx` (route by `location.pathname`: `/` → Home, `/signin` → SignIn, `/app` → Library, anything else → Home). No router library.
- Add dependency: `npm install better-auth -w @paperbrew/web`

**Interfaces:**
- Consumes: `/api/providers`, `/api/me`, `PUT /api/me/address`, `/api/articles`, `DELETE /api/articles/:id` and `/api/brew` (Tasks 2–4).

- [ ] **Step 1: Home.**
  - `<h1>Paperbrew</h1>`, then the line "Turn the articles you save into a magazine you print at home.", then `<a href="/signin">Sign in</a>`.
  - With a session (`authClient.useSession()`), show a link to `/app` instead.
- [ ] **Step 2: SignIn.**
  - For each provider from `/api/providers`, show a button "Continue with Google" / "GitHub" / "Reddit" that calls `authClient.signIn.social({ provider, callbackURL: '/app' })`.
  - With no providers, show "Sign-in isn't set up yet."
- [ ] **Step 3: Library.**
  - Without a session, `location.replace('/signin')`.
  - Otherwise show, in order:
    1. "Forward articles to: `<address>`".
    2. A "Change" toggle that reveals a text input prefilled with the token and a "Save" button → `PUT /api/me/address`. Show the API's error text on 400/409, and the new address on success.
    3. A "Brew" button:
       - It `fetch`es `/api/brew`, shows "Brewing…" and stays disabled while it waits.
       - On success, it turns the response into a Blob and downloads it through a temporary `<a download>`, using the filename from `content-disposition` (fallback `paperbrew.pdf`), then revokes the object URL.
       - On failure, it shows the API's error text.
    4. A "Sign out" button (`authClient.signOut()` → `/`).
    5. A `<ul>` of articles: the title linked to `sourceUrl` (plain text if null), then site name, status, and a "Remove" button that calls DELETE and drops the row from state.
  - Empty state: "No articles yet. Forward an email with a link to the address above."
- [ ] **Step 4:** Run `npm run typecheck` and `npm run build -w @paperbrew/web`. Expected: pass.
- [ ] **Step 5: Docs.**
  - In `CLAUDE.md`, mark next tasks 1 and 3 done. Add one line on auth and its env vars, and one on `/brew` (with booklet imposition still to do).
  - In `apps/api/README.md`, the Deploy env list adds `INBOUND_ADDRESS`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and the optional provider pairs, plus the callback URL format.
- [ ] **Step 6: Commit** with the message `feat(web): home, sign-in and library pages`.

### After the tasks (done by the controller, not a subagent)

- Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `INBOUND_ADDRESS` on Vercel, and remove `INBOUND_DOMAIN`. Apply the schema to Supabase, then push.
- Verify in production: `/api/auth/ok`, `/providers`, `/app` redirects to `/signin` when signed out, and `/me`, `/articles` and `/brew` answer 401 without a session.
- Check that the Chromium function stays under Vercel's size limit and renders a real PDF in production, using a seeded test user's session, then delete the test data.
- The user creates the OAuth apps and the Postmark inbound server. Their credentials go into Vercel env.
