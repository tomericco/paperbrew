# Gmail Newsletters Implementation Plan (PR 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user connects Gmail from a new Settings page; every hour Paperbrew pulls new mail, keeps editorial newsletters (rules + a small local zero-shot model) and saves them as articles.

**Architecture:**
- Our own OAuth flow (not Better Auth) stores an encrypted refresh token per user.
- An hourly `/cron/tick` (Supabase pg_cron) enqueues a `gmail_sync` job per connection on the existing Postgres job queue.
- Sync reads Gmail history since the stored `historyId`, filters by headers, then body rules, then a transformers.js NLI model running on CPU inside the function, and inserts `articles` rows via `extractNewsletter`.

**Tech Stack:** Hono, pg, zod, vitest, `@huggingface/transformers` (new), Node `crypto`, Gmail REST API via `fetch`, React (web).

**Spec:** `docs/superpowers/specs/2026-11-22-autonomous-brew-design.md` (sections 1, "Who gets it", 4, 5).

## Global Constraints
- Schema changes additive and idempotent in `apps/api/src/db/schema.sql` (`if not exists`, drop/re-add constraints).
- Pure logic separated from I/O; a test with every behavior. API tests run with no database (mock `pool.query` as `test/library.test.ts` does).
- Gmail and Google OAuth calls go to fixed Google hosts with plain `fetch`, not `safeFetch`.
- Stored article HTML goes through `extractNewsletter` (which sanitizes).
- Scope: `https://www.googleapis.com/auth/gmail.readonly` plus `openid email`; `access_type=offline`; `prompt=consent`.
- Redirect URI: `${BETTER_AUTH_URL}/api/gmail/callback` (the web proxy strips `/api`, so the API route is `/gmail/callback`).
- No backfill: on connect, store the profile's current `historyId`; only later mail is considered.
- Per-sync cap: 200 messages.
- Body rules: words ≥ `NEWSLETTER_MIN_WORDS` (250, from `inbound/plan.ts`); prose ratio ≥ 0.7.
- Classifier: editorial wins only if its score is highest and ≥ 0.5. Input = subject + first 400 words.
- Non-Latin script (`detectScript` ≠ `'latin'`): skip the model, keep it, reason `rules-only (non-English)`.
- No bodies stored for rejected mail.
- Available to every signed-in user. Until Google's app review is done, Google itself limits who can connect (see the spec's "Google limits" section). The Gmail UI shows only when `GET /me` says `gmailAvailable`.
- Web: works at 375 px with no sideways scroll, 40 px touch targets, hover styles only under `@media (hover: hover)`.
- `sanitize-html`/`htmlparser2` pins stay untouched.

## Review Focus
1. **A Gmail message with only an HTML part, or nested `multipart/mixed > multipart/alternative`.** Must still decode to text and html (Task 5 test `nested alternative inside mixed`, `html-only derives text`).
2. **Google returns no `refresh_token` on callback** (the user connected before and Google skipped consent). Must redirect to `/app/settings?gmail=error`, never store a connection that can't refresh (Task 7 test `callback without refresh_token`).
3. **The same newsletter subscribed with the Paperbrew address and arriving in Gmail.** Must save once (Task 8 test `skips a message whose Message-ID is already an inbound email`).
4. **A sync job running while the user disconnects.** Must stop quietly, not crash or recreate the row (Task 8 test `connection deleted mid-sync`).
5. **The model fails to download or load on a cold start.** The job retries and the message is not marked seen (Task 6 test `inference error propagates`).

---

