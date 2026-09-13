import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../src/schema.js";
import * as admin from "../src/core/admin.js";
import { verifyPassword } from "../src/core/auth.js";
import { ROLE_CAPABILITIES } from "../src/core/role-caps.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// admin core: default role seeding, household settings, role/module-grant CRUD,
// member CRUD with hashed passwords, and per-member overrides — proven identical
// on better-sqlite3 and D1.

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

for (const backend of backends) {
  describe(`core/admin (${backend.name})`, () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await backend.make();
    });

    afterAll(async () => {
      await db.close();
    });

    beforeEach(async () => {
      if (backend.name === "d1") {
        await closeD1();
        db = await backend.make();
      } else {
        await db.reset();
      }
    });

    describe("seedDefaultRoles", () => {
      it("seeds the four default roles with the role matrix, once", async () => {
        await admin.seedDefaultRoles(db.db);
        const roles = await db.db.select().from(s.membersRoles).orderBy(s.membersRoles.id).all();
        expect(roles.map((r) => r.name)).toEqual(["Parents", "Older Kids", "Younger Kids", "Kiosk"]);

        const parents = await admin.getRole(db.db, roles[0].id);
        const parentsFull = parents && (await admin.roleWithGrants(db.db, parents));
        expect(parentsFull?.modules.map((m) => m.name).sort()).toEqual(["calendar", "lists", "meal-plan", "tasks"]);
        const tasks = parentsFull?.modules.find((m) => m.name === "tasks");
        for (const cap of ROLE_CAPABILITIES.tasks) expect(tasks?.caps[cap]).toBe(true);

        const older = await admin.getRole(db.db, roles[1].id);
        const olderFull = older && (await admin.roleWithGrants(db.db, older));
        const olderTasks = olderFull?.modules.find((m) => m.name === "tasks");
        expect(olderTasks?.caps.assign_others).toBe(false);

        // Idempotent: a second pass adds nothing
        await admin.seedDefaultRoles(db.db);
        const again = await db.db.select().from(s.membersRoles).all();
        expect(again).toHaveLength(4);
      });
    });

    describe("roleCapabilities catalog", () => {
      it("exposes the four grantable modules and the tasks capability set", () => {
        const catalog = admin.roleCapabilities();
        expect(catalog.modules.map((m) => m.name)).toEqual(["tasks", "lists", "meal-plan", "calendar"]);
        const tasks = catalog.modules.find((m) => m.name === "tasks");
        expect(tasks?.caps.length).toBe(ROLE_CAPABILITIES.tasks.length);
        expect(tasks?.caps[0]).toEqual({ key: "view_others", label: "View other's tasks" });
      });
    });

    describe("settings", () => {
      it("defaults flags to enabled and units to metric", async () => {
        const settings = await admin.getAdminSettings(db.db);
        expect(settings.family_name).toBeNull();
        expect(settings.weather_units).toBe("metric");
        expect(settings.tasks_enable_categories).toBe(true);
        expect(settings.tasks_enable_priorities).toBe(true);
        expect(settings.tasks_enable_dollar).toBe(false);
      });

      it("round-trips household settings and flag toggles", async () => {
        await admin.updateAdminSettings(db.db, {
          family_name: "Lundstedt",
          latitude: "47.6",
          longitude: "-122.3",
          weather_units: "imperial",
          tasks_enable_categories: false,
          tasks_enable_dollar: true,
        });
        let settings = await admin.getAdminSettings(db.db);
        expect(settings.family_name).toBe("Lundstedt");
        expect(settings.latitude).toBe("47.6");
        expect(settings.weather_units).toBe("imperial");
        expect(settings.tasks_enable_categories).toBe(false);
        expect(settings.tasks_enable_dollar).toBe(true);

        // Empty lat/lon clears the stored location
        await admin.updateAdminSettings(db.db, { latitude: "", longitude: "" });
        settings = await admin.getAdminSettings(db.db);
        expect(settings.latitude).toBeNull();
        expect(settings.longitude).toBeNull();

        // Invalid units fall back to metric
        await admin.updateAdminSettings(db.db, { weather_units: "kelvin" });
        settings = await admin.getAdminSettings(db.db);
        expect(settings.weather_units).toBe("metric");
      });
    });

    describe("module toggles", () => {
      it("setModuleEnabled flips the global flag", async () => {
        await db.db.insert(s.modules).values({ name: "calendar", enabled: true }).run();
        await admin.setModuleEnabled(db.db, "calendar", false);
        const row = await db.db.select().from(s.modules).where(eq(s.modules.name, "calendar")).get();
        expect(row?.enabled).toBe(false);
      });
    });

    describe("roles", () => {
      it("create validates name and shows normalized module grants", async () => {
        await expect(admin.createRole(db.db, "", [])).rejects.toMatchObject({ status: 400 });

        const role = await admin.createRole(db.db, "Chores", [
          { name: "tasks", enabled: false, caps: { create: false } },
        ]);
        expect(role.id).toBeGreaterThan(0);
        expect(role.name).toBe("Chores");
        const taskGrant = role.modules.find((m) => m.name === "tasks");
        expect(taskGrant?.enabled).toBe(false);
        // Caps always merge over the defaults for that module
        expect(taskGrant?.caps.assign_self).toBe(true);
        expect(taskGrant?.caps.create).toBe(false);
        // All four role modules are normalized onto the role
        expect(role.modules.map((m) => m.name).sort()).toEqual(["calendar", "lists", "meal-plan", "tasks"]);

        await expect(admin.createRole(db.db, "Chores", [])).rejects.toMatchObject({
          status: 400,
          message: "A role with that name already exists",
        });
      });

      it("listRoles/getRole/updateRole/deleteRole round-trip", async () => {
        const role = await admin.createRole(db.db, "Read Only", [
          { name: "tasks", enabled: true },
        ]);
        const listed = await admin.listRoles(db.db);
        expect(listed.map((r) => r.name)).toContain("Read Only");

        const fetched = await admin.getRole(db.db, role.id);
        expect(fetched?.name).toBe("Read Only");

        // Rename + replace grants (normalized back to ALL role modules; unlisted
// modules return to their defaults, exactly like the container)
        const updated = await admin.updateRole(db.db, role.id, {
          name: "Read Only v2",
          modules: [{ name: "lists", enabled: true, caps: { add_items: true } }],
        });
        expect(updated?.name).toBe("Read Only v2");
        expect(updated?.modules.map((m) => m.name).sort()).toEqual(["calendar", "lists", "meal-plan", "tasks"]);
        const listsGrant = updated?.modules.find((m) => m.name === "lists");
        expect(listsGrant?.enabled).toBe(true);
        expect(listsGrant?.caps.add_items).toBe(true);
        const tasksGrant = updated?.modules.find((m) => m.name === "tasks");
        expect(tasksGrant?.enabled).toBe(true); // defaulted when not supplied
        expect(tasksGrant?.caps.create).toBe(true);

        // Rename clash guarded
        await admin.createRole(db.db, "Other", []);
        await expect(
          admin.updateRole(db.db, role.id, { name: "Other" })
        ).rejects.toMatchObject({ status: 400 });

        await admin.deleteRole(db.db, role.id);
        expect(await admin.getRole(db.db, role.id)).toBeNull();
        await expect(admin.deleteRole(db.db, role.id)).rejects.toMatchObject({ status: 404 });
      });

      // Capability rules came from the shared ROLE_CAPABILITIES catalog
      it("caps recorded from body are respected, defaults preserved", async () => {
        const role = await admin.createRole(db.db, "Caps", [
          { name: "meal-plan", enabled: true, caps: {} },
        ]);
        const grant = role.modules.find((m) => m.name === "meal-plan");
        expect(grant?.caps).toEqual({ edit: true });
      });
    });

    describe("members", () => {
      it("createMember hashes passwords and hides them via publicUser", async () => {
        await expect(admin.createMember(db.db, { name: "" })).rejects.toMatchObject({
          status: 400,
        });

        const member = (await admin.createMember(db.db, {
          name: "Ada",
          is_admin: true,
          password: "secret",
        }))!;
        expect(member.id).toBeGreaterThan(0);
        expect(member.name).toBe("Ada");
        expect(member.is_admin).toBe(true);
        expect(JSON.stringify(member)).not.toContain("secret");

        const row = await db.db.select().from(s.users).all();
        expect(verifyPassword("secret", row[0].passwordHash)).toBe(true);
      });

      it("updateMember edits fields, clears role when sent as null, and resets the password", async () => {
        const member = (await admin.createMember(db.db, { name: "Bob" }))!;
        const updated = await admin.updateMember(db.db, member.id, {
          name: "Bobby",
          birthday: "2015-06-01",
          role_id: null,
        });
        expect(updated?.name).toBe("Bobby");
        expect(updated?.birthday).toBe("2015-06-01");

        await admin.updateMember(db.db, member.id, { password: "newpass" });
        const row = await db.db.select().from(s.users).all();
        expect(verifyPassword("newpass", row[0].passwordHash)).toBe(true);

        await expect(admin.updateMember(db.db, 9999, {})).rejects.toMatchObject({
          status: 404,
        });
      });

      it("listMembers returns public users in id order", async () => {
        await admin.createMember(db.db, { name: "Zed" });
        await admin.createMember(db.db, { name: "Ari" });
        const members = await admin.listMembers(db.db);
        expect(members.map((m) => (m as { name: string }).name)).toEqual(["Zed", "Ari"]);
      });

      it("deleteMember clears task_assignees then removes the user", async () => {
        const a = (await admin.createMember(db.db, { name: "Del" }))!;
        const b = (await admin.createMember(db.db, { name: "Keep" }))!;
        const [t] = await db.db
          .insert(s.tasks)
          .values({ name: "Chore" })
          .returning()
          .all();
        await db.db.insert(s.taskAssignees).values({ taskId: t.id, userId: a.id }).run();
        await db.db.insert(s.taskAssignees).values({ taskId: t.id, userId: b.id }).run();

        await admin.deleteMember(db.db, a.id);
        expect(await db.db.select().from(s.users).all()).toHaveLength(1);
        const left = await db.db.select().from(s.taskAssignees).all();
        expect(left.map((r) => r.userId)).toEqual([b.id]);
      });
    });

    describe("per-member module access", () => {
      it("sets, toggles, and clears overrides via null", async () => {
        const member = (await admin.createMember(db.db, { name: "Kid" }))!;
        await admin.setMemberModules(db.db, member.id, "calendar", true);
        expect((await admin.getMemberModules(db.db, member.id)).overrides).toEqual({ calendar: true });

        await admin.setMemberModules(db.db, member.id, "calendar", false);
        expect((await admin.getMemberModules(db.db, member.id)).overrides).toEqual({ calendar: false });

        await admin.setMemberModules(db.db, member.id, "calendar", null);
        expect(await admin.getMemberModules(db.db, member.id)).toEqual({ overrides: {} });
      });

      it("memberExists guards missing members with 404", async () => {
        const member = (await admin.createMember(db.db, { name: "Exists" }))!;
        await expect(admin.memberExists(db.db, member.id)).resolves.toMatchObject({ id: member.id });
        await expect(admin.memberExists(db.db, 9999)).rejects.toMatchObject({ status: 404 });
      });
    });
  });
}