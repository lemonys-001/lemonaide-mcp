import { Button } from "../components/ui";

export function DocsPage({ onBack }: { onBack: () => void }) {
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Install the LemonAIde MCP</h1>
          <p className="muted">Connect any MCP-compatible client to the LemonAIde MCP server.</p>
        </div>
        <Button variant="ghost" onClick={onBack}>Back</Button>
      </header>
      <div className="stack">
        <div className="card">
          <h3>MCP Endpoint</h3>
          <code style={{ fontFamily: "var(--mono)" }}>https://lemonaide-mcp.lemonys.workers.dev/mcp</code>
        </div>
      </div>
    </section>
  );
}
