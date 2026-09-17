// Cloudflare Workers entry for clanboard — the SAME portable app as the Node
// container, one deployment target apart. It imports the same core (migration
// splitter, ChangeLog, storage adapter) and the same module registry, so the
// container, the test suite, and Workers can never drift on schema, realtime,
// or routes. Behind the fetch handler everything is a plain Hono request; the
// poll/change contract and the R2 photo uploads behave identically to the
// container's /api/changes and /uploads.
//
// Node-only concerns (better-sqlite3 file, ws upgrade, module job timers,
// serveStatic) are intentionally NOT imported here. The Worker is stateless
// beyond its bindings; ws is replaced by the client's /api/changes short-poll
// fallback, and background jobs run from the `scheduled` cron handler instead
// of in-process timers.
//
// Unlike the container, the Worker's boot is wrapped in a once-per-isolate
// promise: schema is applied idempotently, storage + the containerDb seam are
// bound, the first admin account is bootstrapped, and the module registry is
// mounted exactly one time (re-registering per request would duplicate routes).
//
// Binding names match test/helpers/db.ts so the Miniflare suite and production
// speak the same wrangler config: d1=CLANBOARD, r2=UPLOADS.

import { Hono } from "hono";
import { drizzle as drizzleFromD1 } from "drizzle-orm/d1";
import type { D1Database, R2Bucket, ScheduledController } from "@cloudflare/workers-types";
import {
  applyMigrationStatements,
  migrationStatementsFromText,
  type MigratableDatabase,
} from "./core/migrations.js";
import { D1_SCHEMA } from "./db/d1-schema.js";
import { initStorage, storage } from "./web/storage.js";
import { createR2Storage } from "./core/storage-r2.js";
import { createSecurity, toAuthRow } from "./web/helpers.js";
import { initSecurity } from "./web/security.js";
import { changeLog } from "./core/changes.js";
import { initContainerDb, containerDb } from "./core/container-db.js";
import { hashPassword, memberEnabledModules, publicUser } from "./core/auth.js";
import { initEmailConfig } from "./core/email.js";
import { initCalendarConfig, runSyncAll } from "./core/calendar.js";
import { users } from "./schema.js";
import {
  registerModule,
  initModules,
  mountModules,
  listModulesStatus,
  runModuleJobs,
} from "./modules/registry.js";
import authModule from "./modules/auth/index.js";
import listsModule from "./modules/lists/index.js";
import tasksModule from "./modules/tasks/index.js";
import mealPlanModule from "./modules/mealplan/index.js";
import calendarModule from "./modules/calendar/index.js";
import dashboardModule from "./modules/dashboard/index.js";
import adminModule from "./modules/admin/index.js";

export interface Env {
  CLANBOARD: D1Database;
  UPLOADS: R2Bucket;
  SESSION_SECRET: string;
  ADMIN_NAME?: string;
  ADMIN_PASSWORD?: string;
  RESEND_API_KEY?: string;
  GOOGLE_API_KEY?: string;
}

// ---------------------------------------------------------------------------
// Schema + boot
// ---------------------------------------------------------------------------

// Split multi-statement SQL on statement-terminating semicolons, ignoring
// semicolons inside string literals and SQL comments (`--` line comments and
// `/* */` block comments, both of which routinely contain `;`). better-sqlite3's
// exec() runs whole blocks; D1's prepare() accepts exactly one statement, and
// module migrate() blocks are multi-statement.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLine) {
      buf += ch;
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      buf += ch;
      if (ch === "*" && next === "/") {
        buf += "/";
        i += 1;
        inBlock = false;
      }
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "-" && next === "-") {
      inLine = true;
      buf += "--";
      i += 1;
      continue;
    } else if (!inSingle && !inDouble && ch === "/" && next === "*") {
      inBlock = true;
      buf += "/*";
      i += 1;
      continue;
    }
    buf += ch;
    if (ch === ";" && !inSingle && !inDouble && buf.trim()) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// better-sqlite3-shaped driver over D1 for module `migrate()` (CREATE/seed
