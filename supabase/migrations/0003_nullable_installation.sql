-- ---------------------------------------------------------------------------
-- 0003: token (PAT) mode — repository links without a GitHub App installation
--
-- When the platform runs with BUILD_DISPATCH_TOKEN instead of a GitHub App,
-- projects still get a backing repository, but there is no installation row
-- to reference. NULL is allowed by the FK; App-mode rows keep the reference.
-- ---------------------------------------------------------------------------
alter table public.github_repositories
  alter column installation_id drop not null;
