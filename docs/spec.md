# Clanboard — v1 Spec (Rev 3)

## Overview
A self-built, web-based family hub replacing a paid device (Skylight, $300+) and unsuitable open-source options. Runs on an existing wall-mounted tablet plus family members' phones via browser (PWA). Designed as a single lightweight Docker container, deployable at minimal/no hosting cost, and potentially open-sourced for others to self-host.

Reviewed an existing open-source project (Kinboard) as prior art — similar goals, but built on a heavier stack (Next.js + self-hosted Supabase, 5+ containers). This project intentionally trades some of that turnkey breadth for a much smaller footprint (single container, SQLite) and simpler self-hosting.

## Users
- 11 family members: 2 adults + 9 children (a mix of older kids who can type/tap normally, and younger kids who need a simplified, low-text UI — large icons/buttons, minimal reading required)
- Two access modes:
  - **Wall display**: shared household login, always-on, glanceable view
  - **Phones**: personal logins, full interaction
- **Admin role**: John and his wife can administer the system (see Admin section)

## Household Member Profiles
- Each member has: name, photo (uploaded), birthday, role (adult/older-kid/younger-kid)
- Used across modules — task assignment, avatars, dashboard, birthday display

## Core Features (v1)

### 1. Calendar
- **Read-only** display of existing Google Calendars (synced in, not created/edited in-app) — Google only for v1, Apple/CalDAV deferred
- Multiple calendars shown simultaneously, color-coded by person/source
- Day/week view suitable for a wall display; agenda view reasonable for phone
- No event creation/editing in this app for v1 — that still happens in Google Calendar

### 2. Tasks / Chores
A general-purpose task system, not just simple chore checkboxes:
- **Name** (required) and **description** (free text, details of what needs to be done)
- **Assignee**: optional — tasks can be created unassigned and claimed/assigned later
- **Due date/time**: optional
- **Adult review flag**: optional per-task setting — if enabled, a task isn't considered fully complete until an adult marks it reviewed, even after the assignee checks it off
- **Recurrence**: optional, supports daily/weekly patterns
  - Weekly recurrence allows specifying which day(s) of the week the task occurs on
  - Recurrence can optionally have a **validity date range**: when enabled, start date defaults to the current date, end date is optional and set in the future (recurrence stops generating new instances after the end date)
- Completion via simple checkbox (subject to the adult-review flag above) — no points, streaks, or rewards system
- Simplified view/interaction for younger kids (e.g., large tappable icons per task, avatar-based assignment display)
- **Quick-add from dashboard**: a simple text-entry field + "Add" button lets anyone create a task by name only, directly from the dashboard — no assignee, due date, or other fields required at creation time; those can be filled in later
- **Daily progress view** ("what needs to be done today"): a dashboard section showing each child, their task completion progress for the day, and a separate list of unassigned tasks needing an owner. With 9 children, this view needs a compact, scannable layout (e.g., a row or small card per child with a simple progress indicator) rather than one that assumes only a couple of people

### 3. Lists
- Shared lists: groceries, to-buy, packing, etc.
- Add/remove/check off items in real time, visible to all users
- No templates or recurring list items in v1 (add manually each time)

### 4. Meal Plan
- Inspired by Kinboard's meal planning feature, kept intentionally simple for v1
- Weekly board with a fixed structure: 3 meals (breakfast/lunch/dinner) + 1 snack per day
- Each meal slot is a **free-text entry** (e.g., "lasagna", "caesar salad", "grapes") — no recipe objects, no structured ingredients
- **Deferred to a future enhancement**: recipe storage/import, and shopping-list integration that adds missing ingredients automatically

### 5. Dashboard
- Weather for current day + next 2 days
- Household member birthdays (upcoming/today)
- **"What needs to be done today"**: per-child task progress (compact, scannable across 9 children) plus a list of unassigned tasks
- Quick-add text entry for creating a new task by name (see Tasks module)
- Likely the default "home" view on the wall display, combining glanceable info from other modules

### 6. Admin
- Add/remove/manage Google Calendar connections
- Manage household member profiles (add/edit members, upload photos, set birthdays)
- Enable/disable individual modules (see Modularity below)
- Restricted to admin users (John and wife) — not exposed to kids' logins

## Modularity Requirement
This is a first-class architectural constraint, not just a feature:
- Each functional area (Calendar, Tasks, Lists, Meal Plan, Dashboard/Weather, and future modules) should be built as a **self-contained module** with a consistent interface (e.g., a defined way to register its UI, its data schema, and any background sync jobs)
- Admins can enable/disable each module from the admin panel; disabled modules disappear from navigation and stop running background jobs
- New modules should be addable later without modifying the core app shell — think plugin-style registration (e.g., a `modules/` directory where each module self-registers)
- This affects the technical approach significantly (see below) and should be settled early — retrofitting modularity later is expensive

