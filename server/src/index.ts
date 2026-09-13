import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import bcrypt from "bcryptjs";
import { drizzle as drizzleFromSqlite } from "drizzle-orm/better-sqlite3";
import { db, memberEnabledModules } from "./db.js";
import { containerDb, initContainerDb } from "./core/container-db.js";
import { publicUser } from "./core/auth.js";
import { createFsStorage } from "./core/storage-fs.js";
import { createSecurity } from "./web/helpers.js";
import { initSecurity } from "./web/security.js";
import { initStorage, storage } from "./web/storage.js";
import { registerModule, initModules, mountModules, startModuleJobs, listModulesStatus } from "./modules/registry.js";
import { setupRealtime, broadcast as rawWsBroadcast } from "./realtime.js";
import { bindWsBroadcast } from "./web/events.js";
import { changeLog } from "./core/changes.js";

import authModule from "./modules/auth/index.js";
import listsModule from "./modules/lists/index.js";
import tasksModule from "./modules/tasks/index.js";
import mealPlanModule from "./modules/mealplan/index.js";
import calendarModule from "./modules/calendar/index.js";
import dashboardModule from "./modules/dashboard/index.js";
import adminModule from "./modules/admin/index.js";

const cwd = process.cwd();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- First-run bootstrap: create an admin account if there are no users ------
const userCount = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
if (userCount === 0) {
  const name = process.env.ADMIN_NAME || "Admin";
  const password = process.env.ADMIN_PASSWORD || "admin1234";
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO users (name, is_admin, password_hash)
    VALUES (?, 1, ?)
  `).run(name, hash);
  console.log("[bootstrap] Created initial admin account:");
  console.log(`  name:     ${name}`);
  console.log(`  password: ${password}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("  (set ADMIN_NAME / ADMIN_PASSWORD env vars to choose your own)");
  }
}

registerModule(listsModule);
registerModule(tasksModule);
registerModule(mealPlanModule);
registerModule(calendarModule);
registerModule(dashboardModule);
registerModule(adminModule);

// Portable core seam: build the Drizzle DbClient over the raw better-sqlite3
// handle and bind it before any security/module handler can read it. `db`
// (raw) stays available to the bootstrap + members queries below; module
// migrate() receives the raw driver for its CREATE TABLE / seed work.
const drizzleDb = drizzleFromSqlite(db);
initContainerDb(drizzleDb);

await initModules(drizzleDb, db);

const secret = process.env.SESSION_SECRET || "clanboard-dev-secret-change-me";
const security = createSecurity(drizzleDb, secret, process.env.NODE_ENV === "production");
initSecurity(security);

const app = new Hono();

// Public endpoints (login + module list for the app shell)
app.route("/api/auth", authModule.app);
app.get("/api/modules", async (c) => c.json(await listModulesStatus()));

// Household member list (for the wall display and member pickers), each with
// their resolved module access. Any authenticated user can view it.
app.get("/api/members", security.authenticated, (c) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY id").all() as Array<Record<string, unknown>>;
  return c.json(
    rows.map((u) => ({
      ...publicUser(u as unknown as import("./core/auth.js").AuthUserRow),
      enabled_modules: memberEnabledModules(Number(u.id)),
    }))
  );
});

// Changes poll: "what changed after revision N on epoch E?" Returns distinct
// tables touched since then (or "*" for a full refresh when the client's
// revision/epoch can't be reconciled). Authenticated so it only answers logged-
// in clients; portable — same handler shape on the Workers entry.
app.get("/api/changes", security.authenticated, (c) => {
  const sinceRaw = c.req.query("since");
  const epochRaw = c.req.query("epoch");
  const req = {
    since: sinceRaw === undefined ? undefined : Number(sinceRaw),
    sinceEpoch: epochRaw === undefined ? undefined : Number(epochRaw),
  };
  return c.json(changeLog.snapshot(req));
});

mountModules(app, { authenticated: security.authenticated, guards: { admin: security.requireAdmin } });

// Serve uploaded member photos through the storage adapter (fs here, R2 on
// the Workers entry). Keys are server-generated, but serve paths are treated
// as untrusted anyway.
const dataDir = process.env.DATA_DIR || path.join(cwd, "data");
initStorage(createFsStorage(path.join(dataDir, "uploads")));
app.get("/uploads/*", async (c) => {
  const key = decodeURIComponent(c.req.path.slice("/uploads/".length));
  const file = await storage().get(key);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(file.bytes, {
    status: 200,
    headers: { "Content-Type": file.contentType },
  });
});

// Serve the built client in production
const publicDir = path.join(__dirname, "..", "public");
app.use("/*", serveStatic({ root: publicDir }));

// SPA fallback: any unmapped path returns the app shell.
const indexHtml = path.join(publicDir, "index.html");
let indexContent = "";
try {
  indexContent = fs.readFileSync(indexHtml, "utf8");
} catch (err) {
  console.error("[static] missing client index.html:", err);
}
app.get("*", (c) => c.html(indexContent || "Clanboard API is running", 200));

const PORT = Number(process.env.PORT || 3001);
const server = serve({ fetch: app.fetch, port: PORT });
setupRealtime(server);
bindWsBroadcast(rawWsBroadcast);
startModuleJobs();

console.log(`Clanboard server listening on port ${PORT}`);
if (process.env.NODE_ENV !== "production") {
  console.log("API base: http://localhost:" + PORT + "/api");
}