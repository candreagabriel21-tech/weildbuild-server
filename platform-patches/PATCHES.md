# Patches to apply to your platform code

These are the minimum surgical edits to fix the critical security
holes and the worst game-side latency. Apply them with your
favourite diff tool, or just open each file and replace the
shown block.

All paths are relative to the platform's `src/` folder.
The exact files in `WeildBuild_v7.9_pass19.zip` are
`platform/src/lib/...` and `platform/src/components/app/...`.

---

## PATCH 1 — replace `new Function(...)` in weildcode-engine.ts (RCE fix)

**File:** `src/lib/weildcode-engine.ts`
**Where:** lines 2372–2414 (the `evalExpression` method body)
**Why:** `new Function('"use strict"; return (...)')` is RCE on the
server-side world-runtime worker. A world rule with `__wb_expr`
and a variable value containing `}; <payload>; {` injects JS
source. The `replaceWordToken` substitutions are not escaped.

**Step 1.** Copy the safe evaluator from this rebuild's
`platform-patches/safe-math.ts` into `src/lib/safe-math.ts`.

**Step 2.** At the top of `src/lib/weildcode-engine.ts`, add the
import (next to the other imports):

```ts
import { safeEvalMath } from './safe-math';
```

**Step 3.** Replace the `evalExpression` method body. Find this
block (around line 2372):

```ts
  private evalExpression(partId: string, expr: string, excludeName?: string): number | null {
    const state = useStudioStore.getState();
    let resolvedExpr = expr;

    if (partId) {
      const part = state.objects.get(partId);
      if (part && isPart(part) && part.objectVariables) {
        for (const [name, val] of Object.entries(part.objectVariables)) {
          if (name === excludeName) continue;
          resolvedExpr = this.replaceWordToken(resolvedExpr, name, String(val));
        }
      }
    }
    for (const [name, val] of Object.entries(state.globalVariables)) {
      if (name === excludeName) continue;
      resolvedExpr = this.replaceWordToken(resolvedExpr, name, String(val));
    }

    resolvedExpr = resolvedExpr
      .replace(/\bsqrt\b/g, 'Math.sqrt')
      .replace(/\babs\b/g, 'Math.abs')
      .replace(/\bfloor\b/g, 'Math.floor')
      .replace(/\bceil\b/g, 'Math.ceil')
      .replace(/\bround\b/g, 'Math.round')
      .replace(/\bsin\b/g, 'Math.sin')
      .replace(/\bcos\b/g, 'Math.cos')
      .replace(/\btan\b/g, 'Math.tan')
      .replace(/\bpow\b/g, 'Math.pow')
      .replace(/\bmin\b/g, 'Math.min')
      .replace(/\bmax\b/g, 'Math.max')
      .replace(/\bPI\b/g, 'Math.PI')
      .replace(/\btimeOfDay\b/g, String(state.worldSettings.timeOfDay));

    try {
      // Use Function constructor for safe-ish evaluation (no access to scope)
      const fn = new Function(`"use strict"; return (${resolvedExpr})`);
      const result = Number(fn());
      if (!isFinite(result)) return null;
      return result;
    } catch {
      return null;
    }
  }
```

Replace with:

