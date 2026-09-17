import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../src/schema.js";
import * as auth from "../src/core/auth.js";
import { fullCapabilities } from "../src/core/role-caps.js";
import { hashPassword } from "../src/core/auth.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// auth core: credential verification, password hashing, /me payload assembly,
// and resolved module access — proven identical on better-sqlite3 and D1.

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

async function seedUser(
  db: TestDatabase,
  opts: { name?: string; is_admin?: boolean; role_id?: number | null; withPassword?: string } = {}
) {
  const [u] = await db.db
    .insert(s.users)
    .values({
      name: opts.name ?? "Ada",
      isAdmin: opts.is_admin ?? false,
      roleId: opts.role_id ?? null,
      passwordHash: opts.withPassword ? hashPassword(opts.withPassword) : null,
    })
    .returning()
    .all();
  return u;
}

// The session/auth layer hands back snake_case rows (SELECT *), so core
// functions expect snake_case keys. Map the seeded camelCase row accordingly.
function snakeUserRow(u: typeof s.users.$inferSelect): auth.AuthUserRow {
  return {
    id: u.id,
    name: u.name,
    photo_url: u.photoUrl,
    birthday: u.birthday,
    gender: u.gender,
    role_id: u.roleId,
    nav_scope: u.navScope,
    is_admin: u.isAdmin,
    is_kiosk: u.isKiosk,
    system_account: u.systemAccount,
    password_hash: u.passwordHash,
    email: u.email,
    login_enabled: u.loginEnabled,
    failed_attempts: u.failedAttempts,
    locked: u.locked,
    must_change_password: u.mustChangePassword,
  };
}

async function seedModules(db: TestDatabase, names: string[]) {
  for (const name of names) {
    await db.db.insert(s.modules).values({ name, enabled: true }).run();
  }
}

