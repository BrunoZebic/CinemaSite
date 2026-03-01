-- Screening configuration table
create table if not exists screenings (
  room_slug text primary key,
  title text not null,
  premiere_number integer,
  premiere_start_unix_ms bigint not null,
  film_duration_sec integer not null default 1200,
  silence_duration_sec integer not null default 20,
  discussion_duration_min integer not null default 45,
  slow_mode_seconds integer not null default 60,
  max_message_chars integer not null default 320,
  video_provider text not null default 'vimeo',
  video_asset_id text not null default '',
  video_manifest_path text,
  video_manifest_url text,
  invite_code_hash text,
  host_passphrase_hash text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint screenings_hls_manifest_path_chk
    check (video_provider <> 'hls' or video_manifest_path is not null)
);

alter table screenings
  add column if not exists video_manifest_path text;

alter table screenings
  add column if not exists video_manifest_url text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'screenings_hls_manifest_path_chk'
  ) then
    alter table screenings
      add constraint screenings_hls_manifest_path_chk
      check (video_provider <> 'hls' or video_manifest_path is not null) not valid;
  end if;
end $$;

-- Persisted chat archive
create table if not exists room_messages (
  id text primary key,
  room_slug text not null references screenings(room_slug) on delete cascade,
  nickname text not null,
  avatar_seed text not null,
  signature text,
  text text not null,
  ts_unix_ms bigint not null,
  phase text,
  created_at timestamptz not null default now()
);

create index if not exists room_messages_room_ts_idx
  on room_messages (room_slug, ts_unix_ms asc);

-- Host moderation events
create table if not exists host_actions (
  id text primary key,
  room_slug text not null references screenings(room_slug) on delete cascade,
  action_type text not null,
  target_signature text,
  target_message_id text,
  ts_unix_ms bigint not null,
  actor text not null default 'host',
  created_at timestamptz not null default now()
);

create index if not exists host_actions_room_ts_idx
  on host_actions (room_slug, ts_unix_ms asc);
