# WeildBuild Server v1.11.0 - Upgrade Notes

Deploy this over the current version exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host). **No new env
vars, no manual seed, no manual migration** - the Main Server's boot-time
`prisma db push` adds the new tables and columns automatically (all with
defaults, so existing rows stay valid). Just deploy all three services.

> Upgrading from v1.9.0 or older? Everything below is new since then.

## What changed (v1.11.0)

1. **The Votes page (ideas + upvotes)** - new `/api/ideas` endpoints:

   | Method | Path | Who | What |
   |--------|------|-----|------|
   | GET | `/api/ideas` | public | list all ideas (logged-in callers also get their own `voted` flag per idea) |
   | POST | `/api/ideas` | players | post an idea (title 3-100, description 0-500; max 5 ideas per account) |
   | POST | `/api/ideas/vote` | players | toggle my upvote (rejected once the close date passed) |
   | PATCH | `/api/ideas` | admins | set status (`open`/`approved`/`considering`/`not_approved`/`already_planned`) and/or `closesAt` (ISO date or `null` to reopen) |
   | DELETE | `/api/ideas` | admins | remove an idea + its votes |

   Two new tables (`ideas`, `idea_votes`) are created by the boot-time
   schema sync. Rate limits: 6 idea posts / minute / user, 60 votes /
   minute / user.

2. **Starting currency is now 20 WeBuy** (was 100) - matches the Welcome
   Letter text. Existing balances are untouched.

3. **Automatic Welcome Letters** - every new registration gets a
   `welcome` notification (kind "Welcome Letter", from "WeildBuild
   Team") with the exact 20-WeBuy greeting text. The register response
   also carries a `welcome` object so the client can pop the pink letter
   instantly.

4. **Announcement kinds** - `POST /admin/announce` accepts a `kind`
   (max 40 chars): "WeildBuild Update" (default), "Announcement",
   "Admin Message", "Message", or anything custom. It is stored on the
   notification (new `kind` column), returned by `/notifications`, and
   pushed through Realtime's `/internal/announcement` so online players
   see it as the letter's eyebrow line immediately.

5. **Boot-time schema sync hardening** - `ensureDatabase()` now prefers
   the repo's own `node_modules/.bin/prisma` (and `tsx`) over `npx`:
   some environments' npx ignores the local install, downloads a random
   remote prisma, and the schema sync silently fails. Fallback to npx
   when the local binary is missing.

---

# Previous: WeildBuild Server v1.9.0 - Upgrade Notes

Deploy this over the current v1.8.1 exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host). **No new env
vars, no manual seed, no manual migration** - the Main Server's boot-time
`prisma db push` adds the two new columns automatically (they both have
defaults, so existing rows stay valid). Just deploy all three services.

## What changed (v1.9.0)

1. **Shop catalog re-names** (live the moment you redeploy, via the
   boot-time catalog re-sync):

   | Item | Was | Now | Description | Price |
   |------|-----|-----|-------------|-------|
   | SHIRT-5 | 24K Golden Torso | **Gold Torso** | Midas Touch oh no! | 5 WeBuy |
   | SHIRT-6 | Dark Blue | **Navy Blue** | Stay cool, stay classic. | 5 WeBuy |

2. **Admin role commands (TOP ADMIN ONLY)** - new actions on
   `POST /admin/moderate`:
   - `make_admin`: promote a regular player to admin (they get the Admin
     panel + a notification telling them)
   - `remove_admin`: demote an "admin" back to player (never works on a
     top_admin, never on yourself)
   - `unban` already existed - the new client exposes it as the
     `/removeban` chat command
   The client ships matching chat commands: `/admin <user>`,
   `/removeadmin <user>` (also `/remove admin <user>`), `/removeban <user>`
   (also `/remove ban <user>`).