## File Structure
- `apps/api/src/gmail/model.ts`: loads the zero-shot pipeline once per instance; `zeroShot()`. I/O only.
- `apps/api/src/gmail/crypto.ts`: AES-256-GCM token encryption. Pure.
- `apps/api/src/gmail/state.ts`: signed OAuth `state`. Pure.
- `apps/api/src/gmail/client.ts`: thin Google OAuth + Gmail REST calls, typed errors.
- `apps/api/src/gmail/mime.ts`: Gmail payload → headers, `{ html, text }`. Pure.
- `apps/api/src/gmail/rules.ts`: metadata and body prefilters. Pure.
- `apps/api/src/gmail/classify.ts`: labels, decision, non-English path. Pure apart from the injected model.
- `apps/api/src/gmail/sync.ts`: the `gmail_sync` job.
- `apps/api/src/gmail/routes.ts`: connect, callback, status, disconnect.
- `apps/api/src/gmail/available.ts`: `gmailAvailable`. Pure.
- `apps/api/src/inbound/dedupe.ts`: `findDuplicateNewsletter`, shared by Gmail and `processEmail`.
- `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/settings/GmailSection.tsx`: the new Settings page.

---

### Task 1: Spike: zero-shot model runs on Vercel

This is a gate. If it fails, stop and report to the user before any other task.

**Files:**
- Modify: `apps/api/package.json` (add `@huggingface/transformers`)
- Create: `apps/api/src/gmail/model.ts`
- Modify: `apps/api/src/app.ts` (add `GET /cron/model-check`)
- Modify: `apps/api/vercel.json` (only if tracing misses the ONNX runtime binaries)

**Interfaces:**
- Produces: `MODEL_ID: string`; `zeroShot(text: string, labels: string[]): Promise<{ labels: string[]; scores: number[] }>` (labels sorted by score, descending).

- [ ] **Step 1: Install** `npm install @huggingface/transformers -w @paperbrew/api`. Expected: the lockfile updates, `npm run typecheck` passes.
- [ ] **Step 2: Implement `model.ts`.**
  - Builds `pipeline('zero-shot-classification', MODEL_ID, { dtype: 'q8' })` once and reuses the promise. If it rejects, clear it so the next call retries.
  - Set `env.cacheDir = '/tmp/transformers-cache'` when `process.env.VERCEL`, and `env.allowLocalModels = false`.
  - Pick `MODEL_ID` from the `Xenova/` hub: an MNLI-tuned model whose quantized ONNX weights are ≤ ~100 MB. Try `Xenova/nli-deberta-v3-xsmall` first and fall back to `Xenova/mobilebert-uncased-mnli`.
- [ ] **Step 3: Add `GET /cron/model-check`.** Same bearer `CRON_SECRET` check as `/cron/run-jobs`. It runs `zeroShot('Our spring sale: 30% off every plan this weekend only.', ['an essay, analysis or reporting', 'a sales promotion or discount'])` and returns `{ ok: true, model: MODEL_ID, top: labels[0], ms }`.
- [ ] **Step 4: Check locally.** Run `npm run dev`, then `curl -H "Authorization: Bearer $CRON_SECRET" localhost:8787/cron/model-check`. Expected: `top` is `a sales promotion or discount`.
- [ ] **Step 5: Check on Vercel.** Push the branch and open the preview deployment of `apps/api`.
  - Expected: the build succeeds (bundle under the limit with Chromium), `/health` returns `{ ok: true }`, and `/cron/model-check` returns `ok: true`.
  - A second call (warm instance) takes under 2000 ms.
  - Record cold and warm `ms` in the PR description.
  - If the build fails on size or `onnxruntime-node` won't load, **stop**. Report the error and the measured sizes to the user.
- [ ] **Step 6: Commit** `feat(api): zero-shot model loader and /cron/model-check`.

### Task 2: Schema and config

**Files:**
- Modify: `apps/api/src/db/schema.sql`, `apps/api/src/config.ts`, `apps/api/.env.example`, `apps/api/src/routes/library.ts` (`GET /me`)
- Test: `apps/api/test/library.test.ts`

**Interfaces:**
- Produces:
  - config field `GMAIL_TOKEN_KEY: string | undefined`
  - `gmailAvailable(env: Record<string, string | undefined>): boolean` in `apps/api/src/gmail/available.ts`: true when `GMAIL_TOKEN_KEY`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are all set.
  - `GET /me` gains `gmailAvailable: boolean`

