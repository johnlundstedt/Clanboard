# Clanboard

A self-hosted family calendar, tasks, lists, and meal-plan dashboard.
Single Docker container. SQLite database. No external services required
to run the core app (Google Calendar + weather are optional integrations).

## Architecture

- `server/` — Node.js (Express) API + module registry + SQLite (better-sqlite3)
- `client/` — React (Vite) single-page app, built to static files and served by the server
- Modules (Calendar, Tasks, Lists, Meal Plan, Dashboard, Admin) each self-register
  routes + DB migrations + nav entries via `server/src/modules/registry.js`

## First run

On first launch with an empty database, the server creates an initial admin
account:

- `ADMIN_NAME` env var (default `Admin`)
- `ADMIN_PASSWORD` env var (default `admin1234` — change this!)

Sign in, then add household members, set your home location for weather on the
Dashboard, and connect Google Calendars from the Calendar module.

Other optional env vars: `SESSION_SECRET`, `PORT` (default 3001), `DATA_DIR`
(default `./data`).

## Local development

```bash
# terminal 1 — API server with hot reload
cd server && npm install && npm run dev

# terminal 2 — frontend dev server (proxies /api + /ws to :3001)
cd client && npm install && npm run dev
```

Visit http://localhost:5173

## Production (single container)

```bash
docker build -t clanboard .
docker run -p 3001:3001 -e SESSION_SECRET=change-me -e ADMIN_PASSWORD=change-me \
  -v $(pwd)/data:/app/data clanboard
```

Visit http://localhost:3001

## Cloudflare (Workers + D1 + R2)

The same portable core also runs on Cloudflare's free tier as a single Worker
(`server/src/worker.ts`): the React build (`client/dist`) is served as Workers
static assets, D1 is the database, and R2 holds uploaded photos. The schema
and module migrations are applied idempotently at worker boot from embedded
SQL, so there is no separate migration step for Cloudflare.

Wrangler needs Node ≥ 22; deploy from `server/` (`server/wrangler.toml` holds
the D1 + R2 bindings, custom domains, and the 15-minute sync cron):

```bash
cd server && npm install
npm run db:gen-schema                # embed drizzle SQL for the Worker (no fs on Workers)
( cd ../client && npm install && npm run build )   # produces client/dist
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy                  # worker + assets + clanboard.app/www custom domains + cron
```

On first boot against an empty D1, the worker creates the initial admin from
the `ADMIN_PASSWORD` secret.

## Status

Auth, module registry, and all six modules (Tasks, Lists, Meal Plan, Calendar,
Dashboard, Admin) are implemented. Realtime updates via WebSocket on the same
process (short-polling fallback).
See `docs/spec.md` for full requirements.
