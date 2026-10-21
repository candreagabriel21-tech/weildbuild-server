# WeildBuild Server v1.4.6 - Upgrade Notes

Deploy this over the current v1.4.5 exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host).

## TWO steps after deploying

**1. Migration** - no NEW columns this time (the `sent_requests` column
from v1.4.5 is unchanged), but running it is harmless and confirms the
schema is current:

```bash
npm install
npm run migrate     # prisma db push - no-op if already current
```

**2. Seed** - REQUIRED to apply the updated shop item descriptions
(Smile Face FACE-1's new text + the fixed Looking Up FACE-15 duplicate).
The seed is idempotent (safe to re-run, upserts only):

```bash
npm run seed
```

## What changed (v1.4.6)

1. **Honest /health versions**
   - All three services used to hardcode `"version": "1.4.4"` in their
     health endpoints - after the v1.4.5 deploy they STILL reported
     1.4.4, which looked exactly like a failed deploy. The version now
     comes from package.json (single source of truth). After deploying,
     `curl https://<each-service>.onrender.com/health` should say
     `"version":"1.4.6"` on Main, Realtime AND both Game Hosts - that's
     your deploy verification.

2. **Shop item description updates (seed data)**
   - FACE-1 "Smile Face": "Every WeildBuilder starts with this friendly
     face. It's a WeildBuild classic!"
   - FACE-15 "Looking Up": "Keep your eyes on the skies!" (was an
     accidental copy of Calm Face's description)
   - Applied by `npm run seed` (see above).

3. **Game thumbnail validation**
   - The studio now attaches a side-view photo (JPEG data URL) to games
     on save/publish. The server validates it (must be a small
     image data URL, capped at ~220KB) before storing it in
     extra_data - it can't be abused as an arbitrary blob store.

## Compatibility

- Client 1.0.0 (dev folder r2 zip) uses the thumbnail; older clients
  ignore it - no forced update needed.
- No database schema changes beyond what v1.4.5 already added.
- No changes to env vars, URLs, or the Render service layout.

## Note on the friend system ("can't add, block or unfriend")

The server was never broken - production testing showed every friend
endpoint working. The bug was a client-side **ghost login** (expired
session + cached profile = UI that LOOKS logged in while every write
fails). Fixed in the client (dev folder r2). If you ever see it again
on an old client: log out and back in, and the buttons work again.
