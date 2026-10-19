import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { Button, ErrorBanner, Field, Input, Notice } from "../components/ui";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  if (!supabaseConfigured) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="brand">LemonAIde</div>
          <h1>Dashboard not configured</h1>
          <Notice tone="warn">
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env</code>, then
            rebuild.
          </Notice>
        </div>
      </main>
    );
  }

  async function submit() {
    setError("");
    setInfo("");
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    if (mode === "signup") {
      const slug = username.trim().toLowerCase();
      if (slug && !/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(slug)) {
        setError("Username must be 3–30 chars: a–z, 0–9, hyphens (no leading/trailing hyphen).");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "login") {
        const { error: err } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw new Error(err.message);
      } else {
        const { error: err, data } = await supabase().auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: slugOrEmpty(username) } },
        });
        if (err) throw new Error(err.message);
        if (!data.session) {
          setInfo("Check your inbox to confirm your email, then sign in.");
          setMode("login");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand">LemonAIde</div>
        <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
        <p className="muted">Build and publish static web apps from your MCP client.</p>

        {info && <Notice tone="ok">{info}</Notice>}
        <ErrorBanner message={error} onDismiss={() => setError("")} />

        <div className="stack">
          <Field label="Email">
            <Input value={email} onChange={setEmail} placeholder="you@example.com" type="email" autoFocus />
          </Field>
          {mode === "signup" && (
            <Field label="Username" hint="Public URL: your-platform.dev/username/app">
              <Input value={username} onChange={setUsername} placeholder="myname" />
            </Field>
          )}
          <Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
            <Input value={password} onChange={setPassword} type="password" onEnter={submit} />
          </Field>
          <Button onClick={submit} disabled={busy} type="button">
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </div>

        <button
          className="linkish"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
            setInfo("");
          }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}

function slugOrEmpty(value: string): string {
  return value.trim().toLowerCase();
}
