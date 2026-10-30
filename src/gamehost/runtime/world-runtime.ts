// ═══════════════════════════════════════════════════════════════════
// WeildBuild — world runtime (v6.4 — CSP / SERVER-AUTHORITATIVE PLAYERS)
// ═══════════════════════════════════════════════════════════════════
// Runs INSIDE A WORKER THREAD, one per game instance, on the gamehost.
//
// WHAT THE SERVER SIMULATES (the authority):
//   • PhysicsWorld (cannon-es): every unanchored part, terrain, trees,
//     joints, body movers - simulated for EVERYONE, once.
//   • The WeildCode rules engine: triggers, timers, actions - the single
//     authority. Its sound actions are relayed to the players' browsers
//     (see sounds.ts setSoundSink); its screen messages ride snapshots.
//   • CHARACTER MOVEMENT (v6.4 CSP RESTORED). The server owns a dynamic
//     cannon pill body per player and runs the SAME movement math the
//     client prediction runs (character-constants.ts). The client still
//     applies inputs LOCALLY the instant they are pressed (the
//     prediction layer), so input latency is 0 ms. When a snapshot
//     arrives, the client reconciles: if its predicted position differs
//     from the authority's by more than RECONCILE_SNAP_STUDS, it snaps
//     and continues predicting from there (rubberband). The user's
//     earlier server-auth attempt failed because there was no prediction
//     layer, so every input waited for the round trip. CSP fixes that.
//   • Player LIFE state: hp, the death animation timer, respawn
//     positions, rule teleports, void deaths.
//
// INPUT CHANNEL (the new player channel, replaces v6.2.6 pstate):
//   Each client sends `input` messages (x, z, jump, sprint, yaw, seq)
//   at up to PLAYER_REPORT_HZ (20 Hz, on change). The worker overwrites
//   that player's p.input every message and acks the latest seq by
//   including it in every snapshot for that player (`ackSeq`). The
//   client uses ackSeq to find the matching entry in its prediction
//   history and reconcile. v6.2.6's `pstate` (client-owned positions)
//   is still accepted as a no-op for backwards compat (older clients
//   keep working - they just see no movement authority).
//
// FORCED POSITIONS (the authority still moves players sometimes):
//   Spawn slots, respawns and teleport_player rules set a pending tp;
//   the next snapshot carries the new position flagged `tp: 1` so the
//   owner teleports its local body and everyone else snaps (never
//   glides) across the map.
//
// WHY A WORKER: the platform modules are module-level singletons (one
// zustand store, one engine instance). A worker per instance gives every
// game its own module registry - true isolation, parallel simulation,
// and a crash in one world can never take down the host process.
//
// PROTOCOL (parentPort messages):
//   →  { t: 'init', studioState, maxPlayers }
//     { t: 'playerJoin', socketId, username }
//     { t: 'playerLeave', socketId }
//     { t: 'input', socketId, x, z, jump, sprint, yaw, seq }  (v6.4)
//     { t: 'pstate', socketId, ... }   (v6.2.6 LEGACY - now a no-op)
//     { t: 'click', socketId, partId }
//     { t: 'chat', username, message }
//     { t: 'getWorldState', reqId }   (v6.2.7: full-state sync for joiners)
//     { t: 'stop' }
//   ←  { t: 'ready' }
//     { t: 'snapshot', seq, players, parts, partUpdates, fx, messages }
//         (each player entry now carries `ackSeq`: last input seq the
//          server has processed - the client uses it to reconcile)
//     { t: 'worldState', reqId, objects, joints, globalVariables }
//
// This file is NOT compiled by the server's tsc - scripts/build-world-
// runtime.mjs bundles it (and the engine/ sources it imports) with esbuild
// into dist/gamehost/world-runtime.bundle.js. The engine/ folder is a copy
// of platform/src/lib kept in sync by the build script when the monorepo
// sibling exists, so STANDALONE deploys (server folder alone) still build.

import { parentPort } from 'node:worker_threads';

