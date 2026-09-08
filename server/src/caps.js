import { memberCapabilities } from "./db.js";

// True if `user` can perform `cap` inside `module`. Admins (and the wall
// display) are always allowed.
export function hasCap(user, module, cap) {
  if (!user) return false;
  if (user.is_admin || user.is_kiosk) return true;
  const caps = memberCapabilities(user);
  return !!(caps[module]?.[cap]);
}

// Express middleware: 403 unless the current user has the capability.
export function requireCap(module, cap) {
  return (req, res, next) => {
    if (hasCap(req.user, module, cap)) return next();
    return res.status(403).json({ error: "Your role doesn't allow this action." });
  };
}

// A user may assign a task to `assigneeId` only if it's themselves (needs
// assign_self) or someone else (needs assign_others).
export function canAssign(user, assigneeId) {
  if (user.is_admin || user.is_kiosk) return true;
  if (assigneeId === undefined) return true;
  const cap = assigneeId === user.id ? "assign_self" : "assign_others";
  return hasCap(user, "tasks", cap);
}