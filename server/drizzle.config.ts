import { defineConfig } from "drizzle-kit";

// Drizzle schema is the single source of truth. drizzle-kit generates standard
// SQL migrations that both deploy targets consume:
//   - Cloudflare Workers: `wrangler d1 migrations apply`
//   - Container: `npm run db:migrate:sqlite` (src/db/migrate-sqlite.ts)
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
});