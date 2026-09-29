# 🚀 WeildBuild Server — Deployment Guide

This guide takes you from zero to a live platform: **Main Server + Realtime + two Game Hosts**, all on free tiers, kept awake 24/7 by a free **UptimeRobot** monitor — with a **Neon Postgres** database and **Backblaze B2** storage.

**Time needed:** ~45–60 minutes (most of it is clicking through dashboards).

---

## 0. The big picture

```
 Desktop app ──────────┐
 (Tauri, any user)     │  HTTPS + JWT
                       ▼
              ┌─────────────────┐        ┌──────────────────┐
              │  MAIN SERVER    │◄──────►│  NEON POSTGRES   │
              │  (auth, games,  │        │  (all data)      │
              │   items, place- │        └──────────────────┘
              │   ment, version)│        ┌──────────────────┐
              │  weildbuild-main│───────►│  BACKBLAZE B2    │
              └───┬────────┬────┘        │  (4 buckets:     │
     placement     │        │             │  assets, files,  │
                  ▼        ▼             │  reports, backup)│
        ┌─────────────┐ ┌─────────────┐ └──────────────────┘
        │ GAME HOST 1 │ │ GAME HOST 2 │
        │ "Server 1"  │ │ "Server 2"  │  ← runs the mini-server
        │ (instances) │ │ (overflow)  │    instances (rooms)
        └──────┬──────┘ └──────┬──────┘
               │  Socket.IO    │
               ▼               ▼
        players' desktop apps connect directly to their instance
```

| Service | What it does | Account |
|---|---|---|
| `weildbuild-main` | The brain: accounts, friends, games, item shop, notifications, version check, instance placement | 1 (you) |
| `weildbuild-realtime` | Presence, friend events, DM push, lobby | 2 (friend) |
| `weildbuild-gamehost-1` | "Server 1" — mini-server instances | 3 (friend) |
| `weildbuild-gamehost-2` | "Server 2" — overflow instances | 4 (friend) |

**Why 4 accounts?** Render's free tier gives each account ~750 instance-hours/month. One service kept awake 24/7 burns ~730 h — so **one always-awake service per account** fits exactly. Four services on one account would get suspended around day 8. (Keep-alive needs no 5th account anymore — a free UptimeRobot monitor does the job, see section 6.)

> **Fewer than 4 accounts?** Prioritize: Main → Realtime → Game Host 1 → Game Host 2. Game hosts that aren't kept awake will cold-start (~30–60 s) on the first join attempt — players just see "waking up the server…" and can retry. Everything still works.

---

## 1. Neon Postgres (5 min)

Supabase's free tier deletes inactive databases — Neon doesn't. That's why we're moving.

1. Go to **https://neon.tech** → **Sign Up** (GitHub login works great).
2. **Create project** → name it `weildbuild` → pick the region closest to you (e.g. *AWS eu-central-1 (Frankfurt)* to match the rest of the stack).
3. On the project dashboard, find **Connection string** → **Prisma** connection string. It looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx-xxxx-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```
4. **Copy it somewhere safe** — it's the `DATABASE_URL` every service needs.

> 💡 Neon free tier: 0.5 GB storage, autosuspend after idle — all fine, it wakes in ~1 s and never deletes data.

---

## 2. Push the server repo to GitHub (5 min)

1. Create a new GitHub repo, e.g. `weildbuild-server` (private is fine — Render reads private repos).
2. From the `weildbuild-server` folder:
   ```bash
   git init
   git add .
   git commit -m "WeildBuild platform server v1.2 (Render build fix)"
   git remote add origin https://github.com/YOUR-NAME/weildbuild-server.git
   git push -u origin main
   ```
3. **Add your friends as collaborators** (Repo → Settings → Collaborators) so their Render accounts can connect it.

---

## 3. Backblaze B2 — the four buckets (10 min)

You already have B2 keys + the `weildbuild` assets bucket. We add three more buckets (same account is fine — buckets are free; only storage costs, and it's cheap).

| Bucket name | Purpose |
|---|---|
| `weildbuild` *(exists)* | Assets — face PNGs, textures, audio, thumbnails |
| `weildbuild-gamefiles` | Game files — published builds, project exports |
| `weildbuild-reports` | Reports — bug reports, moderation, diagnostics |
| `weildbuild-backups` | Backups — database exports, snapshots |

1. **https://console.backblaze.com** → **B2 Cloud Storage** → **Buckets** → **Create a Bucket** (three times):
   - Name: `weildbuild-gamefiles` / `weildbuild-reports` / `weildbuild-backups`
   - **Private** bucket, no object lock.
2. **App Keys** → **Add a New Application Key**:
   - Name: `weildbuild-server`
   - Allow access to **All buckets** (it needs the assets bucket AND the new three).
3. Copy the **keyID** and the **applicationKey** (shown only once!).
4. Check your **Endpoint** on any bucket's page — e.g. `s3.eu-central-003.backblazeb2.com`. All four buckets on one account share the same endpoint region.

> If your buckets live in different regions, set `B2_ENDPOINT` per service later — but simplest is: keep them all in one region.

---

## 4. Generate the two secrets (2 min)

Run these anywhere Node is installed and save the outputs:

```bash
# AUTH_SECRET — signs login tickets. MUST be identical on ALL services.
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# INTERNAL_TOKEN — main ↔ game hosts server-to-server. Same on main + both game hosts.
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