- [ ] **Step 1: Schema.** Append to `schema.sql`:
  - `gmail_connections` (`user_id uuid primary key references users on delete cascade`, `google_email text not null`, `refresh_token_enc text not null`, `history_id text not null`, `status text not null default 'active' check (status in ('active','needs_reconnect'))`, `connected_at`, `last_synced_at`, `last_error text`)
  - `gmail_messages` (`user_id`, `gmail_message_id text`, `decision text check in ('rule_skip','not_editorial','editorial')`, `reason text`, `from_email text`, `subject text`, `seen_at timestamptz default now()`, pk `(user_id, gmail_message_id)`)
  - `gmail_blocked_senders` (`user_id`, `email text`, pk both)
  - `articles` gets `gmail_message_id text` and `message_id text`
  - a unique index `articles_user_gmail_uq on articles (user_id, gmail_message_id) where gmail_message_id is not null`
  - re-create the `added_via` check as `in ('email','web','gmail')`. The current constraint is the inline default name `articles_added_via_check`; drop it `if exists` and re-add.
  - `enable row level security` on the three new tables.
- [ ] **Step 2: Config.** `GMAIL_TOKEN_KEY`: optional; when set it must decode from base64 to exactly 32 bytes (zod `refine`). Add it to `.env.example` with a comment (`openssl rand -base64 32`).
- [ ] **Step 3: Failing tests:**
  - `gmailAvailable` is false when any of the three is missing, true when all are set.
  - `GET /me` includes `gmailAvailable`.
- [ ] **Step 4: Implement**, adding `gmailAvailable` to the `GET /me` response.
- [ ] **Step 5:** Run `npm test -w @paperbrew/api`. Expected: PASS. Run `npm run db:migrate` against local DB twice. Expected: no errors (idempotent).
- [ ] **Step 6: Commit** `feat(api): gmail tables and config`.

### Task 3: Token encryption and OAuth state

**Files:**
- Create: `apps/api/src/gmail/crypto.ts`, `apps/api/src/gmail/state.ts`
- Test: `apps/api/test/gmailCrypto.test.ts`

**Interfaces:**
- Produces:
  - `encryptToken(plain: string, keyB64: string): string`, returning `v1.<iv>.<tag>.<ciphertext>` (base64url parts, 12-byte random IV)
  - `decryptToken(enc: string, keyB64: string): string` (throws on tamper)
  - `signState(userId: string, secret: string, now?: Date): string`
  - `verifyState(state: string, secret: string, now?: Date): { userId: string } | null` (HMAC-SHA256 over `userId.expiresAtMs`; 10-minute expiry)

- [ ] **Step 1: Failing tests:**
  - encrypt → decrypt round-trips
  - two encryptions of the same input differ
  - flipping one character of the ciphertext makes `decryptToken` throw
  - `verifyState(signState('u1', s))` → `{ userId: 'u1' }`
  - at `now + 11 min` → `null`
  - with another secret → `null`
  - a malformed string → `null`
