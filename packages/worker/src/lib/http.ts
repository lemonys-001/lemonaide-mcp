import { apiErr, apiOk, type ApiResponse } from "@lemonaide/shared";

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function jsonOk<T>(data: T, correlationId: string, status = 200): Response {
  const body: ApiResponse<T> = apiOk(data, correlationId);
  return Response.json(body, { status, headers: { "x-correlation-id": correlationId } });
}

export function jsonErr(
  code: string,
  message: string,
  correlationId: string,
  status = 400,
  opts?: { details?: Record<string, unknown>; retryable?: boolean },
): Response {
  const body: ApiResponse<never> = apiErr(code, message, correlationId, opts);
  return Response.json(body, { status, headers: { "x-correlation-id": correlationId } });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Render a simple branded HTML page (consent, errors, messages). */
export function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · LemonAIde</title>
<style>
  :root { color-scheme: dark; --bg:#0c0f0a; --fg:#e8ece4; --muted:#9aa392; --card:#141a10; --line:#26301f; --accent:#c8e64a; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font-family:ui-sans-serif,system-ui,-apple-system,sans-serif; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:32px; width:min(460px,100%); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:var(--muted); line-height:1.5; margin:8px 0; }
  form { margin-top:20px; display:flex; gap:10px; }
  button { font:inherit; font-weight:600; border-radius:9px; padding:10px 18px; cursor:pointer; border:1px solid var(--line); }
  button.primary { background:var(--accent); color:#11150d; border-color:transparent; }
  button.ghost { background:transparent; color:var(--fg); }
  .scopes { background:#0f140c; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-size:13px; color:var(--muted); }
  .scopes code { color:var(--accent); }
  input[type="email"], input[type="password"] { font:inherit; color:var(--fg); background:#0f140c; border:1px solid var(--line); border-radius:8px; padding:10px 12px; width:100%; }
  input[type="email"]:focus, input[type="password"]:focus { outline:1px solid var(--accent); }
  label { margin:0; }
  .brand { font-size:13px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin-bottom:14px; }
  .warn { color:#e6c14a; }
</style>
</head>
<body><div class="card"><div class="brand">LemonAIde</div>${body}</div></body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
