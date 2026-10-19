import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Me } from "./lib/api";
import { api } from "./lib/api";
import { supabase, supabaseConfigured } from "./lib/supabase";
import { useHashRoute } from "./lib/router";
import { ErrorBanner, Spinner } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SettingsPage } from "./pages/SettingsPage";

type AuthState = "checking" | "signedOut" | "signedIn";

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState("");
  const [route, navigate] = useHashRoute();

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
      setMeError("");
    } catch (err) {
      setMeError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuth("signedOut");
      return;
    }
    void supabase()
      .auth.getSession()
      .then(({ data }) => {
        setAuth(data.session ? "signedIn" : "signedOut");
      });
    const { data: sub } = supabase().auth.onAuthStateChange((_event, session) => {
      setAuth(session ? "signedIn" : "signedOut");
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (auth === "signedIn") void refreshMe();
  }, [auth, refreshMe]);

  if (auth === "checking") {
    return (
      <main className="auth-shell">
        <Spinner label="Loading LemonAIde…" />
      </main>
    );
  }

  if (auth === "signedOut") {
    return <LoginPage />;
  }

  const section = route[0] ?? "";
  const param = route[1] ?? "";

  let page: ReactNode;
  if (section === "projects" && param) {
    page = <ProjectPage projectRef={param} onBack={() => navigate(["projects"])} />;
  } else if (section === "settings") {
    page = <SettingsPage me={me} />;
  } else {
    page = <ProjectsPage onOpen={(slug) => navigate(["projects", slug])} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          LemonAIde
        </a>
        <nav className="topnav">
          <a href="#/" className={`toplink${section !== "settings" ? " active" : ""}`}>
            Projects
          </a>
          <a href="#/settings" className={`toplink${section === "settings" ? " active" : ""}`}>
            Settings
          </a>
          {me && <span className="whoami">@{me.username}</span>}
        </nav>
      </header>

      <main className="content">
        {meError && (
          <ErrorBanner
            message={`Account lookup failed: ${meError}`}
            onDismiss={() => setMeError("")}
          />
        )}
        {page}
      </main>

      <footer className="foot">
        <span className="muted small">LemonAIde · static apps via MCP</span>
      </footer>
    </div>
  );
}