for (const backend of backends) {
  describe(`core/auth (${backend.name})`, () => {
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

    it("verifyCredentials returns the user row on success", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true, withPassword: "secret" });
      const row = await auth.verifyCredentials(db.db, "Admin", "secret");
      expect(row.id).toBe(admin.id);
      expect(row.is_admin).toBeTruthy();
      expect(row.password_hash).toBeTruthy();
    });

    it("rejects bad password, unknown user, missing fields, and hash-less users", async () => {
      await seedUser(db, { name: "Admin", is_admin: true, withPassword: "secret" });
      await seedUser(db, { name: "HashLess" });

      await expect(auth.verifyCredentials(db.db, "Admin", "wrong")).rejects.toMatchObject({
        status: 401,
      });
      await expect(auth.verifyCredentials(db.db, "ghost", "secret")).rejects.toMatchObject({
        status: 401,
      });
      await expect(auth.verifyCredentials(db.db, undefined, "secret")).rejects.toMatchObject({
        status: 400,
      });
      await expect(auth.verifyCredentials(db.db, "admin", undefined)).rejects.toMatchObject({
        status: 400,
      });
      // No password_hash set → invalid credentials, not a crash
      await expect(auth.verifyCredentials(db.db, "HashLess", "secret")).rejects.toMatchObject({
        status: 401,
      });
    });

    it("name matching is exact (binary collation), like the container", async () => {
      await seedUser(db, { name: "Admin", withPassword: "secret" });
      await expect(auth.verifyCredentials(db.db, "admin", "secret")).rejects.toMatchObject({
        status: 401,
      });
    });

    it("publicUser maps the safe shape and never leaks secrets", async () => {
      const u = await seedUser(db, { name: "Ada", role_id: null, withPassword: "secret" });
      const row = auth.publicUser({
        id: u.id,
        name: u.name,
        photo_url: null,
        birthday: null,
        gender: null,
        role_id: null,
        nav_scope: "all",
        is_admin: false,
        is_kiosk: false,
        system_account: false,
        password_hash: "irrelevant",
      });
      expect(row).toEqual({
        id: u.id,
        name: "Ada",
        photo_url: null,
        birthday: null,
        gender: null,
        role_id: null,
        nav_scope: "all",
        is_admin: false,
        is_kiosk: false,
        system_account: false,
        email: null,
        login_enabled: false,
        failed_attempts: 0,
        locked: false,
        must_change_password: false,
      });
      expect(JSON.stringify(row)).not.toContain("irrelevant");
      expect(auth.publicUser(null)).toBeNull();
    });

    it("getMePayload for an admin: family_name + all modules + full caps", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true, withPassword: "secret" });
      await seedModules(db, ["dashboard", "tasks", "meal-plan", "lists", "admin", "calendar"]);
      await db.db.insert(s.settings).values({ key: "family_name", value: "Lundstedt" }).run();

      const me = await auth.getMePayload(db.db, snakeUserRow(admin));
      expect(me.family_name).toBe("Lundstedt");
      expect(me.enabled_modules.sort()).toEqual([
        "admin",
        "calendar",
        "dashboard",
        "lists",
        "meal-plan",
        "tasks",
      ]);
      expect(me.caps).toEqual(fullCapabilities());
      expect(JSON.stringify(me)).not.toContain("secret");
      expect(me).not.toHaveProperty("password_hash");
      expect(me).not.toHaveProperty("passwordHash");
    });

    it("getMePayload falls back to the default family name", async () => {
      const admin = await seedUser(db, { name: "Admin", is_admin: true, withPassword: "secret" });
      const me = await auth.getMePayload(db.db, snakeUserRow(admin));
      expect(me.family_name).toBe("Clanboard");
    });

    it("memberEnabledModules: role grants, overrides, and the global gate", async () => {
      await seedModules(db, ["dashboard", "tasks", "meal-plan", "lists", "calendar", "admin"]);
      // Role grants only tasks + meal-plan; lists left ungr:
      const [role] = await db.db.insert(s.membersRoles).values({ name: "Kid" }).returning().all();
      await db.db.insert(s.roleModules).values({ roleId: role.id, name: "tasks", caps: JSON.stringify({ create: true }) });
      await db.db.insert(s.roleModules).values({ roleId: role.id, name: "meal-plan", caps: JSON.stringify({ edit: true }) });

      const roleKid = await seedUser(db, { name: "RoleKid", role_id: role.id });
      const enabledForRole = await auth.memberEnabledModules(
        db.db,
        snakeUserRow(roleKid)
      );
      expect(enabledForRole.sort()).toEqual(["dashboard", "meal-plan", "tasks"]);

      // Per-member override turns a role-less module on (lists):
      await db.db.insert(s.userModules).values({ userId: roleKid.id, name: "lists", enabled: true }).run();
      const withOverride = await auth.memberEnabledModules(
        db.db,
        snakeUserRow(roleKid)
      );
      expect(withOverride.sort()).toEqual(["dashboard", "lists", "meal-plan", "tasks"]);

      // Global disabled always wins, even for admins:
      await db.db.update(s.modules).set({ enabled: false }).where(eq(s.modules.name, "calendar")).run();
      const admin = await seedUser(db, { name: "Admin", is_admin: true });
      const adminEnabled = await auth.memberEnabledModules(
        db.db,
        snakeUserRow(admin)
      );
      expect(adminEnabled).not.toContain("calendar");

      // Role member with no role_id inherits the global gate:
      const noRole = await seedUser(db, { name: "NoRole" });
      const noRoleEnabled = await auth.memberEnabledModules(
        db.db,
        snakeUserRow(noRole)
      );
      expect(noRoleEnabled.sort()).toEqual(["dashboard", "lists", "meal-plan", "tasks"]);
    });

    it("password hashing roundtrips", async () => {
      const hash = auth.hashPassword("admin1234");
      expect(hash).toMatch(/^\$2[aby]\$/);
      expect(auth.verifyPassword("admin1234", hash)).toBe(true);
      expect(auth.verifyPassword("nope", hash)).toBe(false);
    });
  });
}