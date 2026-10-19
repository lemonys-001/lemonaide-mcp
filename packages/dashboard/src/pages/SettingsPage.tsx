import { useCallback, useEffect, useState } from "react";
import { api, type McpConnection, type Me } from "../lib/api";
import { supabase } from "../lib/supabase";
import { Badge, Button, EmptyState, ErrorBanner, Spinner, timeAgo } from "../components/ui";

export function SettingsPage({ me }: { me: Me | null }) {
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setConnections(await api.listConnections());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnections([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(grantId: string, clientName: string | null) {
    if (!window.confirm(`Disconnect ${clientName ?? "this client"}? It will lose access immediately.`)) return;
    try {
      await api.revokeConnection(grantId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Account, connected MCP clients, and session controls.</p>
        </div>
        <Button
          variant="ghost"
          onClick={async () => {
            await supabase().auth.signOut();
            window.location.hash = "#/";
            window.location.reload();
          }}
        >
          Sign out
        </Button>
      </header>

      <ErrorBanner message={error} onDismiss={() => setError("")} />

      <div className="stack narrow">
        <div className="card">
          <div className="panel-head">
            <strong>Account</strong>
          </div>
          {me ? (
            <div className="account-grid">
              <div>
                <span className="muted small">Username</span>
                <div>
                  <strong>{me.username}</strong>
                </div>
              </div>
              <div>
                <span className="muted small">Display name</span>
                <div>{me.displayName ?? "—"}</div>
              </div>
              <div>
                <span className="muted small">MCP connections</span>
                <div>{me.mcpConnections}</div>
              </div>
            </div>
          ) : (
            <Spinner />
          )}
        </div>

        <div className="card">
          <div className="panel-head">
            <strong>MCP connections</strong>
            <Badge tone="muted">{connections ? connections.length : "…"}</Badge>
          </div>
          <p className="muted small">
            Clients you've approved (Claude, OpenCode, …). Revoking one cuts its token access immediately — new
            authorization is required to reconnect.
          </p>
          {connections === null ? (
            <Spinner />
          ) : connections.length === 0 ? (
            <EmptyState
              title="No MCP clients connected"
              body="Authorize one via the MCP URL your platform gives you (https://…/mcp)."
            />
          ) : (
            <ul className="conn-list">
              {connections.map((c) => (
                <li key={c.grantId} className="conn-row">
                  <div>
                    <strong>{c.clientName ?? c.clientId}</strong>
                    <div className="muted small row gap">
                      <span>{c.scopes.join(" ")}</span>
                      <span>·</span>
                      <span>authorized {timeAgo(c.createdAt)}</span>
                      {c.lastUsedAt && (
                        <>
                          <span>·</span>
                          <span>last used {timeAgo(c.lastUsedAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button small variant="danger" onClick={() => void revoke(c.grantId, c.clientName)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
