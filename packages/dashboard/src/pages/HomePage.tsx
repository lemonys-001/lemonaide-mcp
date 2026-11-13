import { Button } from "../components/ui";

export function HomePage({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <main className="hero">
      <div className="hero-inner">
        <div className="brand">
          Lemon<em>AI</em>de
        </div>
        <h1>Your agent builds the app. You watch it go live.</h1>
        <p className="muted">
          Create, build, and deploy static web apps from Claude or any MCP client — with build
          logs, deploys, and rollbacks in one panel.
        </p>
        <div className="hero-ctas">
          <Button onClick={onGetStarted}>Get started</Button>
          <Button variant="ghost" onClick={() => (window.location.hash = "#/docs")}>
            Install MCP
          </Button>
        </div>
        <div className="hero-plate">
          <span className="route-plate">
            /me/<strong>my-first-app</strong>
          </span>
          <p className="muted small">One URL per project. The agent does the rest.</p>
        </div>
      </div>
    </main>
  );
}