- [ ] **Step 2: Run.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** with `node:crypto` (`createCipheriv('aes-256-gcm')`, `createHmac`, `timingSafeEqual`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): gmail token encryption and signed oauth state`.

### Task 4: Google OAuth and Gmail client

**Files:**
- Create: `apps/api/src/gmail/client.ts`
- Test: `apps/api/test/gmailClient.test.ts`

**Interfaces:**
- Produces:
  - `class GmailAuthError extends Error`: refresh got `invalid_grant`, or a 401 after refresh.
  - `class HistoryExpiredError extends Error`: `history.list` returned 404.
  - `type GmailPart = { mimeType: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number }; parts?: GmailPart[] }`
  - `type GmailMessage = { id: string; payload: GmailPart }`
  - `authUrl(state: string, redirectUri: string): string`
  - `exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string | null }>`
  - `refreshAccessToken(refreshToken: string): Promise<string>`
  - `revokeToken(token: string): Promise<void>`: never throws.
  - `getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }>`
  - `listHistory(accessToken: string, startHistoryId: string): Promise<{ messageIds: string[]; historyId: string }>`: follows `nextPageToken`, `historyTypes=messageAdded`, de-duplicates ids.
  - `listMessages(accessToken: string, q: string, max: number): Promise<string[]>`
  - `getMessage(accessToken: string, id: string, format: 'metadata' | 'full'): Promise<GmailMessage>`: metadata asks for `From`, `Subject`, `List-Unsubscribe`, `List-Id`, `Message-ID`.

- [ ] **Step 1: Failing tests** (stub `globalThis.fetch` with `vi.fn`):
  - `authUrl` contains `access_type=offline`, `prompt=consent`, `scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly` and the state.
  - `refreshAccessToken` on a 400 `{ error: 'invalid_grant' }` rejects with `GmailAuthError`; a 500 rejects with a plain `Error`.
  - `listHistory` on 404 rejects with `HistoryExpiredError`.
  - `listHistory` follows two pages and returns their combined unique ids and the last page's `historyId`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Uses `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` from `process.env` (as `auth/providers.ts` does). Endpoints:
  - `accounts.google.com/o/oauth2/v2/auth`
  - `oauth2.googleapis.com/token`
  - `oauth2.googleapis.com/revoke`
  - `gmail.googleapis.com/gmail/v1/users/me/...`
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): google oauth and gmail rest client`.

### Task 5: MIME decoding

**Files:**
- Create: `apps/api/src/gmail/mime.ts`
- Test: `apps/api/test/gmailMime.test.ts`

**Interfaces:**
- Consumes: `GmailPart`, `GmailMessage` (Task 4).
- Produces:
  - `header(msg: GmailMessage, name: string): string | null` (case-insensitive)
  - `decodeBody(payload: GmailPart): { html: string; text: string }`

- [ ] **Step 1: Failing tests** (build payloads inline with `Buffer.from(s).toString('base64url')`):
  - a single `text/plain` part gives `{ html: '', text }`.
  - `multipart/alternative` with plain + html gives both.
  - `nested alternative inside mixed`, plus a PDF attachment part with `filename: 'x.pdf'`: the attachment is ignored.
  - `html-only derives text`: `<p>Hello <b>world</b></p><style>p{}</style>` gives text `Hello world` (tags, `style`/`script` contents dropped, entities decoded, whitespace collapsed).
  - `header(msg, 'list-unsubscribe')` finds `List-Unsubscribe`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Depth-first walk. First `text/plain` and first `text/html` without a filename win. Derive text from html when there's no plain part.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): decode gmail message bodies`.

### Task 6: Rules and classifier decision

**Files:**
- Create: `apps/api/src/gmail/rules.ts`, `apps/api/src/gmail/classify.ts`
- Test: `apps/api/test/gmailRules.test.ts`, `apps/api/test/gmailClassify.test.ts`

