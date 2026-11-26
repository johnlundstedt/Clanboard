// Marketing homepage gate, shared by the Worker and the container entry.
// Visitors to "/" without a valid session cookie (new visitors, search
// engines) get the static marketing page (client/public/home.html); anyone
// signed in gets the app shell as before, so wall displays and installed PWAs
// keep opening straight into Clanboard.
import { sessionCookieName, verifySession } from "./session.js";

export async function hasValidSession(cookieHeader: string | null | undefined, secret: string): Promise<boolean> {
  if (!cookieHeader) return false;
  const prefix = sessionCookieName + "=";
  const part = cookieHeader.split(/;\s*/).find((p) => p.startsWith(prefix));
  if (!part) return false;
  try {
    return !!(await verifySession(secret, decodeURIComponent(part.slice(prefix.length))));
  } catch {
    return false;
  }
}
