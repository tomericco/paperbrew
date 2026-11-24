-- Paperbrew MVP schema: users, their private forwarding addresses,
-- the raw inbound emails, the articles they produce, and a small job queue.

create extension if not exists pgcrypto;

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  created_at  timestamptz not null default now()
);
-- Every user signs in through Better Auth (auth_users below). The email is null when the
-- provider gives none (Reddit), so it's only a contact hint, not an identity.
alter table users alter column email drop not null;
alter table users add column if not exists auth_user_id text unique;
alter table users add column if not exists paper_layout text not null default 'flat';
alter table users drop constraint if exists users_paper_layout_check;
alter table users add constraint users_paper_layout_check check (paper_layout in ('flat', 'booklet'));
alter table users add column if not exists paper_look text not null default 'broadsheet';
alter table users drop constraint if exists users_paper_look_check;
alter table users add constraint users_paper_look_check check (paper_look in ('broadsheet', 'fieldnotes', 'zine'));
-- Set once, when the user finishes (or leaves) the guided onboarding.
alter table users add column if not exists onboarded_at timestamptz;

-- Each user gets a mailbox token (three random words, e.g. amber-otter-lantern),
-- delivered to INBOUND_ADDRESS with {token} filled in.
-- Rotating the address = disable the old row, insert a new one.
create table if not exists inbound_addresses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token        text not null unique,
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz
);
-- Word tokens: two or more words joined by single hyphens, 3-40 chars. Replaces the older
-- letters-only check; idempotent.
alter table inbound_addresses drop constraint if exists inbound_addresses_token_check;
alter table inbound_addresses add constraint inbound_addresses_token_check
  check (token ~ '^[a-z0-9]+(-[a-z0-9]+)+$' and length(token) between 3 and 40);

-- Extra sender addresses a user may forward from (used when REQUIRE_KNOWN_SENDER=true).
create table if not exists sender_aliases (
  user_id      uuid not null references users(id) on delete cascade,
  email        text not null,
  verified_at  timestamptz,
  primary key (user_id, email)
);

create table if not exists inbound_emails (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  provider             text not null,
  provider_message_id  text not null,
  message_id           text,
  from_email           text not null,
  subject              text not null default '',
  received_at          timestamptz not null default now(),
  payload              jsonb not null,          -- normalized email, attachments stripped
  status               text not null default 'received'
                       check (status in ('received', 'processed', 'failed')),
  result               jsonb,                   -- what we decided: links, newsletter, nothing
  error                text,
  unique (provider, provider_message_id)
);

create table if not exists articles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  source_type       text not null check (source_type in ('link', 'email')),
  source_url        text,                       -- link the user sent (null for newsletters)
  canonical_url     text,                       -- dedupe key for links
  inbound_email_id  uuid references inbound_emails(id) on delete set null,
  added_via         text not null default 'email' check (added_via in ('email', 'web')),
  title             text,
  author            text,
  site_name         text,
  excerpt           text,
  content_html      text,                       -- sanitized, print-ready HTML
  text_content      text,
  word_count        integer,
  reading_minutes   integer,
  lead_image_url    text,
  published_at      text,
  status            text not null default 'pending'
                    check (status in ('pending', 'ready', 'failed')),
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists articles_user_canonical_uq
  on articles (user_id, canonical_url) where canonical_url is not null;
create unique index if not exists articles_user_email_uq
  on articles (user_id, inbound_email_id) where source_type = 'email';
create index if not exists articles_user_created_idx on articles (user_id, created_at desc);
alter table articles add column if not exists archived_at timestamptz;
create index if not exists articles_user_archived_idx
  on articles (user_id, archived_at desc) where archived_at is not null;

-- Brewing schedule: when a user's magazine is built automatically. Days are 0 = Sunday ... 6;
-- brew_hour is a whole hour in the IANA brew_timezone. last_brew_at is the last time an issue was queued.
alter table users add column if not exists brew_enabled boolean not null default false;
alter table users add column if not exists brew_days smallint[] not null default '{}';
alter table users add column if not exists brew_hour smallint not null default 7;
alter table users drop constraint if exists users_brew_hour_check;
alter table users add constraint users_brew_hour_check check (brew_hour between 0 and 23);
alter table users add column if not exists brew_timezone text not null default 'UTC';
alter table users add column if not exists brew_budget_minutes int not null default 60;
alter table users drop constraint if exists users_brew_budget_minutes_check;
alter table users add constraint users_brew_budget_minutes_check check (brew_budget_minutes in (30, 45, 60, 90));
alter table users add column if not exists last_brew_at timestamptz;

-- How many issues an article has been left out of, and why it was archived.
alter table articles add column if not exists rollover_count int not null default 0;
alter table articles add column if not exists archive_reason text;
alter table articles drop constraint if exists articles_archive_reason_check;
alter table articles add constraint articles_archive_reason_check check (archive_reason in ('printed', 'skipped'));

create table if not exists jobs (
  id            bigserial primary key,
  type          text not null,
  payload       jsonb not null,
  run_at        timestamptz not null default now(),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  locked_at     timestamptz,
  done_at       timestamptz,
  last_error    text
);
create index if not exists jobs_ready_idx on jobs (run_at) where done_at is null;