**Interfaces:**
- Consumes: `zeroShot` (Task 1), `detectScript` (`brew/direction.ts`), `countWords`/`NEWSLETTER_MIN_WORDS` (`inbound/plan.ts`).
- Produces:
  - `senderEmail(from: string): string`: lowercased address out of `"Name <a@b>"`.
  - `passesMetadataRules(meta: { listUnsubscribe: string | null; listId: string | null; from: string }, blocked: Set<string>): { ok: boolean; reason: string }`. Reasons are `not-a-list`, `blocked-sender` or `ok`.
  - `PROSE_RATIO_MIN = 0.7`
  - `passesBodyRules(body: { html: string; text: string }): { ok: boolean; reason: string }`. Reasons are `too-short`, `mostly-links` or `ok`. Ratio = 1 − (words inside `<a>` text ÷ words in text).
  - `LABELS: readonly string[]`, exactly:
    - `'an essay, analysis or reporting'`
    - `'a sales promotion or discount'`
    - `'a product or company update'`
    - `'a receipt, notification or alert'`
    - `'a list of links'`
  - `EDITORIAL_LABEL = LABELS[0]`
  - `EDITORIAL_MIN_SCORE = 0.5`
  - `classifierInput(subject: string, text: string): string`: subject, newline, first 400 words.
  - `decide(result: { labels: string[]; scores: number[] }): { editorial: boolean; reason: string }`. Reason is `<short label> <score to 2dp>`; short labels are `editorial`, `promotion`, `update`, `notification` and `links`.
  - `classifyEmail(email: { subject: string; html: string; text: string }, infer?: typeof zeroShot): Promise<{ editorial: boolean; reason: string }>`

- [ ] **Step 1: Failing tests:**
  - `passesMetadataRules` with neither list header → `not-a-list`.
  - A blocked sender (case-insensitive) → `blocked-sender`.
  - `passesBodyRules` at 249 words → `too-short`.
  - 300 words where 120 are anchor text → `mostly-links`.
  - 300 prose words → `ok`.
  - `decide({ labels: [EDITORIAL_LABEL, …], scores: [0.62, …] })` → `{ editorial: true, reason: 'editorial 0.62' }`.
  - Editorial on top at 0.41 → `editorial: false`.
  - Promotion on top → `{ editorial: false, reason: 'promotion 0.71' }`.
  - `classifyEmail` with Hebrew text → `{ editorial: true, reason: 'rules-only (non-English)' }` and `infer` not called.
  - `inference error propagates`: `infer` rejects, so `classifyEmail` rejects.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): newsletter rules and editorial classifier`.

### Task 7: Connect, callback, status and disconnect routes

**Files:**
- Create: `apps/api/src/gmail/routes.ts`
- Modify: `apps/api/src/app.ts` (mount), `apps/api/src/jobs/queue.ts` (add `'gmail_sync'` to `JobType`; payload `{ id: userId }`)
- Test: `apps/api/test/gmailRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `GET /gmail/connect` → 302 to `authUrl`.
  - `GET /gmail/callback` → 302 to `/app/settings?gmail=connected` or `?gmail=error`.
  - `GET /me/gmail` → `{ connected: false }` or `{ connected: true, email, status, lastSyncedAt, recent: { from, subject, decision, reason, seenAt }[] }` (last 20 by `seen_at`).
  - `DELETE /me/gmail` → 204.
  - All behind `requireUser`. If `gmailAvailable(process.env)` is false, connect/callback answer 503 `{ error: 'gmail not configured' }`.

- [ ] **Step 1: Failing tests** (mock session, `pool.query` and `client.js`):
  - Connect returns 302 whose `location` has the state for this user.
  - Callback with a bad or expired state → 302 `?gmail=error`, no insert.
  - Callback whose state userId ≠ session user → `?gmail=error`.
  - `callback without refresh_token` → `?gmail=error`, no insert.
  - A good callback upserts `gmail_connections` with the encrypted token, `history_id` from `getProfile` and `status='active'`, then enqueues `gmail_sync` and redirects `?gmail=connected`.
  - `DELETE /me/gmail` calls `revokeToken` and deletes the row.
  - With Gmail not configured, connect and callback → 503.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The upsert is `on conflict (user_id) do update` (reconnect resets `status`, `last_error`, `history_id`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): gmail connect and disconnect`.

### Task 8: Sync job and duplicate detection

**Files:**
- Create: `apps/api/src/gmail/sync.ts`, `apps/api/src/inbound/dedupe.ts`
- Modify: `apps/api/src/jobs/runner.ts` (dispatch `gmail_sync`; a `GmailAuthError` is handled inside sync, never retried), `apps/api/src/pipeline/processEmail.ts` (newsletter path calls `findDuplicateNewsletter`)
- Test: `apps/api/test/gmailSync.test.ts`, `apps/api/test/dedupe.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6, `extractNewsletter`, `cleanSubject`, `displayName`.
- Produces:
  - `syncGmail(userId: string, deps?: { gmail?: typeof import('./client.js'); classify?: typeof classifyEmail }): Promise<{ seen: number; saved: number }>`
  - `findDuplicateNewsletter(db: Db, userId: string, n: { messageId: string | null; title: string }): Promise<boolean>`. True when either:
    - the user has an `inbound_emails` row or a Gmail article with that `message_id`;
    - or there's an article whose lower(title) = lower(n.title) created in the last 3 days by the other path (`added_via` differs).