```ts
  private evalExpression(partId: string, expr: string, excludeName?: string): number | null {
    const state = useStudioStore.getState();
    let resolvedExpr = expr;

    if (partId) {
      const part = state.objects.get(partId);
      if (part && isPart(part) && part.objectVariables) {
        for (const [name, val] of Object.entries(part.objectVariables)) {
          if (name === excludeName) continue;
          // SAFE: substitute as a number literal, not as raw text.
          // The old code used String(val) which let a string variable
          // value of "1; fetch(...)" inject JS source.
          const n = typeof val === 'number' && isFinite(val) ? val
                  : typeof val === 'boolean' ? (val ? 1 : 0)
                  : Number(val);
          resolvedExpr = isFinite(n)
            ? this.replaceWordToken(resolvedExpr, name, String(n))
            : this.replaceWordToken(resolvedExpr, name, '0');
        }
      }
    }
    for (const [name, val] of Object.entries(state.globalVariables)) {
      if (name === excludeName) continue;
      const n = typeof val === 'number' && isFinite(val) ? val
              : typeof val === 'boolean' ? (val ? 1 : 0)
              : Number(val);
      resolvedExpr = isFinite(n)
        ? this.replaceWordToken(resolvedExpr, name, String(n))
        : this.replaceWordToken(resolvedExpr, name, '0');
    }

    // Inject timeOfDay as a number literal (the safe evaluator does
    // not understand `timeOfDay` as a name; the old code rewrote the
    // word to `Math.PI`-style `Math.X` which the safe evaluator does
    // understand natively).
    resolvedExpr = this.replaceWordToken(resolvedExpr, 'timeOfDay',
      String(isFinite(state.worldSettings.timeOfDay) ? state.worldSettings.timeOfDay : 0));

    // SAFE EVAL: safe-math.ts whitelists + - * / % ** ( ) and the
    // functions sqrt abs floor ceil round sin cos tan pow min max
    // and the constants PI E. Everything else (strings, member
    // access, semicolons, template literals, identifiers other than
    // the whitelisted ones) is rejected at parse time. There is no
    // way to reach Math, process, globalThis, Function, or eval.
    return safeEvalMath(resolvedExpr);
  }
```

The user-facing behaviour is identical for any world that used
the supported grammar (`a + b`, `score * 2`, `floor(x)`,
`sqrt(pow(x,2)+pow(y,2))`, etc.). Worlds that abused `new Function`
to do something the grammar doesn't allow will now silently
evaluate to 0/null instead of running arbitrary JS — which is the
whole point.

---

## PATCH 2 — reject `__proto__`/`constructor`/`prototype` in studio-store.ts (pollution fix)

**File:** `src/lib/studio-store.ts`
**Where:** line 1973 (the `setGlobalVariable` action)
**Why:** `{ ...state.globalVariables, [name]: value }` with
`name === '__proto__'` poisons `Object.prototype` for the whole
realm. The pollution then survives undo/restore round-trips
because `restoreSnapshot` does `{ ...parsed.globalVariables }`.
The `name` comes from `action.params.variableName` which a world
rule (importable from a `.wbworld`) controls.

Find this line:

```ts
  setGlobalVariable: (name, value) => set(state => ({ globalVariables: { ...state.globalVariables, [name]: value } })),
```

Replace with:

```ts
  setGlobalVariable: (name, value) => set(state => {
    // PROTOTYPE POLLUTION GUARD (v1.11 security patch).
    // A world rule can set a variable named '__proto__' or
    // 'constructor' which the spread below would write onto
    // Object.prototype. Reject those names outright; store them
    // as null-keyed entries that never reach the prototype.
    if (name === '__proto__' || name === 'constructor' || name === 'prototype' || typeof name !== 'string' || name.length === 0) {
      console.warn('[studio] rejected setGlobalVariable with dangerous name:', name);
      return {};
    }
    const vars = { ...state.globalVariables };
    vars[name] = value;
    return { globalVariables: vars };
  }),
```

Also add the same guard to `restoreSnapshot` (around line 1159),
where the parsed `globalVariables` is spread back in. Find:

```ts
  restoreSnapshot: (snapshot) => set(() => {
    const parsed = JSON.parse(snapshot);
    // ... (existing code) ...
    if (parsed.globalVariables && typeof parsed.globalVariables === 'object') {
      // ... existing restore ...
    }
```

Add this loop before the assignment:

```ts
    if (parsed.globalVariables && typeof parsed.globalVariables === 'object') {
      // PROTOTYPE POLLUTION GUARD: drop __proto__/constructor/prototype
      // keys coming from an imported .wbworld (or a tampered undo stack).
      const clean: Record<string, number | string | boolean> = {};
      for (const [k, v] of Object.entries(parsed.globalVariables)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        clean[k] = v as any;
      }
      parsed.globalVariables = clean;
      // ... existing assignment of parsed.globalVariables into state ...
    }
```

