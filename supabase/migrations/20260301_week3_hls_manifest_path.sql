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
