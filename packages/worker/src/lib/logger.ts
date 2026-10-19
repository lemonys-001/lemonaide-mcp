/** Structured JSON logging with correlation IDs and secret redaction. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT-like
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, base: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = {
    level,
    msg: redactSecrets(msg),
    ts: new Date().toISOString(),
    ...base,
  };
  if (fields) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      safe[k] = typeof v === "string" ? redactSecrets(v) : v;
    }
    payload.fields = safe;
  }
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => emit("debug", bindings, msg, fields),
    info: (msg, fields) => emit("info", bindings, msg, fields),
    warn: (msg, fields) => emit("warn", bindings, msg, fields),
    error: (msg, fields) => emit("error", bindings, msg, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}
