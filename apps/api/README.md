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
- `BETTER_AUTH_SECRET` (32+ chars) and `BETTER_AUTH_URL` (the **web** origin, e.g. `https://paperbrew-web.vercel.app`)
- Sign-in providers, each enabled only when both are set: `GOOGLE_CLIENT_ID`/`_SECRET`, `GITHUB_CLIENT_ID`/`_SECRET`, `REDDIT_CLIENT_ID`/`_SECRET`. Callback URLs are `$BETTER_AUTH_URL/api/auth/callback/{google|github|reddit}`.

## Security notes

- **Addresses are secret.** Tokens are three random words, so anyone who knows an address can add to that library. Set `REQUIRE_KNOWN_SENDER=true` to accept only the account email and verified aliases (`sender_aliases`). To rotate an address, set `disabled_at` and issue a new token.
- **Fetching is SSRF-safe.** IP-literal hosts are checked before connecting, and every DNS answer is checked at connect time, which also covers redirects and DNS rebinding. Private, loopback, link-local and metadata ranges are refused. Other limits: a 15 s timeout, a 5 MB cap, HTML only, and at most 6 redirects.
- **Stored HTML is sanitized** to print-friendly tags. There are no scripts, styles, classes or event handlers, and tracking pixels are dropped.
- **The webhook handles retries.** It always answers 200 for emails it deliberately ignores (unknown address, malformed payload), so the provider doesn't retry them. It answers 500 only on real failures, which CloudMailin and Postmark retry, and repeated deliveries are deduped (CloudMailin: `Message-ID` header or a content hash; Postmark: `MessageID`).

## Layout

```
src/
  app.ts                  Hono app: inbound webhooks, health, cron, auth, library and brew routes
  auth/                   Better Auth setup, enabled providers, user provisioning
  routes/library.ts       /me, /me/address, /articles (signed-in user)
  brew/                   GET /brew: articles to a PDF magazine
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
  db/schema.sql           tables
```

## Next steps

- Send a confirmation reply ("Saved 2 articles") and a reply for failures.
- Add the web paste-a-link endpoint. It reuses the `fetch_article` pipeline with `added_via = 'web'`.
- Rename articles (list and remove exist).
- Booklet imposition for `/brew` (A4 folded, two-sided).
- Sites that need JavaScript or are paywalled will fail extraction. Mark them clearly in the UI.
