import express from "express";
import bcrypt from "bcryptjs";
import { db, memberEnabledModules, memberCapabilities, getSetting } from "../../db.js";

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT,
      expires_at INTEGER
    );
  `);
}

const SALT_ROUNDS = 10;

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    photo_url: u.photo_url,
    birthday: u.birthday,
    gender: u.gender,
    role_id: u.role_id,
    nav_scope: u.nav_scope,
    is_admin: !!u.is_admin,
    is_kiosk: !!u.is_kiosk,
  };
}

export function authenticated(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
    if (user) {
      req.user = user;
      return next();
    }
  }
  return res.status(401).json({ error: "Not authenticated" });
}

export function requireAdmin(req, res, next) {
  if (req.user && req.user.is_admin) return next();
  return res.status(403).json({ error: "Admin required" });
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

const router = express.Router();

// Current authenticated user (or 401)
router.get("/me", (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({
    ...publicUser(user),
    family_name: getSetting("family_name") || "Clanboard",
    enabled_modules: memberEnabledModules(user.id),
    caps: memberCapabilities(user),
  });
});

router.post("/login", (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: "name and password are required" });

  const user = db.prepare("SELECT * FROM users WHERE name = ?").get(name.trim());
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  req.session.userId = user.id;
  res.json(publicUser(user));
});

router.post("/logout", (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.json({ ok: true }));
  } else {
    res.json({ ok: true });
  }
});

export default {
  name: "auth",
  navLabel: null,
  migrate,
  router,
  authenticated,
  requireAdmin,
  hashPassword,
  publicUser,
};