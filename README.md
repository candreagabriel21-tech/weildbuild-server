# WeildBuild Server

> **v1.3.2 — local dev always welcome (CORS).** Any `localhost` /
> `127.0.0.1` origin (any port) and the Tauri desktop origins are now
> ALWAYS allowed, no matter what `ALLOWED_ORIGINS` says. This fixes
> WB Admin CTRL run in browser mode (`npm run dev`, port 5173) getting
> "Failed to fetch" against the live server. Production origins still
> come from `ALLOWED_ORIGINS`.
>
> **v1.3.1 — no more Render Shell needed (it went paid-only).** Render
> removed Shell access from free plans, so the old "run `npm run migrate`
> in the Shell" step is gone. The Main Server now sets up the database
> **by itself, automatically, every time it boots**: it syncs the schema
> (`prisma db push` — a no-op when already in sync) and, if the database
> is completely empty (brand-new Neon project), also runs the seed
> (default admin account + 34 shop items). Deploy and you're done.
>
> **v1.3.0 — admin settings + WB Admin CTRL.** The version gate (client
> min/latest + **per-platform download links**) is now stored in the database
> and editable at runtime via the new admin API (`GET/PUT /api/admin/settings`)
> — no redeploys needed to change them. New `GET /api/admin/overview`
> returns the whole platform state in one call (counts, hosts, live
> instances **with player usernames**, uptime, recent DMs). Game hosts now
> report player names + uptime in heartbeats.
>
> **v1.2.0 — build fix for Render.** v1.1 failed to build with `TS7016`:
> Render builds run with `NODE_ENV=production`, and npm **skips
> devDependencies** in that mode — so `@types/express` (and `tsx`) never got
> installed. Fix: all build-time tools (`prisma`, `typescript`, `tsx`,
> `@types/*`) now live in `dependencies`, so the build works no matter what
> `NODE_ENV` is.

The platform backend for **WeildBuild** — a 3D game creation platform (think Roblox Studio). This repo replaces the old Next.js API routes + Supabase setup with a proper multi-service architecture deployed on free tiers.

```
weildbuild-server/
├── src/
│   ├── main/        ← MAIN SERVER (REST API — the brain)
│   │   ├── index.ts         Express app: mounts all routers + /version gate
│   │   ├── middleware.ts    JWT ticket auth (requireAuth / requireAdmin)
│   │   └── routes/          auth, users, friends, games, items,
│   │                        notifications, admin, storage, reports,
│   │                        instances (+ internal host registry)
│   ├── realtime/    ← REALTIME SERVER (Socket.IO)
│   │   └── index.ts         presence, friend requests, DM push, lobby
│   ├── gamehost/    ← GAME HOST (runs the mini servers)
│   │   ├── index.ts         registers with main, heartbeats, Socket.IO rooms
│   │   └── instances.ts     instance manager: create/fill/dispose rooms
│   ├── db/          ← Prisma data layer (users, games, items, sessions,
│   │                  rate limits, hosts, instances, reports…)
│   ├── b2/          ← Backblaze B2 storage (4 buckets)
│   └── shared/      ← config, JWT, constants, HTTP helpers
├── prisma/          ← schema + seed (34 shop items, admin account)
├── tests/           ← password-compat test (must pass before deploy)
├── scripts/         ← E2E suite + embedded-Postgres test helper
├── render.yaml      ← Render blueprint (see the header comment!)
└── DEPLOY.md        ← 🚀 START HERE — click-by-click deployment guide
```

## The three services

| Service | Port | Purpose |
|---|---|---|
| **Main Server** | 8000 | Accounts (scrypt + JWT tickets), profiles, friends & DMs, games CRUD, item shop with race-safe purchases, notifications, version gate, storage proxy, **instance placement** |
| **Realtime** | 3003 | Socket.IO: presence (`user:online`), friend request/accept push, `dm:new` push, lobby relay |
| **Game Host** | 3004 | The Roblox-style part: runs N **mini-server instances** per host. Each instance = one room of ≤10 players, own physics/events, **deleted 20 s after hitting 0 players** |

> **Keep-alive:** Render free tier sleeps after 15 min idle. A free **UptimeRobot** monitor pings each `/health` every 5 minutes — 2-minute setup, no extra service or Render account (DEPLOY.md §6).

### How multiplayer placement works

```
player joins game ──► POST /api/instances/join (main)
                          │ 1. existing instance of this game with room left?
                          │    → join it (fullest first)
                          │ 2. else create instance on best host:
                          │    priority 1 (Server 1) → priority 2 (Server 2)
                          ▼
                    { instanceId, socketUrl, token }
                          │
player ◄──────────────────┘ connects Socket.IO straight to that host
                             with the same JWT ticket — host verifies locally
```

Hosts **register** with main on boot and **heartbeat** every 15 s (instances + player counts). Hosts that stop heartbeating for 60 s are marked offline and instances closed — crash-safe. Instances at 0 players are disposed after `EMPTY_GRACE_MS` (default 20 s).

## Local development

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL + AUTH_SECRET at minimum
npm run setup                 # prisma db push + seed
npm run build                 # prisma generate + tsc
npm run start:main            # :8000  (or dev:main for watch mode)
npm run start:realtime        # :3003
npm run start:gamehost        # :3004
```

**Full E2E test** (boots an embedded Postgres, all three services, runs 28 checks — auth, shop, friends, DMs, publish, placement, heartbeats):

```bash
node scripts/test-db.js &     # embedded Postgres on :5433
bash scripts/test-e2e.sh
```

**Password compatibility test** (verifies old accounts still log in):

```bash
npm run test:compat
```

## Deploying

Read **[DEPLOY.md](./DEPLOY.md)** — the full guide (Neon, Render's 4-account trick, B2 buckets, secrets, UptimeRobot keep-alive, smoke tests). Short version: every service = one Render web service from this repo, one per Render account, all kept awake 24/7 by a free UptimeRobot monitor.

## API surface (v1)

All routes are mounted under `/api/*` — **the exact same paths the old Next.js app used**, so the desktop client only changed its base URL. Tickets go in the `X-Session-Token` header (or `?session_token=` for downloads).

- `POST /api/auth` — `action: register | login | logout | session`
- `GET/PUT /api/users` — search, profiles, self-update
- `GET/POST /api/friends` — requests, accept/decline, block, DMs (`send_message`, `get_messages`)
- `GET/POST/PUT /api/games` — publish, update, list (games ARE the game files: JSONB worlds)
- `GET/POST /api/items` — catalog + race-safe purchase (`buyItemId` transaction)
- `GET/POST /api/notifications`
- `POST /api/reports` — bug reports → B2 reports bucket
- `GET /api/storage/download` — authenticated B2 asset proxy
- `GET/POST /api/admin/backup|cleanup` — top_admin only
- `GET /version` — client version gate
- `GET /api/instances` + `POST /api/instances/join` — live servers + placement
- `POST /internal/hosts/register|heartbeat` — server-to-server (token-gated)
