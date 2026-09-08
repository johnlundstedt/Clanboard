import express from "express";
import path from "node:path";
import http from "node:http";
import session from "express-session";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import SqliteStore from "./session-store.js";
import { registerModule, initModules, mountModules, startModuleJobs, listModulesStatus } from "./modules/registry.js";
import { setupRealtime } from "./realtime.js";
import { authenticated, requireAdmin, publicUser } from "./modules/auth/index.js";
import { memberEnabledModules } from "./db.js";

import authModule from "./modules/auth/index.js";
import listsModule from "./modules/lists/index.js";
import tasksModule from "./modules/tasks/index.js";
import mealPlanModule from "./modules/mealplan/index.js";
import calendarModule from "./modules/calendar/index.js";
import dashboardModule from "./modules/dashboard/index.js";
import adminModule from "./modules/admin/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- First-run bootstrap: create an admin account if there are no users ------
const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
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

initModules(db);

const app = express();
app.use(express.json({ limit: "8mb" }));

app.use(session({
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET || "clanboard-dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, sameSite: "lax" },
}));

// Serve uploaded member photos
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
app.use("/uploads", express.static(path.join(dataDir, "uploads")));

// Public endpoints (login + module list for the app shell)
app.use("/api/auth", authModule.router);
app.get("/api/modules", (req, res) => res.json(listModulesStatus()));

// Everything else under /api requires authentication
app.use("/api", authenticated);

// Household member list (for the wall display and member pickers), each with
// their resolved module access. Any authenticated user can view it.
app.get("/api/members", (req, res) => {
  const users = db
    .prepare("SELECT * FROM users ORDER BY id")
    .all();
  res.json(
    users.map((u) => ({
      ...publicUser(u),
      enabled_modules: memberEnabledModules(u.id),
    }))
  );
});

mountModules(app, { admin: requireAdmin });

// Serve the built client in production
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = http.createServer(app);
setupRealtime(server);
startModuleJobs();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Clanboard server listening on port ${PORT}`);
  if (process.env.NODE_ENV !== "production") {
    console.log("API base: http://localhost:" + PORT + "/api");
  }
});