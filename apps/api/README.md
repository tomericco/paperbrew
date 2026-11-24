# @paperbrew/api: email capture (MVP)

Users forward emails to a private address like `4fcb639be7306607cef6+amber-otter-lantern@cloudmailin.net`.
This service turns each email into saved articles that the magazine builder can use later.

```
CloudMailin ──POST──▶ /webhooks/cloudmailin/inbound ─┐
Postmark    ──POST──▶ /webhooks/postmark/inbound ────┴─▶ inbound_emails + job
                                                              │
                                     worker: process_email ◀──┘
                                       ├─ short email with links ──▶ article rows (pending) ──▶ fetch_article jobs
                                       └─ long forwarded newsletter ──▶ article row (ready)
                                     worker: fetch_article ──▶ SSRF-safe fetch ▶ Readability ▶ sanitize ▶ ready / failed
```

## What gets saved

| The user sends… | Result |
|---|---|
| A short email with links (`for the flight: https://…`) | Each article link is fetched and saved |
| A forwarded newsletter (250+ words after the forward header) | The newsletter itself becomes one article, titled with the original subject and attributed to the original sender. Links in the user's own note above the forward are saved too |
| A short forward ("thought you'd like this: <link>") | The links in it |
| A newsletter subscribed directly with the Paperbrew address | Saved as one article |

Links are cleaned before saving. Tracking parameters are stripped, Google and Outlook redirect wrappers are unwrapped, and unsubscribe, social and image links are skipped. After fetching, links are deduped by canonical URL, so the same article sent twice is stored once.

## Run locally

From `apps/api/` (or run the same scripts from the repo root, which forwards them here):

```bash
cp .env.example .env            # fill in DATABASE_URL and a long webhook password
npm install                     # installs the whole workspace
npm run db:migrate              # idempotent
npm run dev                     # API on :8787
npm run worker                  # in a second terminal
npm test                        # unit tests (no DB needed)
```

Users and their addresses are created on first sign-in (Better Auth). Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and at least one provider's client pair in `.env`, then sign in through the web app (`npm run dev:web`). To skip sign-in in a quick test, seed a user by hand:

```sql
insert into users (email) values ('you@example.com') returning id;
insert into inbound_addresses (user_id, token) values ('<id>', 'amber-otter-lantern');
```

