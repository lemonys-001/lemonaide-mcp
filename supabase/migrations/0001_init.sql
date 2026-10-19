-- LemonAIde MCP — initial schema
-- All user-owned rows are protected by RLS; the server uses the service-role key
-- (which bypasses RLS) and performs explicit ownership checks in application code.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helper: auto-update updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null,
  display_name  text,
  avatar_url    text,
  github_login  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint username_format check (username ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  constraint username_not_reserved check (
    username not in (
      'api', 'mcp', 'oauth', 'auth', 'assets', 'static', 'app', 'apps',
      'dashboard', 'admin', 'health', 'login', 'logout', 'callback', 'authorize',
      'register', 'token', 'www', 'mail', 'support', 'help', 'docs', 'blog',
      'settings', 'account', 'projects', 'lemonaide', 'lemonai', 'null',
      'undefined', 'internal', 'worker', 'build', 'builds', 'deploy', 'deploys'
    )
  )
);

create unique index profiles_username_lower_key on public.profiles (lower(username));
create index profiles_username_idx on public.profiles (username);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', 'user-' || substr(new.id::text, 1, 8)),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  name         text not null,
  slug         text not null,
  description  text,
  framework    text not null default 'vanilla-html',
  status       text not null default 'active',
  github_repo_id bigint,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint project_name_length check (char_length(name) between 1 and 50),
  constraint project_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'),
  constraint project_status_check check (status in ('active', 'archived')),
  constraint project_framework_check check (
    framework in ('vanilla-html', 'vite-react-ts', 'vite-vanilla', 'static-site')
  ),
  unique (owner_id, slug)
);

create index projects_owner_idx on public.projects (owner_id, status, created_at desc);

create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- project_versions — immutable source snapshots
-- manifest: {"files":[{"path":"index.html","size":123,"sha256":"..."}],"totalBytes":123}
-- ---------------------------------------------------------------------------
create table public.project_versions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  version     integer not null,
  label       text,
  manifest    jsonb not null,
  file_count  integer not null default 0,
  total_bytes bigint not null default 0,
  storage_prefix text not null, -- r2 key prefix holding this snapshot
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),

  unique (project_id, version)
);

create index project_versions_project_idx on public.project_versions (project_id, version desc);

-- ---------------------------------------------------------------------------
-- project_files — current-state index (source of truth lives in R2)
-- ---------------------------------------------------------------------------
create table public.project_files (
  project_id  uuid not null references public.projects (id) on delete cascade,
  path        text not null,
  size        bigint not null default 0,
  sha256      text not null,
  version_id  uuid references public.project_versions (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (project_id, path)
);

-- ---------------------------------------------------------------------------
-- builds
-- ---------------------------------------------------------------------------
create table public.builds (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  version_id     uuid references public.project_versions (id) on delete set null,
  status         text not null default 'queued',
  framework      text not null,
  install_command text,
  build_command  text,
  idempotency_key text,
  runner_run_id  bigint,
  artifact_prefix text,           -- r2 key prefix of validated output (dist/)
  artifact_count integer,
  artifact_bytes bigint,
  error_code     text,
  error_message  text,
  log_truncated  boolean not null default false,
  correlation_id uuid not null default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,

  constraint build_status_check check (
    status in ('queued', 'running', 'succeeded', 'failed', 'canceled')
  )
);

create unique index builds_idempotency_key_key on public.builds (idempotency_key)
  where idempotency_key is not null;
create index builds_project_idx on public.builds (project_id, created_at desc);
create index builds_status_idx on public.builds (status) where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- deployments
-- ---------------------------------------------------------------------------
create table public.deployments (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  build_id       uuid not null references public.builds (id) on delete restrict,
  deployment_number integer not null,
  status         text not null default 'pending',
  slug           text not null,          -- appname at deploy time
  username       text not null,          -- owner username at deploy time (routing key)
  asset_prefix   text not null,          -- r2 prefix: deployments/{project_id}/{deployment_number}/
  asset_count    integer not null default 0,
  total_bytes    bigint not null default 0,
  commit_sha     text,                   -- github commit corresponding to this deployment
  is_current     boolean not null default false,
  error_message  text,
  created_at     timestamptz not null default now(),
  deployed_at    timestamptz,

  constraint deployment_status_check check (
    status in ('pending', 'deploying', 'deployed', 'failed', 'superseded', 'rolled_back')
  ),
  unique (project_id, deployment_number)
);

create unique index deployments_current_idx on public.deployments (project_id) where is_current;
create index deployments_lookup_idx on public.deployments (username, slug) where status = 'deployed';
create index deployments_project_idx on public.deployments (project_id, deployment_number desc);

-- ---------------------------------------------------------------------------
-- github_installations (platform GitHub App installations per user)
-- ---------------------------------------------------------------------------
create table public.github_installations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  installation_id bigint not null unique,
  account_login   text not null,
  account_type    text not null,
  permissions     jsonb not null default '{}'::jsonb,
  suspended_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index github_installations_user_idx on public.github_installations (user_id);

create trigger github_installations_updated_at before update on public.github_installations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- github_repositories
-- ---------------------------------------------------------------------------
create table public.github_repositories (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  installation_id bigint not null references public.github_installations (installation_id) on delete cascade,
  repo_full_name text not null,
  repo_url       text not null,
  default_branch text not null default 'main',
  is_private     boolean not null default true,
  last_commit_sha text,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),

  unique (project_id)
);

