-- Paperbrew MVP schema: users, their private forwarding addresses,
-- the raw inbound emails, the articles they produce, and a small job queue.

create extension if not exists pgcrypto;

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  created_at  timestamptz not null default now()
);

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
-- Word tokens (hyphens allowed, 3-40 chars). Replaces the older letters-only check; idempotent.
alter table inbound_addresses drop constraint if exists inbound_addresses_token_check;
alter table inbound_addresses add constraint inbound_addresses_token_check
  check (token ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(token) between 3 and 40);

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

-- Supabase exposes the public schema over its REST API with the anon key. RLS with no policies
-- shuts that off; the backend connects as the table owner, which bypasses RLS.
alter table users enable row level security;
alter table inbound_addresses enable row level security;
alter table sender_aliases enable row level security;
alter table inbound_emails enable row level security;
alter table articles enable row level security;
alter table jobs enable row level security;