Send a test email without a provider (CloudMailin's JSON Normalized shape; set `INBOUND_ADDRESS` to match):

```bash
curl -u $INBOUND_WEBHOOK_USER:$INBOUND_WEBHOOK_PASSWORD -H 'content-type: application/json' \
  -d '{"envelope":{"from":"you@example.com","to":"4fcb639be7306607cef6+amber-otter-lantern@cloudmailin.net","recipients":["4fcb639be7306607cef6+amber-otter-lantern@cloudmailin.net"]},"headers":{"subject":"test","message_id":"<t1@local>"},"plain":"https://paulgraham.com/greatwork.html"}' \
  localhost:8787/webhooks/cloudmailin/inbound
```

## Inbound email setup

Both webhooks share one set of basic-auth credentials, `INBOUND_WEBHOOK_USER` and `INBOUND_WEBHOOK_PASSWORD` (16+ chars). `{token}` in `INBOUND_ADDRESS` is each user's word token, e.g. `amber-otter-lantern`; plus-tags after it (`...+trip`) are ignored.

### CloudMailin (current: free, no domain needed)

1. Create an address in CloudMailin. The free plan gives one like `4fcb639be7306607cef6@cloudmailin.net`, and it accepts plus-addresses, so every user gets `4fcb639be7306607cef6+<token>@cloudmailin.net`.
2. Set the target URL, with the credentials embedded (CloudMailin sends them as basic auth): `https://<INBOUND_WEBHOOK_USER>:<INBOUND_WEBHOOK_PASSWORD>@paperbrew-api.vercel.app/webhooks/cloudmailin/inbound`.
3. Set the POST format to **JSON (Normalized)**.
4. Set `INBOUND_ADDRESS=4fcb639be7306607cef6+{token}@cloudmailin.net` (your own address id in place of `4fcb639be7306607cef6`).
5. The free plan rejects messages over 512 KB, so very large newsletters (usually ones with inline images) won't arrive.

Retries of one email are deduped by its `Message-ID` header, or, when it has none, by a hash of sender, date, subject and body.

### Postmark (alternative)

1. Create a server in Postmark and open its **Inbound** message stream.
2. Set the webhook URL with basic auth: `https://<INBOUND_WEBHOOK_USER>:<INBOUND_WEBHOOK_PASSWORD>@api.yourdomain.com/webhooks/postmark/inbound`.
3. Choose how addresses look, then set `INBOUND_ADDRESS` to that template:
   - Your own domain: set an inbound domain (e.g. `save.yourdomain.com`) and add the MX record Postmark gives you for it (`inbound.postmarkapp.com`). Every address on that domain reaches the webhook. `INBOUND_ADDRESS={token}@save.yourdomain.com`.
   - Postmark's shared address: `INBOUND_ADDRESS=a1b2c3+{token}@inbound.postmarkapp.com`, where `a1b2c3` is your server's inbound hash. Plus-tags after the token (`...+trip`) are ignored.

## Deploy (Vercel)

The API runs as one Vercel Node.js function (`api/index.ts`); `vercel.json` routes every path to it. There is no worker on Vercel: a new email triggers `drain()` via `waitUntil` once the webhook has answered, and a daily cron calls `GET /cron/run-jobs` to retry what's left. Set the project root to `apps/api` and these env vars:

- `POSTGRES_URL` (set by the Supabase integration) or `DATABASE_URL`
- `INBOUND_ADDRESS`
- `INBOUND_WEBHOOK_USER`, `INBOUND_WEBHOOK_PASSWORD`
- `CRON_SECRET` (Vercel sends it to the cron as a bearer token; without it the endpoint answers 401)
- `AUTOBREW_ENABLED` (optional, off by default until the print agent ships; set to `true` to test scheduled issues)
- `MAC_APP_URL` (optional: where the Mac app is downloaded. Settings shows the Printer section only when it is set)
- `BETTER_AUTH_SECRET` (32+ chars) and `BETTER_AUTH_URL` (the **web** origin, e.g. `https://paperbrew-web.vercel.app`)
- Sign-in providers, each enabled only when both are set: `GOOGLE_CLIENT_ID`/`_SECRET`, `GITHUB_CLIENT_ID`/`_SECRET`, `REDDIT_CLIENT_ID`/`_SECRET`. Callback URLs are `$BETTER_AUTH_URL/api/auth/callback/{google|github|reddit}`.

## Hourly tick (Supabase)

### What the tick does

Every hour Supabase calls `GET /cron/tick`. It queues a `gmail_sync` job for every active Gmail connection that doesn't already have one waiting. When `AUTOBREW_ENABLED=true` it also queues a `create_issue` job for every user with a paired Mac whose brewing schedule has an open slot (a user who already has one waiting is skipped; `create_issue` re-checks the slot under a row lock and queues an issue of the oldest ready articles that fit the reading-time budget). Scheduled brews only run for users with a paired Mac: `create_issue` re-checks this under the row lock and, with no active print device, does nothing (articles and `last_brew_at` untouched), so pairing later in the brew window still brews that slot. Then it runs the jobs that are due. It also fails any issue stuck `printing` for over 30 minutes (`error = 'timed out'`, reported as `stale`), even with `AUTOBREW_ENABLED` off, so it can be printed again. The daily Vercel cron (`/cron/run-jobs`) stays as a safety net for anything left over. Both endpoints need `Authorization: Bearer $CRON_SECRET` and answer 401 without it.

### Schedule it

Vercel Hobby crons run once a day, so the hourly schedule lives in Supabase. In the Supabase SQL editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Then schedule the call, with your real `CRON_SECRET` in place of `<CRON_SECRET>`:

```sql
select cron.schedule('paperbrew-tick', '5 * * * *', $$ select net.http_get(url := 'https://paperbrew-api.vercel.app/cron/tick', headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'), timeout_milliseconds := 300000) $$);
```

The route answers only after it has run the due jobs (up to about 50 s, and a long job can go past that), while `pg_net` gives up after 5 s by default, so the schedule sets `timeout_milliseconds := 300000` (the 300 s limit of a Vercel function).

The secret lives inside that SQL (in `cron.job`), so never commit the filled-in statement anywhere.

Check it, and remove it:

```sql
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 5;
select status_code, content, created from net._http_response order by created desc limit 5;
select cron.unschedule('paperbrew-tick');
```

`cron.job_run_details` only shows that the request was queued. `net._http_response` is what shows whether the API answered: look for `status_code` 200. A 401 means the `CRON_SECRET` in the schedule does not match the one set on the API. (`pg_net` keeps these responses for a few hours only.)

### Gmail setup (Google Cloud)

1. Enable the **Gmail API** in the Google Cloud project that owns the sign-in OAuth client.
2. On the OAuth consent screen, add the scope `https://www.googleapis.com/auth/gmail.readonly`.
3. On the existing OAuth client, add these authorized redirect URIs: `https://<web origin>/api/gmail/callback` and, for local dev, `http://localhost:5173/api/gmail/callback`.
4. While the app is in **Testing**, add yourself under **Test users**. Until Google verifies the app, only test users (up to 100) can connect. Testing mode also ends each connection after 7 days; Settings then shows "Reconnect Gmail". An Internal consent screen (Workspace projects) or publishing the app unverified avoids that. Unverified apps are capped at 100 users and show Google's warning screen.
5. Set the new env var `GMAIL_TOKEN_KEY` (encrypts the stored refresh tokens). Generate it with `openssl rand -base64 32`.

Gmail features appear only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GMAIL_TOKEN_KEY` are all set.

**Starter fetch.** The regular sync only looks at mail that arrives after the connect. So the first connect also queues a one-off `gmail_starter` job (`src/gmail/starter.ts`): it scans up to 40 messages from the last 30 days (`newer_than:30d -in:sent -in:chats -in:drafts`) through the same per-message pipeline, stops after 3 articles, and sets `gmail_connections.starter_done_at`, also when it found nothing, when Google revoked access (the connection is flagged `needs_reconnect` like the sync) and on the job's last failed attempt. The callback queues it only while `starter_done_at` is null, so a reconnect does not repeat it (a disconnect deletes the row, so connecting again afterwards does). `GET /me/gmail` reports `starter: { state: 'pending' | 'done', saved }`, where `saved` counts all of the user's `added_via = 'gmail'` articles.

**Return target.** `GET /gmail/connect?from=welcome` returns to `/app/welcome?gmail=connected|error` after Google; anything else returns to `/app/settings?gmail=...`. The target is signed into the OAuth state (`<userId>.<welcome|settings>.<expiresAt>.<hmac>`), so it cannot be changed on the way back.

## Print agent API

The Mac app (a local agent) prints queued issues. It talks to these routes; everything else in this section is its contract. Tables: `issues`, `print_devices` (one row per paired Mac, only the SHA-256 of its token), `print_pair_codes` (single-use codes, 10 minutes, only the hash).

**Pairing.** Signed-in Settings calls `POST /me/print-devices/pair-code` and opens the deep link `paperbrew://pair?code=XXXXXXXX&api=<url-encoded BETTER_AUTH_URL>`. The `api` value is the **web** origin, not the API's: the agent must call `<api>/api/agent/...` (the web proxy strips `/api`), never `<api>/agent/...`. One Mac per user: a successful pairing revokes the user's other devices.

| Route | Auth | Answers |
|---|---|---|
| `POST /agent/pair` `{ code, name? }` | none (the code is the credential) | `201 { token, deviceId }` (the token is shown once) · `400` bad body · `410` code expired, used or unknown |
| `POST /agent/jobs/claim` | bearer | `200 { id, layout }` for the user's oldest queued issue, now `printing` · `204` nothing queued |
| `GET /agent/issues/:id/pdf` | bearer | `200` the PDF · `204` nothing left to print (every article was archived since; the issue is **already marked printed**, so the Mac must **not** report a result) · `404` not this device's printing issue · `503` + `Retry-After: 30` while another brew renders (retry; the issue stays `printing`) · `500` render failed |
| `POST /agent/issues/:id/result` `{ ok, error? }` | bearer | `204` recorded · `404` not this device's printing issue, or already reported · `400` bad body |

- **Auth:** `Authorization: Bearer <token>` on every route except pairing. `401` means the device was revoked (or the token is unknown): stop and ask the user to pair again.
- **States:** `queued` → `printing` (claimed) → `printed` or `failed`. `ok: true` marks the issue printed and archives its articles; `ok: false` marks it failed with `error` (cut to 500 characters). A failed issue can be printed again from Settings.
- **Timeout:** an issue `printing` for over 30 minutes is failed with `error = 'timed out'` by the stale sweep in `/cron/tick`, so the Mac must report within 30 minutes of claiming. A success reported late for a `timed out` issue still counts (`ok: true` makes it `printed` and archives its articles); a late `ok: false` is a `404`.

## Library API (signed-in user)

Beyond the basics (`/me/address`, `/me/schedule`, `/articles`), these were added with onboarding:

- `PUT /me/settings` accepts `paperLook`: `broadsheet` (default), `fieldnotes` or `zine`, stored in `users.paper_look`. The renderer applies it to `GET /brew` and to the print agent's PDF. `GET /me` returns it as `paperLook`.
- `GET /me` also returns `needsOnboarding`. It is computed, never stored: `users.onboarded_at` is null **and** the user has no articles (archived and not-ready ones count), no Gmail connection, no active print device and brew is not enabled. `POST /me/onboarding/complete` sets `onboarded_at` (idempotent, `204`).
- `GET /brew?ids=a,b,c` brews only those articles: at most 50 UUIDs, taken from the caller's ready, unarchived articles, oldest first (`created_at` ascending). `400` on a bad list. Without `ids` it brews at most the 50 oldest ready, unarchived articles. Either way the `x-brew-article-ids` response header lists the ids that went into the PDF, in brew order.
- `GET /me/next-issue` previews what the next scheduled issue holds: `{ ids, minutes, budgetMinutes }`. Read-only (no rollover, no writes), same pick rule as `create_issue` (oldest first, picked until the reading-time budget is full), and it works whether or not the schedule is on.
- `GET /articles` rows carry `readingMinutes` (null when unknown; counts as 1 minute when picking).

## Security notes

- **Addresses are secret.** Tokens are three random words, so anyone who knows an address can add to that library. Set `REQUIRE_KNOWN_SENDER=true` to accept only the account email and verified aliases (`sender_aliases`). To rotate an address, set `disabled_at` and issue a new token.
- **Fetching is SSRF-safe.** IP-literal hosts are checked before connecting, and every DNS answer is checked at connect time, which also covers redirects and DNS rebinding. Private, loopback, link-local and metadata ranges are refused. Other limits: a 15 s timeout, a 5 MB cap, HTML only, and at most 6 redirects.
- **Stored HTML is sanitized** to print-friendly tags. There are no scripts, styles, classes or event handlers, and tracking pixels are dropped.
- **The webhook handles retries.** It always answers 200 for emails it deliberately ignores (unknown address, malformed payload), so the provider doesn't retry them. It answers 500 only on real failures, which CloudMailin and Postmark retry, and repeated deliveries are deduped (CloudMailin: `Message-ID` header or a content hash; Postmark: `MessageID`).

## Layout

```
src/
  app.ts                  Hono app: inbound webhooks, health, cron, auth, library, brew and gmail routes
  auth/                   Better Auth setup, enabled providers, user provisioning
  gmail/                  Gmail newsletters: connect, token storage, sync, classifier
  cron/tick.ts            hourly tick: queues a gmail_sync per active connection and (AUTOBREW_ENABLED) a create_issue per due schedule
  schedule/               brewing schedule: slot maths (schedule.ts), issue picking (pick.ts), create_issue job (createIssue.ts)
  routes/library.ts       /me, /me/address, /me/settings, /me/schedule, /articles (signed-in user)
  print/devices.ts        pairing: /me/print-devices (pair-code, list, remove), POST /agent/pair, requireDevice (bearer-token middleware)
  print/agent.ts          the Mac app's routes: /agent/jobs/claim, /agent/issues/:id/pdf and /result
  print/issues.ts         GET /me/issues (last 10), POST /me/issues/:id/reprint (failed issue back to queued; 409 if nothing is left)
  print/secrets.ts        pair codes, device tokens, sha256
  uuid.ts                 UUID_RE, shared by the routes that take an id in the path
  brew/                   GET /brew: articles to a PDF magazine
  brew/issuePdf.ts        renderIssuePdf: articles to a flat or booklet PDF stream (GET /brew and the print agent)
  server.ts               local server (npm run dev)
  inbound/cloudmailin.ts  CloudMailin JSON (Normalized) payload → InboundEmail
  inbound/postmark.ts     Postmark payload → InboundEmail (add other providers next to these)
  inbound/address.ts      address template, word tokens, recipient → token
  inbound/plan.ts         what to save from an email (forward detection, newsletter vs links)
  links/                  URL cleaning, article-link filtering
  fetch/                  SSRF-safe fetcher
  extract/                Readability extraction + sanitizing
  pipeline/               process_email, fetch_article
  jobs/                   Postgres job queue (SKIP LOCKED), runner (runOne, drain), local worker
  db/schema.sql           tables (incl. issues, print_devices, print_pair_codes)
```

## Next steps

- Send a confirmation reply ("Saved 2 articles") and a reply for failures.
- Add the web paste-a-link endpoint. It reuses the `fetch_article` pipeline with `added_via = 'web'`.
- Rename articles (list and remove exist).
- Booklet imposition for `/brew` (A4 folded, two-sided).
- Sites that need JavaScript or are paywalled will fail extraction. Mark them clearly in the UI.
