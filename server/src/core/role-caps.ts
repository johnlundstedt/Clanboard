// The modules a role can grant beyond simple on/off, and the capabilities an
// admin can toggle within each. Calendar/dashboard/admin have no per-module
// capabilities (a role either grants the module or not). Kept framework- and
// driver-agnostic so both container (Express + better-sqlite3) and Cloudflare
// (Hono + D1) share the exact same rules.
export const ROLE_CAPABILITIES = {
  tasks: [
    "view_others",
    "create", "create_unassigned",
    "assign_self", "assign_others",
    "volunteer", "reassign",
    "edit", "delete", "update_deadline",
    "complete_own", "complete_others",
    "review",
  ],
  "meal-plan": ["edit"],
  lists: ["create_lists", "delete_lists", "add_items", "remove_items", "complete_items"],
} as const;

// Full capabilities object for every configurable module (admin / no role).
export function fullCapabilities() {
  const out: Record<string, Record<string, boolean>> = {};
  for (const [module, caps] of Object.entries(ROLE_CAPABILITIES)) {
    out[module] = Object.fromEntries(caps.map((c) => [c, true]));
  }
  return out;
}