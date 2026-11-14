import { AdBanner } from "../components/AdBanner";
import { Button } from "../components/ui";

const BASE = "https://lemonaide-mcp.lemonys.workers.dev";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="stack">{children}</div>
    </div>
  );
}

export function DocsPage({ onBack }: { onBack: () => void }) {
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Help &amp; documentation</h1>
          <p className="muted">Everything you need to build, publish, and manage apps on LemonAIde.</p>
        </div>
        <Button variant="ghost" onClick={onBack}>Back</Button>
      </header>

      <div className="stack">
        <Section title="What is LemonAIde?">
          <p>
            LemonAIde hosts static web apps built by your AI agent. You (or your agent) create a project, edit its files,
            and LemonAIde builds and publishes it to a live URL — with version history, build logs, and rollbacks.
          </p>
        </Section>

        <Section title="Getting started">
          <ol className="stack">
            <li>Sign up with your email — you pick a username on first sign-in. Your apps live under <code>/{`{username}`}</code>.</li>
            <li>Create a project from the dashboard, or ask your agent to do it over MCP. Choose a framework template (static HTML, Vite React, Vite vanilla).</li>
            <li>Build the project. A build runs on GitHub Actions, the logs stream back to the build page.</li>
            <li>Publish the deployment. Your app is live at <code>{BASE}/{`{username}`}/{`{slug}`}</code>.</li>
          </ol>
        </Section>

        <Section title="Files and versions">
          <p>
            Every save to a project file creates a new version. You can browse versions, download any file, and restore.
            Projects start with a template you can edit directly in the dashboard.
          </p>
        </Section>

        <Section title="Builds, publishing, and rollbacks">
          <ul className="stack">
            <li><strong>Build</strong> — compiles your project into a deployment artifact. Frameworks: plain static files are served as-is; Vite projects get an SPA shell with fallback routing.</li>
            <li><strong>Publish</strong> — makes a deployment live. Publishing a new deployment supersedes the old one atomically.</li>
            <li><strong>Rollback</strong> — republish any previous deployment from the project's history.</li>
            <li><strong>Unpublish</strong> — takes the site offline (files are kept).</li>
          </ul>
        </Section>

        <Section title="GitHub sync">
          <p>
            Connect your GitHub account from a project's Settings tab. Repos are always created under <em>your</em> GitHub
            account — never the platform's — so you own the source. You choose public or private.
          </p>
          <ul className="stack">
            <li><strong>Set up GitHub sync…</strong> — registers the LemonAIde GitHub app with your account. One click; credentials are generated server-side.</li>
            <li><strong>Create repository</strong> — makes a repo for this project under your account and pushes your source.</li>
            <li><strong>Sync now</strong> — pushes current files to the repo and starts a build. Publish the build to go live.</li>
            <li><strong>Disconnect</strong> — removes the repo link (the GitHub repo itself stays yours).</li>
          </ul>
        </Section>

        <Section title="Using the MCP server">
          <p>Connect any MCP-compatible client (Claude Desktop, Claude Code, OpenCode, ChatGPT, …):</p>
          <p><code>{BASE}/mcp</code></p>
          <ul className="stack">
            <li>Scopes: <code>mcp:read</code> for read-only work, <code>mcp:write</code> for creating and editing projects and files.</li>
            <li>When your client asks for a resource identifier, use <code>{BASE}/mcp</code>.</li>
            <li>After changing permissions, restart your client so it re-grants with the new scopes.</li>
            <li>Common tools: create project, list projects, write files, build, publish, sync to GitHub.</li>
          </ul>
        </Section>

        <Section title="Your account">
          <p>
            Settings → Danger zone → <strong>Delete account</strong> removes your profile, projects, files, builds,
            deployments, GitHub links, and sign-in. This cannot be undone; your GitHub repositories are untouched.
          </p>
        </Section>

        <Section title="Troubleshooting">
          <ul className="stack">
            <li><strong>"connect your GitHub account first"</strong> — click <em>Connect GitHub account</em> in the project Settings tab and finish the GitHub install.</li>
            <li><strong>Agent can't write, only read</strong> — the session was granted <code>mcp:read</code>. Restart the client to re-grant with <code>mcp:write</code>.</li>
            <li><strong>Build failed</strong> — open the build to see the runner log; usually a syntax error or a missing file.</li>
            <li><strong>Site shows "not published"</strong> — publish a successful build, or unpublish was clicked.</li>
            <li><strong>401 from the dashboard</strong> — your session expired; sign in again.</li>
          </ul>
        </Section>
      </div>
      <AdBanner />
    </section>
  );
}