The algorithm, which the tests pin:
1. Load the connection. If it's missing, return `{ seen: 0, saved: 0 }`. Decrypt the token and refresh it. On `GmailAuthError`, set `status='needs_reconnect'` and `last_error`, then return.
2. Get ids from `listHistory(history_id)`. On `HistoryExpiredError`, use `listMessages('newer_than:2d -in:sent -in:chats -in:drafts', 200)` and the profile's `historyId`.
3. Drop ids already in `gmail_messages`, then keep the first 200. Load the blocked senders.
4. For each id: fetch metadata.
   - Fails `passesMetadataRules` → insert `gmail_messages` (`rule_skip`, reason).
   - Otherwise fetch full and `decodeBody`. Fails `passesBodyRules` → `rule_skip`.
   - Otherwise `classifyEmail`. Not editorial → `not_editorial`.
   - Editorial and `findDuplicateNewsletter` true → `rule_skip` with reason `duplicate`.
   - Editorial otherwise → `extractNewsletter({ html, text, title: cleanSubject(subject), author: displayName(from) })`, insert the article (`source_type='email'`, `added_via='gmail'`, `status='ready'`, `gmail_message_id`, `message_id`) and the `gmail_messages` row (`editorial`) in one transaction.
5. Advance `history_id` and set `last_synced_at = now()`, but only after every message was recorded. If more than 200 ids remained, leave `history_id` unchanged. The skip-seen step makes the rerun cheap.