⚠️ **Never commit these.** You'll paste them directly into Render dashboards.

---

## 5. Deploy on Render — the 4-account plan (20 min)

Every account does the same simple thing: **create ONE web service from the shared GitHub repo**. You can do this for your friends on their machines, or send them this section.

### How to create one service (repeat per account)

1. Log in to the Render account → **New +** → **Web Service**.
2. **Connect** the `weildbuild-server` GitHub repo (friends need collaborator access first).
3. Fill in the fields from the table for that account:
   - **Name** / **Region** (*Frankfurt*) / **Branch** (`main`)
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: from the table
   - **Instance Type**: Free
4. Click **Add Environment Variable** for every row in the table's env section (secrets pasted, not typed).
5. **Create Web Service** → wait for build (~2–4 min) → watch the log for the startup banner.

### Account 1 — YOU — `weildbuild-main`

| Field | Value |
|---|---|
| Name | `weildbuild-main` |
| Start Command | `npm run start:main` |
| Health check path | `/health` |

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(Neon connection string from step 1)* |
| `AUTH_SECRET` | *(from step 4)* |
| `INTERNAL_TOKEN` | *(from step 4)* |
| `B2_KEY_ID` | *(from step 3)* |
| `B2_APPLICATION_KEY` | *(from step 3)* |
| `B2_ENDPOINT` | `s3.eu-central-003.backblazeb2.com` *(yours!)* |
| `B2_ASSETS_BUCKET` | `weildbuild` |
| `B2_GAMEFILES_BUCKET` | `weildbuild-gamefiles` |
| `B2_REPORTS_BUCKET` | `weildbuild-reports` |
| `B2_BACKUPS_BUCKET` | `weildbuild-backups` |
| `ALLOWED_ORIGINS` | `tauri://localhost,http://tauri.localhost,http://localhost:3000,https://weildbuild.vercel.app` — v1.3.2+: every `localhost`/`127.0.0.1` port is ALSO always allowed, so local tools (e.g. Admin CTRL on :5173) work no matter what |
| `CLIENT_LATEST_VERSION` | `13.1.0` |
| `CLIENT_MIN_VERSION` | `13.0.0` |
| `CLIENT_DOWNLOAD_URL` | `https://weildbuild.vercel.app` |

### Account 2 — `weildbuild-realtime`

| Field | Value |
|---|---|
| Name | `weildbuild-realtime` |
| Start Command | `npm run start:realtime` |
| Health check path | `/health` |

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(same Neon string)* |
| `AUTH_SECRET` | *(same as main — critical!)* |
| `ALLOWED_ORIGINS` | `tauri://localhost,http://tauri.localhost,http://localhost:3000,https://weildbuild.vercel.app` — v1.3.2+: every `localhost`/`127.0.0.1` port is ALSO always allowed, so local tools (e.g. Admin CTRL on :5173) work no matter what |

### Account 3 — `weildbuild-gamehost-1` ("Server 1")