-- ---------------------------------------------------------------------------
-- mcp_authorizations — mirror of OAuth grants held in OAUTH_KV (dashboard/revocation)
-- token hashes only; plaintext tokens are never stored.
-- ---------------------------------------------------------------------------
create table public.mcp_authorizations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  client_id      text not null,
  client_name    text,
  scopes         text[] not null default '{}',
  grant_id       text not null,          -- provider grant key in OAUTH_KV
  token_prefix   text,                   -- sha256 prefix of access token (display only)
  granted_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  expires_at     timestamptz,

  unique (user_id, grant_id)
);

create index mcp_authorizations_user_idx on public.mcp_authorizations (user_id, revoked_at);

-- ---------------------------------------------------------------------------
-- usage_records — append-only quota accounting
-- ---------------------------------------------------------------------------
create table public.usage_records (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  kind       text not null,              -- 'build' | 'deploy' | 'storage' | 'project'
  quantity   bigint not null default 1,
  unit       text not null,              -- 'count' | 'bytes'
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint usage_kind_check check (kind in ('build', 'deploy', 'storage', 'project'))
);

create index usage_records_user_kind_idx on public.usage_records (user_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.profiles (id) on delete set null,
  actor_type     text not null,          -- 'user' | 'mcp' | 'system'
  action         text not null,          -- e.g. 'project.create', 'deploy.publish'
  target_type    text,
  target_id      text,
  meta           jsonb not null default '{}'::jsonb,
  correlation_id uuid,
  ip             text,
  user_agent     text,
  created_at     timestamptz not null default now(),

  constraint actor_type_check check (actor_type in ('user', 'mcp', 'system'))
);

create index audit_logs_user_idx on public.audit_logs (user_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Browser/dashboard traffic uses the anon key; RLS scopes every query to auth.uid().
-- The Worker uses the service-role key with explicit ownership checks.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_versions enable row level security;
alter table public.project_files enable row level security;
alter table public.builds enable row level security;
alter table public.deployments enable row level security;
alter table public.github_installations enable row level security;
alter table public.github_repositories enable row level security;
alter table public.mcp_authorizations enable row level security;
alter table public.usage_records enable row level security;
alter table public.audit_logs enable row level security;

-- profiles: read/update own row
create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());

-- projects: owner full access
create policy "projects_select_own" on public.projects
  for select using (owner_id = auth.uid());
create policy "projects_insert_own" on public.projects
  for insert with check (owner_id = auth.uid());
create policy "projects_update_own" on public.projects
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "projects_delete_own" on public.projects
  for delete using (owner_id = auth.uid());

-- helper: project ownership (used by child-table policies)
create or replace function public.owns_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p where p.id = pid and p.owner_id = auth.uid()
  );
$$;

create policy "project_versions_select_own" on public.project_versions
  for select using (public.owns_project(project_id));

create policy "project_files_select_own" on public.project_files
  for select using (public.owns_project(project_id));

create policy "builds_select_own" on public.builds
  for select using (public.owns_project(project_id));

create policy "deployments_select_own" on public.deployments
  for select using (public.owns_project(project_id));

create policy "github_installations_select_own" on public.github_installations
  for select using (user_id = auth.uid());
create policy "github_installations_insert_own" on public.github_installations
  for insert with check (user_id = auth.uid());
create policy "github_installations_delete_own" on public.github_installations
  for delete using (user_id = auth.uid());

create policy "github_repositories_select_own" on public.github_repositories
  for select using (public.owns_project(project_id));

create policy "mcp_authorizations_select_own" on public.mcp_authorizations
  for select using (user_id = auth.uid());

create policy "usage_records_select_own" on public.usage_records
  for select using (user_id = auth.uid());

create policy "audit_logs_select_own" on public.audit_logs
  for select using (user_id = auth.uid());

-- Note: there are intentionally NO insert/update/delete policies for browser
-- clients on version/build/deployment/repo/usage/audit tables. The Worker
-- (service role) performs all mutations with ownership checks.