// work) and the migration runner. Matches the proven per-statement path the
// suite uses: prepare().run() / .all() / .first().
function d1Raw(d1: D1Database): MigratableDatabase {
  return {
    exec: async (sql: string) => {
      let result: unknown;
      for (const statement of splitStatements(sql)) {
        result = await d1.prepare(statement).run();
      }
      return result;
    },
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => d1.prepare(sql).bind(...args).run() as unknown,
      all: async (...args: unknown[]) => {
        const res = await d1.prepare(sql).bind(...args).all();
        return res.results ?? [];
      },
      get: async (...args: unknown[]) => d1.prepare(sql).bind(...args).first(),
    }),
  };
}

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// Replicates the container's first-run bootstrap: if there are no users,
// create an admin account. Password comes from an ADMIN_PASSWORD secret (or a
// generated one, logged once through the runtime logs since it can't be
// recovered later).
async function ensureAdmin(env: Env): Promise<void> {
  const count = await env.CLANBOARD.prepare("SELECT COUNT(*) AS c FROM users").first();
  if (count && Number(count.c) > 0) return;

  const name = env.ADMIN_NAME || "Admin";
  const password = env.ADMIN_PASSWORD || randomPassword();
  await env.CLANBOARD.prepare("INSERT INTO users (name, is_admin, password_hash) VALUES (?, 1, ?)")
    .bind(name, hashPassword(password))
    .run();

  if (env.ADMIN_PASSWORD) {
    console.log(`[bootstrap] created initial admin "${name}" — sign in with the ADMIN_PASSWORD secret`);
  } else {
    console.log(`[bootstrap] created initial admin "${name}" with a generated temporary password: ${password}`);
    console.log("[bootstrap] set the ADMIN_PASSWORD secret next time for a password you already know");
  }
}

let ready: Promise<void> | null = null;
let app: Hono | null = null;

async function ensureApp(env: Env): Promise<void> {
  if (ready) return ready;
  const boot = (async () => {
    // Apply the drizzle SQL to D1 the same way the suite and the container do:
    // one statement at a time, idempotently (D1 persists between cold starts,
    // so plain CREATE TABLE would explode the second time it ran).
    const migratable = d1Raw(env.CLANBOARD);
    await applyMigrationStatements(migratable, migrationStatementsFromText(D1_SCHEMA), {
      idempotent: true,
    });

    initStorage(createR2Storage(env.UPLOADS));

    const db = drizzleFromD1(env.CLANBOARD);
    initContainerDb(db);

    const secret = env.SESSION_SECRET || "clanboard-worker-session-secret-change-me";
    const security = createSecurity(db, secret, true);
    initSecurity(security);

    initEmailConfig({ resendApiKey: env.RESEND_API_KEY ?? null });
    initCalendarConfig({ googleApiKey: env.GOOGLE_API_KEY ?? null });

    await ensureAdmin(env);

    // auth is mounted separately below (login must not require a session) and is
    // not part of the module registry, matching the container entry exactly.
    registerModule(listsModule);
    registerModule(tasksModule);
    registerModule(mealPlanModule);
    registerModule(calendarModule);
    registerModule(dashboardModule);
    registerModule(adminModule);

    await initModules(db, migratable);

    const ctx = new Hono();

    // Changes poll: "what changed after revision N on epoch E?" Returns
    // distinct tables touched since then (or "*" for a full refresh). Same
    // handler shape as the container.
    ctx.get("/api/changes", security.authenticated, (c) => {
      const sinceRaw = c.req.query("since");
      const epochRaw = c.req.query("epoch");
      return c.json(
        changeLog.snapshot({
          since: sinceRaw === undefined ? undefined : Number(sinceRaw),
          sinceEpoch: epochRaw === undefined ? undefined : Number(epochRaw),
        })
      );
    });

    // Module list for the app shell (enabled state read live via the DbClient).
    ctx.get("/api/modules", async (c) => c.json(await listModulesStatus()));

    // Household member list (wall display + pickers), each with resolved module
    // access — portable twin of the container's /api/members.
    ctx.get("/api/members", security.authenticated, async (c) => {
      const rows = await db.select().from(users).orderBy(users.id).all();
      const out: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const u = toAuthRow(row as unknown as Record<string, unknown>);
        if (!u) continue;
        out.push({
          ...(publicUser(u) ?? {}),
          enabled_modules: await memberEnabledModules(db, u),
        });
      }
      return c.json(out);
    });

    // Serve uploaded member photos out of R2. Keys are server-generated, but
    // paths are treated as untrusted anyway.
    ctx.get("/uploads/*", async (c) => {
      const key = decodeURIComponent(c.req.path.slice("/uploads/".length));
      const file = await storage().get(key);
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(file.bytes, {
        status: 200,
        headers: { "Content-Type": file.contentType },
      });
    });

    // Login/logout/me must not require a session — mount auth before
    // mountModules (Hono keeps the first-registered route, exactly like the
    // container entry does).
    ctx.route("/api/auth", authModule.app);

    mountModules(ctx, {
      authenticated: security.authenticated,
      guards: { admin: security.requireAdmin },
    });

    app = ctx;
  })();
  ready = boot.catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureApp(env);
    return app!.fetch(request, env);
  },

  // Cron-triggered background work. The container runs module jobs on in-proc
  // timers; here they run on a schedule instead via runModuleJobs (this cron is
  // 15-minutely, so the tasks list's 30-min materialize just runs more often,
  // and the lists module's hourly auto-delete runs fine too). Calendar sync
  // stays explicit; it's the one job without a module-jobs entry. Guards as a
  // no-op while there are no calendar connections.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await ensureApp(env);
    await Promise.all([runSyncAll(containerDb), runModuleJobs()]);
    controller.noRetry();
  },
};