## Explicitly Out of Scope for v1
- Push notifications (nice-to-have, later phase)
- Offline support for the wall display (always-on wifi assumed)
- Event creation/editing from within the app (calendar stays read-only)
- Points/rewards/gamification for tasks
- List templates or recurring list items
- Native mobile apps (PWA only)
- Recipe management (recipe search/import/storage) and recipe-driven shopping list integration — meal plan v1 is free-text entries only per meal slot
- Smart home, energy dashboards, cameras, pocket money — all out of scope (features Kinboard has that this project doesn't need)
- Multi-household / multi-tenant support (single household per deployment, at least initially)

## Technical Approach

### Hosting & Deployment
- **Single Docker container**: the entire app — frontend, backend API, database, and file storage — runs as one container, no multi-container orchestration required for a basic deployment
- **Target hosting**: minimal/no cost — sized to fit a GCP free-tier e2-micro instance (2 shared vCPU, 1 GB RAM); the single-container design is specifically chosen to fit this constraint comfortably, unlike a multi-container Postgres/Supabase stack
- **Open source consideration**: if released publicly on GitHub, avoid hard dependencies on paid or proprietary cloud services so others can realistically self-host for free/cheap. A single container with an embedded database is also simply easier for a non-technical self-hoster to run than a multi-service compose stack

### Stack (lean recommendation)
- **Frontend**: React as a plain Vite-built SPA (not Next.js) — no SSR needed for a dashboard behind a login, and it's a lighter build
- **Backend**: A single Node.js process (Express or Fastify) that serves both the API and the built frontend static files
- **Database**: **SQLite**, embedded in the same container/process — no separate DB container, backup is just copying the file. Appropriate given low write-concurrency (one household, not a multi-tenant service)
- **Auth**: Simple session-cookie + bcrypt-hashed-password auth, rolled by hand — no dedicated auth service needed at this scale
  - Shared household account for the wall display
  - Individual accounts for phones
  - Admin flag on user record gating the Admin module
- **Realtime sync**: a WebSocket server (`ws` library) within the same Node process, broadcasting changes on writes; short-polling (5–10s) is an acceptable simpler fallback if WebSockets add too much complexity early on
- **Calendar sync**: Google Calendar API only for v1 — pull events into a local read-only cache table, refresh periodically via a background job in the same process
- **Weather**: a free-tier weather API (e.g., Open-Meteo, which requires no API key, or OpenWeatherMap free tier) — current day + 2-day forecast only, minimal calls needed
- **File storage** (for member photos): local filesystem volume mounted into the container, alongside the SQLite file — no S3/MinIO needed at this scale

### Modularity Implementation Approach
- Define a lightweight module interface/contract early, e.g.:
  - A module exports: a nav entry, one or more routes/components, its own DB tables/migrations, optional background jobs
  - A central module registry reads an admin-configurable enabled/disabled list and mounts only active modules
- Core modules to build to this contract from day one: Calendar, Tasks, Lists, Meal Plan, Dashboard, Admin — this validates the contract works before any "future module" is attempted
- Keep the contract minimal for v1 — over-engineering a plugin system before you have 2-3 real modules built against it tends to guess wrong; let the real modules inform the interface

### Data model (rough sketch)
- `users`: id, name, photo_url, birthday, role (adult/older-kid/younger-kid), is_admin, password_hash
- `tasks`: id, name, description, assigned_to (nullable), due_at (nullable), requires_adult_review (bool), completed_at, reviewed_at (nullable), recurrence_rule (nullable: daily/weekly + days-of-week), recurrence_start_date, recurrence_end_date (nullable)
- `lists`: id, name, items[] (text, checked, added_by)
- `meal_plan`: id, date, meal_slot (breakfast/lunch/dinner/snack), text (free-text description of what's being eaten)
- `calendar_connections`: id, provider (google/apple), credentials/token ref, added_by_admin
- `calendar_cache`: synced events (read-only, refreshed from external calendar APIs)
- `modules`: id, name, enabled (bool) — admin-controlled

## Build Approach
1. Stand up the single-container skeleton first (Node backend serving a Vite React shell + SQLite), deployed to GCP free tier early — validates the hosting/deployment story before building features on top of it
2. Build the module registry/contract, and one trivial module against it (e.g., Lists) to prove the pattern
3. Add Tasks module (full model: assignment, due dates, recurrence, adult review) and Dashboard (weather) as additional modules
4. Add Calendar module (Google sync first, Apple/CalDAV after)
5. Add Meal Plan module (simple free-text weekly board: 3 meals + snack per day)
6. Add Admin module (calendar management, member profiles/photos, module toggles)
7. Build the simplified younger-kids view as a distinct UI mode
8. Polish the wall-display kiosk view last

## Future Enhancements (Post-v1)
- Meal Plan: recipe storage/import and shopping-list integration that adds missing ingredients for planned meals automatically
- Apple Calendar / CalDAV sync alongside Google

## Open Questions to Resolve During Build
- WebSocket realtime vs. short-polling — worth a quick spike to see how much complexity the WebSocket approach actually adds before committing
- If open-sourcing: licensing choice (MIT/Apache-2.0 are common for this kind of project), and how much setup documentation is needed for others to self-host
- How many distinct "younger kid" profiles need the simplified UI, and how different should it be from the standard view?
