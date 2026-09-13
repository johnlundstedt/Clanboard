// HMAC-signed session cookie. Portable over Node and Cloudflare Workers:
// uses only Web Crypto + atob/btoa globals, no node built-ins.

export const sessionCookieName = "clanboard_session";

export interface SessionData {
  userId: number;
  exp: number;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64UrlToBytes(s: string): Uint8Array {
  let clean = s.replace(/-/g, "+").replace(/_/g, "/");
  while (clean.length % 4) clean += "=";
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

export async function signSession(
  secret: string,
  data: { userId: number },
  ttlMs = 30 * 24 * 3600 * 1000
): Promise<string> {
  const session: SessionData = { userId: data.userId, exp: Date.now() + ttlMs };
  const payload = bytesToB64Url(new TextEncoder().encode(JSON.stringify(session)));
  const sig = bytesToB64Url(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

export async function verifySession(secret: string, token: string): Promise<SessionData | null> {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = bytesToB64Url(await hmac(secret, payload));
  if (sig !== expected) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payload))) as SessionData;
    if (typeof session.userId === "number" && typeof session.exp === "number" && session.exp > Date.now()) {
      return session;
    }
  } catch {
    // malformed payload
  }
  return null;
}