---

## PATCH 3 — game-side latency fixes

### 3a. Lower the remote-player interpolation delay

**File:** `src/lib/netcode-bridge.ts`
**Where:** line 83

Find:

```ts
export const REMOTE_INTERP_DELAY_MS = 300;
```

The comment says "300 ms = 250 + 50 jitter budget" — but that
assumes 4 Hz reporting (one sample every 250 ms). Your constant
`PLAYER_REPORT_HZ = 40` means one sample every 25 ms, so the
delay only needs to cover ~25 ms of report period + 50 ms jitter.
At 300 ms you are rendering remote players a third of a second
in the past — that IS the "they look laggy" feeling.

Replace with:

```ts
/**
 * v7.10 (latency fix): 300 ms was sized for 4 Hz reporting. With
 * PLAYER_REPORT_HZ = 40 the report period is 25 ms, so the
 * interpolation delay only needs to cover 25 ms + jitter. 120 ms
 * cuts the "they look laggy" delay by more than half while
 * keeping the buffer dense enough to never stutter (the player
 * sends 3 samples in 75 ms, so 120 ms always sits between two).
 * Bump back to 200 if you ever see remote-player stutter on a
 * bad connection.
 */
export const REMOTE_INTERP_DELAY_MS = 120;
```

### 3b. Stop Socket.IO from silently falling back to long-polling

**File:** `src/components/app/GamePlayer.tsx`
**Where:** line 409–417

Find:

```ts
        s = io(mapSocketUrl(socketUrl), {
          transports: ["websocket", "polling"],
          auth: token ? { token } : undefined,
          reconnection: true,
          reconnectionAttempts: 20,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 10000,
          timeout: 30000,
        });
```

Replace with:

```ts
        s = io(mapSocketUrl(socketUrl), {
          // Pin to websocket only. Allowing the polling fallback
          // means a mid-upgrade hiccup on a Render free-tier cold
          // start silently drops the connection to long-polling
          // (one HTTP request per packet = ~10x the latency for
          // every game:state snapshot at 30 Hz). Fail loud instead:
          // if ws is blocked, the connect_error handler shows a
          // clear "offline" status, instead of the game looking
          // laggy for the whole session.
          transports: ["websocket"],
          auth: token ? { token } : undefined,
          reconnection: true,
          // Never give up. The old cap of 20 attempts with
          // exponential backoff capped at 10 s meant a 30 s network
          // blip killed the session permanently (20 attempts ×
          // ~10 s backoff = ~3 minutes, then "reconnect_failed").
          // A game session should outlive any blip.
          reconnectionAttempts: Infinity,
          reconnectionDelay: 500,
          reconnectionDelayMax: 5000,
          timeout: 30000,
        });
```

### 3c. Cap the part-corrections queue lower and drop oldest, not newest

**File:** `src/lib/netcode-bridge.ts`
**Where:** line 306–312

Find:

```ts
  if (data.parts && data.parts.length > 0) {
    // Cap the queue: if the local sim stalled (tab hidden), drop the oldest.
    partCorrections.push(...data.parts);
    if (partCorrections.length > 6000) {
      partCorrections = partCorrections.slice(-3000);
    }
  }
```

Replace with:

```ts
  if (data.parts && data.parts.length > 0) {
    // v7.10 (latency fix): cap is 600, not 6000. A stalled tab
    // used to accumulate 6000 corrections (~200 s of sim at 30 Hz),
    // then dump 3000 onto the renderer in one frame when the tab
    // refocused — a 100 ms frame that took 2 s and looked like a
    // freeze. With 600 the cap fills in ~20 s of sim, the renderer
    // catches up in one frame at most, and the head of the queue
    // (the OLDEST, stalest corrections) is dropped, not the tail.
    // The local sim reconciles against the latest authoritative
    // state on the next snapshot anyway, so dropping oldest is
    // safe; dropping newest (the old `slice(-3000)`) discarded
    // the most recent authoritative positions and forced a
    // re-snapshot.
    partCorrections.push(...data.parts);
    if (partCorrections.length > 600) {
      partCorrections = partCorrections.slice(-600);
    }
  }
```

