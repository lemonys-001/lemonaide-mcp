import type { ReactNode } from "react";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  small?: boolean;
  title?: string;
}) {
  const { variant = "primary", small, type = "button", ...rest } = props;
  return (
    <button
      type={type}
      className={`btn btn-${variant}${small ? " btn-sm" : ""}`}
      {...rest}
    />
  );
}

export function Field(props: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && !props.error && <span className="field-hint">{props.hint}</span>}
      {props.error && <span className="field-error">{props.error}</span>}
    </label>
  );
}

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  mono?: boolean;
}) {
  return (
    <input
      className={`input${props.mono ? " mono" : ""}`}
      type={props.type ?? "text"}
      value={props.value}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && props.onEnter) props.onEnter();
      }}
    />
  );
}

export function Badge(props: { children: ReactNode; tone?: "ok" | "warn" | "err" | "info" | "muted" }) {
  return <span className={`badge badge-${props.tone ?? "muted"}`}>{props.children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" />
      {label && <span className="muted">{label}</span>}
    </div>
  );
}

export function ErrorBanner(props: { message: string; onDismiss?: () => void }) {
  if (!props.message) return null;
  return (
    <div className="banner banner-err" role="alert">
      <span>{props.message}</span>
      {props.onDismiss && (
        <button className="banner-x" onClick={props.onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function Notice(props: { children: ReactNode; tone?: "info" | "ok" | "warn" }) {
  return <div className={`banner banner-${props.tone ?? "info"}`}>{props.children}</div>;
}

export function EmptyState(props: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{props.title}</h3>
      {props.body && <p className="muted">{props.body}</p>}
      {props.action}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildTone(status: string): "ok" | "err" | "warn" | "info" | "muted" {
  if (status === "succeeded" || status === "deployed" || status === "active") return "ok";
  if (status === "failed" || status === "canceled") return "err";
  if (status === "running" || status === "queued" || status === "deploying") return "info";
  return "muted";
}
