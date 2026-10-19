# LemonAIde MCP

AI-powered web app creation & hosting platform. MCP-compatible AI clients (Claude, OpenCode, …) can create, edit, build, and publish static web apps for authenticated LemonAIde users, served at `https://YOUR_DOMAIN/{username}/{appname}`.

## Stack

| Layer | Tech |
| --- | --- |
| MCP server | Cloudflare Workers + `agents` (`createMcpHandler`, Streamable HTTP) + `@modelcontextprotocol/server` |
| Auth | OAuth 2.1 (`@cloudflare/workers-oauth-provider`) backed by Supabase Auth (Google) |
| API / routing | Hono, single Worker, path-based app router serving R2 assets |
| Database | Supabase Postgres (migrations + RLS) |
| Storage | Cloudflare R2 (source snapshots, build artifacts) |
| Builds | Isolated GitHub Actions build runner (allowlisted frameworks) |
| Git | GitHub App integration (private repos by default) |
| Dashboard | React + Vite, dark-first |

## Monorepo layout

```
packages/shared      schemas, error codes, validation (zod)
packages/worker      the Cloudflare Worker: MCP, OAuth, API, app router
packages/dashboard   React dashboard (deployed as Worker static assets)
supabase/migrations  SQL migrations with RLS
.github/workflows    CI + isolated build runner
docs/SETUP.md        reproducible infrastructure setup
```

## Development

```sh
cp .env.example .env           # fill in local values
npm install
npm run dev                    # worker on http://localhost:8787
npm run dev:dashboard          # Vite dev server on :5173 (proxies /api to worker)
```

## Tests & checks

```sh
npm run check                  # typecheck + test + lint
```

## Deployment

See [docs/SETUP.md](docs/SETUP.md) for the full reproducible checklist (Cloudflare, Supabase, GitHub App).

```sh
npm run build -w @lemonaide/dashboard
npm run deploy -w @lemonaide/worker -- --env production
```

CI deploys automatically on push to `main` when `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets are configured.

## Security model

- Every MCP operation is bound to a verified OAuth session; user IDs in tool arguments are never trusted.
- Tenant isolation enforced by Postgres RLS + server-side ownership checks.
- AI-generated code builds run in ephemeral GitHub Actions runners with no access to platform secrets, other users' files, or the R2 source bucket (artifacts flow through an authenticated callback API).
- Published assets are reachable only through the deployment router; source files are private.
