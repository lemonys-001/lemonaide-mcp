import { useCallback, useEffect, useState } from "react";
import { api, type Project } from "../lib/api";
import { Badge, Button, EmptyState, ErrorBanner, Field, Input, Spinner, buildTone, timeAgo } from "../components/ui";
import { AdBanner } from "../components/AdBanner";

const FRAMEWORKS = [
  { id: "vanilla-html", label: "Vanilla HTML", blurb: "Plain index.html — zero tooling" },
  { id: "vite-react-ts", label: "Vite + React + TS", blurb: "SPA, router-free React app" },
  { id: "vite-vanilla", label: "Vite Vanilla", blurb: "Lightweight Vite bundle" },
  { id: "static-site", label: "Static site", blurb: "Pre-built HTML/CSS/JS" },
];

export function ProjectsPage({ onOpen }: { onOpen: (slug: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [owner, setOwner] = useState("me");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [framework, setFramework] = useState("vanilla-html");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.me().then((m) => setOwner(m.username)).catch(() => {});
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const project = await api.createProject({ name: name.trim(), framework });
      setName("");
      setCreating(false);
      onOpen(project.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const list = projects ?? [];
  const published = list.filter((p) => p.currentDeployment?.isCurrent && p.currentDeployment.status === "deployed").length;
  const lastActivity = list.length ? list.map((p) => p.updated_at).sort().at(-1)! : null;

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">Create, build, and publish apps from Claude or any MCP client.</p>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New project"}</Button>
      </header>

      {projects !== null && list.length > 0 && (
        <div className="stat-strip" role="status">
          <span>
            <strong>{list.length}</strong> project{list.length === 1 ? "" : "s"}
          </span>
          <span>
            <strong>{published}</strong> published
          </span>
          {lastActivity && (
            <span>
              last activity <strong>{timeAgo(lastActivity)}</strong>
            </span>
          )}
        </div>
      )}

      <ErrorBanner message={error} onDismiss={() => setError("")} />

      {creating && (
        <div className="card form-card">
          <Field label="Project name" hint="Used for the default URL slug (editable later).">
            <Input value={name} onChange={setName} placeholder="My awesome app" autoFocus onEnter={create} />
          </Field>
          <div className="framework-grid">
            {FRAMEWORKS.map((fw) => (
              <button
                key={fw.id}
                className={`framework-card${framework === fw.id ? " selected" : ""}`}
                onClick={() => setFramework(fw.id)}
              >
                <strong>{fw.label}</strong>
                <span className="muted">{fw.blurb}</span>
              </button>
            ))}
          </div>
          <div className="row end">
            <Button onClick={create} disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </div>
      )}

      {projects === null ? (
        <Spinner label="Loading projects…" />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Create one here, or ask your MCP client: “create a project called …”"
          action={<Button onClick={() => setCreating(true)}>+ New project</Button>}
        />
      ) : (
        <div className="project-grid">
          {list.map((p) => {
            const live = p.currentDeployment?.isCurrent && p.currentDeployment.status === "deployed" ? p.liveUrl : null;
            return (
              <div key={p.id} className="project-card">
                <button className="project-open" onClick={() => onOpen(p.slug)}>
                  <div className="row between">
                    <strong>{p.name}</strong>
                    <Badge tone={buildTone(p.status)}>{p.status}</Badge>
                  </div>
                  <code className="route-plate">
                    /{owner}/<strong>{p.slug}</strong>
                  </code>
                </button>
                <div className="row gap muted small project-meta">
                  <span>{p.framework}</span>
                  <span>·</span>
                  <span>{timeAgo(p.updated_at)}</span>
                  {live && (
                    <a href={live} target="_blank" rel="noreferrer">
                      View live ↗
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AdBanner />
    </section>
  );
}
