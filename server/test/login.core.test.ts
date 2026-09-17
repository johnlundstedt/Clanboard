import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../src/schema.js";
import * as auth from "../src/core/auth.js";
import * as email from "../src/core/email.js";
import * as admin from "../src/core/admin.js";
import {
  applyMigrationStatements,
  migrationStatements as coreMigrationStatements,
} from "../src/core/migrations.js";
import {
  closeD1,
  makeD1Database,
  makeSqliteDatabase,
  type TestDatabase,
} from "./helpers/db.js";

// Login-managed members: email login, temporary passwords, forced password
// change, lockout, forgot-password, and admin unlock.

const backends = [
  { name: "sqlite", make: makeSqliteDatabase },
  { name: "d1", make: makeD1Database },
];

afterAll(async () => {
  await closeD1();
});

async function seedUser(
  db: TestDatabase,
  opts: {
    name: string;
    password?: string;
    email?: string;
    login_enabled?: boolean;
    is_admin?: boolean;
    is_kiosk?: boolean;
    system_account?: boolean;
  } = { name: "Ada" }
) {
  const [u] = await db.db
    .insert(s.users)
    .values({
      name: opts.name,
      email: opts.email ?? null,
      loginEnabled: opts.login_enabled ?? false,
      isAdmin: opts.is_admin ?? false,
      isKiosk: opts.is_kiosk ?? false,
      systemAccount: opts.system_account ?? false,
      passwordHash: opts.password ? auth.hashPassword(opts.password) : null,
    })
    .returning()
    .all();
  return u;
}