// ─── Browser-API polyfills (BEFORE the platform imports) ───
// The WeildCode engine drives itself with requestAnimationFrame; in a
// worker we map that onto a ~30 Hz timer so its timers/waits/fades tick
// (v6.2.2: was 16ms/60Hz - the engine's per-frame objects.forEach scans
// were the worker's biggest CONSTANT cost, halving them is free latency).
// IDLE PAUSE: while the instance has NO players the callback is HELD
// instead of scheduled - the rules engine (timers, waits, fades) fully
// freezes. The sim tick resumes it the moment anyone joins.
let enginePaused = false;
let heldRafCb: ((t: number) => void) | null = null;
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => {
    if (enginePaused) { heldRafCb = cb; return 1; }
    return setTimeout(() => cb(Date.now()), 33) as unknown as number;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

interface RuntimePlayer {
  socketId: string;
  username: string;
  // ─── v6.4 CSP: the AUTHORITY drives the player's body ───
  /** The latest input state the client sent. The stepSim runs the SAME
   * movement math the client prediction runs (character-constants.ts)
   * against this every tick - the body's velocity and position are
   * the truth, p.x/p.y/p.z only mirror the body for snapshot building. */
  input: { x: number; z: number; jump: boolean; sprint: boolean; yaw: number };
  /** The seq of the last input message we processed. Echoed in every
   * snapshot for this player as `ackSeq` so the client can reconcile
   * its prediction history. */
  lastInputSeq: number;
  /** Mirror of the body's feet position (kept in sync each tick so the
   * snapshot builder, touch checks and void check read O(1) without
   * looking up the body every time). */
  x: number;
  y: number;
  z: number;
  /** Body yaw (radians) - derived from movement direction (legacy style). */
  yaw: number;
  /** Smoothed horizontal velocity (the prediction math's intermediate
   * state, identical to what the legacy v6.2.5 server stored per player). */
  velX: number;
  velZ: number;
  /** Jump cooldown timer (seconds; > 0 means cannot jump). */
  jumpCooldown: number;
  /** v6.2.4 latch: airborne BECAUSE OF A JUMP. The rising edge IS the
   * jump (fires the anim flag exactly once per hop, never twice as the
   * old vy>0 test did at the apex + landing impact). */
  airborneFromJump: boolean;
  /** Seconds since the jump impulse (the 0.15 s grace before the latch
   * can clear on the first grounded tick). */
  jumpAge: number;
  /** simClock when grounded last held (coyote-time jumps). */
  lastGroundedClock: number;
  /** Authority-owned life state. */
  hp: number;
  /** > 0 while the death animation plays; respawn fires when it expires. */
  dyingTimer: number;
  /** Forced position waiting to ride the next snapshot (spawn slot /
   * respawn / teleport rule). Consumed when broadcast. */
  pendingTp: { x: number; y: number; z: number } | null;
  /** simClock time until which below-voidY reports are treated as stale
   * leftovers of the death that just ended (see RESPAWN_VOID_GRACE_SECONDS). */
  respawnGraceUntil: number;
  /** Part ids currently touched (when_touched re-arm). */
  touched: Set<string>;
}

const SIM_HZ = 30;
// Parts + player entries stream in DELTA snapshots at 30 Hz. Player
// entries only actually change when a client report lands (v1.3: up to
// 20 Hz per player - reports fire on movement, capped at one per 0.05 s,
// with a slow 2 Hz keepalive while standing still), so the wire cost
// stays reasonable while parts keep the dense stream client-side
// interpolation runs on.
const SNAPSHOT_HZ = 30;
// v6.2.1: aligned with the client's DEATH_DURATION (StudioPlayViewport
// startDeath) - the local and remote death animations now end together with
// the server-side respawn, so the body reappears exactly at the spawn point
// instead of 0.45s of dead air.
const DEATH_ANIMATION_SECONDS = 1.35;
// ─── v6.4 CSP: input cadence + reconciliation constants ───
/** v6.2.6: the client's report rate (documentation only - the server
 * applies inputs as they arrive). Clients now send input on movement
 * (capped at 20 Hz = one per 0.05 s) with a 2 Hz keepalive while idle. */
const PLAYER_REPORT_HZ = 20;
/** v6.2.9 VOID DOUBLE-DEATH FIX: after the authority respawns a player,
 * the owner's in-flight reports can still carry the DEATH SPOT
 * (below voidY) for a network-beat - its local death animation ends
 * slightly after ours, and the dyingTimer guard has already flipped to
 * 0. Those stale reports used to re-arm the void check and kill the
 * player a SECOND time at the spawn point (double explosion + double
 * death wait, user report). During this grace window after a respawn,
 * reports that would drag the record back into the void are dropped
 * (a genuinely post-teleport report is above voidY by definition). */
const RESPAWN_VOID_GRACE_SECONDS = 0.75;
/** v6.2.5: Coyote time - a jump still counts this long after leaving
 * the ground. Matches the client's prediction (coyoteTimer 0.1s) so the
 * authority never denies a jump the client already predicted (that was
 * the jump rubber-band: client jumps, server disagrees, next snapshot
 * yanks back). */
const JUMP_COYOTE_SECONDS = 0.1;

// ─── v6.2.2: idle + interest management ───
/** Parts farther than this from EVERY player are not streamed in
 * snapshots (clients stop rendering parts at 320 studs anyway, so this
 * can never hide something a player can see) and are put to sleep early
 * when they are slow. Env-tunable: WORLD_INTEREST_RADIUS. */
const INTEREST_RADIUS = Math.max(80, Number(process.env.WORLD_INTEREST_RADIUS) || 340);
const INTEREST_RADIUS_SQ = INTEREST_RADIUS * INTEREST_RADIUS;
/** Every player is re-broadcast at least this often (a keyframe) even
 * when nothing about them changed, so late joiners and drifted clients
 * self-heal. With delta snapshots this trims idle traffic by ~97%. */
const PLAYER_KEYFRAME_SECONDS = 2;
/** How often moving parts are written back into the store for the rules
 * engine. The CLIENT does this at 4 Hz; the worker used to do it at
 * 30 Hz, cloning the whole objects Map (and every touched part) 30x/s -
 * a major GC hiccup source on big maps. 7 Hz keeps rule reads near
 * current for a fraction of the pressure. */
const STORE_SYNC_HZ = 7;
/** Max part transforms per join keyframe snapshot (huge worlds spread the
 * catch-up over a few snapshots instead of one giant frame). */
const PARTS_KEYFRAME_BUDGET = 300;

function post(msg: unknown): void {
  parentPort?.postMessage(msg);
}

function fatal(message: string): void {
  post({ t: 'error', message });
  process.exit(1);
}

async function main(): Promise<void> {
  if (!parentPort) {
    console.error('[world-runtime] must be started as a worker');
    process.exit(1);
  }

  // ─── Receive init, then load the platform engine ───
  const init: any = await new Promise((resolve) => {
    parentPort!.once('message', (m: any) => {
      if (m?.t === 'init') resolve(m);
      else fatal(`expected init, got ${m?.t}`);
    });
  });

  // Dynamic import: the polyfills above must be in place first, and this
  // keeps the (heavy) platform module graph out of workers that never init.
  const { useStudioStore, isPart } = await import('../../../engine/studio-store');
  const { restoreStudioState } = await import('../../../engine/studio-project');
  const { weildCodeEngine } = await import('../../../engine/weildcode-engine');
  const { PhysicsWorld } = await import('../../../engine/game-engine/physics');
  // v6.4 CSP: the SAME character movement math the client prediction runs.
  // The server-authoritative sim and the client prediction step identical
  // math, so divergence stays tiny and reconciliation is a gentle lerp
  // (or invisible) instead of a snap.
  const {
    stepHorizontalVelocity, applyJump,
    ACCEL_WALK, ACCEL_STOP, AIR_RELEASE_DECAY, AIR_MOVE_FACTOR,
  } = await import('../../../engine/game-engine/character-constants');

  type StudioPart = import('../../../engine/studio-store').StudioPart;

  // ─── Load the world ───
  const studioState = init.studioState;
  if (!studioState || !Array.isArray(studioState.objects)) {
    fatal('init.studioState missing');
    return;
  }
  // Defensive normalization: restoreStudioState deep-clones fields
  // verbatim, and a payload missing optional arrays would leave `undefined`
  // in the store (breaking .length reads). Real exports always carry them;
  // hand-built or older payloads might not.
  studioState.joints ??= [];
  studioState.treeInstances ??= [];
  studioState.waterBodies ??= [];
  studioState.terrainLayers ??= [];
  studioState.globalTimers ??= [];
  studioState.globalVariables ??= {};
  studioState.avatar ??= {};
  restoreStudioState(studioState);
  // v1.3 (CharacterRoot removed): spawn precedence is the explicit
  // studioState.spawnPoint (the .wbworld export's spawn_point) > the first
  // Spawn part (feet on its top surface) > {0,5,0}. Published games don't
  // set spawnPoint, so the Spawn part is the normal path.
  let spawnPoint = studioState.spawnPoint ?? null;
  if (!spawnPoint) {
    for (const obj of studioState.objects) {
      const p = obj as any;
      if (p && p.isSpawnPoint && p.position) {
        const top = p.size ? p.size.y / 2 : 0;
        spawnPoint = { x: p.position.x, y: p.position.y + top, z: p.position.z };
        break;
      }
    }
  }
  if (!spawnPoint) spawnPoint = { x: 0, y: 5, z: 0 };

  // Server-authoritative mode ON + play mode ON (the engine only runs
  // while isPlaying).
  useStudioStore.setState({ netcode: { mode: 'server' } as any });
  useStudioStore.setState({
    playState: {
      ...useStudioStore.getState().playState,
      isPlaying: true,
      isTestPlay: false,
      characterHealth: useStudioStore.getState().playState.characterMaxHealth || 100,
    },
  });

  // ─── Build the physics world (parts, terrain, trees - NOT players) ───
  // v6.2.6: no character pills exist on the server anymore. The owning
  // clients simulate their characters; parts therefore do not collide
  // with server-side player hitboxes (the classic network-ownership
  // tradeoff the user accepted).
  const physicsSettings = useStudioStore.getState().physicsSettings;
  const world = new PhysicsWorld(physicsSettings);

  const queue: StudioPart[] = [];
  useStudioStore.getState().objects.forEach((obj) => {
    if (isPart(obj) && !(obj as StudioPart).isCharacterPart && (obj as StudioPart).showInWorld !== false) {
      queue.push(obj as StudioPart);
    }
  });
  let lowestBottom = 0;
  for (const p of queue) {
    const bottom = p.position.y - p.size.y / 2;
    if (bottom < lowestBottom) lowestBottom = bottom;
  }
  world.voidY = Math.min(-50, lowestBottom - 30);
  for (const part of queue) world.addBody(part);

  const currentState = useStudioStore.getState();
  if (currentState.terrainHeightmap) world.addTerrain(currentState.terrainHeightmap);
  if (currentState.treeInstances.length > 0) world.addTrees(currentState.treeInstances);
  world.joints = [...currentState.joints];

  const activeIds = new Set<string>();
  useStudioStore.getState().objects.forEach((obj) => {
    if (isPart(obj) && !obj.anchored && (obj as StudioPart).showInWorld !== false) activeIds.add(obj.id);
  });

  // ─── Players ───
  // v1.3 (user request): the CharacterRoot part was DELETED. The spawn
  // point comes from the studioState's spawnPoint (the wbworld export's
  // spawn_point, computed by findStudioSpawn: Spawn part > world setting)
  // and every player uses the standard pill dims (same defaults as the
  // client's createCharacterPillBody).
  const players = new Map<string, RuntimePlayer>();
  const spawnFeet = { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z };
  // Pill dims for touch checks / void checks (same clamps the client's
  // createCharacterPillBody applies - see physics.ts).
  const playerHeight = 2;
  const playerHalfW = 0.4;

  // Spawn spacing: joining players land on a widening ring around the
  // spawn point (like classic lobby games) so overlapping characters
  // never spawn inside each other on join. The slot reaches the client
  // as its first `tp` (the local body teleports there behind the load
  // curtain, before the player can even see the world).
  let joinCounter = 0;
  function spawnSlot(i: number): { x: number; y: number; z: number } {
    if (i === 0) return { ...spawnFeet };
    const ring = Math.ceil(Math.sqrt(i));           // 1, 2, 3, ...
    const idx = i - (ring * ring - 2 * ring + 1);   // position within the ring
    const count = 2 * ring;                          // cells on this ring
    const angle = (idx / count) * Math.PI * 2 + (ring % 2 ? Math.PI / count : 0);
    const radius = ring * 1.6;
    return {
      x: spawnFeet.x + Math.cos(angle) * radius,
      y: spawnFeet.y,
      z: spawnFeet.z + Math.sin(angle) * radius,
    };
  }

  function addPlayer(socketId: string, username: string): void {
    const slot = spawnSlot(joinCounter++);
    // v6.4 CSP: the server owns a DYNAMIC cannon body per player. The
    // owning client still drives its character (its inputs drive this
    // body via p.input each tick), but now parts can also push the
    // player back (a dynamic body is bidirectional, a kinematic one
    // is not). The legacy v6.3.0 kinematic hack (used so the client's
    // 0.25 s reports could push parts) is gone - the server simulates
    // the player itself now.
    try {
      world.addNamedCharacterBody(socketId, slot, {
        size: { x: playerHalfW * 2, y: playerHeight, z: playerHalfW * 2 },
      });
    } catch { /* never kill the sim over a body add */ }
    players.set(socketId, {
      socketId,
      username,
      input: { x: 0, z: 0, jump: false, sprint: false, yaw: 0 },
      lastInputSeq: 0,
      x: slot.x,
      y: slot.y,
      z: slot.z,
      yaw: 0,
      velX: 0,
      velZ: 0,
      jumpCooldown: 0,
      airborneFromJump: false,
      jumpAge: 0,
      lastGroundedClock: 0,
      hp: useStudioStore.getState().playState.characterMaxHealth || 100,
      dyingTimer: 0,
      pendingTp: slot, // the joiner's local body teleports to its slot
      respawnGraceUntil: 0,
      touched: new Set(),
    });
  }

  function removePlayer(socketId: string): void {
    players.delete(socketId);
    lastPlayerBroadcast.delete(socketId); // v6.2.2: drop its delta state
    // v6.4: drop the player's physics body (its contacts would
    // otherwise keep resolving against a phantom player who left).
    try { world.removeNamedCharacterBody(socketId); } catch { /* already gone */ }
  }

  /** v6.2.5: fire a jump press the moment it is known - called from the
   * input message handler (instant) AND from stepSim (the safety net).
   * Honors the 0.5 s cooldown and coyote time (a jump still counts this
   * long after leaving the ground, matching the client feel); sets the
   * v6.2.4 airborneFromJump latch whose rising edge IS the jump and whose
   * falling edge IS the landing (exactly one of each per hop, everywhere).
   * A jump that cannot fire is consumed and dropped - identical to the old
   * tick-only semantics. */
  function tryJump(p: RuntimePlayer): void {
    if (p.dyingTimer > 0) return;
    if (!p.input.jump) return;
    p.input.jump = false; // consumed either way (never buffered mid-air)
    const body = world.getNamedCharacterBody(p.socketId);
    if (!body) return;
    const grounded = world.namedCharacterGroundCheck(p.socketId);
    const coyote = grounded || simClock - p.lastGroundedClock <= JUMP_COYOTE_SECONDS;
    if (!(coyote && p.jumpCooldown <= 0)) return;
    const j = applyJump(body.velocity.x, body.velocity.y, body.velocity.z, p.jumpCooldown);
    if (!j) return;
    body.velocity.set(j.x, j.y, j.z);
    body.wakeUp();
    p.jumpCooldown = 0.5;
    p.lastGroundedClock = -1e9; // the jump consumed the coyote grace
    p.airborneFromJump = true;
    p.jumpAge = 0;
  }

  /** Refresh playState.characterPosition for the ACTING player right
   * before the engine runs its triggers (rules that read "the player's
   * position" - teleport_player with relative axes etc.). */
  function setEngineActorPos(username: string | undefined): void {
    if (!username) return;
    for (const p of players.values()) {
      if (p.username === username) {
        useStudioStore.getState().setPlayState({
          characterPosition: { x: p.x, y: p.y, z: p.z },
        });
        return;
      }
    }
  }

  function respawn(p: RuntimePlayer): void {
    p.hp = useStudioStore.getState().playState.characterMaxHealth || 100;
    p.dyingTimer = 0;
    p.pendingTp = { ...spawnFeet }; // the owner teleports; others snap
    // v6.2.8 DOUBLE-DEATH FIX: move the SERVER's record of the player to
    // the spawn point too (pendingTp alone only fixes the BROADCAST). The
    // old code left p.x/p.y/p.z at the death spot - for a VOID death that
    // is still below voidY, so the void check in the very same stepSim
    // frame re-killed the just-respawned player: they exploded a SECOND
    // time at the spawn point and waited through another full death
    // animation ("you die again when you respawn" + the delayed respawn).
    p.x = spawnFeet.x;
    p.y = spawnFeet.y;
    p.z = spawnFeet.z;
    p.velX = 0;
    p.velZ = 0;
    p.input = { x: 0, z: 0, jump: false, sprint: false, yaw: 0 };
    p.airborneFromJump = false;
    p.jumpAge = 0;
    p.jumpCooldown = 0;
    // v6.2.9: the record fix above is not enough on its own - the owner's
    // in-flight reports still carry the death spot for a network-beat
    // after this (see RESPAWN_VOID_GRACE_SECONDS). Arm the grace window.
    p.respawnGraceUntil = simClock + RESPAWN_VOID_GRACE_SECONDS;
    // v6.4: snap the dynamic body to the spawn point with zeroed velocity.
    // A respawn is a teleport - the body's contact resolver must not
    // interpret the death-spot -> spawn delta as a huge velocity and
    // slingshot every part around the spawn across the map.
    try { world.teleportNamedCharacterBody(p.socketId, spawnFeet); } catch { /* body gone */ }
  }

  // ─── v6.2.1: per-player rule effects ───
  // The engine (in server mode) queues kill/heal/damage/set/teleport
  // effects with the ACTING player's username instead of writing the single
  // shared playState (which used to make "one player steps on lava" kill
  // EVERYONE). Effects without an actor (timer/global rules) keep the
  // classic applies-to-everyone semantics.
  function killPlayer(p: RuntimePlayer): void {
    if (p.dyingTimer <= 0 && p.hp > 0) {
      p.hp = 0;
      p.dyingTimer = DEATH_ANIMATION_SECONDS; // respawn fires when it expires
      // The dead touch nothing: clearing the set re-arms when_touched for
      // the respawned body (standing on the same lava kills you AGAIN).
      p.touched.clear();
    }
  }

  function healPlayer(p: RuntimePlayer): void {
    p.hp = useStudioStore.getState().playState.characterMaxHealth || 100;
    p.dyingTimer = 0; // a heal cancels an in-progress death
  }

  function applyPlayerEffects(): void {
    const effects = weildCodeEngine.drainPlayerEffects();
    for (const e of effects) {
      const targets = e.username ? players : null;
      if (targets) {
        // Named actor: only that player.
        for (const p of targets.values()) {
          if (p.username !== e.username) continue;
          applyEffectToPlayer(p, e);
        }
      } else {
        // Global rule (timer etc.): everyone - the classic semantics.
        for (const p of players.values()) applyEffectToPlayer(p, e);
      }
    }
  }

  function applyEffectToPlayer(p: RuntimePlayer, e: import('../../../engine/weildcode-engine').PlayerEffect): void {
    const maxHp = useStudioStore.getState().playState.characterMaxHealth || 100;
    switch (e.kind) {
      case 'kill':
        killPlayer(p);
        break;
      case 'heal':
        healPlayer(p);
        break;
      case 'damage':
        p.hp = Math.max(0, Math.min(maxHp, p.hp + (e.value ?? 0)));
        if (p.hp <= 0) killPlayer(p);
        break;
      case 'set_health':
        p.hp = Math.max(0, Math.min(maxHp, e.value ?? 0));
        if (p.hp <= 0) killPlayer(p);
        break;
      case 'teleport':
        if (e.position) {
          // v6.2.6: forced position - the owner's local body teleports
          // when the tp flag reaches it; others snap via the >20-stud
          // interpolation rule.
          p.x = e.position.x;
          p.y = e.position.y;
          p.z = e.position.z;
          p.pendingTp = { x: e.position.x, y: e.position.y, z: e.position.z };
          p.velX = 0;
          p.velZ = 0;
          p.input = { x: 0, z: 0, jump: false, sprint: false, yaw: 0 };
          // v6.4: snap the dynamic body too (a teleport is not a velocity
          // impulse - the body would otherwise be dragged from its old
          // position through every part between it and the new spot).
          try { world.teleportNamedCharacterBody(p.socketId, e.position); } catch { /* body gone */ }
        }
        break;
    }
  }

  // ─── Rules engine: sound relay + screen message relay ───
  const fxOut: Array<{ name: string; volume: number }> = [];
  const soundRelay = (name: string, volume: number) => {
    if (fxOut.length < 64) fxOut.push({ name, volume: Math.max(0, Math.min(1, volume)) });
  };
  try { (await import('../../../engine/sounds')).setSoundSink(soundRelay); } catch { /* sounds module optional */ }

  const messagesOut: any[] = [];
  useStudioStore.subscribe((state: any, prev: any) => {
    // Screen messages created by rule actions ride the next snapshot.
    if (state.screenMessages.length > prev.screenMessages.length) {
      for (const m of state.screenMessages.slice(prev.screenMessages.length)) {
        if (messagesOut.length < 32) {
          messagesOut.push({
            message: m.message,
            position: m.position,
            textColor: m.textColor,
            fontStyle: m.fontStyle,
            fontSize: m.fontSize,
            backgroundColor: m.backgroundColor,
            duration: m.duration,
          });
        }
      }
    }
    // v6.2.1: health + teleport rules no longer flow through the shared
    // playState here. In server mode the engine queues per-player effects
    // (see applyPlayerEffects) that target the ACTING player only - the old
    // "copy characterHealth/teleportPosition onto every player" mirror was
    // the root cause of "one player dies, everyone dies (and nobody
    // respawns)".
  });

  // ─── Part change tracking for snapshots ───
  // Transforms: compare each active body against its last broadcast.
  const lastBroadcast = new Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number }>();
  // Rule-driven full updates: zustand replaces objects on write, so a
  // reference change on a part our transform sync did NOT touch means a
  // rule edited it - broadcast the whole part so client stores converge.
  // v6.2.7: the diff ALSO detects DELETED parts (ids that vanished from
  // the store) and NEW parts (ids that appeared) - deletions were never
  // broadcast before, so a rule deleting a part left a ghost on every
  // connected client, and rule-created parts never reached clients whose
  // updateObject no-ops on unknown ids (clients now addObject for those).
  let lastObjectsRef: Map<string, any> | null = null;
  const partUpdatesOut: any[] = [];
  const ourSyncIds = new Set<string>();

  // ─── v6.2.2: delta snapshot + interest state ───
  // Players are only broadcast when they CHANGE (plus a periodic keyframe
  // of everyone). Parts only when they change AND are near a player.
  const lastPlayerBroadcast = new Map<string, {
    x: number; y: number; z: number; yaw: number; hp: number;
    walking: boolean; jumping: boolean; dying: boolean; sprint: boolean;
    ackSeq: number;
  }>();
  let simClock = 0;                 // simulated seconds (frozen while idle)
  let nextPlayerKeyframeAt = 0;     // sim-time of the next all-players keyframe
  let partsKeyframeDirty = true;    // re-broadcast every part once (boot + joins)
  let partsKeyframeQueue: string[] | null = null;
  // showInWorld === false parts (touch checks must skip them)
  const hiddenPartIds = new Set<string>();
  // throttled passes
  let storeSyncAccum = 0;           // 7 Hz store write-back
  let slowPassAccum = 0;            // 0.5 s body add/remove/anchored sync
  let sleepPassAccum = 0;           // 0.33 s far-body sleep/wake pass

  // ─── Input / click / chat / reports from the host ───
  parentPort!.on('message', (m: any) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'playerJoin' && typeof m.socketId === 'string') {
      if (!players.has(m.socketId)) {
        const username = String(m.username || 'Player');
        addPlayer(m.socketId, username);
        // v6.2.2: a late joiner missed every part transform that was
        // ever broadcast before it arrived (its world load carries the
        // SAVED positions, not where physics actually settled things).
        // Queue a full part keyframe so its first seconds in the world
        // are not full of floating bricks that snap into place later.
        partsKeyframeDirty = true;
        // v1.5: game rules - on_player_join (optional username filter).
        try { weildCodeEngine.handlePlayerJoined(username); } catch { /* never kill the sim */ }
      }
    } else if (m.t === 'playerLeave' && typeof m.socketId === 'string') {
      const leaving = players.get(m.socketId);
      removePlayer(m.socketId);
      // v1.5: game rules - on_player_leave.
      if (leaving) {
        try { weildCodeEngine.handlePlayerLeft(leaving.username); } catch { /* never kill the sim */ }
      }
    } else if (m.t === 'pstate' && typeof m.socketId === 'string') {
      // ─── v6.2.6 LEGACY / v6.4 NO-OP ───
      // The old client-owned-position channel is no longer used. The
      // server-authoritative simulation drives the player's body from
      // `input` messages now; this message is still accepted so older
      // clients do not error (their characters simply do not move on
      // the authority - they should update to the new client that
      // sends inputs).
    } else if (m.t === 'input' && typeof m.socketId === 'string') {
      // ─── v6.4 CSP: the player channel (input + ack seq) ───
      // The owning client sends its current input state with a
      // monotonically increasing seq. We overwrite p.input (so the
      // next tick runs the latest) and remember the seq (so the next
      // snapshot acks it - the client uses ackSeq to reconcile its
      // prediction history). A jump press fires THE INSTANT it arrives
      // (tryJump) instead of waiting for the next tick - up to 33 ms
      // of latency saved on every hop, matching the legacy v6.2.5 path.
      const p = players.get(m.socketId);
      if (!p) return;
      if (p.dyingTimer > 0) return; // dead players ignore inputs
      // Sanitize: numbers only, direction clamped to unit length.
      let x = Number(m.x) || 0;
      let z = Number(m.z) || 0;
      const len = Math.hypot(x, z);
      if (len > 1) { x /= len; z /= len; }
      if (!Number.isFinite(x) || !Number.isFinite(z)) { x = 0; z = 0; }
      p.input = {
        x, z,
        jump: !!m.jump,
        sprint: !!m.sprint,
        yaw: Number.isFinite(Number(m.yaw)) ? Number(m.yaw) : 0,
      };
      // Advance the ack seq (only forward - a stale/duplicate must not
      // rewind it, or the client would re-reconcile against an old state).
      const seq = Number(m.seq);
      if (Number.isFinite(seq) && seq > p.lastInputSeq) p.lastInputSeq = seq;
      // Instant jump: matches the legacy v6.2.5 path (the safety net in
      // stepSim still runs every tick).
      if (m.jump) tryJump(p);
    } else if (m.t === 'click' && typeof m.partId === 'string') {
      // v6.2.1: the clicker's username rides along so player-targeting
      // rules (kill/heal/damage/teleport) hit THEM, not the whole room.
      const username = typeof m.username === 'string' ? m.username : undefined;
      setEngineActorPos(username);
      try { weildCodeEngine.handleClick(m.partId, username); } catch { /* rules must never kill the sim */ }
    } else if (m.t === 'chat' && typeof m.message === 'string') {
      // v1.5: game rules - on_chat_message (optional username/contains filters).
      const username = String(m.username || 'Player');
      setEngineActorPos(username);
      try { weildCodeEngine.handleChatMessage(username, String(m.message)); } catch { /* never kill the sim */ }
    } else if (m.t === 'getWorldState') {
      // ─── v6.2.7: full-state sync for a late joiner ───
      // The gamehost only asks when the instance was already lived-in
      // (a fresh instance has nothing to sync - the published studio
      // state IS the truth). Sends every non-character part record with
      // the LIVE physics transforms, plus joints and global variables.
      const objects: any[] = [];
      useStudioStore.getState().objects.forEach((obj: any) => {
        if (!isPart(obj) || obj.isCharacterPart) return;
        const rec: any = { ...obj };
        const pb = world.bodies.get(obj.id);
        if (pb) {
          rec.position = { x: pb.position.x, y: pb.position.y, z: pb.position.z };
          rec.rotation = { x: pb.rotation.x, y: pb.rotation.y, z: pb.rotation.z };
        }
        objects.push(rec);
      });
      post({
        t: 'worldState',
        reqId: m.reqId,
        objects,
        joints: useStudioStore.getState().joints,
        globalVariables: useStudioStore.getState().globalVariables,
      });
    } else if (m.t === 'stop') {
      shutdown();
    }
  });

  // ─── The simulation loop ───
  let running = true;
  // v6.2.2: starts IDLE (no players) - the tick pauses everything until
  // the first playerJoin message arrives.
  let idle = true;
  let seq = 0;
  let simAccum = 0;
  let snapAccum = 0;
  let lastTime = Date.now();
  const SIM_DT = 1 / SIM_HZ;

  function playerTouchChecks(): void {
    // when_touched('player'): fire on the parts each player overlaps,
    // once per contact (enter fires, leave re-arms) - the same semantics
    // as the client's collisionParts loop.
    // v6.4: positions come from the SERVER-AUTHORITATIVE body (kept in
    // sync with p.x/p.y/p.z each tick by stepSim section 1).
    // v6.2.2 PERF: the candidate list is built ONCE per tick straight
    // from the physics bodies (current to THIS step, not the 7 Hz store
    // write-back) instead of re-walking the whole store PER PLAYER.
    const candidates: Array<{ id: string; x: number; y: number; z: number; hx: number; hy: number; hz: number }> = [];
    world.bodies.forEach((pb) => {
      if (!pb.canCollide) return;
      if (hiddenPartIds.has(pb.id)) return;
      candidates.push({
        id: pb.id,
        x: pb.position.x, y: pb.position.y, z: pb.position.z,
        hx: pb.size.x / 2, hy: pb.size.y / 2, hz: pb.size.z / 2,
      });
    });
    if (candidates.length === 0) return;
    for (const p of players.values()) {
      if (p.dyingTimer > 0) continue; // the dead touch nothing
      const cy = p.y + playerHeight / 2; // pill center from feet
      const stillTouched = new Set<string>();
      const newlyTouched: string[] = [];
      for (const c of candidates) {
        if (Math.abs(c.x - p.x) > c.hx + playerHalfW + 0.1) continue;
        if (Math.abs(c.z - p.z) > c.hz + playerHalfW + 0.1) continue;
        if (Math.abs(c.y - cy) > c.hy + playerHeight / 2) continue;
        stillTouched.add(c.id);
        if (!p.touched.has(c.id)) newlyTouched.push(c.id);
      }
      for (const id of newlyTouched) {
        // v6.2.1: the TOUCHING player is the acting player - a lava brick
        // kills the player who stepped on it, not everyone in the room.
        // (setEngineActorPos first: rules that read "the player's position"
        // must see THIS player's reported spot, not a stale value.)
        setEngineActorPos(p.username);
        try { weildCodeEngine.handleTouch(id, 'player', p.username); } catch { /* never kill the sim */ }
      }
      p.touched = stillTouched;
    }
  }

  function stepSim(dt: number): void {
    simClock += dt; // simulated seconds (drives keyframe deadlines)

    // 0. v6.2.1: apply queued per-player rule effects (kill/heal/damage/
    //    teleport) - the engine queues them while running triggers between
    //    ticks (timer fires, touch events, clicks, chat).
    try { applyPlayerEffects(); } catch { /* never kill the sim */ }

    // 1. v6.4 CSP: CHARACTER MOVEMENT (input -> velocity -> body). The
    //    server-authoritative sim runs the SAME movement math the client
    //    prediction runs (character-constants.ts). The body's velocity
    //    and position are the truth; p.x/p.y/p.z mirror the body for
    //    the snapshot builder + touch checks + void check (so they don't
    //    each look up the body every tick).
    for (const p of players.values()) {
      const body = world.getNamedCharacterBody(p.socketId);
      if (!body) continue;

      if (p.dyingTimer > 0) {
        // The death animation freezes the body in place; respawn fires
        // when it expires.
        p.dyingTimer -= dt;
        body.velocity.set(0, 0, 0);
        if (p.dyingTimer <= 0) respawn(p);
        continue;
      }
      p.jumpCooldown = Math.max(0, p.jumpCooldown - dt);

      const grounded = world.namedCharacterGroundCheck(p.socketId);
      if (grounded) p.lastGroundedClock = simClock;
      world.setNamedCharacterStanding(p.socketId, grounded && p.input.x === 0 && p.input.z === 0);

      // v6.2.4: age the jump latch and clear it on the first grounded tick
      // past a short grace (the impulse lands after this ground check in the
      // same tick, and the body needs a tick or two to actually leave the
      // ground, so a fresh jump must not clear itself immediately).
      if (p.airborneFromJump) {
        p.jumpAge += dt;
        if (grounded && p.jumpAge > 0.15) {
          p.airborneFromJump = false;
          p.jumpAge = 0;
        }
      }

      // Smoothed target velocity (the client's two-stage ramp). The
      // server uses the SAME stepHorizontalVelocity the client uses,
      // so prediction divergence stays tiny.
      const stepped = stepHorizontalVelocity(p.velX, p.velZ, p.input.x, p.input.z, p.input.sprint, grounded, dt);
      p.velX = stepped.velX;
      p.velZ = stepped.velZ;

      // Jump: the input handler fires presses the instant they arrive
      // (see the 'input' message case); this tick-path call remains as
      // the safety net for any jump that lands between handler and tick
      // (identical logic, idempotent under the 0.5 s cooldown).
      tryJump(p);

      // Steer the REAL body velocity toward the target (physics owns the
      // outcome - walls/ramps/pushed parts behave physically).
      const isWalking = Math.hypot(p.input.x, p.input.z) > 0.01;
      const bodyLerp = grounded ? (isWalking ? ACCEL_WALK : ACCEL_STOP) : (isWalking ? ACCEL_WALK : AIR_RELEASE_DECAY);
      const tb = 1 - Math.exp(-bodyLerp * 30 * dt);
      const airTarget = grounded ? 1 : AIR_MOVE_FACTOR;
      body.velocity.x += (p.velX * airTarget - body.velocity.x) * tb;
      body.velocity.z += (p.velZ * airTarget - body.velocity.z) * tb;
      if (grounded && !isWalking) {
        const hSpeed = Math.hypot(body.velocity.x, body.velocity.z);
        if (hSpeed < 0.75) { body.velocity.set(0, body.velocity.y, 0); }
      }
      // A driver body never sleeps (we want it awake to resolve contacts
      // every tick even when the player stands still).
      body.wakeUp();

      // Face the movement direction.
      if (isWalking) p.yaw = Math.atan2(p.velX, p.velZ);

      // Mirror the body position into p.x/y/z so the snapshot builder
      // and touch checks read O(1) without looking up the body.
      const entry = (world as any).namedCharacterEntries?.get(p.socketId);
      const height = entry?.height ?? playerHeight;
      p.x = body.position.x;
      p.y = body.position.y - height / 2;
      p.z = body.position.z;

      // Void death: the authority still owns "fell off the world".
      // v6.2.8: only for LIVING players (hp > 0) - a just-respawned
      // player (dyingTimer just hit 0, hp restored) must never be
      // re-killed by a stale below-voidY record.
      // v6.4: the respawn grace window covers this check too (a stale
      // below-void record can slip in between respawn() writing the
      // spawn position and the next input - without the grace the void
      // check could re-kill the player a second time AT THE SPAWN).
      if (p.hp > 0
        && simClock >= p.respawnGraceUntil
        && p.y + height / 2 < world.voidY) {
        p.hp = 0;
        p.dyingTimer = DEATH_ANIMATION_SECONDS;
      }
    }

    // 2. World physics: every part, terrain, trees, joints, movers.
    world.step(dt);

    // 3. Body-mover/anchored sync + when_touched('parts') + void cleanup:
    //    the same housekeeping PhysicsSimulation does on the client.
    const objects = useStudioStore.getState().objects;
    const updateObject = useStudioStore.getState().updateObject;
    for (const id of Array.from(activeIds)) {
      const obj = objects.get(id);
      if (!obj || !isPart(obj)) { activeIds.delete(id); continue; }
      const pb = world.bodies.get(id);
      if (!pb) { activeIds.delete(id); continue; }

      const storeMovers = (obj as any).bodyMovers || [];
      const explosionMovers: string[] = [];
      for (const mover of storeMovers) {
        if (mover.id?.startsWith('explosion_') && mover.enabled) {
          if (mover.type === 'BodyForce' && mover.force) {
            world.addImpulse(id, mover.force, 0.15);
          }
          explosionMovers.push(mover.id);
        }
      }
      if (explosionMovers.length > 0) {
        const remaining = storeMovers.filter((m: any) => !explosionMovers.includes(m.id));
        updateObject(id, { bodyMovers: remaining } as any);
        pb.bodyMovers = [...remaining];
      } else if (pb.bodyMovers.length !== storeMovers.length) {
        pb.bodyMovers = [...storeMovers];
      } else {
        for (let i = 0; i < pb.bodyMovers.length; i++) {
          if (pb.bodyMovers[i]?.id !== storeMovers[i]?.id) { pb.bodyMovers = [...storeMovers]; break; }
        }
      }
      if (pb.anchored !== obj.anchored) {
        pb.anchored = obj.anchored;
        if (!obj.anchored) pb.isAwake = true;
      }

      // when_touched('parts') - landing frame only.
      const wasGrounded = (pb as any)._wasGrounded;
      if (pb.isGrounded && !wasGrounded) {
        try { weildCodeEngine.handleTouch(id, 'parts'); } catch { /* never kill the sim */ }
      }
      (pb as any)._wasGrounded = pb.isGrounded;
    }

    // Void: fallen parts are deleted (when_destroyed fires).
    const fallen: string[] = [];
    for (const id of activeIds) {
      const pb = world.bodies.get(id);
      if (pb && !pb.anchored && pb.position.y < world.voidY) fallen.push(id);
    }
    if (fallen.length > 0) {
      world.removeBodiesBulk(fallen);
      const s = useStudioStore.getState();
      for (const id of fallen) {
        activeIds.delete(id);
        s.removeObject(id); // fires when_destroyed rules
      }
    }

    // 4. Player touch triggers (when_touched 'player').
    playerTouchChecks();

    // 5. Store sync for moving parts so rules read near-current values
    //    (the client does this at 4 Hz; 7 Hz here is plenty). v6.2.2: this
    //    used to run EVERY tick (30 Hz) - each pass clones the whole
    //    objects Map, which on big maps was the worker's main GC hiccup
    //    source. Also refreshes the hidden-parts set for touch checks.
    storeSyncAccum += dt;
    if (storeSyncAccum >= 1 / STORE_SYNC_HZ) {
      storeSyncAccum = 0;
      ourSyncIds.clear();
      const syncUpdates: Array<{ id: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }> = [];
      for (const id of activeIds) {
        const pb = world.bodies.get(id);
        if (!pb || pb.anchored) continue;
        const cb = world.getCannonBody(id);
        if (cb && cb.sleepState === 2) continue;
        syncUpdates.push({
          id,
          position: { x: pb.position.x, y: pb.position.y, z: pb.position.z },
          rotation: { x: pb.rotation.x, y: pb.rotation.y, z: pb.rotation.z },
        });
        ourSyncIds.add(id);
      }
      if (syncUpdates.length > 0) {
        useStudioStore.getState().syncPhysicsPositions(syncUpdates);
      }
      hiddenPartIds.clear();
      useStudioStore.getState().objects.forEach((obj: any) => {
        if (isPart(obj) && obj.showInWorld === false) hiddenPartIds.add(obj.id);
      });
    }

    // 5b. v6.2.2 SLOW BODY SYNC (v6.2.4: 0.15 s, mirrors the client's
    //     PhysicsSimulation slow path): parts CREATED by rules during play
    //     (when_created / create_part) never had a physics body on the server
    //     - players walked straight through rule-spawned walls while their own
    //     client showed a collision (a major rubber-band source). Also removes
    //     bodies whose store part was deleted and pushes rule-moved anchored
    //     positions into the physics world. The pass used to run every 0.5 s:
    //     a freshly spawned part spent up to half a second as a ghost the
    //     character (and other parts) passed straight through - "characters
    //     sometimes pass through unanchored parts". 0.15 s shrinks that ghost
    //     window to a blink while keeping the pass cheap (one light forEach).
    slowPassAccum += dt;
    if (slowPassAccum >= 0.15) {
      slowPassAccum = 0;
      const objectsNow = useStudioStore.getState().objects;
      objectsNow.forEach((obj: any) => {
        if (!isPart(obj) || obj.isCharacterPart) return;
        const pb = world.bodies.get(obj.id);
        if (!pb) {
          // Part created during play: give it a body now.
          if (obj.showInWorld !== false) {
            world.addBody(obj);
            if (!obj.anchored) activeIds.add(obj.id);
          }
          return;
        }
        if (pb.anchored !== obj.anchored) {
          pb.anchored = obj.anchored;
          pb._anchoredDirty = true;
          // v6.2.4: push the flip into the CANNON body too (type + mass) -
          // the mirror flag alone left the boot-time body type in place.
          try { world.refreshBodyAnchored(obj); } catch { /* never kill the pass */ }
          if (obj.anchored) activeIds.delete(obj.id);
          else { activeIds.add(obj.id); pb.isAwake = true; }
        }
        // Rule moved an anchored part: push the store position to physics.
        if (pb.anchored) {
          if (
            Math.abs(pb.position.x - obj.position.x) > 0.001 ||
            Math.abs(pb.position.y - obj.position.y) > 0.001 ||
            Math.abs(pb.position.z - obj.position.z) > 0.001
          ) {
            pb.position = { ...obj.position };
            pb._anchoredDirty = true;
          }
        }
      });
      // Bodies whose store part is gone (rule delete_part etc.): drop them.
      const gone: string[] = [];
      world.bodies.forEach((pb, id) => {
        const obj = objectsNow.get(id);
        if (!obj || !isPart(obj) || obj.isCharacterPart) gone.push(id);
      });
      if (gone.length > 0) {
        world.removeBodiesBulk(gone);
        for (const id of gone) activeIds.delete(id);
      }
    }

    // 5c. v6.2.2 FAR-BODY SLEEPING (0.33 s, mirrors the client's v13.4
    //     play-mode pass): unanchored parts beyond the interest radius of
    //     EVERY player stop simulating; they wake when someone comes near.
    //     "Runs objects only where there are players."
    //     v6.2.6: "where the players are" = their last accepted reports.
    sleepPassAccum += dt;
    if (sleepPassAccum >= 1 / 3 && players.size > 0) {
      sleepPassAccum = 0;
      if (players.size > 0) {
        for (const id of activeIds) {
          const pb = world.bodies.get(id);
          const cb = world.getCannonBody(id);
          if (!pb || !cb || pb.anchored || cb.mass === 0) continue;
          let inRange = false;
          for (const p of players.values()) {
            const dx = pb.position.x - p.x;
            const dy = pb.position.y - p.y;
            const dz = pb.position.z - p.z;
            if (dx * dx + dy * dy + dz * dz <= INTEREST_RADIUS_SQ) { inRange = true; break; }
          }
          if (!inRange) {
            if (cb.sleepState !== 2) { cb.sleep(); pb.isAwake = false; }
          } else if (cb.sleepState === 2) {
            cb.wakeUp(); pb.isAwake = true;
          }
        }
      }
    }
  }

  function buildSnapshot(): any | null {
    // v6.2.2: snapshots are DELTAS. A player is included only when their
    // transform / hp / anim state changed since their last broadcast (or
    // on the periodic keyframe of everyone); a part only when its
    // transform changed AND it is inside the interest radius of some
    // player (or while the join keyframe is catching a newcomer up).
    // Snapshots with literally nothing to say are not sent at all - an
    // idle world no longer broadcasts 15 empty frames every second.

    // Players: changed transforms + hp + anim only, plus a keyframe of
    // EVERYONE every PLAYER_KEYFRAME_SECONDS (late joiners + drift
    // self-healing - clients treat a missing entry as "unchanged").
    // v6.4: the transform/hp/anim come from the SERVER-AUTHORITATIVE body
    // (mirrored into p.x/y/z each tick) and the anim flags are derived
    // from the input + airborneFromJump latch (legacy style). A pendingTp
    // (spawn slot / respawn / teleport rule) forces the entry out flagged
    // `tp` so the OWNER teleports and everyone else snaps. Each entry also
    // carries `ackSeq` so the owner can reconcile its prediction history.
    const keyframe = simClock >= nextPlayerKeyframeAt;
    if (keyframe) nextPlayerKeyframeAt = simClock + PLAYER_KEYFRAME_SECONDS;
    const playersOut: any[] = [];
    for (const p of players.values()) {
      let x = p.x, y = p.y, z = p.z;
      let tp = false;
      if (p.pendingTp) {
        x = p.pendingTp.x;
        y = p.pendingTp.y;
        z = p.pendingTp.z;
        p.x = x; p.y = y; p.z = z;
        p.pendingTp = null;
        tp = true;
      }
      const isWalking = Math.hypot(p.velX, p.velZ) > 0.01;
      const anim = {
        walking: isWalking && p.dyingTimer <= 0,
        // v6.2.4 LATCH: the rising edge IS the jump, the falling edge IS
        // the landing. The old vy>0 test flipped false at the apex and
        // true again on the landing impact spike (double anim).
        jumping: p.dyingTimer <= 0 && p.airborneFromJump,
        dying: p.dyingTimer > 0,
        sprint: isWalking && p.input.sprint && p.dyingTimer <= 0,
      };
      const hp = Math.round(p.hp);
      const prev = lastPlayerBroadcast.get(p.socketId);
      // v6.4: ackSeq changes every input message, but reconciliations only
      // need to happen when the ack advances - so we include a player in
      // the snapshot when ackSeq changes too (this is rare, so it does
      // not bust the delta stream).
      const ackChanged = !prev || prev.ackSeq !== p.lastInputSeq;
      const changed = ackChanged || tp ||
        Math.abs(prev.x - x) > 0.01 ||
        Math.abs(prev.y - y) > 0.01 ||
        Math.abs(prev.z - z) > 0.01 ||
        Math.abs(prev.yaw - p.yaw) > 0.02 ||
        prev.hp !== hp ||
        prev.walking !== anim.walking ||
        prev.jumping !== anim.jumping ||
        prev.dying !== anim.dying ||
        prev.sprint !== anim.sprint;
      if (!keyframe && !changed) continue; // nothing new to say about them
      lastPlayerBroadcast.set(p.socketId, {
        x, y, z, yaw: p.yaw, hp,
        walking: anim.walking, jumping: anim.jumping, dying: anim.dying, sprint: anim.sprint,
        ackSeq: p.lastInputSeq,
      });
      playersOut.push({
        socketId: p.socketId,
        username: p.username,
        position: [x, y, z],
        rotation: [0, p.yaw, 0],
        anim,
        hp,
        dying: p.dyingTimer > 0,
        ackSeq: p.lastInputSeq,
        ...(tp ? { tp: 1 } : {}),
      });
    }

    // Player positions (interest tests for parts).
    const plX: number[] = [], plY: number[] = [], plZ: number[] = [];
    for (const p of players.values()) {
      plX.push(p.x); plY.push(p.y); plZ.push(p.z);
    }

    // Join/boot keyframe queue: the next few snapshots re-broadcast every
    // unanchored part once (up to PARTS_KEYFRAME_BUDGET per snapshot) so a
    // client that just arrived learns where physics actually settled
    // everything, not just what moves after it joined.
    if (partsKeyframeQueue === null && partsKeyframeDirty) {
      partsKeyframeQueue = Array.from(activeIds);
      partsKeyframeDirty = false;
    }
    const drained = partsKeyframeQueue
      ? partsKeyframeQueue.slice(0, PARTS_KEYFRAME_BUDGET)
      : [];
    const keyframeIds = drained.length > 0 ? new Set(drained) : null;

    // Changed part transforms since the last broadcast (interest-culled).
    const parts: any[] = [];
    for (const id of activeIds) {
      const pb = world.bodies.get(id);
      if (!pb || pb.anchored) continue;
      const prev = lastBroadcast.get(id);
      const changed = !prev ||
        Math.abs(prev.x - pb.position.x) > 0.01 ||
        Math.abs(prev.y - pb.position.y) > 0.01 ||
        Math.abs(prev.z - pb.position.z) > 0.01 ||
        Math.abs(prev.rx - pb.rotation.x) > 0.5 ||
        Math.abs(prev.ry - pb.rotation.y) > 0.5 ||
        Math.abs(prev.rz - pb.rotation.z) > 0.5;
      if (keyframeIds?.has(id)) {
        // Keyframe parts always go out (a newcomer needs settled state,
        // even for parts outside its current view).
      } else if (changed) {
        // Regular delta: only stream parts some player can actually see
        // (clients render nothing past 320 studs). lastBroadcast is NOT
        // updated for skipped parts, so they naturally re-send the moment
        // they come back into somebody's range.
        let inRange = false;
        for (let i = 0; i < plX.length; i++) {
          const dx = pb.position.x - plX[i];
          const dy = pb.position.y - plY[i];
          const dz = pb.position.z - plZ[i];
          if (dx * dx + dy * dy + dz * dz <= INTEREST_RADIUS_SQ) { inRange = true; break; }
        }
        if (!inRange) continue;
      } else {
        continue;
      }
      parts.push({
        id,
        x: pb.position.x, y: pb.position.y, z: pb.position.z,
        rx: pb.rotation.x, ry: pb.rotation.y, rz: pb.rotation.z,
      });
      lastBroadcast.set(id, { x: pb.position.x, y: pb.position.y, z: pb.position.z, rx: pb.rotation.x, ry: pb.rotation.y, rz: pb.rotation.z });
    }

    // Rule-driven full part updates (color/size/transparency/...).
    // v6.2.7: NEW and DELETED parts ride the same channel - a deleted
    // part broadcasts { id, deleted: true }, a rule-created part carries
    // its full record (clients addObject when the id is unknown).
    const objects = useStudioStore.getState().objects;
    if (lastObjectsRef) {
      let budget = 200; // per-snapshot cap keeps huge rule storms bounded
      for (const id of Array.from(lastObjectsRef.keys())) {
        if (budget <= 0) break;
        if (!objects.has(id)) {
          partUpdatesOut.push({ id, deleted: true });
          lastObjectsRef.delete(id);
          budget -= 1;
        }
      }
      objects.forEach((obj: any, id: string) => {
        if (budget <= 0) return;
        if (!isPart(obj)) return;
        const prev = lastObjectsRef!.get(id);
        if (prev === obj) return;
        lastObjectsRef!.set(id, obj);
        if (prev) {
          if (ourSyncIds.has(id)) {
            // Our transform sync only changes position/rotation - anything
            // else changing means a rule touched it too. Cheap field check;
            // a full deep-compare is overkill on the hot path.
            if (
              prev.color === obj.color &&
              prev.size?.x === obj.size?.x && prev.size?.y === obj.size?.y && prev.size?.z === obj.size?.z &&
              prev.transparency === obj.transparency &&
              prev.material === obj.material
            ) return;
          }
        }
        partUpdatesOut.push(obj);
        budget -= 1;
      });
    } else {
      lastObjectsRef = new Map(objects as any);
    }

    // v6.2.2: nothing changed anywhere -> send nothing at all.
    if (
      playersOut.length === 0 &&
      parts.length === 0 &&
      partUpdatesOut.length === 0 &&
      fxOut.length === 0 &&
      messagesOut.length === 0
    ) {
      return null;
    }

    seq += 1;
    if (partsKeyframeQueue && drained.length > 0) {
      partsKeyframeQueue.splice(0, drained.length);
      if (partsKeyframeQueue.length === 0) partsKeyframeQueue = null;
    }

    return {
      t: 'snapshot',
      seq,
      players: playersOut,
      parts,
      partUpdates: partUpdatesOut.splice(0, partUpdatesOut.length),
      fx: fxOut.splice(0, fxOut.length),
      messages: messagesOut.splice(0, messagesOut.length),
    };
  }

  // Start the rules engine (single authority).
  try {
    weildCodeEngine.start();
  } catch (e: any) {
    console.warn('[world-runtime] engine start failed (continuing physics-only):', e?.message);
  }

  const tick = setInterval(() => {
    if (!running) return;
    const now = Date.now();
    if (players.size === 0) {
      // v6.2.2 EMPTY-INSTANCE PAUSE: with no players in the room there is
      // nothing anybody can observe. The physics step, the rules engine
      // (its rAF callback is held by the polyfill), the store write-back
      // and the snapshots all stop. The empty-grace sweeper disposes this
      // worker soon anyway; until then it costs ~one interval callback.
      if (!idle) {
        idle = true;
        enginePaused = true;
        simAccum = 0; snapAccum = 0; storeSyncAccum = 0; slowPassAccum = 0; sleepPassAccum = 0;
      }
      lastTime = now;
      return;
    }
    if (idle) {
      // Someone joined: unfreeze the rules engine (release the held rAF
      // callback) and restart the clocks without integrating the gap.
      idle = false;
      enginePaused = false;
      lastTime = now;
      simAccum = 0; snapAccum = 0; storeSyncAccum = 0; slowPassAccum = 0; sleepPassAccum = 0;
      const cb = heldRafCb;
      heldRafCb = null;
      if (cb) setTimeout(() => cb(Date.now()), 16);
    }
    let frameDt = (now - lastTime) / 1000;
    lastTime = now;
    if (frameDt > 0.25) frameDt = 0.25; // catch-up clamp after stalls

    simAccum += frameDt;
    snapAccum += frameDt;
    let stepped = false;
    while (simAccum >= SIM_DT) {
      stepSim(SIM_DT);
      simAccum -= SIM_DT;
      stepped = true;
    }
    if (stepped && snapAccum >= 1 / SNAPSHOT_HZ) {
      snapAccum = 0;
      const snap = buildSnapshot();
      if (snap) post(snap); // null = nothing changed, nothing to send
    }
  }, 1000 / SIM_HZ);

  function shutdown(): void {
    if (!running) return;
    running = false;
    clearInterval(tick);
    try { weildCodeEngine.stop(); } catch { /* already stopped */ }
    post({ t: 'stopped' });
    setTimeout(() => process.exit(0), 50).unref();
  }

  post({ t: 'ready', players: 0, parts: queue.length, spawn: [spawnFeet.x, spawnFeet.y, spawnFeet.z] });
}

main().catch((e) => {
  console.error('[world-runtime] fatal:', e);
  fatal(String(e?.message || e));
});
