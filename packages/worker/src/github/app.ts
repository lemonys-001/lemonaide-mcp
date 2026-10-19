/**
 * GitHub App authentication: RS256 JWT signing with Web Crypto (no node:crypto,
 * no external deps). The private key is a PKCS#8 PEM supplied as a secret.
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
  const body = pem.slice(start + begin.length, stop).replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = pemToBinary(pem, "PRIVATE KEY");
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
