import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { StatusCode, ContentfulStatusCode } from "hono/utils/http-status";
import { eq } from "drizzle-orm";
import type { DbClient } from "../core/db.js";
import { hasCap, type LoggedInUser } from "../core/caps.js";
import type { AuthUserRow } from "../core/auth.js";
import { users } from "../schema.js";
import { sessionCookieName, signSession, verifySession, type SessionData } from "./session.js";

// HTTP-facing request/response/middleware helpers shared by every module
// adapter. The core layer stays framework-agnostic; everything here is
// Hono-specific and portable to the Workers entry later.

// Map a Drizzle users row (camelCase keys) back to the snake_case AuthUserRow
// shape the auth core expects.
export function toAuthRow(r: Record<string, unknown> | undefined | null): AuthUserRow | null {
  if (!r) return null;
  return {
    id: r.id as number,
    name: r.name as string,
    photo_url: (r.photoUrl as string) ?? null,
    birthday: (r.birthday as string) ?? null,
    gender: (r.gender as string) ?? null,
    role_id: (r.roleId as number | null) ?? null,
    nav_scope: (r.navScope as string) ?? "all",
    is_admin: r.isAdmin as boolean | number,
    is_kiosk: r.isKiosk as boolean | number,
    system_account: r.systemAccount as boolean | number,
    password_hash: (r.passwordHash as string) ?? null,
    email: (r.email as string) ?? null,
    login_enabled: r.loginEnabled as boolean | number,
    failed_attempts: (r.failedAttempts as number) ?? 0,
    locked: r.locked as boolean | number,
    must_change_password: r.mustChangePassword as boolean | number,
  };
}

export interface Security {
  authenticated(c: Context, next: Next): Promise<Response | void>;
  requireAdmin(c: Context, next: Next): Promise<Response | void>;
  setSession(c: Context, userId: number): Promise<void>;
  clearSession(c: Context): void;
  currentSession(c: Context): Promise<SessionData | null>;
  userById(id: number): Promise<AuthUserRow | null>;
}

export function createSecurity(db: DbClient, secret: string, cookieSecure = false): Security {
  async function userById(id: number): Promise<AuthUserRow | null> {
    const row = await db.select().from(users).where(eq(users.id, id)).get();
    return toAuthRow(row as unknown as Record<string, unknown> | undefined);
  }

  function cookieSession(c: Context): Promise<SessionData | null> {
    const token = getCookie(c, sessionCookieName);
    if (!token) return Promise.resolve(null);
    return verifySession(secret, token);
  }

  return {
    async authenticated(c, next): Promise<Response | void> {
      const session = await cookieSession(c);
      if (session) {
        const user = await userById(session.userId);
        if (user) {
          c.set("user", user);
          return next();
        }
      }
      return c.json({ error: "Not authenticated" }, 401);
    },

    requireAdmin(c, next): Promise<Response | void> {
      const user = c.get("user") as LoggedInUser | undefined;
      if (user && user.is_admin) return next();
      return Promise.resolve(c.json({ error: "Admin required" }, 403));
    },

    async setSession(c, userId) {
      const token = await signSession(secret, { userId });
      setCookie(c, sessionCookieName, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 30 * 24 * 3600,
        secure: cookieSecure,
      });
    },

    clearSession(c) {
      deleteCookie(c, sessionCookieName, { path: "/" });
    },

    currentSession: cookieSession,

    userById,
  };
}

// Run an async core function and translate its result/errors to an HTTP
// response. HttpError carries status + message; anything else is a 500.
export async function respond(
  c: Context,
  fn: () => Promise<unknown> | unknown,
  opts: { status?: number } = {}
): Promise<Response> {
  try {
    const data = await fn();
    if (opts.status === 204) {
      c.status(204);
      return c.body(null);
    }
    if (opts.status) c.status(opts.status as StatusCode);
    return c.json(data);
  } catch (err) {
    if (err instanceof Error && "status" in (err as { status?: unknown })) {
      const status = (err as unknown as { status: number }).status;
      return c.json({ error: err.message }, status as ContentfulStatusCode);
    }
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  }
}

export function readJson(c: Context): Promise<Record<string, unknown>> {
  return c.req.json().catch(() => ({}));
}

// Hono middleware: 403 unless the current user has the capability.
export function requireCap(db: DbClient, module: string, cap: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const user = c.get("user") as LoggedInUser | undefined;
    if (await hasCap(db, user, module, cap)) return next();
    return c.json({ error: "Your role doesn't allow this action." }, 403);
  };
}

export function numParam(c: Context, name: string): number | undefined {
  const v = c.req.param(name);
  return v === undefined ? undefined : Number(v);
}