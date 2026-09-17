import { Hono } from "hono";
import { ensureModuleRow, isModuleEnabled } from "../core/db.js";

// Each module file exports: { name, migrate(db), app, navLabel, jobs? }
// `app` is a Hono router; `jobs` is an optional array of
// { name, intervalMs, run } background tasks.
const modules = [];
let activeDb = null;

export function registerModule(mod) {
  modules.push(mod);
}

// Boot hook. `db` is the Drizzle DbClient used for module queries; `raw` is
// the better-sqlite3-shaped driver (raw better-sqlite3 on the container, a D1
// adapter on the Worker) handed to each module's `migrate()` for its CREATE
// TABLE / ALTER / seed work. Defaulting `raw` to `db` keeps single-arg callers
// working, though both entries pass a real raw driver.
//
// `migrate()` is async because D1 prepares are async; on the container the
// awaited calls resolve synchronously, so one contract serves both backends.
export async function initModules(db, raw = db) {
  activeDb = db;
  for (const mod of modules) {
    await ensureModuleRow(activeDb, mod.name);
    if (mod.migrate) await mod.migrate(raw);
  }
}

// Mount every module's Hono router under /api/<name>. Options:
//   authenticated  - Hono middleware run first on every module route
//   guards         - per-module Hono middleware (e.g. admin: requireAdmin)
// Sub-apps stay mounted but reject requests while disabled, so the admin toggle
// takes effect immediately without a restart.
export function mountModules(parent, opts = {}) {
  const { authenticated, guards = {} } = opts;
  for (const mod of modules) {
    if (!mod.app) continue;
    const guard = guards[mod.name];
    const sub = new Hono();
    // Remember the viewer's IANA timezone (sent by the client as X-Timezone) so
    // date-sensitive handlers compute "today" locally instead of on UTC.
    sub.use("*", (c, next) => {
      c.set("timezone", c.req.header("x-timezone") || "");
      return next();
    });
    if (authenticated) sub.use("*", authenticated);
    sub.use("*", async (c, next) => {
      if (!(await isModuleEnabled(activeDb, mod.name))) {
        return c.json({ error: "Module disabled" }, 404);
      }
      return next();
    });
    if (guard) sub.use("*", guard);
    sub.route("/", mod.app);
    parent.route(`/api/${mod.name}`, sub);
  }
}

// Run every module's background jobs once, on demand. The Workers `scheduled`
// entry uses this instead of the container's in-proc timers, so both backends
// share the exact same job definitions. Each job is guarded by its module's
// enabled flag (matching startModuleJobs) and failures never take down a
// sibling job.
export async function runModuleJobs() {
  for (const mod of modules) {
    if (!(await isModuleEnabled(activeDb, mod.name))) continue;
    for (const job of mod.jobs || []) {
      try {
        await job.run();
      } catch (err) {
        console.error(`[${mod.name}/${job.name}]`, err);
      }
    }
  }
}

export function startModuleJobs() {
  for (const mod of modules) {
    for (const job of mod.jobs || []) {
      const timer = setInterval(async () => {
        if (await isModuleEnabled(activeDb, mod.name)) {
          job.run().catch((err) => console.error(`[${mod.name}/${job.name}]`, err));
        }
      }, job.intervalMs);
      timer.unref?.();
    }
  }
}

export async function listModulesStatus() {
  const statuses = [];
  for (const m of modules) {
    statuses.push({
      name: m.name,
      navLabel: m.navLabel,
      enabled: await isModuleEnabled(activeDb, m.name),
      jobs: (m.jobs || []).map((j) => ({ name: j.name, intervalMs: j.intervalMs })),
    });
  }
  return statuses;
}