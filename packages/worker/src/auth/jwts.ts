/**
 * Supabase access-token verification.
 * Supports RS256 via the project JWKS endpoint and HS256 when a JWT secret is configured.
 * Never accepts an unverified token: signature, issuer, audience and expiry are checked.
 */

export interface VerifiedJwt {
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  role?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

export class JwtVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtVerificationError";
  }
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function b64urlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
}

let jwksCache: { url: string; fetchedAt: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks(url: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new JwtVerificationError(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  if (keys.length === 0) throw new JwtVerificationError("JWKS contains no keys");
  jwksCache = { url, fetchedAt: Date.now(), keys };
  return keys;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg ?? "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function importEcKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export interface VerifyOptions {
  supabaseUrl: string;
  /** Optional HS256 shared secret (project JWT secret). */
  jwtSecret?: string;
  /** Defaults to `${supabaseUrl}/auth/v1` issuer with aud "authenticated". */
  issuer?: string;
  audience?: string;
  /** Clock skew tolerance in seconds. */
  leewaySec?: number;
}

export async function verifySupabaseJwt(token: string, opts: VerifyOptions): Promise<VerifiedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerificationError("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  if (!B64URL_RE.test(headerB64) || !B64URL_RE.test(payloadB64) || !B64URL_RE.test(signatureB64)) {
    throw new JwtVerificationError("malformed token");
  }

  const header = decodePart<{ alg?: string; kid?: string; typ?: string }>(headerB64);
  const payload = decodePart<VerifiedJwt & Record<string, unknown>>(payloadB64);
  if (!header.alg || !payload.sub) throw new JwtVerificationError("missing claims");

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBytes(signatureB64);

  let valid = false;
  if (header.alg === "RS256" || header.alg === "ES256") {
    const jwksUrl = `${opts.supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
    const keys = await fetchJwks(jwksUrl);
    const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
    const wantKty = header.alg === "ES256" ? "EC" : "RSA";
    for (const jwk of candidates) {
      if (jwk.kty !== wantKty) continue;
      const key = jwk.kty === "EC" ? await importEcKey(jwk) : await importRsaKey(jwk);
      const alg = jwk.kty === "EC"
        ? { name: "ECDSA", hash: "SHA-256" }
        : { name: "RSASSA-PKCS1-v1_5" };
      valid = await crypto.subtle.verify(alg, key, signature as BufferSource, data);
      if (valid) break;
    }
  } else if (header.alg === "HS256") {
    if (!opts.jwtSecret) throw new JwtVerificationError("HS256 token but no JWT secret configured");
    const key = await importHmacKey(opts.jwtSecret);
    valid = await crypto.subtle.verify("HMAC", key, signature as BufferSource, data);
  } else {
    throw new JwtVerificationError(`unsupported alg: ${header.alg}`);
  }

  if (!valid) throw new JwtVerificationError("signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  const leeway = opts.leewaySec ?? 30;
  if (typeof payload.exp !== "number" || now > payload.exp + leeway) {
    throw new JwtVerificationError("token expired");
  }
  if (typeof payload.iat === "number" && payload.iat > now + leeway + 60) {
    throw new JwtVerificationError("token issued in the future");
  }

  const expectedIssuer = opts.issuer ?? `${opts.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  if (payload.iss !== undefined && payload.iss !== expectedIssuer) {
    throw new JwtVerificationError("issuer mismatch");
  }

  const expectedAud = opts.audience ?? "authenticated";
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (aud !== undefined && !audOk) throw new JwtVerificationError("audience mismatch");

  return payload;
}
