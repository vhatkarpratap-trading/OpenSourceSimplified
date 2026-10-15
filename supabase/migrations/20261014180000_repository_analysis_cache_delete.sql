do $$
begin
  create policy "public analysis cache can be removed"
    on public.repository_analysis_cache for delete to anon
    using (repository_visibility = 'open-source');
exception
  when duplicate_object then null;
end $$;
