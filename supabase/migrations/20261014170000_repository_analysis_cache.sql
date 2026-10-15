create table if not exists public.repository_analysis_cache (
  repository_key text primary key,
  repository_name text not null,
  repository_description text not null default '',
  repository_author text,
  repository_url text,
  repository_visibility text not null check (repository_visibility in ('open-source', 'private')),
  published_by_name text,
  published_by_email text,
  provider text not null,
  structure_hash text not null,
  analysis_json jsonb not null,
  cache_json jsonb not null,
  analysed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.repository_analysis_cache enable row level security;

do $$
begin
  begin
    create policy "public analysis cache is readable"
      on public.repository_analysis_cache for select to anon using (repository_visibility = 'open-source');
  exception when duplicate_object then null; end;
  begin
    create policy "public analysis cache can be published"
      on public.repository_analysis_cache for insert to anon with check (repository_visibility = 'open-source');
  exception when duplicate_object then null; end;
  begin
    create policy "public analysis cache can be refreshed"
      on public.repository_analysis_cache for update to anon
      using (repository_visibility = 'open-source')
      with check (repository_visibility = 'open-source');
  exception when duplicate_object then null; end;
end $$;
