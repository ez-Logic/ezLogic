create table if not exists queries (
  query_id   uuid primary key default gen_random_uuid(),
  model      text not null,
  query      text not null,
  response   text not null,
  messages   jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists chat_turns (
  user_token text not null,
  chat_id    uuid not null,
  query_id   uuid not null references queries (query_id),
  created_at timestamptz not null default now(),
  primary key (chat_id, query_id)
);

create index if not exists chat_turns_user_idx
  on chat_turns (user_token, chat_id, created_at);

alter table queries add column if not exists root_node_id text;

create table if not exists proof_nodes (
  query_id uuid not null references queries (query_id) on delete cascade,
  node_id text not null,
  depends_on_ids text[],
  lean_name text not null default '',
  statement text not null default '',
  primary key (query_id, node_id)
);

alter table proof_nodes add column if not exists kind text;
alter table proof_nodes add column if not exists proof_dependency_ids text[];

create table if not exists users (
  user_id           uuid primary key default gen_random_uuid(),
  email             text not null unique,
  password_hash     text not null,
  email_verified_at timestamptz,
  created_at        timestamptz not null default now()
);
