# WeildBuild Server v1.9.1 - Upgrade Notes

Deploy this over the current v1.9.0 exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host). **No new env
vars, no manual seed, no manual migration** - the Main Server's boot-time
`prisma db push` adds the two new Vote tables automatically (both are
new, so existing rows are untouched). Just deploy all three services.

## What changed (v1.9.1)

1. **The Vote page** - a new `/api/votes` router:
   - `GET /api/votes` - the public idea list with Yes/No counts; a
     logged-in caller also gets their OWN current vote (so the thumb
     buttons can toggle). No voter names are ever returned.
   - `POST /api/votes` - create an update idea (admins only): title +
     message.
   - `POST /api/votes/vote` - cast, change or remove your vote
     (`value`: `1` = Yes, `-1` = No, `0` = remove). One vote per player
     per idea, enforced by a unique key; clicking the thumb you already
     picked removes the vote.
   - `DELETE /api/votes/:id` - delete an idea (the admin who posted it,
     or the top admin).

2. **ANONYMOUS by design**: the API only ever returns aggregate counts
   plus the caller's own vote. There is no endpoint that reveals who
   voted what - not even for admins.

3. **Two new tables** (added automatically on boot):
   - `vote_ideas` - the ideas themselves (title, message, author, date)
   - `vote_votes` - one row per (idea, player) with value 1 / -1

4. Nothing else changed: same session model, same origins policy, same
   item re-sync guarantees.

## Client that goes with it

`WeildBuild-dev-1.0.0-r11.zip` (game version stays 1.0.0). Built from
the same r10 source plus:

- A **Vote button in the sidebar (right under Settings)**: view update
  ideas from admins, vote Yes/No with thumbs, click again to take your
  vote back. Admins get a "Post an update idea" card on the same page.
- **In-game DM chat pop-up**: click a player in a game's Players panel
  and a tiny chat card opens - text them without leaving the game (same
  conversation as the Friends page; no pop-ups for the chat you are
  actively reading, even in-game).
- The **announcement letter got the WeildBuild look**: the square app
  logo replaces the wax-seal stamp, "WeildBuild Update" heading, a
  small "From: (user) on (date)" line (date only - no clock time, so
  players in different time zones are never confused), then the title
  in big text.
- **Signup agreement checkbox**: "I agree to the Terms, Rules and
  Privacy Policy." - the words are links (new tab on the web), and the
  Create Account button stays disabled until the box is ticked.
- **/rules text updates**: "Keep it clean" is now "No swearing", and
  the intro now says the rules apply "across the entire WeildBuild
  platform, including the website, the studio...".

## Deploy checklist

1. Deploy **all three services** from this zip (only Main changed, but
   deploying all three keeps the versions in `/health` in sync).
2. Open the site as any admin: the sidebar's new **Vote** page shows
   the "Post an update idea" card; post one, then log in as a regular
   player and vote on it.
3. Done. (`/health` on each service now reports `"version": "1.9.1"`.)

---

# v1.9.0 (if you are skipping from v1.8.1 or earlier)

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

## Client that went with it

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

## Deploy checklist (v1.9.0)

1. Deploy **all three services** from this zip (Main + Realtime are the
   ones that matter for these features).
2. Watch the Main logs for `Official shop items re-synced` (the two
   renamed shirts go live within ~30s of boot).
3. Open the site as the top admin: the Admin panel now has the
   Announcements card; `/admin <user>` in a game's chat promotes a
   player.
4. Done. (`/health` on each service reported `"version": "1.9.0"`.)

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