| Field | Value |
|---|---|
| Name | `weildbuild-gamehost-1` |
| Start Command | `npm run start:gamehost` |
| Health check path | `/health` |

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(same Neon string)* |
| `AUTH_SECRET` | *(same as main)* |
| `INTERNAL_TOKEN` | *(same as main)* |
| `ALLOWED_ORIGINS` | `tauri://localhost,http://tauri.localhost,http://localhost:3000,https://weildbuild.vercel.app` — v1.3.2+: every `localhost`/`127.0.0.1` port is ALSO always allowed, so local tools (e.g. Admin CTRL on :5173) work no matter what |
| `MAIN_SERVER_URL` | `https://weildbuild-main.onrender.com` *(your actual main URL)* |
| `HOST_ID` | `server-1` |
| `HOST_LABEL` | `Server 1` |
| `HOST_PRIORITY` | `1` |
| `MAX_INSTANCES_PER_HOST` | `6` |
| `MAX_PLAYERS_PER_INSTANCE` | `10` |
| `EMPTY_GRACE_MS` | `20000` |
| `HEARTBEAT_INTERVAL_MS` | `15000` |

### Account 4 — `weildbuild-gamehost-2` ("Server 2", overflow)

Identical to Account 3 **except**:

| Key | Value |
|---|---|
| Name | `weildbuild-gamehost-2` |
| `HOST_ID` | `server-2` |
| `HOST_LABEL` | `Server 2` |
| `HOST_PRIORITY` | `2` |

> **URLs differ?** Render assigns `<name>.onrender.com` from the service name — if you named services exactly as above, the URLs match. Otherwise adjust the monitor URLs in section 6 and both hosts' `MAIN_SERVER_URL` to the real URLs.

---

## 6. Keep everything awake — UptimeRobot (5 min)

Render's free tier puts a service to sleep after **15 minutes** with no inbound traffic, and waking up takes ~30–60 s — not great for players. Instead of running our own pinger service (which would eat a 5th Render account), we let a free online monitoring **bot** do the pinging on a schedule. It keeps every service awake **and** emails you the moment something actually goes down. Two good options — pick one:

### Option A — UptimeRobot (recommended)

1. Go to **https://uptimerobot.com** → **Sign Up** (free plan: 50 monitors at 5-minute intervals — plenty).
2. Click **Add New Monitor** → type **HTTP(s)**.
3. Create **one monitor per service** (four in total):

   | Friendly name | URL to monitor |
   |---|---|
   | WeildBuild Main | `https://weildbuild-main.onrender.com/health` |
   | WeildBuild Realtime | `https://weildbuild-realtime.onrender.com/health` |
   | WeildBuild Game Host 1 | `https://weildbuild-gamehost-1.onrender.com/health` |
   | WeildBuild Game Host 2 | `https://weildbuild-gamehost-2.onrender.com/health` |

