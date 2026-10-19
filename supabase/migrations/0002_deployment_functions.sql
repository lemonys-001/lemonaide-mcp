-- Atomic deployment promotion / unpublish helpers.
-- SECURITY DEFINER so the service-role path stays consistent; both functions
-- verify ownership through projects.owner_id before changing anything.

create or replace function public.set_current_deployment(p_deployment_id uuid, p_owner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_status text;
begin
  select project_id, status into v_project_id, v_status
  from deployments where id = p_deployment_id;

  if v_project_id is null then
    raise exception 'deployment not found';
  end if;

  if not exists (select 1 from projects p where p.id = v_project_id and p.owner_id = p_owner) then
    raise exception 'deployment not found';
  end if;

  if v_status not in ('deployed', 'pending') then
    raise exception 'deployment is not in a promotable state: %', v_status;
  end if;

  update deployments
    set is_current = false,
        status = case when is_current and status = 'deployed' then 'superseded' else status end
  where project_id = v_project_id
    and id <> p_deployment_id
    and is_current;

  update deployments
    set is_current = true,
        status = 'deployed',
        deployed_at = coalesce(deployed_at, now())
  where id = p_deployment_id;

  update projects set updated_at = now() where id = v_project_id;
end;
$$;

create or replace function public.clear_current_deployment(p_project_id uuid, p_owner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from projects p where p.id = p_project_id and p.owner_id = p_owner) then
    raise exception 'project not found';
  end if;

  update deployments
    set is_current = false,
        status = case when status = 'deployed' then 'superseded' else status end
  where project_id = p_project_id
    and is_current;
end;
$$;
