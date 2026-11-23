# Autonomous brew: Gmail newsletters, a brewing schedule, and a print agent

## Why
Paperbrew's promise is a reading habit that happens without effort: collect, then an issue prints on its own
when you read best. Today every step is manual: forward each email, press Brew, download, print.
This makes the loop run by itself for one user (Tomer) first:
1. Paperbrew reads Gmail and keeps the editorial newsletters (essays, analysis), not receipts or promos.
2. On a schedule set in Settings, it builds an issue sized to a reading-time budget.
3. It sends that issue as a print request to the Paperbrew Mac app (a menu-bar app), which prints it.

## Goals
- Connect Gmail from Settings (read-only) and pick editorial newsletters **fully automatically**: no sender list to confirm.
- A brewing schedule in Settings: on/off, days of the week, an hour, time zone, reading-time budget.
- At brew time, an issue is created from saved articles (Gmail, forwarded and pasted alike) within the budget and queued for printing.
- A Paperbrew Mac app: download, open, click "Connect this Mac" in Settings. Users never use Terminal. It prints queued issues on the chosen printer (the Mac's default unless changed). Booklets print two-sided, short-edge.
- Printed articles are archived automatically (same `archived_at` as the manual Brew modal).

## Non-goals (this round)
- Google app verification and the CASA security audit. Until it's done, Google caps Gmail connections at 100 users (see "Google limits"). Verification needs a domain (still TBD) and starts later.
- Outbound email of any kind (decided: delivery is a print request, not an email).
- Windows/Linux apps, more than one paired Mac per user, auto-update of the Mac app.
- Apple signing and notarization are not built in this round, but they **block giving the app to non-technical users**: unsigned, macOS shows a "can't be opened" warning (an Apple Developer account, $99/yr, fixes it). The owner tests unsigned (right-click → Open once). The build config has signing ready behind env vars.
- The magazine model (reorder, rename, looks). Issues use the existing renderer and the user's `paper_layout`.
- Real-time Gmail push (Pub/Sub). Hourly polling is enough for a weekly-ish issue.

## Anti-goals
- A promo, receipt or notification printed as an article.
- An article silently lost. Anything taken out of the queue without printing stays visible in Archived, marked as not printed.
- Printing the same issue twice.
- Storing the bodies of emails Paperbrew decided not to keep.

## Constraints
- Vercel functions (300 s max) and Supabase Postgres. Vercel's built-in cron is daily, so the hourly tick comes from **Supabase pg_cron + pg_net** calling the API with `Bearer $CRON_SECRET`. The existing daily Vercel cron stays.
- Every outbound fetch to user-supplied URLs still goes through `safeFetch`. Gmail and Anthropic API calls are to fixed hosts and may use plain `fetch`/SDKs.
- Stored article HTML goes through `sanitizeArticleHtml` (via `extractNewsletter`, as today).
- Schema changes additive and idempotent in `schema.sql`.
- Phone-first web UI (375 px, 40 px touch targets, hover only under `@media (hover: hover)`).
- Pure logic separated from I/O, with tests for every behavior.

## Approaches (decided in conversation)
- **Picked: hourly tick + Mac app.** One hourly `/cron/tick` syncs Gmail for connected users and creates issues for users whose brew time passed. The Mac app polls for queued issues; the PDF renders when the app downloads it, reusing the brew renderer.
- Rejected: Gmail push via Pub/Sub. Instant arrival doesn't matter for a scheduled issue; it adds a GCP topic and a watch to renew every 7 days.
- Rejected: render at tick time and email the PDF. Email delivery was dropped; rendering every due user's issue inside the tick is heavy.
- Rejected: PrintNode (paid, a vendor in the core path). Rejected: a Terminal-installed script, because users aren't technical (user's call: build the Mac app now). Rejected: a native Swift app; it's smaller, but adds a second language to a TypeScript repo (my call: Electron).
- Newsletter picking: **fully automatic** (user's choice over confirming senders). Rules prefilter, then a **small free classifier model running inside the API** decides (user's choice). Rejected: Claude Haiku (not free); Ollama on the Mac (only works while the Mac is on, and asks every user to install a 2 GB model); free hosted tiers like Gemini or Groq (may train on what they're sent, a bad fit for email and for Google's later review).
- Issue size: **reading-time budget** (user's choice over "include everything").

## Design

### 1. Gmail connection (`apps/api/src/gmail/`)
**OAuth (my call: our own small flow, not Better Auth's `linkSocial`).** It works whatever provider the user signed in with, doesn't add `prompt=consent` to sign-in, and keeps disconnect simple.
- `GET /gmail/connect` (signed in): redirects to Google with scope `https://www.googleapis.com/auth/gmail.readonly` (plus `openid email` to learn the address), `access_type=offline`, `prompt=consent`, and a `state` bound to the session (signed with `BETTER_AUTH_SECRET`, 10-minute expiry).
- `GET /gmail/callback`: exchanges the code, stores the connection, enqueues a first `gmail_sync`, redirects to `/app/settings`.
- `DELETE /me/gmail`: revokes the token at Google, deletes the connection.
- Reuses `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Redirect URI: `${BETTER_AUTH_URL}/api/gmail/callback` (the web proxy strips `/api`).
- Refresh token encrypted at rest with AES-256-GCM, key from new env `GMAIL_TOKEN_KEY` (32 bytes, base64).
- On `invalid_grant` (revoked, or test-mode 7-day expiry): mark the connection `needs_reconnect`; Settings shows "Reconnect Gmail".

**Table `gmail_connections`**: `user_id` (pk, fk users), `google_email`, `refresh_token_enc`, `history_id text`, `status` (`active` | `needs_reconnect`), `connected_at`, `last_synced_at`, `last_error`.

**Sync (`gmail_sync` job, one per connected user per tick):**
- First sync: no backfill (user's call). Store the mailbox's current `historyId` from `users.getProfile`, and only mail arriving after connecting is considered.
- Later syncs: `history.list` from `history_id`, `historyTypes=messageAdded`. If Google answers 404 (history too old), fall back to `newer_than:2d`.
- Skip message ids already in `gmail_messages`. For each new one, fetch `format=metadata` (From, Subject, List-Unsubscribe, List-Id, Date) and run the **rules prefilter**. Only survivors are fetched `format=full`.
- Cap per sync: 200 messages (my call); the rest come next tick.

**Rules prefilter (pure, `gmail/rules.ts`):** keep only if all hold:
- has `List-Unsubscribe` or `List-Id`;
- sender not in the user's `gmail_blocked_senders`;
- after full fetch: text word count ≥ `NEWSLETTER_MIN_WORDS` (250), and prose-heavy: words outside link text ≥ 70% (my call, tunable constant).

**Classifier (`gmail/classify.ts`):** a small model running on CPU inside the API function with `@huggingface/transformers` (transformers.js, ONNX). Free, and mail never leaves our server.
- Task: zero-shot classification (an NLI model) of subject + the first ~400 words of plain text against these labels:
  - "an essay, analysis or reporting" (**editorial**)
  - "a sales promotion or discount"
  - "a product or company update"
  - "a receipt, notification or alert"
  - "a list of links"
- Editorial wins if its score is highest and ≥ 0.5. The threshold is a tunable constant.
- Reason stored = the winning label and its score, e.g. `promotion 0.71`.
- Model: the builder picks one, quantized and ≤ ~100 MB (e.g. a MobileBERT or DeBERTa-v3-xsmall MNLI export from the `Xenova/` hub). Downloaded on first use into `/tmp` and kept for the life of the warm instance, not bundled. That keeps the Vercel bundle under its limit next to Chromium.
- **Risk to check first in PR 1:** `onnxruntime-node` (pulled in by transformers.js) adds a large native binary. Deploy a spike to Vercel and check `/health` and one classification before building the rest, as with the sanitize-html pin.
- **Non-English mail (my call):** these models are English-only. When the text is mostly Hebrew or Arabic script (reuse `detectScript`), skip the model and keep the email if the rules filter passed it, with reason `rules-only (non-English)`.
- Label mapping and threshold logic are pure and tested. Model loading and inference sit behind one function that tests mock.
- If the model fails to load, the job retries (existing backoff); the message isn't marked seen until decided.

**Table `gmail_messages`**: `user_id`, `gmail_message_id`, `decision` (`rule_skip` | `not_editorial` | `editorial`), `reason`, `from_email`, `subject`, `seen_at`; pk `(user_id, gmail_message_id)`. No bodies stored for rejected mail.

**Saving an editorial newsletter:** decode the Gmail MIME parts (base64url, pure `gmail/mime.ts`) to `{ html, text }`, run `extractNewsletter`, insert into `articles` with `source_type='email'`, `added_via='gmail'` (extend the check constraint), status `ready`, and new columns `gmail_message_id` (unique per user) and `message_id` (the RFC `Message-ID` header).

**Same newsletter from Gmail and forwarded (my call: one article).**
- Before saving from Gmail, skip the message if the user already has an article whose `inbound_emails.message_id` matches.
- In `processEmail`, skip saving a newsletter whose original `Message-ID` matches an existing Gmail article. Where a forward doesn't carry the original id, match on cleaned subject + sender within 3 days.

**Block a sender:** when deleting a Gmail article in the web app, the confirm offers "Also skip future emails from <sender>". Adds a row to `gmail_blocked_senders (user_id, email)`.

### 2. Brewing schedule
**Columns on `users`:** `brew_enabled bool default false`, `brew_days smallint[]` (0 = Sunday … 6), `brew_hour smallint` (0–23), `brew_timezone text` (IANA, defaulted from the browser), `brew_budget_minutes int default 60`, `last_brew_at timestamptz`.
- Whole hours only, since the tick is hourly (my call).
- `PUT /me/settings` accepts these alongside `paperLayout` (all optional, zod-validated; time zone checked with `Intl`).

**Tick: `GET /cron/tick`** (Bearer `CRON_SECRET`, hourly from Supabase pg_cron at minute 5):
1. Enqueue `gmail_sync` for each `active` connection (skip one already queued).
2. For each user with `brew_enabled`, run pure `isBrewDue({ days, hour, timezone }, lastBrewAt, now)`: true when the latest scheduled slot ≤ now is after `last_brew_at` and less than 6 hours old. A long outage doesn't print stale issues. Enqueue `create_issue` for due users.
3. `drain(DRAIN)` as today.

**`create_issue` job:**
- Candidates: the user's `ready`, non-archived articles, oldest first.
- Pure `pickIssueArticles(candidates, budgetMinutes)`: add in order while the running total of `reading_minutes` stays ≤ budget. Always include the first article even if it alone is over budget. Cap at 50 (current brew cap).
- Rollover: each ready candidate left out gets `rollover_count += 1` (new column, default 0). One that reaches 2 is archived with `archive_reason='skipped'`. Printed ones get `archive_reason='printed'` on print success. Manual archive stays `null`.
- Archived tab shows skipped ones with a "Not printed" mark; "Move back" resets `rollover_count`.
- No candidates: no issue; just set `last_brew_at`.
- Otherwise insert an `issues` row and set `last_brew_at = now()` in the same transaction.

**Articles already in an open issue (my call):**
- Candidates exclude articles that are in a `queued` or `printing` issue. If the Mac sleeps through a brew, the next brew only takes newer articles, and nothing is printed twice.
- When an issue turns `failed`, its articles go back to the pool without raising `rollover_count`. "Print again" re-queues the failed issue, minus any of its articles already picked up by a later open issue.
- At render time (`GET /agent/issues/:id/pdf`), articles archived or deleted since the issue was created are left out. So a manual Brew plus archive in the meantime doesn't print them again. If none are left, the issue becomes `printed` with nothing to print, and the agent reports it.

**Table `issues`:** `id`, `user_id`, `created_at`, `layout` (snapshot of `paper_layout`), `article_ids uuid[]` (in order), `status` (`queued` | `printing` | `printed` | `failed`), `claimed_by` (device id), `claimed_at`, `printed_at`, `error`.

### 3. Print agent
**Pairing (no typing):**
- Settings → Printer → "Connect this Mac" calls `POST /me/print-devices/pair-code`. It returns a one-time code valid for 10 minutes (stored hashed).
- The web page then opens `paperbrew://pair?code=<code>&api=<API origin>`. The Mac app registers the `paperbrew://` protocol, so macOS hands it the link.
- The app calls `POST /agent/pair { code, name }`, where the name is the Mac's computer name. It gets back a long-lived device token (random 32 bytes; stored server-side as a SHA-256 hash).
- The web page polls the device list and shows "Connected" once the Mac appears.
- Fallback when the link doesn't open the app (app not installed yet): the page says "Install the app first", with the download button, and keeps the code alive. The app's window also has a "Paste code" field, a paste and not typing.
- Table `print_devices`: `id`, `user_id`, `name`, `token_hash`, `created_at`, `last_seen_at`, `revoked_at`. Plus `print_pair_codes (code_hash, user_id, expires_at, used_at)`.
- Settings lists the device with last seen, and "Remove".

**Agent API** (Bearer device token; updates `last_seen_at`):
- `POST /agent/jobs/claim`: atomically claims the user's oldest `queued` issue (`for update skip locked`), sets `printing`, returns `{ id, layout }` or 204.
- `GET /agent/issues/:id/pdf`: renders the issue's `article_ids` in order with `layout` (refactor `brew/route.ts` into a shared `buildIssuePdf(articles, layout)`). Articles deleted since are skipped.
- `POST /agent/issues/:id/result { ok, error? }`: `printed` archives the issue's articles (`archive_reason='printed'`); a failure sets `failed` with the error.
- A `printing` issue older than 30 minutes is marked `failed` by the tick, not re-queued (no double print). Settings shows failed issues with "Print again", which re-queues.

**The Mac app (`apps/mac`, new workspace `@paperbrew/mac`):** Electron + TypeScript, a menu-bar app with no Dock icon (`LSUIElement`).
- **Install:** a `.dmg` built with electron-builder (universal: Apple silicon + Intel). Settings' "Download for Mac" links to `MAC_APP_URL` (new env; where the file is hosted is the builder's call, e.g. Vercel Blob or a GitHub release).
- **Menu:**
  - a status line ("Ready · <printer>", "Printing your issue…", "Not connected", "Can't reach Paperbrew");
  - last printed issue with its date;
  - **Printer ▸** a list of the Mac's printers, from `lpstat`, default first;
  - **Start at login** (on by default, `app.setLoginItemSettings`);
  - Open Paperbrew (web Settings);
  - Disconnect;
  - Quit.
- **Storage:** the device token is kept with Electron `safeStorage` (macOS Keychain-backed). Settings (API origin, printer) go in the app's userData folder.
- **Loop every 60 s:** claim → download PDF to a temp file → `lp` → report result → delete the file.
- **`lp` arguments** come from a pure function: booklet → `-o sides=two-sided-short-edge -o media=A4`; flat → `-o media=A4`, sides left to the printer default; `-d <printer>` when one is chosen. The app runs `lp` itself, so the user never sees it.
- **"Printed"** means `lp` exited 0 (accepted by macOS printing), not that paper came out.
- **Notifications** (my call): a macOS notification "Your issue is printing" and, on failure, "Couldn't print your issue", with the reason.
- **Tests:** pure parts are unit-tested (lp args, deep-link parsing, status text, the claim/report loop with a mocked API and a mocked `lp`). The Electron shell is checked by hand on the owner's Mac.
- If the Mac is asleep at brew time, the issue waits and prints when it wakes (accepted).

### Who gets it (decided: every signed-in user)
- No allowlist. Every signed-in user sees the Schedule, Gmail and Printer sections.
- The Gmail section shows only when `GET /me` returns `gmailAvailable` (Google client id/secret and `GMAIL_TOKEN_KEY` all set).
- **Google limits (not ours):** `gmail.readonly` is a restricted permission. Until Google verifies the app, only people named as test users can connect (up to 100), or, if the consent screen is published unverified, up to 100 users who each see an "unverified app" warning. Anyone else is blocked by Google. Beyond 100, verification and the CASA audit are required.

### 4. Web (`apps/web`)
A Settings page at `/app/settings` (linked from the Library header). The paper layout control moves there. Sections:
- **Brewing schedule:** on/off, day chips, hour select, time zone (prefilled), budget (30 / 45 / 60 / 90 min). A line under it reads "Next issue: Saturday 07:00", computed with the same rule as `isBrewDue`.
- **Gmail:** Connect / connected address / last checked / "Reconnect" when needed / Disconnect. Recent decisions list (last 20 kept or skipped, with reason) so the user can see what the classifier is doing.
- **Printer:** "Download for Mac", then "Connect this Mac" (as above); a device row with last seen and Remove; recent issues with status and "Print again" on failures.
- `GET /me` returns the schedule, Gmail status and devices (or separate small endpoints; builder's call).
- Gmail articles show a small "Gmail" tag in the Saved list.

### 5. One-time setup (done by the owner, not code)
- Google Cloud project used for sign-in:
  - enable the Gmail API;
  - add the `gmail.readonly` scope on the consent screen;
  - add `https://<web origin>/api/gmail/callback` and the localhost equivalent as redirect URIs;
  - if the app is in Testing, add yourself as a test user. Testing-mode tokens expire after 7 days, so expect a weekly "Reconnect Gmail". If the consent screen is In production but unverified, connecting shows Google's "unverified app" warning instead, and tokens don't expire weekly.
- Env:
  - `GMAIL_TOKEN_KEY`
  - `CRON_SECRET` (already exists)
- Supabase: enable `pg_cron` and `pg_net`, schedule `net.http_get` to `/cron/tick` hourly with the bearer header. The SQL goes in the README, not in `schema.sql`, because it holds the secret.

### Tests
- Pure:
  - MIME decoding
  - rules prefilter
  - classifier label mapping, threshold and the non-English path
  - `isBrewDue` (time zones, DST change, outage window)
  - `pickIssueArticles` (budget, over-budget first article, cap)
  - rollover/skip rule
  - `lp` argument builder
  - token encryption round trip
  - OAuth `state` sign/verify
- Routes:
  - settings validation
  - pair-code expiry and single use
  - device-token auth
  - claim exclusivity (two claims, one wins)
  - result archives with the right reason
  - stale `printing` → `failed`
- Gmail calls and model inference are mocked at their boundary.

### Build order (three PRs)
1. Gmail connection, sync, classifier, saving articles, Gmail section in Settings.
2. Schedule, tick, issues, rollover, Schedule section in Settings.
3. Agent API, pairing, Printer section in Settings.
4. The Mac app (`apps/mac`) and its `.dmg`.

## Left to the builder
- The exact model, label wording and thresholds (start at 0.5 and a 70% prose ratio, then tune on real mail).
- Settings page layout within the existing design tokens. The design canvas has no Settings screen yet.
- Whether `GET /me` grows or Settings uses its own endpoints.
- The agent's logging, and the exact CLI shape beyond `pair` and `install`.