- [ ] **Step 1: Failing tests** (fake `gmail` deps object, `pool.query`/`pool.connect` spies):
  - `invalid_grant` → `needs_reconnect`, resolves.
  - `HistoryExpiredError` → `listMessages` called with `newer_than:2d -in:sent -in:chats -in:drafts`.
  - Metadata without list headers → `rule_skip`, `getMessage(…, 'full')` not called.
  - Editorial → article insert with `added_via` `'gmail'`.
  - Not editorial → no article insert, `not_editorial` recorded.
  - `skips a message whose Message-ID is already an inbound email`.
  - `connection deleted mid-sync`: the final update affects 0 rows, and the call still resolves.
  - 250 new ids → only 200 processed, `history_id` not advanced.
  - `findDuplicateNewsletter`: matches on message_id; matches on same title from the other path within 3 days; no match at 4 days.
  - `processEmail` skips the newsletter insert when `findDuplicateNewsletter` returns true (extend the existing pattern in `resave.test.ts`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w @paperbrew/api`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(api): gmail sync job keeps editorial newsletters`.

### Task 9: Hourly tick and Supabase cron

**Files:**
- Create: `apps/api/src/cron/tick.ts`
- Modify: `apps/api/src/app.ts` (add `GET /cron/tick`, calling `tick()` then `drain`), `apps/api/README.md` (setup section)
- Test: `apps/api/test/tick.test.ts`

**Interfaces:**
- Produces: `GET /cron/tick` (bearer `CRON_SECRET`) → `{ ok: true, gmail: number, ran: number }`. PR 2 adds brews to the same handler, so keep the per-step work in a `tick()` function in `src/cron/tick.ts` that returns these counts.

- [ ] **Step 1: Failing tests:**
  - Without the bearer → 401.
  - With it: one `insert into jobs` for each `active` connection that has no undone `gmail_sync` job for that user (one SQL `insert … select … where not exists`), then `drain` runs.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: README.** Add "Hourly tick (Supabase)" with:
  - the SQL to enable `pg_cron`/`pg_net`;
  - `select cron.schedule('paperbrew-tick', '5 * * * *', $$ select net.http_get(url := 'https://paperbrew-api.vercel.app/cron/tick', headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')) $$);`
  - the Google Cloud steps from spec section 5;
  - the new env var `GMAIL_TOKEN_KEY` (`openssl rand -base64 32`).
- [ ] **Step 6: Commit** `feat(api): hourly tick syncs gmail`.

### Task 10: Settings page with Gmail, Gmail tag, block sender

**Files:**
- Create: `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/settings/GmailSection.tsx`
- Modify:
  - `apps/web/src/App.tsx` (route `/app/settings`)
  - `apps/web/src/pages/Library.tsx` (header link "Settings"; delete flow)
  - `apps/web/src/pages/article.tsx` (`addedVia` and a "Gmail" tag in `articleMeta`)
  - `apps/web/src/styles.css`
  - `apps/api/src/routes/library.ts` (`GET /articles` returns `addedVia`; `DELETE /articles/:id?blockSender=1`)
- Test: `apps/api/test/library.test.ts` (API parts)

**Interfaces:**
- Consumes: `GET /me` `gmailAvailable`; `GET/DELETE /api/me/gmail`; `GET /api/gmail/connect`.
- Produces:
  - `DELETE /articles/:id?blockSender=1`: for a Gmail article, inserts its `gmail_messages.from_email` into `gmail_blocked_senders` (`on conflict do nothing`) before deleting.
  - `Settings.tsx` renders one section component per area, so PRs 2–3 add `ScheduleSection` and `PrinterSection` next to `GmailSection`.

- [ ] **Step 1: Failing API tests:**
  - `GET /articles` rows include `addedVia`.
  - `DELETE …?blockSender=1` on a Gmail article inserts the blocked sender.
  - Without the flag, no insert.
- [ ] **Step 2: Implement the API.**
- [ ] **Step 3: Run.** Expected: PASS.
- [ ] **Step 4: Build the web parts.**
  - Settings page: signed-in guard as in `Library`; a "Paper" section with the layout radio (reuse the `LAYOUTS` copy and `PUT /api/me/settings`); `GmailSection` only when `me.gmailAvailable`.
  - `GmailSection` has four states:
    - not connected: "Connect Gmail" link to `/api/gmail/connect`;
    - connected: address, "Last checked <relative time>", Disconnect;
    - `needs_reconnect`: a warning line plus "Reconnect Gmail";
    - and a "Recent decisions" list (`Kept` / `Skipped` + reason + subject).
  - Read `?gmail=connected|error` once and show a one-line notice.
  - Library: keep the existing layout split-menu on the Brew button (my call: the spec said "moves", but removing it from Brew costs a click at brew time), and add a "Settings" header action.
  - Deleting a Gmail article shows a native `confirm('Also skip future emails from <site name>?')`; yes adds `?blockSender=1`.
- [ ] **Step 5: Verify in the browser.**
  - `npm run dev` + `npm run dev:web` (preview tool, `.claude/launch.json`); sign in and open `/app/settings`.
  - Check at 375 px and desktop: no sideways scroll, buttons ≥ 40 px tall.
  - Connect Gmail end to end with your own Google account (listed as a test user while the app is in testing).
  - Send yourself a long newsletter-style email from a list. Then `curl` `/cron/tick` with the bearer and the item appears under Recent decisions (and in Saved if kept).
  - Take a screenshot as proof.
- [ ] **Step 6: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(web): settings page with gmail connection`.