3. **Announcements ("WeildBuild Updates")** - new `POST /admin/announce`
   (top admin only). Send a letter to one, several, or ALL players:
   - every recipient gets an `announcement` notification in their inbox
     (full message + optional title)
   - online players ALSO get the small toast + the clickable letter
     instantly (Main pushes to Realtime's new `/internal/announcement`)
   - recipients can mute the pop-up per-category (client Settings);
     the inbox copy always lands

4. **Two new database columns** (added automatically on boot):
   - `notifications.title` - the letter's subject line (empty on old rows)
   - `users.notify_toasts` - the client's "Toast Messages" master switch

5. Nothing else changed: same session model, same origins policy, same
   item re-sync guarantees (never touches accounts, balances, ownership
   or community items).

## Client that goes with it

`WeildBuild-dev-1.0.0-r10.zip` (game version stays 1.0.0). Built from
the same r9 source plus:

- Shop shows "Gold Torso" / "Navy Blue" (server-driven).
- Notification fixes: no more pop-ups for the chat you are actively
  reading, no more double pop-ups for friend events, and clicking a
  notification now actually takes you there (it even leaves a running
  game and opens the right conversation).
- Notification settings that work: Friend Requests, Toast Messages
  (replaces Purchases) and WeildBuild Updates (renamed from Game
  Updates) all gate the pop-ups now. DM pop-ups always show; the inbox
  always receives everything.
- Announcements card in the Admin panel (top admin only): write a
  message, pick recipients (one, several, all), send it as a letter.
- Description editing no longer fires a server request when nothing
  changed.
- Studio: Esc no longer exits the editor - it is reserved for canceling
  block placement (the hint now reads "Click to place (part). Esc to
  cancel").

## Deploy checklist

1. Deploy **all three services** from this zip (Main + Realtime are the
   ones that matter for these features).
2. Watch the Main logs for `Official shop items re-synced` (the two
   renamed shirts go live within ~30s of boot).
3. Open the site as the top admin: the Admin panel now has the
   Announcements card; `/admin <user>` in a game's chat promotes a
   player.
4. Done. (`/health` on each service now reports `"version": "1.9.0"`.)

---

# v1.8.1 (if you are skipping from v1.8.0 or earlier)

## What changed (v1.8.1): the shop catalog re-sync + the clothing rework

**Deploying this updates the item catalog in your LIVE database
automatically.** The Main Server now re-syncs the official catalog
(`data/items/*.json`) into the database a few seconds after every boot -
not just on an empty database. So the new prices/names/descriptions
below go live on Render the moment you redeploy, with no SQL, no shell,
no seed command.

- **Every shirt and every pants item now costs 5 WeBuy.** (Faces keep
  their existing prices.)
- Renamed + re-described items:

  | Item | Was | Now | New description |
  |------|-----|-----|------------------|
  | SHIRT-5 | Gold Rush | **24K Golden Torso** | Midas Touch oh no! |
  | SHIRT-6 | Midnight | **Dark Blue** | Blue in the sky |
  | SHIRT-7 | Blossom | **Strawberry Shirt** | Strawberry milkshake! |
  | PANTS-2 | Midnight | **Void** | Or they could be dark jeans |
  | PANTS-4 | Crimson | **Tomato Red** | June and July are sisters |
  | PANTS-5 | Cloud White | Cloud White | Soft as a cloud! (desc only) |
  | PANTS-6 | Nebula | **Purple** | You'll be either blend in or be in style with the platform |

- Two colors changed (visible in the game client r9+): **Flame (SHIRT-2)
  is now orange `#FF9B0F`**, and **Tomato Red (PANTS-4) is a true tomato
  red `#FF6347`** (it was crimson).
- What the re-sync will NEVER touch: user accounts, balances, owned
  items, sessions - and any item whose ID is not in `data/items`
  (community items, if you ever add them).
- Players who already own renamed items keep them - ownership is by ID
  (SHIRT-7 etc.), which did not change.

## Client that goes with it

`WeildBuild-dev-1.0.0-r9.zip` - same as r8 plus the two new item colors
(orange Flame, tomato-red Tomato Red) in the shop previews and avatar
rendering. r8 and older clients still work, they just show the old
colors for those two items until they update.

## Deploy checklist

1. Deploy **all three services** from `weildbuild-server-v1.8.1.zip`
   (they share the codebase; Main + Realtime are the ones that matter).
2. Open the site, go to the Shop: shirts/pants should show the new names
   and "Buy: 5 WeBuy" within ~30s of the deploy (the re-sync runs right
   after boot; the client may need a refresh).
3. Done. (`/health` on each service now reports `"version": "1.8.1"`.)

---

# v1.8.0 (if you are skipping from v1.4.7)

## What changed (v1.8.0)

**The web app is allowed in.** Any `https://*.vercel.app` origin (plus
`*.vercel.dev` previews) now passes CORS and the mutating-request origin
check on both Main and Realtime. This is what lets the Vercel-hosted
website/webapp (`VERCEL-DEPLOY.md` in the game zip) talk to the servers:
accounts, games, chat, multiplayer, everything.

- Same trust model as the always-allowed localhost origins: the session
  cookie is `SameSite=Lax` (browsers never send it cross-site), so a
  page on another origin cannot act as anyone - the web app
  authenticates with the `X-Session-Token` header, which only our own
  client ever holds.
- Custom domains (e.g. `play.weildbuild.com`) still go through the
  `ALLOWED_ORIGINS` env var as before.
- Nothing else changed - no schema, no seed, no new endpoints.

## Client that goes with it (v1.8.0 era)

`WeildBuild-dev-1.0.0-r7.zip` (also the Vercel web app source). Its
features since the r4 exe/apk build:

- Tiny in-app notification pop-ups + OS-level desktop notifications for
  new DMs / friend events (works on any server; the socket push is
  realtime, no server change needed).
- Session heartbeat: bans/sign-outs detected within ~20s WITHOUT a
  refresh. On v1.4.7+ servers bans also arrive instantly via the
  realtime push; on older servers the heartbeat is the fallback path.
- Admin chat commands (`/warn`, `/ban`, `/show char-hitbox`), the red
  admin Commands button, quick warn/ban buttons in the players list,
  0.5s jump cooldown, and the pill/capsule character hitbox (the
  edge-of-block fix) - all client side, work on any recent server.
- The icon fixes (client side only).

The client works fine against v1.4.7 servers too (minus the web-app
origins) - but the Vercel site needs THIS version.

## Deploy checklist (v1.8.0 era)

1. Deploy **all three services** from the v1.8.0 zip
   (they share the codebase; Main + Realtime are the ones that matter).
2. Confirm `https://<your-site>.vercel.app` loads and can log in.
3. Done. (`/health` on each service reports `"version": "1.8.0"`.)

---

# v1.4.7 (if you are skipping from v1.4.6)

## ONE new env var on the MAIN service (for the instant pop-ups)

`REALTIME_SERVER_URL` = the public URL of your Realtime service
(e.g. `https://weildbuild-realtime.onrender.com`).

The moment an admin warns or bans a player, Main pushes the event to
Realtime and the pop-up lands on the player's open app INSTANTLY (plus
banned sockets are force-disconnected). Without this env var, moderation
still fully works - players just see the pop-up on their next login
instead of the instant push.

The endpoint is protected by the same `INTERNAL_TOKEN` you already set
on Main (Realtime checks it). No database changes, no migration, no
seed needed - just deploy both services (Main AND Realtime must both
run v1.4.7+).

## What changed (v1.4.7)

1. **Instant moderation push (Main + Realtime)**
   - Main: after a warn/ban is saved, it POSTs to
     `REALTIME_SERVER_URL/internal/moderation` (fire-and-forget with the
     internal token; a Realtime hiccup never fails the moderation
     action itself).
   - Realtime: new authenticated endpoint that relays
     `moderation:warning` / `moderation:banned` to the player's open
     socket, and force-disconnects every socket of a banned player
     half a second later (after the event flushes).
   - The v1.4.7+ client turns these into the full-screen warning/ban
     pop-ups. Older clients simply ignore the new events.

2. **No schema changes, no seed changes** - `npm run migrate` is
   harmless as always but not required for this update.

## Compatibility

- Old client + new server: everything works; the new server just also
  accepts web-app origins and (with `REALTIME_SERVER_URL` set) pushes
  moderation events that old clients ignore.
- New client + old server: everything works except the Vercel web app
  (origins rejected); moderation arrives via the heartbeat fallback
  (within ~20s) instead of instantly.
