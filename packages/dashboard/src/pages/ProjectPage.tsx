import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Build,
  type Deployment,
  type Project,
  type ProjectFile,
  type ValidationIssue,
} from "../lib/api";
import {
  Badge,
  Button,
  ErrorBanner,
  EmptyState,
  Field,
  Input,
  Notice,
  Spinner,
  buildTone,
  bytes,
  timeAgo,
} from "../components/ui";

type Tab = "files" | "builds" | "deployments" | "settings";

export function ProjectPage({ projectRef, onBack }: { projectRef: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setProject(await api.getProject(projectRef));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <Spinner label="Loading project…" />;
  if (!project) {
    return (
      <section>
        <ErrorBanner message={error || "Project not found."} />
        <Button onClick={onBack}>← Projects</Button>
      </section>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "files", label: "Files" },
    { id: "builds", label: "Builds" },
    { id: "deployments", label: "Deployments" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <section>
      <header className="page-head">
        <div>
          <button className="linkish" onClick={onBack}>
            ← Projects
          </button>
          <h1>
            {project.name} <Badge tone={buildTone(project.status)}>{project.status}</Badge>
          </h1>
          <p className="muted row gap" style={{ flexWrap: "wrap" }}>
            <span className="route-plate">
              /me/<strong>{project.slug}</strong>
            </span>
            <span>{project.framework}</span>
            {project.liveUrl && (
              <>
                <span>·</span>
                <a href={project.liveUrl} target="_blank" rel="noreferrer" className="link">
                  {project.liveUrl.replace(/^https?:\/\//, "")} ↗
                </a>
              </>
            )}
          </p>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <ErrorBanner message={error} onDismiss={() => setError("")} />

      {tab === "files" && <FilesTab project={project} onError={setError} />}
      {tab === "builds" && <BuildsTab project={project} onDeployed={() => setTab("deployments")} onError={setError} />}
      {tab === "deployments" && <DeploymentsTab project={project} onError={setError} onRefresh={refresh} />}
      {tab === "settings" && <SettingsTab project={project} onChanged={refresh} onError={setError} />}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function FilesTab({ project, onError }: { project: Project; onError: (msg: string) => void }) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [newPath, setNewPath] = useState("");

  const loadList = useCallback(async () => {
    try {
      setFiles(await api.listFiles(project.slug));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    }
  }, [project.slug, onError]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function open(path: string) {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    try {
      const file = await api.readFile(project.slug, path);
      setSelected(path);
      setContent(file.content);
      setDirty(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await api.writeFile(project.slug, selected, content);
      setDirty(false);
      await loadList();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function addFile() {
    const path = newPath.trim().replace(/^\/+/, "");
    if (!path) return;
    try {
      await api.writeFile(project.slug, path, "");
      setNewPath("");
      await loadList();
      await open(path);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(path: string) {
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      await api.deleteFile(project.slug, path);
      if (selected === path) {
        setSelected(null);
        setContent("");
      }
      await loadList();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runValidation() {
    try {
      const result = await api.validate(project.slug);
      setIssues(result.issues);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="split">
      <aside className="panel">
        <div className="panel-head">
          <strong>Files</strong>
          <Button small variant="ghost" onClick={runValidation}>
            Validate
          </Button>
        </div>
        <div className="row gap new-file">
          <Input value={newPath} onChange={setNewPath} placeholder="src/page.html" />
          <Button small onClick={addFile} disabled={!newPath.trim()}>
            Add
          </Button>
        </div>
        {files === null ? (
          <Spinner />
        ) : files.length === 0 ? (
          <EmptyState title="No files" body="Add index.html to get started." />
        ) : (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.path}>
                <button className={`file-item${selected === f.path ? " active" : ""}`} onClick={() => void open(f.path)}>
                  <span className="file-path">{f.path}</span>
                  <span className="muted small">{bytes(f.size)}</span>
                </button>
                <button className="file-x" title="Delete" onClick={() => void remove(f.path)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {issues && (
          <div className="issues">
            <div className="panel-head">
              <strong>Validation</strong>
              <Badge tone={issues.some((i) => i.severity === "error") ? "err" : "ok"}>
                {issues.length === 0 ? "clean" : `${issues.length} issue(s)`}
              </Badge>
            </div>
            {issues.length === 0 ? (
              <p className="muted small">No issues found.</p>
            ) : (
              issues.map((issue, i) => (
                <div key={i} className={`issue issue-${issue.severity}`}>
                  <Badge tone={issue.severity === "error" ? "err" : "warn"}>{issue.severity}</Badge>
                  <span>{issue.message}</span>
                  {issue.path && <code className="muted small">{issue.path}</code>}
                </div>
              ))
            )}
          </div>
        )}
      </aside>

      <div className="panel editor-panel">
        <div className="panel-head">
          <strong className="mono">{selected ?? "No file open"}</strong>
          <div className="row gap">
            {dirty && <Badge tone="warn">unsaved</Badge>}
            <Button small onClick={save} disabled={!selected || !dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {selected ? (
          <textarea
            className="editor mono"
            spellCheck={false}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                void save();
              }
            }}
          />
        ) : (
          <EmptyState title="Select a file" body="Or add one on the left. Cmd/Ctrl+S saves." />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Builds                                                              */
/* ------------------------------------------------------------------ */

function BuildsTab({ project, onDeployed, onError }: { project: Project; onDeployed: () => void; onError: (msg: string) => void }) {
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<{ buildId: string; content: string; status: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setBuilds(await api.listBuilds(project.slug));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setBuilds([]);
    }
  }, [project.slug, onError]);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [load]);

  async function startBuild() {
    setBusy(true);
    try {
      await api.startBuild(project.slug);
      await load();
      startPolling();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => void load(), 3000);
    // stop polling after builds settle
    window.setTimeout(() => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      void load();
    }, 120_000);
  }

  async function viewLogs(build: Build) {
    try {
      const result = await api.buildLogs(build.id, 0, 100_000);
      setLogs({ buildId: build.id, content: result.content || "(no output yet)", status: build.status });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deploy(build: Build) {
    setBusy(true);
    try {
      await api.deploy(project.slug, build.id);
      onDeployed();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <p className="muted">Builds run on an isolated GitHub Actions runner — never on this Worker.</p>
        <Button onClick={startBuild} disabled={busy}>
          {busy ? "Starting…" : "▶ Build"}
        </Button>
      </div>

      {builds === null ? (
        <Spinner label="Loading builds…" />
      ) : builds.length === 0 ? (
        <EmptyState title="No builds yet" body="Hit “Build” to compile your project." action={<Button onClick={startBuild}>▶ Build</Button>} />
      ) : (
        <div className="table">
          <div className="tr th">
            <span>Status</span>
            <span>Created</span>
            <span>Artifacts</span>
            <span>Duration</span>
            <span />
          </div>
          {builds.map((b) => (
            <div key={b.id} className="tr">
              <span>
                <Badge tone={buildTone(b.status)}>{b.status}</Badge>
                {b.error_message && <div className="err-line">{b.error_message}</div>}
              </span>
              <span className="muted">{timeAgo(b.created_at)}</span>
              <span className="muted">{b.artifact_count != null ? `${b.artifact_count} · ${bytes(b.artifact_bytes)}` : "—"}</span>
              <span className="muted">{duration(b)}</span>
              <span className="row gap end">
                <Button small variant="ghost" onClick={() => void viewLogs(b)}>
                  Logs
                </Button>
                {b.status === "succeeded" && (
                  <Button small onClick={() => void deploy(b)} disabled={busy}>
                    Deploy
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {logs && (
        <div className="card">
          <div className="panel-head">
            <strong>Logs · build {logs.buildId.slice(0, 8)}</strong>
            <Button small variant="ghost" onClick={() => setLogs(null)}>
              Close
            </Button>
          </div>
          <pre className="logs mono">{logs.content}</pre>
        </div>
      )}
    </div>
  );
}

function duration(b: Build): string {
  if (!b.started_at) return "—";
  const end = b.finished_at ? new Date(b.finished_at).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - new Date(b.started_at).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/* ------------------------------------------------------------------ */
/* Deployments                                                         */
/* ------------------------------------------------------------------ */

function DeploymentsTab({
  project,
  onError,
  onRefresh,
}: {
  project: Project;
  onError: (msg: string) => void;
  onRefresh: () => void;
}) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDeployments(await api.listDeployments(project.slug));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setDeployments([]);
    }
  }, [project.slug, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rollback(id: string) {
    if (!window.confirm("Roll back live traffic to that version?")) return;
    setBusy(true);
    try {
      await api.rollback(project.slug, id);
      await load();
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!window.confirm("Unpublish this app? The live URL will stop serving.")) return;
    setBusy(true);
    try {
      await api.unpublish(project.slug);
      await load();
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const live = deployments?.find((d) => d.isCurrent && d.status === "deployed");

  return (
    <div className="stack">
      {live ? (
        <Notice tone="ok">
          Live at <a href={live.liveUrl} target="_blank" rel="noreferrer" className="link">{live.liveUrl}</a> ·{" "}
          deployment #{live.deploymentNumber}
        </Notice>
      ) : (
        <Notice>Not published yet — build first, then deploy.</Notice>
      )}

      <div className="row end">
        <Button variant="danger" onClick={unpublish} disabled={busy || !live}>
          Unpublish
        </Button>
      </div>

      {deployments === null ? (
        <Spinner label="Loading deployments…" />
      ) : deployments.length === 0 ? (
        <EmptyState title="No deployments" body="Run a build and deploy it to go live." />
      ) : (
        <div className="table">
          <div className="tr th">
            <span>#</span>
            <span>Status</span>
            <span>Deployed</span>
            <span>Assets</span>
            <span />
          </div>
          {deployments.map((d) => (
            <div key={d.deploymentId} className="tr">
              <span>#{d.deploymentNumber}</span>
              <span>
                <Badge tone={buildTone(d.status)}>{d.status}</Badge> {d.isCurrent && <Badge tone="info">live</Badge>}
                {d.errorMessage && <div className="err-line">{d.errorMessage}</div>}
              </span>
              <span className="muted">{timeAgo(d.deployedAt)}</span>
              <span className="muted">
                {d.assetCount} · {bytes(d.totalBytes)}
              </span>
              <span className="row gap end">
                {!d.isCurrent && d.status === "superseded" && (
                  <Button small variant="ghost" onClick={() => void rollback(d.deploymentId)} disabled={busy}>
                    Roll back
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function SettingsTab({ project, onChanged, onError }: { project: Project; onChanged: () => void; onError: (msg: string) => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [slug, setSlug] = useState(project.slug);
  const [renameSlug, setRenameSlug] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      await api.updateProject(project.slug, {
        name: name.trim() || project.name,
        description: description.trim() || null,
        update_slug: renameSlug && slug.trim() !== project.slug,
      });
      setSaved(true);
      setRenameSlug(false);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack narrow">
      <div className="card">
        <div className="panel-head">
          <strong>Project</strong>
          {saved && <Badge tone="ok">saved</Badge>}
        </div>
        <Field label="Name">
          <Input value={name} onChange={setName} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={setDescription} placeholder="What does this app do?" />
        </Field>
        <Field label="URL slug" hint={renameSlug ? "Changing this moves live URLs — old links will 404." : undefined}>
          <div className="row gap">
            <Input value={slug} onChange={setSlug} mono />
            {!renameSlug && (
              <Button small variant="ghost" onClick={() => setRenameSlug(true)}>
                Edit
              </Button>
            )}
          </div>
        </Field>
        <div className="row end">
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <div className="card">
        <div className="panel-head">
          <strong>Danger zone</strong>
        </div>
        <p className="muted small">Deleting removes files, builds, deployments, and the live URL permanently.</p>
        <div>
          <Button
            variant="danger"
            onClick={async () => {
              const typed = window.prompt(`Type the slug "${project.slug}" to confirm deletion:`);
              if (typed !== project.slug) return;
              setBusy(true);
              try {
                await api.deleteProject(project.slug, project.slug);
                window.location.hash = "#/";
              } catch (err) {
                onError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Delete project…
          </Button>
        </div>
      </div>
    </div>
  );
}
