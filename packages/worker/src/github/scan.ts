/**
 * Secret scanning for project source files before build/push.
 * Conservative pattern set for common credential formats; hits block the
 * operation (configurable to warn-only for build).
 */

export interface SecretFinding {
  path: string;
  rule: string;
  line: number;
  snippet: string; // redacted match context, never the full secret
}

interface Rule {
  id: string;
  description: string;
  regex: RegExp;
}

const RULES: Rule[] = [
  { id: "aws-access-key", description: "AWS access key id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-pat", description: "GitHub personal access token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-pat", description: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "slack-token", description: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "openai-key", description: "OpenAI API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: "anthropic-key", description: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "google-api-key", description: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-key", description: "Stripe secret key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: "supabase-jwt-secret", description: "Supabase JWT secret assignment", regex: /(?:JWT_SECRET|SERVICE_ROLE_KEY)\s*[:=]\s*["'][A-Za-z0-9_-]{30,}["']/g },
  { id: "private-key-block", description: "PEM private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "generic-bearer", description: "Hard-coded bearer token", regex: /\bBearer\s+[A-Za-z0-9._-]{40,}/g },
];

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".html", ".htm", ".css", ".scss",
  ".md", ".txt", ".yml", ".yaml", ".toml", ".env", ".webmanifest", ".svg", ".map",
]);

function isTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes(".env")) return true;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? TEXT_EXTENSIONS.has(lower.slice(dot)) : false;
}

function redact(match: string): string {
  if (match.length <= 8) return "…";
  return `${match.slice(0, 4)}…${match.slice(-2)} (len ${match.length})`;
}

export function scanForSecrets(files: { path: string; content: string }[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    if (!isTextPath(file.path)) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.length > 10_000) continue;
      for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        const match = rule.regex.exec(line);
        if (match) {
          findings.push({
            path: file.path,
            rule: rule.id,
            line: i + 1,
            snippet: redact(match[0]),
          });
        }
      }
    }
  }
  return findings;
}

export function describeFindings(findings: SecretFinding[]): string {
  return findings
    .slice(0, 10)
    .map((f) => `${f.path}:${f.line} ${f.rule} → ${f.snippet}`)
    .join("; ");
}
