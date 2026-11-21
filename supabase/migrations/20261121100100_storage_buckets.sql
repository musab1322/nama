-- =============================================================================
-- Migration : 20261121100100_storage_buckets.sql
-- Buckets   :
--   project-assets   (private)  icons, splash, screenshots. Owner can read/write.
--                               Path: {project_id}/...
--   project-sources  (private)  generated source snapshots per version. service_role only.
--   build-artifacts  (private)  .aab / .ipa copies. service_role only (served via signed URLs).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('project-assets',  'project-assets',  false, 5242880,
     array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  ('project-sources', 'project-sources', false, 104857600, null),
  ('build-artifacts', 'build-artifacts', false, 524288000, null)
on conflict (id) do nothing;

-- Safely extract the project id from the first path segment (never throws on bad input).
create or replace function private.project_id_from_path(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_first text := split_part(p_name, '/', 1);
begin
  if v_first ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_first::uuid;
  end if;
  return null;
end;
$$;
revoke all on function private.project_id_from_path(text) from public;
grant execute on function private.project_id_from_path(text) to authenticated, service_role;

create policy "project-assets: owner read"
  on storage.objects for select to authenticated
  using (bucket_id = 'project-assets'
         and (select private.owns_project(private.project_id_from_path(name))));

create policy "project-assets: owner upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'project-assets'
              and (select private.owns_project(private.project_id_from_path(name))));

create policy "project-assets: owner update"
  on storage.objects for update to authenticated
  using (bucket_id = 'project-assets'
         and (select private.owns_project(private.project_id_from_path(name))))
  with check (bucket_id = 'project-assets'
              and (select private.owns_project(private.project_id_from_path(name))));

create policy "project-assets: owner delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'project-assets'
         and (select private.owns_project(private.project_id_from_path(name))));

-- project-sources and build-artifacts have NO policies for authenticated:
-- only service_role (which bypasses RLS) can touch them.
