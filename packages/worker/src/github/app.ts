/**
 * GitHub App authentication: RS256 JWT signing with Web Crypto (no node:crypto,
 * no external deps). GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY") PEMs;
 * manifest conversions and secrets may also carry PKCS#8 — both accepted.
 */

const encoder = new TextEncoder();

function pemToBinary(pem: string, marker: string): ArrayBuffer {
  const begin = `-----BEGIN ${marker}-----`;
  const end = `-----END ${marker}-----`;
  const start = pem.indexOf(begin);
  const stop = pem.indexOf(end);
  if (start === -1 || stop === -1) {
    throw new Error(`PEM marker ${marker} not found`);
  }
  // strip literal \r\n escapes too — secrets sometimes store the key with them
  const body = pem.slice(start + begin.length, stop).replace(/\\r|\\n/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** DER helpers to wrap a PKCS#1 RSAPrivateKey into PKCS#8 PrivateKeyInfo. */
function derLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, len >> 8, len & 0xff]);
}

function derConcat(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(1 + derLength(total).length + total);
  out[0] = tag;
  out.set(derLength(total), 1);
  let offset = 1 + derLength(total).length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  // SEQUENCE { OID rsaEncryption, NULL }
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return derConcat(0x30, version, algId, derConcat(0x04, pkcs1));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  let keyData: Uint8Array;
  try {
    keyData = new Uint8Array(pemToBinary(pem, "PRIVATE KEY"));
  } catch {
    keyData = pkcs1ToPkcs8(new Uint8Array(pemToBinary(pem, "RSA PRIVATE KEY")));
  }
  return crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** Sign a GitHub App JWT (issuer = app id, 10-minute max lifetime). */
export async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const encodedHeader = b64url(encoder.encode(JSON.stringify(header)));
  const encodedPayload = b64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importRsaPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}
