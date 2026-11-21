-- T-05: writing and approving specs (FR-002a, design §5.1 and §6).
-- Both entry points are atomic: credits, state changes and the follow-up job
-- commit together or not at all, so a failure never leaves a charge without work.

-- -----------------------------------------------------------------------------
-- start_spec_draft: charge credits and queue the spec.draft job
-- -----------------------------------------------------------------------------
create or replace function public.start_spec_draft(
  p_project_id uuid,
  p_user_id    uuid,
  p_cost       integer,
  p_payload    jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job bigint;
  v_ref text := 'spec_draft:' || gen_random_uuid()::text;
begin
  -- one draft at a time per project: the project row lock serialises concurrent requests
  perform 1 from public.projects where id = p_project_id and owner_id = p_user_id for update;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.jobs
              where dedupe_key = 'spec.draft:' || p_project_id and status in ('queued', 'running')) then
    raise exception 'draft_in_progress' using errcode = 'P0001';
  end if;

  if p_cost > 0 then
    perform public.spend_credits(p_user_id, p_cost, v_ref, jsonb_build_object('project_id', p_project_id));
  end if;

  v_job := public.enqueue_job(
    'spec.draft',
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
      'projectId', p_project_id, 'userId', p_user_id, 'creditRef', v_ref, 'cost', p_cost),
    p_project_id,
    'spec.draft:' || p_project_id,
    now(),
    3);
  return v_job;
end;
$$;

-- -----------------------------------------------------------------------------
-- approve_spec: supersede the old spec, approve the draft, point the project
-- at it, charge the generation and queue app.generate (T-06 runs it).
-- -----------------------------------------------------------------------------
create or replace function public.approve_spec(
  p_spec_id uuid,
  p_user_id uuid,
  p_cost    integer
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spec    public.app_specs%rowtype;
  v_project public.projects%rowtype;
  v_job     bigint;
begin
  select * into v_spec from public.app_specs where id = p_spec_id;
  if not found then
    raise exception 'spec_not_found' using errcode = 'P0002';
  end if;

  select * into v_project from public.projects
   where id = v_spec.project_id and owner_id = p_user_id for update;
  if not found then
    raise exception 'spec_not_found' using errcode = 'P0002';
  end if;

  -- re-read under the project lock: a concurrent approval may have won
  select * into v_spec from public.app_specs where id = p_spec_id;
  if v_spec.status <> 'draft' then
    raise exception 'spec_locked' using errcode = 'P0001';
  end if;
  if v_project.status = 'generating' or exists (
       select 1 from public.jobs
        where dedupe_key = 'app.generate:' || v_project.id and status in ('queued', 'running')) then
    raise exception 'generation_in_progress' using errcode = 'P0001';
  end if;

  if p_cost > 0 then
    perform public.spend_credits(p_user_id, p_cost, 'generate:' || p_spec_id,
      jsonb_build_object('project_id', v_project.id, 'spec_id', p_spec_id));
  end if;

  update public.app_specs set status = 'superseded'
   where project_id = v_project.id and status = 'approved';

  update public.app_specs
     set status = 'approved', approved_at = now(), approved_by = p_user_id
   where id = p_spec_id;

  update public.projects set current_spec_id = p_spec_id where id = v_project.id;

  v_job := public.enqueue_job(
    'app.generate',
    jsonb_build_object('projectId', v_project.id, 'specId', p_spec_id, 'userId', p_user_id,
                       'cost', p_cost, 'creditRef', 'generate:' || p_spec_id),
    v_project.id,
    'app.generate:' || v_project.id,
    now(),
    3);
  return v_job;
end;
$$;

revoke all on function public.start_spec_draft(uuid, uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.approve_spec(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.start_spec_draft(uuid, uuid, integer, jsonb) to service_role;
grant execute on function public.approve_spec(uuid, uuid, integer) to service_role;
