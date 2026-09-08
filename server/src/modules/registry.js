import { ensureModuleRow, isModuleEnabled } from "../db.js";

// Each module file exports: { name, migrate(db), router, navLabel, jobs? }
// `jobs` is an optional array of { name, intervalMs, run } background tasks.
const modules = [];

export function registerModule(mod) {
  modules.push(mod);
}

export function initModules(db) {
  for (const mod of modules) {
    ensureModuleRow(mod.name);
    if (mod.migrate) mod.migrate(db);
  }
}

export function mountModules(app, guards = {}) {
  for (const mod of modules) {
    if (!mod.router) continue;
    const guard = guards[mod.name];
    // Routers stay mounted but reject requests while disabled, so admin toggle
    // takes effect immediately without a restart. `guard` (e.g. requireAdmin)
    // runs before the router for modules that carry one.
    app.use(`/api/${mod.name}`, (req, res, next) => {
      if (!isModuleEnabled(mod.name)) {
        return res.status(404).json({ error: "Module disabled" });
      }
      if (guard) return guard(req, res, next);
      next();
    }, mod.router);
  }
}

export function startModuleJobs() {
  for (const mod of modules) {
    for (const job of mod.jobs || []) {
      const timer = setInterval(() => {
        if (isModuleEnabled(mod.name)) {
          job.run().catch((err) => console.error(`[${mod.name}/${job.name}]`, err));
        }
      }, job.intervalMs);
      timer.unref?.();
    }
  }
}

export function listModulesStatus() {
  return modules.map((m) => ({
    name: m.name,
    navLabel: m.navLabel,
    enabled: isModuleEnabled(m.name),
    jobs: (m.jobs || []).map((j) => ({ name: j.name, intervalMs: j.intervalMs })),
  }));
}