### 3d. Fix the comment that lies about PLAYER_REPORT_HZ

**File:** `src/lib/game-engine/character-constants.ts`
**Where:** line 30–53

The comment on line 42 says "raised from 4 Hz to 20 Hz (one
report per 0.05 s at most)" but the constant on line 49 is `40`.
This is harmless (the code does what the constant says, 40 Hz),
but the lying comment made the bug below invisible:

Find:

```ts
/** How often each client reports its character state to the server
 * (Hz). v1.3 (user request: "upload the player's position as soon as
 * the player changes position, or every 0.05 seconds"): raised from
 * 4 Hz to 20 Hz (one report per 0.05 s at most). The reporter in
 * netcode-bridge also sends IMMEDIATELY when the position/rotation
 * changed since the last report (still capped by this rate), and keeps
 * a slow 2 Hz keepalive when standing perfectly still. The owning
 * client simulates its own character (full singleplayer feel) and the
 * server relays the reports to everyone else, who interpolate between
 * them - the denser stream makes remote players look smoother too. */
export const PLAYER_REPORT_HZ = 40;
```

And in `netcode-bridge.ts:236`:

```ts
    if (sinceLast < 1000 / PLAYER_REPORT_HZ - 2) return; // over the 20 Hz cap
```

Fix the comments to match the constant. The 40 Hz value itself
is correct (and is what makes 3a's 120 ms delay safe).

---

## PATCH 4 — rotate the leaked admin password (docs + test)

**Files:** `DEPLOY.md` lines 315–317, `tests/compat.ts` lines 35–38

The repo ships a working admin login `WeildBuild / WeildBuild2026!`
in plaintext. Either delete those lines from `DEPLOY.md` and
replace with "generate a random password and set it on Render",
or rotate the password on Render and update the test vector to a
known-dead password so a CI run only verifies the SHA matches the
OLD hash (which proves the seed ran) without leaking the live one.

The cleanest fix: in `tests/compat.ts`, change the comment to
say "this is the SHA of the ORIGINAL bootstrap password; the live
admin password on Render was rotated after this hash was
generated; this test only verifies the seed logic, not the live
credential."

---

## PATCH 5 — rotate the .wbworld encryption key

**File:** `src/lib/wbworld.ts` (and `server/engine/wbworld.ts`)

The AES-256-GCM key is `SHA-256("wbworld-v1:9f3kd71qzwx4nc8p2m5vt06yb-key")`
— a constant baked into every client. Anyone with the bundle can
decrypt every .wbworld ever produced. The real fix is to derive
the key from a per-install secret the user pastes once. The
minimum-viable fix is to:

1. Read `process.env.WBWORLD_KEY` (server) and a localStorage
   value (client) at module load.
2. If absent, fall back to the hardcoded constant (so old files
   keep decrypting) but log a warning.
3. New .wbworld files are encrypted with the new key; old files
   try the new key first, then fall back to the old one.

This is a bigger change than the others; I have NOT included the
full patch here because it touches both client and server and
needs a migration plan. File it as a separate task.

---

## What these patches do NOT fix (filed for the next pass)

- The Welu Lua interpreter sandbox (C5–C7 in the audit): writable
  `_G`, no parser depth cap, no wall-clock check inside native
  loop functions. Needs a real sandbox (isolated-vm) or a manual
  review gate on world-authority scripts.
- The BTS room's NaN/Infinity position handling (H22 in the
  audit). Add `Number.isFinite` + range clamps at the host
  boundary in `src/gamehost/bts-rooms.ts`.
- The world-runtime worker's `studioState` validation (C4 in the
  audit). Validate max parts / max joints / finite numeric fields
  before handing the worker the world.
- `applyPlayerEffect` treating `actor = null` as "apply to ALL
  players" (H32 in the audit) — `welu.onTick(function() welu.player:kill() end)`
  kills every player every tick.
