-- T-13: organizations and charity verification (FR-012c, design §5.6 and §7).
-- One organization per account. A charity sends its NCNP licence and a document;
-- an admin verifies it. Verification turns on the plan's charity discount
-- (plan_price_for, from the next payment or renewal) and, if the admin allows it,
-- donations inside the charity's apps. Every decision is written to audit_log.

-- private bucket; the server uploads on the owner's behalf and admins read through signed URLs
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-documents', 'org-documents', false, 5242880, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

create unique index if not exists organizations_one_per_owner on public.organizations (owner_id);

-- writes go through submit_organization only (status and review fields are never the user's)
revoke insert on public.organizations from authenticated;
drop policy if exists "organizations: create own" on public.organizations;

create or replace function public.submit_organization(
  p_user_id       uuid,
  p_kind          public.org_kind,
  p_legal_name    text,
  p_license       text,
  p_document_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     public.organizations%rowtype;
  v_license text := nullif(btrim(coalesce(p_license, '')), '');
  v_doc     text;
  v_id      uuid;
begin
  if p_document_path is not null and p_document_path not like p_user_id::text || '/%' then
    raise exception 'invalid_document' using errcode = '22023';
  end if;

  select * into v_org from public.organizations where owner_id = p_user_id for update;
  v_doc := coalesce(p_document_path, v_org.document_path);

  if p_kind = 'charity' and v_license is null then
    raise exception 'license_required' using errcode = '22023';
  end if;
  if p_kind = 'charity' and v_doc is null then
    raise exception 'document_required' using errcode = '22023';
  end if;

  -- nothing changed on a reviewed organization: keep its decision
  if found and v_org.kind = p_kind and v_org.legal_name = btrim(p_legal_name)
     and v_org.license_number is not distinct from v_license and p_document_path is null
     and v_org.verification_status in ('verified', 'pending') then
    return v_org.id;
  end if;

  insert into public.organizations (owner_id, kind, legal_name, license_number, document_path, verification_status)
  values (p_user_id, p_kind, btrim(p_legal_name), v_license, v_doc,
          case when p_kind = 'charity' then 'pending' else 'unverified' end::public.verification_status)
  on conflict (owner_id) do update
     set kind = excluded.kind,
         legal_name = excluded.legal_name,
         license_number = excluded.license_number,
         document_path = excluded.document_path,
         verification_status = excluded.verification_status,
         donations_eligible = false,          -- any change needs a new review
         reviewed_by = null, reviewed_at = null, review_note = null
  returning id into v_id;

  -- the account's projects belong to its organization (spec review reads it from there)
  update public.projects set organization_id = v_id where owner_id = p_user_id and organization_id is distinct from v_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_user_id, 'organization.submit', 'organization', v_id::text, jsonb_build_object('kind', p_kind));
  return v_id;
end;
$$;

-- p_approve true: verify (pending only). false: reject a pending one, or revoke a verified one.
create or replace function public.review_organization(
  p_org_id     uuid,
  p_admin_id   uuid,
  p_approve    boolean,
  p_donations  boolean,
  p_note       text
)
returns public.verification_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_status public.verification_status;
begin
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_org from public.organizations where id = p_org_id for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;
  if v_org.kind <> 'charity'
     or (p_approve and v_org.verification_status <> 'pending')
     or (not p_approve and v_org.verification_status not in ('pending', 'verified')) then
    raise exception 'not_reviewable' using errcode = 'P0001';
  end if;
  if not p_approve and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'note_required' using errcode = '22023';   -- the owner is told why
  end if;

  v_status := case when p_approve then 'verified' else 'rejected' end;
  update public.organizations
     set verification_status = v_status,
         donations_eligible = p_approve and coalesce(p_donations, false),
         reviewed_by = p_admin_id, reviewed_at = now(),
         review_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000)
   where id = p_org_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id,
          case when p_approve then 'organization.verify'
               when v_org.verification_status = 'verified' then 'organization.revoke'
               else 'organization.reject' end,
          'organization', p_org_id::text,
          jsonb_build_object('donations', p_approve and coalesce(p_donations, false), 'owner', v_org.owner_id));
  return v_status;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.submit_organization(uuid, public.org_kind, text, text, text)',
    'public.review_organization(uuid, uuid, boolean, boolean, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
