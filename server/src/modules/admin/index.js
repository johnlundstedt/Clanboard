import { Hono } from "hono";
import { notifyUsers, notifyModules, notifyDashboard } from "../../web/events.js";
import { containerDb } from "../../core/container-db.js";
import { listModulesStatus } from "../registry.js";
import { parsePhotoDataUrl, photoKey } from "../../core/storage.js";
import { storage } from "../../web/storage.js";
import { numParam, readJson, respond } from "../../web/helpers.js";
import * as core from "../../core/admin.js";

function migrate() {
  core.seedDefaultRoles(containerDb).catch((err) => {
    console.error("[admin] seeding default roles failed:", err);
  });
}

const app = new Hono();

// --- Photos ------------------------------------------------------------------
// Upload a member photo. Accepts a base64 data URL in JSON; bytes go through
// the storage adapter (fs on the container, R2 on Cloudflare).
app.post("/photos", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const photo = parsePhotoDataUrl(body.data);
    const key = photoKey(body.name, photo.ext);
    await storage().put(key, photo.bytes, photo.mime);
    return { photo_url: `/uploads/${key}` };
  }, { status: 201 })
);

// --- Module toggles ----------------------------------------------------------
app.get("/modules", (c) =>
  respond(c, () => listModulesStatus())
);

app.patch("/modules/:name", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    await core.setModuleEnabled(containerDb, c.req.param("name"), body.enabled);
    notifyModules();
    return { ok: true };
  })
);

// --- Household settings ------------------------------------------------------
app.get("/settings", (c) => respond(c, () => core.getAdminSettings(containerDb)));

app.post("/settings", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    await core.updateAdminSettings(containerDb, body);
    notifyUsers();
    notifyDashboard();
    return { ok: true };
  })
);

// --- Roles -------------------------------------------------------------------
app.get("/role-capabilities", (c) => {
  return c.json(core.roleCapabilities());
});

app.get("/roles", (c) => respond(c, () => core.listRoles(containerDb)));

app.get("/roles/:id", (c) =>
  respond(c, async () => {
    const role = await core.getRole(containerDb, numParam(c, "id"));
    if (!role) throw Object.assign(new Error("Role not found"), { status: 404 });
    return core.roleWithGrants(containerDb, role);
  })
);

app.post("/roles", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const role = await core.createRole(containerDb, body?.name, body?.modules);
    notifyUsers();
    notifyModules();
    return role;
  }, { status: 201 })
);

app.patch("/roles/:id", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const role = await core.updateRole(containerDb, numParam(c, "id"), body);
    notifyUsers();
    notifyModules();
    return role;
  })
);

app.delete("/roles/:id", (c) =>
  respond(c, async () => {
    await core.deleteRole(containerDb, numParam(c, "id"));
    notifyUsers();
    notifyModules();
    return null;
  }, { status: 204 })
);

// --- Members -----------------------------------------------------------------
app.get("/members", (c) => respond(c, () => core.listMembers(containerDb)));

app.post("/members", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const user = await core.createMember(containerDb, body);
    notifyUsers();
    return user;
  }, { status: 201 })
);

app.patch("/members/:id", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const user = await core.updateMember(containerDb, numParam(c, "id"), body);
    notifyUsers();
    return user;
  })
);

// --- Per-member module access -------------------------------------------------
app.get("/members/:id/modules", (c) =>
  respond(c, async () => {
    await core.memberExists(containerDb, numParam(c, "id"));
    return core.getMemberModules(containerDb, numParam(c, "id"));
  })
);

// Body: { module, enabled } — enabled=false disables for this member, true
// enables, null clears the override (back to inheriting the global state).
app.patch("/members/:id/modules", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    const { module, enabled } = body;
    await core.memberExists(containerDb, numParam(c, "id"));
    if (!module) throw Object.assign(new Error("module is required"), { status: 400 });
    await core.setMemberModules(containerDb, numParam(c, "id"), module, enabled);
    notifyModules();
    notifyUsers();
    return { ok: true };
  })
);

app.delete("/members/:id", (c) =>
  respond(c, async () => {
    await core.deleteMember(containerDb, numParam(c, "id"));
    notifyUsers();
    return null;
  }, { status: 204 })
);

export default {
  name: "admin",
  navLabel: "Admin",
  migrate,
  app,
};