4. Leave the interval at **5 minutes** (well under Render's 15-minute sleep timer) → **Create Monitor**.
5. Repeat for the other three services.

That's it — every service now gets an inbound request every 5 minutes, so nothing ever sleeps, and the dashboard doubles as your at-a-glance status page (plus email alerts if a service truly crashes).

### Option B — cron-job.org

Same idea: **https://cron-job.org** → free account → **Create Cronjob** → paste one of the `/health` URLs above → schedule **Every 5 minutes** → **Create**. One job per service.

> Adding **Game Host 3** later? The whole keep-alive config is just: add one more monitor for its `/health` URL.

---

## 7. First-run database setup — AUTOMATIC (0 min)

**You don't have to do anything.** As of **v1.3.1**, the Main Server sets up the database **by itself**, in the background, a few seconds after every start:

1. It runs `prisma db push` — this creates/updates all tables. It's safe to re-run: if the database is already up to date it does nothing and finishes in about a second.
2. If the database is **completely empty** (a brand-new Neon project), it also runs the seed — the default admin account (**WeildBuild**) + the 34 shop items. If even one user account already exists, the seed is skipped, so it can never reset a password you changed.

This replaced the old instructions that used the **Render Shell** — which Render has since made a **paid feature** ("Shell is not supported for free compute plans"). No Shell needed anymore.

You can watch it happen: Render dashboard → `weildbuild-main` → **Logs** → right after startup you'll see lines starting with `[db-setup]`, ending with `Database ready`.

<details>
<summary>Manual alternative (only if you like doing things by hand)</summary>

On your own computer, with `DATABASE_URL` set to the Neon connection string in a `.env` file inside this folder:

```bash
npm install
npm run setup   # = prisma db push + seed (same thing the server does automatically)
```

This is also the fix if you ever want to *force* a re-seed: the automatic seed only runs on a completely empty database.
</details>

**Verify it worked** — a minute or two after the first deploy, visit `https://<your-main-server>.onrender.com/api/items?type=face` in a browser. You should see 20 face JSONs.

---

## 8. Smoke tests (5 min)

Run these from any terminal (or browser for the GETs):

```bash
MAIN=https://weildbuild-main.onrender.com

# 1. All services healthy?
curl -s $MAIN/health
curl -s https://weildbuild-realtime.onrender.com/health
curl -s https://weildbuild-gamehost-1.onrender.com/health
curl -s https://weildbuild-gamehost-2.onrender.com/health

# 2. Version gate answers?
curl -s $MAIN/version

# 3. Login as the seeded admin (original password works!)
curl -s -X POST $MAIN/api/auth -H "Content-Type: application/json" \
  -d '{"action":"login","username":"WeildBuild","password":"WeildBuild2026!"}'

# 4. Game hosts registered? After ~30 s of both hosts running:
curl -s $MAIN/api/instances
#    And the UptimeRobot dashboard should show all four monitors "Up".
```

Then the real test: **log in from the desktop app** (the rewired v13.1 client) — login, shop, friends, publish a game, and join it. The first join should print in the gamehost logs: `[instance] …` and the main logs: `[instances] placed player on …`.

---

## 9. Operating the platform

| Task | How |
|---|---|
| **Release a new client version** | Set `CLIENT_LATEST_VERSION` (+ `CLIENT_MIN_VERSION` if it's a forced update) on the Main Service env vars. Old clients see the update screen on next launch. |
| **Deploy server code changes** | `git push` to `main` — every service auto-deploys (autoDeploy: true). |
| **Take a backup** | Settings → Back Up Now in the app (admin), or `POST /api/admin/backup` — lands in the `weildbuild-backups` B2 bucket. |
| **See who's playing** | `GET /api/instances` — live list of running mini servers + player counts. Or open **WB Admin CTRL** (player *names* per instance). |
| **Change client version / download links** | Open **WB Admin CTRL** → *Version gate* card → edit → Save. Applies instantly (clients check `/version` on boot). Values set here override the `CLIENT_*` env vars. |
| **Check uptime** | UptimeRobot dashboard — every monitor should be **Up**; you get an email alert the moment one goes down. |
| **Add Game Host 3** | Another friend account, same as Account 3 but `HOST_ID=server-3`, `HOST_PRIORITY=3` — plus one more UptimeRobot monitor for its `/health` URL (section 6). |

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails: `TS7016 Could not find a declaration file for module 'express'` | **Fixed in v1.2.0** — Render builds with `NODE_ENV=production`, and npm skips devDependencies in that mode. v1.2 puts `prisma`, `typescript`, `tsx` and all `@types/*` in `dependencies`, so this can't happen. If you ever see it again, someone moved them back to `devDependencies` — undo that. |
| `502` / cold start slowness on first request | Free-tier wake-up (~30–60 s). If it keeps happening, check the UptimeRobot monitor for this service is **Up** with a 5-minute interval (section 6). |
| Login fails with CORS error in app logs | The desktop origin is missing from `ALLOWED_ORIGINS`. Windows Tauri = `http://tauri.localhost`, macOS/Linux = `tauri://localhost`. Add both. |
| Game join says "No game servers available" | No game host has registered with main. Check the host's logs — `MAIN_SERVER_URL` correct? `INTERNAL_TOKEN` matches main's? Registration retries every 15 s. |
| Realtime connects then instantly drops | `AUTH_SECRET` on realtime differs from main → tickets don't verify. Make them identical. |
| `P1001 Can't reach database` | `DATABASE_URL` missing/wrong on that service, or Neon project paused (it auto-resumes — just retry). |
| Free hours exhausted (service suspended) | That account hosts more than one always-awake service. Move one to another account. |

---

## 11. Security notes

- **Rotate the old Supabase service key** that was in the shared `.env` (Backblaze console → App Keys → the old key) — it appeared in a zip you distributed.
- `AUTH_SECRET` and `INTERNAL_TOKEN` live **only** in Render env vars — never in the repo, never in the client.
- All write routes require a valid ticket; game-host internal routes require the internal token; the admin routes require `top_admin`.
- The client NEVER talks to Neon or B2 directly — only Main Server does. Keep it that way.
