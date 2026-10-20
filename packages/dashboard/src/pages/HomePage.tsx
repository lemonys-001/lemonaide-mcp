import { Button } from "../components/ui";

export function HomePage({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <main className="auth-shell">
      <div style={{ maxWidth: 720, padding: 24, textAlign: "center" }}>
        <div className="brand" style={{ marginBottom: 16 }}>LemonAIde</div>
        <h1 style={{ fontSize: 32, margin: "8px 0 12px" }}>Build and publish static apps with MCP</h1>
        <p className="muted" style={{ fontSize: 16, marginBottom: 24 }}>
          LemonAIde lets your AI agent create, build, and deploy static web apps via the Model Context Protocol.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 32 }}>
          <Button onClick={onGetStarted}>Get Started</Button>
          <Button variant="ghost" onClick={() => (window.location.hash = "#/docs")}>Install MCP</Button>
        </div>
      </div>
    </main>
  );
}