for (const backend of backends) {
  describe(`login + lockout (${backend.name})`, () => {
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

    it("managed members accumulate failed attempts and lock on the third", async () => {
      await seedUser(db, { name: "Ada", password: "right", email: "ada@x.io", login_enabled: true });

      await expect(auth.verifyCredentials(db.db, "Ada", "wrong1")).rejects.toMatchObject({ status: 401 });
      await expect(auth.verifyCredentials(db.db, "Ada", "wrong2")).rejects.toMatchObject({ status: 401 });
      // Third failure locks the account instead of a plain 401:
      await expect(auth.verifyCredentials(db.db, "Ada", "wrong3")).rejects.toMatchObject({ status: 423 });

      const row = await db.db
        .select({
          locked: s.users.locked,
          failedAttempts: s.users.failedAttempts,
        })
        .from(s.users)
        .where(eq(s.users.name, "Ada"))
        .get();
      expect(row?.locked).toBe(true);
      expect(row?.failedAttempts).toBe(0);

      // Even the correct password is refused while locked.
      await expect(auth.verifyCredentials(db.db, "Ada", "right")).rejects.toMatchObject({ status: 423 });
    });

    it("a successful login resets the attempt counter", async () => {
      await seedUser(db, { name: "Ada", password: "right", email: "ada@x.io", login_enabled: true });
      await expect(auth.verifyCredentials(db.db, "Ada", "wrong")).rejects.toMatchObject({ status: 401 });
      await expect(auth.verifyCredentials(db.db, "Ada", "wrong")).rejects.toMatchObject({ status: 401 });
      const ok = await auth.verifyCredentials(db.db, "Ada", "right");
      expect(ok.id).toBeTruthy();
      const row = await db.db
        .select({ failedAttempts: s.users.failedAttempts })
        .from(s.users)
        .where(eq(s.users.name, "Ada"))
        .get();
      expect(row?.failedAttempts).toBe(0);
    });

    it("admin / kiosk / system / non-login accounts are exempt from lockout", async () => {
      await seedUser(db, { name: "Admin", password: "pw", is_admin: true, login_enabled: true });
      await seedUser(db, { name: "Kiosk", password: "pw", is_kiosk: true, login_enabled: true });
      await seedUser(db, { name: "Sys", password: "pw", system_account: true, login_enabled: true });
      await seedUser(db, { name: "NoLogin", password: "pw" });

      for (const name of ["Admin", "Kiosk", "Sys", "NoLogin"]) {
        for (let i = 0; i < 5; i += 1) {
          await expect(auth.verifyCredentials(db.db, name, "nope")).rejects.toMatchObject({
            status: 401,
          });
        }
      }
      // None locked, and the managed login flag didn't change the exemption.
      const rows = await db.db.select().from(s.users);
      for (const r of rows) {
        expect(r.locked).toBe(false);
        expect(r.failedAttempts).toBe(0);
      }
      // Exempt accounts still sign in fine afterwards.
      await expect(auth.verifyCredentials(db.db, "Admin", "pw")).resolves.toBeTruthy();
      await expect(auth.verifyCredentials(db.db, "NoLogin", "pw")).resolves.toBeTruthy();
    });

    it("login returns the must_change_password flag for a temp-password member", async () => {
      await seedUser(db, { name: "Ada", password: "Temp1!aaaa", email: "ada@x.io", login_enabled: true });
      await db.db
        .update(s.users)
        .set({ mustChangePassword: true })
        .where(eq(s.users.name, "Ada"))
        .run();
      const user = await auth.verifyCredentials(db.db, "Ada", "Temp1!aaaa");
      expect(user.must_change_password).toBe(true);
    });

    it("unlockMember clears lock and attempt count; resetPassword rewrites the hash", async () => {
      const u = await seedUser(db, { name: "Ada", password: "Old1!aa", email: "ada@x.io", login_enabled: true });
      await db.db
        .update(s.users)
        .set({ locked: true, failedAttempts: 2 })
        .where(eq(s.users.id, u.id))
        .run();
      await expect(auth.verifyCredentials(db.db, "Ada", "Old1!aa")).rejects.toMatchObject({ status: 423 });

      await admin.unlockMember(db.db, Number(u.id));
      const unlocked = await auth.verifyCredentials(db.db, "Ada", "Old1!aa");
      expect(unlocked.locked).toBe(false);

      await auth.resetPassword(db.db, Number(u.id), "Temp2!bbb");
      await expect(auth.verifyCredentials(db.db, "Ada", "Old1!aa")).rejects.toMatchObject({ status: 401 });
      const forced = await auth.verifyCredentials(db.db, "Ada", "Temp2!bbb");
      expect(forced.must_change_password).toBe(true);
      expect(forced.locked).toBe(false);
    });

    it("forgot-password lookup is exact on name, case-insensitive on email, mailed only to login-managed accounts", async () => {
      await seedUser(db, { name: "Ada", email: "ada@X.io", login_enabled: true });
      await seedUser(db, { name: "Admin", email: "admin@x.io", is_admin: true, login_enabled: true });

      expect(await auth.findLoginUser(db.db, "Ada", "ADA@x.io")).toEqual({ id: expect.any(Number), email: "ada@X.io" });
      expect(await auth.findLoginUser(db.db, "ada", "ada@x.io")).toBeNull(); // name is case-sensitive
      expect(await auth.findLoginUser(db.db, "Ada", "other@x.io")).toBeNull();
      expect(await auth.findLoginUser(db.db, "Admin", "admin@x.io")).toBeNull(); // exempt
      expect(await auth.findLoginUser(db.db, "Ghost", "ada@x.io")).toBeNull();
    });

    it("password policy: at least 8 chars, upper + lower + symbol", () => {
      expect(auth.validateNewPassword("Ab1!cdef")).toBeNull();
      expect(auth.validateNewPassword("abcdefgh")).toContain("uppercase");
      expect(auth.validateNewPassword("ABCDEFGH")).toContain("lowercase");
      expect(auth.validateNewPassword("Abcdefgh")).toContain("symbol");
      expect(auth.validateNewPassword("Ab1!cd")).toContain("at least 8");
      expect(auth.validateNewPassword(undefined)).toBeTruthy();

      for (let i = 0; i < 5; i += 1) {
        const pw = auth.generateTemporaryPassword();
        expect(pw.length).toBeGreaterThanOrEqual(8);
        expect(auth.validateNewPassword(pw)).toBeNull();
      }
    });

    it("createMember with login enabled requires an email, validates the password, and never leaks", async () => {
      await expect(admin.createMember(db.db, { name: "Eva", login_enabled: true })).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        admin.createMember(db.db, { name: "Eva", login_enabled: true, email: "not-an-email" })
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        admin.createMember(db.db, { name: "Eva", password: "short", email: "eva@x.io", login_enabled: true })
      ).rejects.toMatchObject({ status: 400 });

      const members = await admin.listMembers(db.db);
      expect(members.length).toBe(0);
    });

    it("createMember with login enabled + email configured generates a temp password and mails it", async () => {
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body?: string }) => {
          sent.push(JSON.parse(init?.body ?? "{}") as { to: string; subject: string; text: string });
          return { ok: true } as Response;
        })
      );
      await db.db.insert(s.settings).values({ key: "resend_api_key", value: "re_xxx" }).run();
      await db.db.insert(s.settings).values({ key: "site_url", value: "https://clanboard.app" }).run();

      const member = (await admin.createMember(db.db, { name: "Eva", email: "eva@x.io", login_enabled: true }))!;
      expect(member.login_enabled).toBe(true);
      expect(member.email).toBe("eva@x.io");
      expect(member.must_change_password).toBe(true);
      expect(member).not.toHaveProperty("password_hash");

      // Two emails: welcome + temporary password; the temp password parsed from
      // the message is valid and signs in with a forced change.
      const subjects = sent.map((m) => m.subject);
      expect(subjects).toEqual(["Welcome to Clanboard!", expect.stringContaining("temporary password")]);
      const matches = /Your temporary password is:\s+\n\s+(\S+)/.exec(sent[1].text ?? "");
      const pw = matches?.[1] ?? "";
      expect(auth.validateNewPassword(pw)).toBeNull();

      const user = await auth.verifyCredentials(db.db, "Eva", pw);
      expect(user.must_change_password).toBe(true);
      vi.unstubAllGlobals();
    });

    it("updateMember mails welcome (+ temp password) when enabling login", async () => {
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body?: string }) => {
          sent.push(JSON.parse(init?.body ?? "{}") as { to: string; subject: string; text: string });
          return { ok: true } as Response;
        })
      );
      await db.db.insert(s.settings).values({ key: "resend_api_key", value: "re_x" }).run();

      // Password-less member: welcome + temporary password, forced change.
      const [plain] = await db.db.insert(s.users).values({ name: "Eva" }).returning().all();
      const updated = (await admin.updateMember(db.db, Number(plain.id), {
        email: "eva@x.io",
        login_enabled: true,
      }))!;
      expect(updated.login_enabled).toBe(true);
      expect(updated.must_change_password).toBe(true);
      expect(sent.map((m) => m.subject)).toEqual([
        "Welcome to Clanboard!",
        expect.stringContaining("temporary password"),
      ]);

      // Member who already has a password: welcome email only, password kept.
      const [noah] = await db.db
        .insert(s.users)
        .values({ name: "Noah", passwordHash: auth.hashPassword("Oldpass1!") })
        .returning()
        .all();
      const before = (await db.db.select().from(s.users).where(eq(s.users.id, Number(noah.id))).get())!;
      sent.length = 0;
      const updated2 = (await admin.updateMember(db.db, Number(noah.id), {
        email: "noah@x.io",
        login_enabled: true,
      }))!;
      expect(updated2.must_change_password).toBe(false);
      expect(sent.map((m) => m.subject)).toEqual(["Welcome to Clanboard!"]);
      const after = (await db.db.select().from(s.users).where(eq(s.users.id, Number(noah.id))).get())!;
      expect(after.passwordHash).toBe(before.passwordHash);

      // No API key configured → explicit failure:
      const [plain2] = await db.db.insert(s.users).values({ name: "Ivo" }).returning().all();
      await db.db.delete(s.settings).where(eq(s.settings.key, "resend_api_key")).run();
      await expect(
        admin.updateMember(db.db, Number(plain2.id), { email: "ivo@x.io", login_enabled: true })
      ).rejects.toMatchObject({ status: 400 });
      vi.unstubAllGlobals();
    });

    it("email helpers refuse to send without a configured key", async () => {
      await expect(email.sendEmail(db.db, { to: "x@x.io", subject: "s", text: "t" })).rejects.toMatchObject({
        status: 400,
      });
      await expect(email.emailConfigured(db.db)).resolves.toBe(false);
      await db.db.insert(s.settings).values({ key: "resend_api_key", value: "re_x" }).run();
      await expect(email.emailConfigured(db.db)).resolves.toBe(true);
    });

    it("RESEND_API_KEY passed at boot (initEmailConfig) wins over the DB setting", async () => {
      await db.db.delete(s.settings).where(eq(s.settings.key, "resend_api_key")).run();
      await expect(email.emailConfigured(db.db)).resolves.toBe(false);

      const auths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
          auths.push(init?.headers?.Authorization ?? "");
          return { ok: true } as Response;
        })
      );

      // Config binding enables sending without any DB row…
      email.initEmailConfig({ resendApiKey: "re_cfgkey" });
      await email.sendEmail(db.db, { to: "x@x.io", subject: "s", text: "t" });
      expect(auths).toEqual(["Bearer re_cfgkey"]);

      // …and overrides a stale legacy admin-settings value.
      await db.db.insert(s.settings).values({ key: "resend_api_key", value: "re_stale" }).run();
      auths.length = 0;
      await email.sendEmail(db.db, { to: "x@x.io", subject: "s", text: "t" });
      expect(auths).toEqual(["Bearer re_cfgkey"]);

      email.initEmailConfig({ resendApiKey: null });
      vi.unstubAllGlobals();
    });

    it("resetMemberPassword mails a fresh temp password and forces a change on sign-in", async () => {
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body?: string }) => {
          sent.push(JSON.parse(init?.body ?? "{}") as { to: string; subject: string; text: string });
          return { ok: true } as Response;
        })
      );
      await db.db.insert(s.settings).values({ key: "resend_api_key", value: "re_x" }).run();
      const [james] = await db.db.insert(s.users).values({
        name: "James",
        email: "james@x.io",
        loginEnabled: true,
        passwordHash: auth.hashPassword("Oldpass1!"),
      }).returning().all();

      const updated = (await admin.resetMemberPassword(db.db, Number(james.id)))!;
      expect(updated.must_change_password).toBe(true);
      expect(updated.locked).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("james@x.io");
      expect(sent[0].subject).toContain("password has been reset");

      const pw = /Your temporary password is:\s+\n\s+(\S+)/.exec(sent[0].text ?? "")?.[1] ?? "";
      expect(auth.validateNewPassword(pw)).toBeNull();
      const user = await auth.verifyCredentials(db.db, "James", pw);
      expect(user.must_change_password).toBe(true);
      vi.unstubAllGlobals();
    });

    it("resetMemberPassword refuses a member without an email", async () => {
      const [luke] = await db.db.insert(s.users).values({ name: "Luke" }).returning().all();
      await expect(admin.resetMemberPassword(db.db, Number(luke.id))).rejects.toMatchObject({ status: 400 });
    });
  });
}

describe("migration idempotency (ALTER-gated)", () => {
  const backends2 = [
    { name: "sqlite", make: makeSqliteDatabase },
    { name: "d1", make: makeD1Database },
  ];

  for (const backend of backends2) {
    it(`re-applying the generated SQL is a no-op on a provisioned ${backend.name} db`, async () => {
      const testDb = await backend.make();
      const statements = await coreMigrationStatements();
      // Fresh db already applied the SQL; applying idempotently again must be
      // safe: the ALTER-guard skips existing columns (a duplicate ADD COLUMN
      // would otherwise throw) and CREATEs are IF-NOT-EXISTS no-ops.
      await expect(applyMigrationStatements(testDb.raw, statements, { idempotent: true })).resolves
        .toBeGreaterThanOrEqual(0);
      const cols = await testDb.queryAll('PRAGMA table_info("users")');
      expect(cols.map((c) => String(c.name))).toEqual(
        expect.arrayContaining([
          "email",
          "login_enabled",
          "failed_attempts",
          "locked",
          "must_change_password",
        ])
      );
      await testDb.close();
    });
  }
});