-- Gmail newsletter sync (read-only OAuth). The refresh token is stored encrypted (GMAIL_TOKEN_KEY).
create table if not exists gmail_connections (
  user_id            uuid primary key references users(id) on delete cascade,
  google_email       text not null,
  refresh_token_enc  text not null,
  history_id         text not null,
  status             text not null default 'active' check (status in ('active', 'needs_reconnect')),
  connected_at       timestamptz not null default now(),
  last_synced_at     timestamptz,
  last_error         text
);
-- Set when the one-off starter fetch (a few recent newsletters) has run, so a reconnect never repeats it.
alter table gmail_connections add column if not exists starter_done_at timestamptz;

-- Every message the classifier has seen, so each is judged once.
create table if not exists gmail_messages (
  user_id           uuid not null references users(id) on delete cascade,
  gmail_message_id  text not null,
  decision          text not null check (decision in ('rule_skip', 'not_editorial', 'editorial')),
  reason            text,
  from_email        text,
  subject           text,
  seen_at           timestamptz not null default now(),
  primary key (user_id, gmail_message_id)
);

create table if not exists gmail_blocked_senders (
  user_id  uuid not null references users(id) on delete cascade,
  email    text not null,
  primary key (user_id, email)
);

alter table articles add column if not exists gmail_message_id text;
alter table articles add column if not exists message_id text;
create unique index if not exists articles_user_gmail_uq
  on articles (user_id, gmail_message_id) where gmail_message_id is not null;
alter table articles drop constraint if exists articles_added_via_check;
alter table articles add constraint articles_added_via_check check (added_via in ('email', 'web', 'gmail'));

-- Better Auth tables (modelName auth_*). Columns are Better Auth 1.7's own camelCase names,
-- generated with its Postgres migration compiler and made idempotent. Don't rename them.
create table if not exists auth_users (
  "id"             text not null primary key,
  "name"           text not null,
  "email"          text not null unique,
  "emailVerified"  boolean not null,
  "image"          text,
  "createdAt"      timestamptz not null default current_timestamp,
  "updatedAt"      timestamptz not null default current_timestamp
);

create table if not exists auth_sessions (
  "id"         text not null primary key,
  "expiresAt"  timestamptz not null,
  "token"      text not null unique,
  "createdAt"  timestamptz not null default current_timestamp,
  "updatedAt"  timestamptz not null,
  "ipAddress"  text,
  "userAgent"  text,
  "userId"     text not null references auth_users ("id") on delete cascade
);
create index if not exists "auth_sessions_userId_idx" on auth_sessions ("userId");

create table if not exists auth_accounts (
  "id"                     text not null primary key,
  "accountId"              text not null,
  "providerId"             text not null,
  "userId"                 text not null references auth_users ("id") on delete cascade,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  "scope"                  text,
  "password"               text,
  "createdAt"              timestamptz not null default current_timestamp,
  "updatedAt"              timestamptz not null
);
create index if not exists "auth_accounts_userId_idx" on auth_accounts ("userId");

create table if not exists auth_verifications (
  "id"          text not null primary key,
  "identifier"  text not null,
  "value"       text not null,
  "expiresAt"   timestamptz not null,
  "createdAt"   timestamptz not null default current_timestamp,
  "updatedAt"   timestamptz not null default current_timestamp
);
create index if not exists "auth_verifications_identifier_idx" on auth_verifications ("identifier");

-- One row per brewed magazine. `layout` snapshots users.paper_layout at brew time; a local print
-- agent claims queued issues (claimed_by/claimed_at) and reports printed or failed.
create table if not exists issues (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  layout       text not null check (layout in ('flat', 'booklet')),
  article_ids  uuid[] not null,
  status       text not null default 'queued' check (status in ('queued', 'printing', 'printed', 'failed')),
  claimed_by   uuid,
  claimed_at   timestamptz,
  printed_at   timestamptz,
  error        text
);
create index if not exists issues_user_created_idx on issues (user_id, created_at desc);

-- A Mac paired for printing. The device token is shown once; only its SHA-256 is stored.
create table if not exists print_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists print_devices_user_idx on print_devices (user_id);

-- One-time pairing codes (10 minutes, single use). Only the SHA-256 of the code is stored.
create table if not exists print_pair_codes (
  code_hash   text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- Supabase exposes the public schema over its REST API with the anon key. RLS with no policies
-- shuts that off; the backend connects as the table owner, which bypasses RLS.
alter table users enable row level security;
alter table inbound_addresses enable row level security;
alter table sender_aliases enable row level security;
alter table inbound_emails enable row level security;
alter table articles enable row level security;
alter table jobs enable row level security;
alter table auth_users enable row level security;
alter table auth_sessions enable row level security;
alter table auth_accounts enable row level security;
alter table auth_verifications enable row level security;
alter table gmail_connections enable row level security;
alter table gmail_messages enable row level security;
alter table gmail_blocked_senders enable row level security;
alter table issues enable row level security;
alter table print_devices enable row level security;
alter table print_pair_codes enable row level security;
