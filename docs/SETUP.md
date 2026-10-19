# LemonAIde MCP — Setup Guide

Step-by-step production setup. Development works without any of this via
`DEV_FAKE_AUTH` (see [Local development](#local-development)).

## Prerequisites

- Node.js ≥ 22 (worker tooling requires it)
- A Cloudflare account (Workers paid plan recommended for custom domains)
- A Supabase project
- A GitHub account/organization (for the GitHub App + platform repo)
- `gh` CLI and `wrangler` logged in: `npx wrangler login`

## 1. Environment files

```bash
cp .env.example .env                      # worker + dashboard vars
cp packages/dashboard/.env.example packages/dashboard/.env   # if present; else create it
```

Fill in:

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | worker secret | Supabase project URL |
| `SUPABASE_ANON_KEY` | worker secret | Browser-safe key (JWT verification of dashboard tokens) |
| `SUPABASE_SERVICE_ROLE_KEY` | worker secret | Server-side DB access (RLS-bypassing; never exposed) |
| `SUPABASE_JWT_ISSUER` | worker var | Defaults to `{SUPABASE_URL}/auth/v1` if unset |
| `SESSION_SECRET` | worker secret | ≥ 32 random chars — OAuth cookies, connect-state HMAC |
| `CONSENT_SECRET` | worker secret (optional) | Overrides `SESSION_SECRET` for consent/HMAC signing |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET` | worker secrets | GitHub App integration |
| `BUILD_RUNNER_TOKEN` | worker secret **+** repo secret | Shared secret for the isolated build runner |
| `MCP_PUBLIC_URL` | worker var | Public origin of the Worker, e.g. `https://lemonaide-mcp.example.com` |
| `APP_BASE_DOMAIN` | worker var | Host serving published apps + dashboard, e.g. `apps.example.com` |
| `DEV_FAKE_AUTH` | worker var (dev only) | Enables `x-dev-user` API auth + consent skip |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | dashboard env | supabase-js browser client |

Generate a secret:

```bash
openssl rand -base64 48 | tr -d '\n' | pbcopy    # SESSION_SECRET / BUILD_RUNNER_TOKEN
```

## 2. Cloudflare resources

```bash
# from packages/worker
npx wrangler kv namespace create OAUTH_KV
npx wrangler r2 bucket create lemonaide-source
npx wrangler r2 bucket create lemonaide-artifacts
npx wrangler queues create lemonaide-builds
```

Paste the returned KV id into `wrangler.toml` (`[[kv_namespaces]].id`).
R2/queue names in `wrangler.toml` must match what you created.

## 3. Supabase

1. Create a project at https://supabase.com.
2. Apply migrations in order (SQL editor or CLI):
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_deployment_functions.sql`
3. Auth → Providers: enable **Email** (confirmations optional for testing).
4. Auth → URL configuration: add your Worker origin to redirect URLs if you
   later add direct Supabase logins; the platform itself uses the Supabase
   **authorize endpoint as upstream IdP**, not the hosted login page.
5. Copy URL + anon + service-role keys into your env.

The migration installs a `handle_new_user` trigger: every new Supabase auth
user gets a `profiles` row with `username = metadata.username` (validated) or
`user-{first 8 of uuid}`.

## 4. GitHub App (platform integration)

Create at https://github.com/settings/apps/new (org: same path under the org):

- **Homepage URL**: your dashboard origin
- **Setup URL**: `https://<worker-origin>/api/github/callback` ← *required*;
  GitHub redirects here after install with `installation_id` + `state`
- **Webhook URL**: `https://<worker-origin>/api/github/webhook` (optional in v1)
- **Webhook secret**: same as `GITHUB_APP_WEBHOOK_SECRET`
- Repository permissions:
  - **Contents**: Read & write (sync project files)
  - **Metadata**: Read-only (required)
- Where available: "Request repositories on install" so users pick repos

Generate a **private key** (PEM) and a **client secret**; note the App ID and
slug. Install the App on the repos/org where projects should live.

## 5. Platform repo (build runner)

The same repo you push this code to doubles as the build runner:

1. Actions → ensure workflows are enabled.
2. Repository **variable**: `WORKER_BASE_URL` = `https://<worker-origin>`
3. Repository **secret**: `BUILD_RUNNER_TOKEN` = same value as the worker secret

`.github/workflows/build-runner.yml` runs on `workflow_dispatch` with a
`build_id` input. The worker dispatches it via the GitHub API (GitHub App
installation token, or `BUILD_DISPATCH_TOKEN` fallback).

> The runner executes **only** the commands the platform returns
> (`FRAMEWORK_BUILD_CONFIG`) — never commands from user source. Builds get no
> long-lived credentials.

## 6. Build & deploy

```bash
npm install
npm run check            # typecheck + lint + tests
npm run build            # shared → worker typecheck → dashboard dist

cd packages/worker
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put BUILD_RUNNER_TOKEN
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_CLIENT_ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET
npx wrangler deploy
```

`[assets]` serves `packages/dashboard/dist` — `npm run build` must run before
`wrangler deploy` (CI does this on push to `main`).

### Recommended routes/DNS

- Worker route or custom domain for the Worker origin → `MCP_PUBLIC_URL`
- Published apps live under the same origin at `/{username}/{slug}`
  (SPA fallback for Vite frameworks, strict 404s for static ones)

## 7. Smoke test

1. Open the dashboard, sign up (email+password; or set `DEV_FAKE_AUTH` in dev).
2. Create a project → **Build** → watch logs → **Deploy** → open live URL.
3. In an MCP client add the server:

   ```
   https://<worker-origin>/mcp
   ```

   Complete consent; scopes requested: `mcp:read mcp:write offline_access`.
4. From the client: `get_platform_info`, `create_project`, `build_project`,
   `deploy`.
5. Dashboard → Settings → **MCP connections** shows the grant; revoke there to
   cut access immediately.

## Local development

```bash
# terminal 1 — worker on :8787
cd packages/worker && npx wrangler dev

# terminal 2 — dashboard on :5173 (proxies /api, /authorize, /oauth to :8787)
cd packages/dashboard && npx vite
```

Without Supabase, set in `.env` / `wrangler.toml` `[vars]`:

```toml
DEV_FAKE_AUTH = "dev"
ENVIRONMENT = "development"
```

then call the API with header `x-dev-user: dev` (the consent page also shows a
**dev skip** button in development). Wrangler vars go in `wrangler.toml`, not
`.env`, unless you use `wrangler dev --var`.

## Operational notes

- **Rotation**: rotate `SESSION_SECRET` invalidates consent cookies and
  connect-states (users re-consent); rotate `BUILD_RUNNER_TOKEN` in *both*
  worker secret and repo secret together or runners 401.
- **Quotas** live in `@lemonaide/shared` `LIMITS` (projects/user, builds/day,
  deploys/day, file sizes). Tune there and redeploy.
- **R2 layout**: sources `src/{projectId}/files/…` (+ snapshots `…/v/{n}/…`),
  artifacts `build/{buildId}/…`. Deployments point at a build prefix; rollback
  just repoints `current_deployment_id`.
- **Deleting a project** removes source, artifacts, and the live URL row in
  one transaction (MCP `delete_project` requires the slug as confirmation).
