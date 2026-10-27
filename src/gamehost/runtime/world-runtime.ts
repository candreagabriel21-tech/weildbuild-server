// ═══════════════════════════════════════════════════════════════════
// WeildBuild — SERVER-AUTHORITATIVE world runtime (v1.2)
// ═══════════════════════════════════════════════════════════════════
// Runs INSIDE A WORKER THREAD, one per game instance, on the gamehost.
// It loads the game's studio state, then runs THE SAME ENGINE THE CLIENT
// RUNS - imported from server/engine (a synced copy of the platform's
// src/lib, see scripts/build-world-runtime.mjs), bundled by esbuild:
//
//   • PhysicsWorld (cannon-es): every unanchored part, terrain, trees,
//     joints, body movers - simulated for EVERYONE, once.
//   • The WeildCode rules engine: triggers, timers, actions - the single
//     authority. Its sound actions are relayed to the players' browsers
//     (see sounds.ts setSoundSink); its screen messages ride snapshots.
//   • One character pill hitbox PER PLAYER (PhysicsWorld's named-body
//     API), driven by the movement math in character-constants.ts - the
//     exact constants the client prediction uses.
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
//     { t: 'input', socketId, x, z, jump, sprint, yaw }   (SAVED server-sim)
//     { t: 'report', socketId, x, y, z, vx, vy, vz, yaw,  (v6.2.8 default)
//       walking, sprint, jumping, grounded }
//     { t: 'click', socketId, partId }
//     { t: 'chat', username, message }        (Phase 5: chat rules)
//     { t: 'stop' }
//   ←  { t: 'ready' }
//     { t: 'snapshot', seq, players, parts, partUpdates, fx, messages }
//     { t: 'error', message }
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
  input: { x: number; z: number; jump: boolean; sprint: boolean; yaw: number };
  hp: number;
  dyingTimer: number;   // > 0 while the death animation plays
  jumpCooldown: number;
  /** v6.2.4: latched "airborne because of a jump" flag. The old
   * velocity-y-threshold jumping flag flipped false at the apex and (much
   * worse) flipped TRUE again for a tick when the landing impact resolved
   * with a small upward velocity spike - every client rendered the jump
   * animation and played the jump sound TWICE (once at the jump, once at
   * landing). The latch is set by the actual jump impulse and cleared by
   * the first grounded tick after a short grace, so its rising edge IS the
   * jump and its falling edge IS the landing. */
  airborneFromJump: boolean;
  /** Seconds since the jump impulse set airborneFromJump (grace timer). */
  jumpAge: number;
  velX: number;         // smoothed horizontal velocity (prediction mirror)
  velZ: number;
  yaw: number;
  /** v6.2.5: simClock when grounded last held (coyote-time jumps). The
   * old relative accumulator (lastGroundedAt += dt) only worked inside
   * stepSim; the absolute clock lets the input handler honor coyote time
   * the instant a jump message arrives, not one tick later. */
  lastGroundedClock: number;
  touched: Set<string>; // part ids currently touched (when_touched re-arm)

  // ─── v6.2.8: CLIENT-REPORT state (PLAYER_NETCODE_MODE=client-report) ───
  // The owning client simulates its own character and streams its state;
  // this is the last ACCEPTED report (what gets broadcast + where the
  // kinematic ghost pill sits between reports).
  report: {
    x: number; y: number; z: number;       // FEET position (client-authoritative)
    yaw: number;
    vx: number; vy: number; vz: number;     // the client's own velocity
    walking: boolean; sprint: boolean; jumping: boolean; grounded: boolean;
  };
  /** Wall-clock ms of the last ACCEPTED report (0 = none yet; also the
   * baseline clock for the implied-speed sanity check). */
  lastReportAt: number;
  /** Wall-clock ms until which reports are dropped wholesale - armed by
   * server-initiated moves (respawn, rule teleports) so the client's
   * in-flight reports from the OLD position cannot drag the player back. */
  ignoreReportsUntil: number;
  /** Consecutive REJECTED reports (speed/teleport caps). The relay must
   * never permanently freeze a diverged client, so after enough consecutive
   * rejections the server ADOPTS the client's claim (positions are
   * client-authoritative by design; the checks are sanity rails). */
  rejectStreak: number;
}

const SIM_HZ = 30;
// v6.2.5: 15 -> 30. Clients render every character (your own included)
// purely from interpolated snapshot samples, so the stream density IS the
// smoothness: 33 ms spacing with a 100-150 ms render delay always spans
// 3+ live samples. Delta filtering keeps the idle cost at the old 15 Hz
// level (unchanged players are simply not listed).
const SNAPSHOT_HZ = 30;
// v6.2.1: aligned with the client's DEATH_DURATION (StudioPlayViewport
// startDeath) - the local and remote death animations now end together with
// the server-side respawn, so the body reappears exactly at the spawn point
// instead of 0.45s of dead air.
const DEATH_ANIMATION_SECONDS = 1.35;
/** Coyote time: a jump still counts this long after leaving the ground.
 * Matches the client's prediction (coyoteTimer 0.1s) so the authority never
 * denies a jump the client already predicted (that was the jump
 * rubber-band: client jumps, server disagrees, next snapshot yanks back). */
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
 * self-heal. With 15 Hz deltas this trims idle traffic by ~97%. */
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
  const { setSoundSink } = await import('../../../engine/sounds');
  const {
    stepHorizontalVelocity, applyJump,
    ACCEL_WALK, ACCEL_STOP, AIR_RELEASE_DECAY, AIR_MOVE_FACTOR,
  } = await import('../../../engine/game-engine/character-constants');
  // v6.2.8: the player netcode mode default + report cadence (shared with
  // the client - see PLAYER_MODE above and character-constants.ts).
  const {
    PLAYER_NETCODE_MODE: PLAYER_NETCODE_MODE_DEFAULT,
    CLIENT_REPORT_INTERVAL_MS,
  } = await import('../../../engine/game-engine/character-constants');

  // ─── v6.2.8: PLAYER NETCODE MODE (the Roblox-style relay) ───
  // Default comes from the SHARED character-constants ('client-report'); the
  // gamehost env PLAYER_NETCODE_MODE=server-sim restores the saved v6.2.5-
  // v6.2.7 server-side character simulation (kept fully intact below - every
  // old path is gated on this flag, nothing was deleted).
  const PLAYER_NETCODE_MODE_ENV = process.env.PLAYER_NETCODE_MODE;
  const PLAYER_MODE: 'client-report' | 'server-sim' =
    PLAYER_NETCODE_MODE_ENV === 'server-sim' ? 'server-sim'
      : PLAYER_NETCODE_MODE_ENV === 'client-report' ? 'client-report'
        : PLAYER_NETCODE_MODE_DEFAULT;

  // The relay's TINY LIGHT CHECKS (explicitly not security - the platform
  // has no players to protect; these keep absurd garbage out of the stream):
  /** Flood guard: reports closer together than this are dropped (the
   * heartbeat is CLIENT_REPORT_INTERVAL_MS; half of it is the tolerance). */
  const REPORT_MIN_INTERVAL_MS = Math.max(60, CLIENT_REPORT_INTERVAL_MS * 0.5);
  /** The user's example check: a single report moving the character further
   * than this from the last accepted position is rejected outright (500
   * studs in one frame is never legitimate). */
  const REPORT_MAX_JUMP_STUDS = 500;
  /** Implied speed cap (studs/s): dist / max(reportInterval, timeSinceLast).
   * Generously above every legit character motion (sprint ~18.4, terminal
   * fall 50) so normal play - including long falls just above the void
   * line - never trips it. */
  const REPORT_SPEED_TOLERANCE = 120;
  /** Cap on the dt used for the implied-speed math, so a long network stall
   * cannot silently whitelist a huge jump (the hard cap above still applies). */
  const REPORT_SPEED_DT_CAP_S = 5;
  /** Consecutive rejections before the relay ADOPTS the client's position
   * (client-authoritative by design - the checks are rails, not judges). */
  const REPORT_REJECT_ADOPT = 8;
  /** After a server-initiated move (respawn / rule teleport) reports are
   * dropped for this long, covering the client's snap + next heartbeat. */
  const TELEPORT_REPORT_GRACE_MS = 1200;
  /** Terminal fall speed for the kinematic ghost's dead-reckoned arc
   * (matches the client's own clamp). */
  const GHOST_TERMINAL_VELOCITY = 50;

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
  const spawnPoint = studioState.spawnPoint ?? { x: 0, y: 5, z: 0 };

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

  // ─── Build the physics world (mirrors the client's PhysicsSimulation) ───
  const physicsSettings = useStudioStore.getState().physicsSettings;
  const world = new PhysicsWorld(physicsSettings);

  const queue: StudioPart[] = [];
  useStudioStore.getState().objects.forEach((obj) => {
    if (isPart(obj) && !(obj as StudioPart).isCharacterPart && !(obj as StudioPart).isCharacterRoot && (obj as StudioPart).showInWorld !== false) {
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
  const players = new Map<string, RuntimePlayer>();
  const characterRoot = Array.from(useStudioStore.getState().objects.values())
    .find((obj) => isPart(obj) && (obj as StudioPart).isCharacterRoot) as StudioPart | undefined;
  const rootSize = characterRoot?.size;
  const rootRot = characterRoot?.rotation;
  const spawnFeet = characterRoot
    ? { x: characterRoot.position.x, y: characterRoot.position.y - characterRoot.size.y / 2, z: characterRoot.position.z }
    : { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z };

  // Spawn spacing: joining players land on a widening ring around the
  // spawn point (like classic lobby games) so overlapping pill hitboxes
  // never shove each other around on join.
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
    world.addNamedCharacterBody(socketId, slot, { size: rootSize, rotationDeg: rootRot });
    // v6.2.8: in client-report mode the named pill is a KINEMATIC GHOST -
    // the owning client streams its own transform, and this pill only
    // dead-reckons the reported velocity so the character still pushes
    // parts (crates, plates) server-side for everyone. Nothing server-side
    // can ever fight the owning client for the character's position.
    if (PLAYER_MODE === 'client-report') {
      world.setNamedCharacterKinematic(socketId, true);
    }
    players.set(socketId, {
      socketId,
      username,
      input: { x: 0, z: 0, jump: false, sprint: false, yaw: 0 },
      hp: useStudioStore.getState().playState.characterMaxHealth || 100,
      dyingTimer: 0,
      jumpCooldown: 0,
      airborneFromJump: false,
      jumpAge: 0,
      velX: 0,
      velZ: 0,
      yaw: rootRot?.y ? (rootRot.y * Math.PI) / 180 : 0,
      lastGroundedClock: 0,
      touched: new Set(),
      // v6.2.8: the report state starts at the assigned spawn slot (what
      // late joiners see until the owner's first heartbeat lands, ~0.25 s).
      report: {
        x: slot.x, y: slot.y, z: slot.z,
        yaw: rootRot?.y ? (rootRot.y * Math.PI) / 180 : 0,
        vx: 0, vy: 0, vz: 0,
        walking: false, sprint: false, jumping: false, grounded: true,
      },
      lastReportAt: 0,
      ignoreReportsUntil: 0,
      rejectStreak: 0,
    });
  }

  function removePlayer(socketId: string): void {
    world.removeNamedCharacterBody(socketId);
    players.delete(socketId);
    lastPlayerBroadcast.delete(socketId); // v6.2.2: drop its delta state
  }

  function respawn(p: RuntimePlayer): void {
    world.teleportNamedCharacterBody(p.socketId, spawnFeet);
    p.hp = useStudioStore.getState().playState.characterMaxHealth || 100;
    p.velX = 0;
    p.velZ = 0;
    p.dyingTimer = 0;
    // A respawned body is FRESH (same semantics as a join): every
    // when_touched trigger re-arms, so spawning ON a trigger part fires it
    // again. v6.2.8: in client-report mode the kinematic ghost never gets
    // the solver "pop" a dynamic body had, so without this the re-arm only
    // worked by accident of the physics settle.
    p.touched.clear();
    // v6.2.8: the relay baseline follows the respawn (the client snaps its
    // local body to the same spot on the dying falling edge), and in-flight
    // reports from the death spot are dropped for the grace window so they
    // cannot drag the player back to where they died.
    if (PLAYER_MODE === 'client-report') {
      p.report = {
        x: spawnFeet.x, y: spawnFeet.y, z: spawnFeet.z,
        yaw: p.report.yaw,
        vx: 0, vy: 0, vz: 0,
        walking: false, sprint: false, jumping: false, grounded: true,
      };
      p.lastReportAt = Date.now();
      p.ignoreReportsUntil = Date.now() + TELEPORT_REPORT_GRACE_MS;
      p.rejectStreak = 0;
    }
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
          world.teleportNamedCharacterBody(p.socketId, { x: e.position.x, y: e.position.y, z: e.position.z });
          p.velX = 0;
          p.velZ = 0;
          // v6.2.8: the relay baseline follows the rule teleport; the
          // client learns about it from the next snapshot (its drift valve
          // snaps the local body), and in-flight reports from the old spot
          // are dropped for the grace window so they cannot undo the rule.
          if (PLAYER_MODE === 'client-report') {
            p.report = {
              x: e.position.x, y: e.position.y, z: e.position.z,
              yaw: p.report.yaw,
              vx: 0, vy: 0, vz: 0,
              walking: false, sprint: false, jumping: false, grounded: true,
            };
            p.lastReportAt = Date.now();
            p.ignoreReportsUntil = Date.now() + TELEPORT_REPORT_GRACE_MS;
            p.rejectStreak = 0;
          }
        }
        break;
    }
  }

  // ─── Rules engine: sound relay + screen message relay ───
  const fxOut: Array<{ name: string; volume: number }> = [];
  setSoundSink((name, volume) => {
    if (fxOut.length < 64) fxOut.push({ name, volume: Math.max(0, Math.min(1, volume)) });
  });

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
  let lastObjectsRef: Map<string, any> | null = null;
  const partUpdatesOut: any[] = [];
  const ourSyncIds = new Set<string>();

  // ─── v6.2.2: delta snapshot + interest state ───
  // Players are only broadcast when they CHANGE (plus a periodic keyframe
  // of everyone). Parts only when they change AND are near a player.
  const lastPlayerBroadcast = new Map<string, {
    x: number; y: number; z: number; yaw: number; hp: number;
    walking: boolean; jumping: boolean; dying: boolean; sprint: boolean;
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

  // ─── Input / click / chat from the host ───
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
    } else if (m.t === 'input' && typeof m.socketId === 'string') {
      // ─── v6.2.8: SAVED server-sim input path (PLAYER_NETCODE_MODE=server-sim).
      // In client-report mode (the default) the 30 Hz input stream is simply
      // not consumed for movement - the owning client's state reports (below)
      // are the character's authority. The code is kept fully intact so the
      // env flag restores the v6.2.5-v6.2.7 behavior with zero code changes.
      if (PLAYER_MODE !== 'server-sim') return;
      const p = players.get(m.socketId);
      if (!p) return;
      // Sanitize: numbers only, direction clamped to unit length.
      let x = Number(m.x) || 0;
      let z = Number(m.z) || 0;
      const len = Math.hypot(x, z);
      if (len > 1) { x /= len; z /= len; }
      if (p.dyingTimer <= 0) {
        p.input = { x, z, jump: !!m.jump, sprint: !!m.sprint, yaw: Number(m.yaw) || 0 };
        // v6.2.5: "the server takes input almost instantly" - a jump press
        // fires THE MOMENT the message arrives instead of waiting for the
        // next simulation tick (up to 33 ms). Steering input is consumed by
        // stepSim at the next tick (<= 33 ms), which is the physics cadence
        // anyway.
        if (m.jump) tryJump(p);
      }
    } else if (m.t === 'report' && typeof m.socketId === 'string') {
      // ─── v6.2.8: CLIENT REPORT (the Roblox-style relay, default mode) ───
      // The owning client simulated its own character this past 0.25 s and
      // tells us where it ended up. Light sanity checks, then the report
      // becomes the broadcast state + drives the kinematic ghost pill.
      const p = players.get(m.socketId);
      if (!p) return;
      try { applyReport(p, m); } catch { /* a malformed report must never kill the sim */ }
    } else if (m.t === 'click' && typeof m.partId === 'string') {
      // v6.2.1: the clicker's username rides along so player-targeting
      // rules (kill/heal/damage/teleport) hit THEM, not the whole room.
      try { weildCodeEngine.handleClick(m.partId, typeof m.username === 'string' ? m.username : undefined); } catch { /* rules must never kill the sim */ }
    } else if (m.t === 'chat' && typeof m.message === 'string') {
      // v1.5: game rules - on_chat_message (optional username/contains filters).
      try { weildCodeEngine.handleChatMessage(String(m.username || 'Player'), String(m.message)); } catch { /* never kill the sim */ }
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
    // v6.2.2 PERF: the candidate list is built ONCE per tick straight
    // from the physics bodies (current to THIS step, not the 7 Hz store
    // write-back) instead of re-walking the whole store PER PLAYER -
    // with 10 players that alone was a 10x multiplier on every object.
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
      const body = world.getNamedCharacterBody(p.socketId);
      if (!body) continue;
      const entry = (world as any).namedCharacters?.get(p.socketId);
      const height = entry?.height ?? 2;
      const halfW = Math.min(entry?.size?.x ?? 0.8, entry?.size?.z ?? 0.8) / 2;
      const stillTouched = new Set<string>();
      const newlyTouched: string[] = [];
      for (const c of candidates) {
        if (Math.abs(c.x - body.position.x) > c.hx + halfW + 0.1) continue;
        if (Math.abs(c.z - body.position.z) > c.hz + halfW + 0.1) continue;
        if (Math.abs(c.y - body.position.y) > c.hy + height / 2) continue;
        stillTouched.add(c.id);
        if (!p.touched.has(c.id)) newlyTouched.push(c.id);
      }
      for (const id of newlyTouched) {
        // v6.2.1: the TOUCHING player is the acting player - a lava brick
        // kills the player who stepped on it, not everyone in the room.
        try { weildCodeEngine.handleTouch(id, 'player', p.username); } catch { /* never kill the sim */ }
      }
      p.touched = stillTouched;
    }
  }

  /**
   * v6.2.5: fire a jump press the moment it is known - called from the
   * input message handler (instant) AND from stepSim (the safety net).
   * Honors the 0.5 s cooldown and coyote time (a jump still counts this
   * long after leaving the ground, matching the client feel); sets the
   * v6.2.4 airborneFromJump latch whose rising edge IS the jump and whose
   * falling edge IS the landing (exactly one of each per hop, everywhere).
   * A jump that cannot fire is consumed and dropped - identical to the old
   * tick-only semantics.
   */
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
    p.jumpCooldown = 0.5;
    p.lastGroundedClock = -1e9; // the jump consumed the coyote grace
    p.airborneFromJump = true;
    p.jumpAge = 0;
  }

  /** Rate-limited rejection logger (a spamming client must not flood the
   * host's stdout - one line per player per few seconds is plenty). */
  let reportWarnAt = 0;
  function warnRejected(p: RuntimePlayer, why: string, dist: number, implied: number): void {
    const now = Date.now();
    if (now - reportWarnAt < 5000) return;
    reportWarnAt = now;
    console.warn(
      `[world-runtime] report rejected (${why}): ${p.username} dist=${dist.toFixed(1)} implied=${implied.toFixed(0)} u/s streak=${p.rejectStreak}`
    );
  }

  /**
   * v6.2.8: apply one CLIENT STATE REPORT (the Roblox-style relay).
   *
   * The owning client simulated its own character over the last 0.25 s and
   * reports where it is / how it is moving. The server:
   *   1. drops it wholesale during a server-initiated move grace (respawn /
   *      rule teleport - in-flight reports from the old position must not
   *      drag the player back) and enforces a small flood interval,
   *   2. drops reports while the player is dying (the dead don't move; the
   *      respawn resets the baseline),
   *   3. kills void-fallers straight from the reported Y (below the line is
   *      a death, never a "violation"),
   *   4. runs the TINY LIGHT CHECKS - the user's 500-studs-in-one-report
   *      hard cap and an implied-speed cap - rejecting (not kicking; there
   *      are no players to protect) anything absurd. After enough
   *      consecutive rejections the report is ADOPTED anyway: positions
   *      are client-authoritative by design and the relay must never
   *      permanently freeze a diverged (if honest) client,
   *   5. accepts: the report becomes the broadcast state, and the KINEMATIC
   *      ghost pill is placed + given the reported velocity so world
   *      physics (crates being shoved) keeps feeling the character.
   */
  function applyReport(p: RuntimePlayer, m: any): void {
    if (PLAYER_MODE !== 'client-report') return;
    const now = Date.now();
    if (now < p.ignoreReportsUntil) return;
    if (now - p.lastReportAt < REPORT_MIN_INTERVAL_MS) return; // flood guard

    // Sanitize: finite numbers only (a tampered client can send anything).
    const x = Number(m.x), y = Number(m.y), z = Number(m.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const clampV = (v: number) => Math.max(-REPORT_SPEED_TOLERANCE, Math.min(REPORT_SPEED_TOLERANCE, Number.isFinite(v) ? v : 0));
    const vx = clampV(Number(m.vx) || 0);
    const vy = clampV(Number(m.vy) || 0);
    const vz = clampV(Number(m.vz) || 0);
    const yaw = Number.isFinite(Number(m.yaw)) ? Number(m.yaw) : p.report.yaw;

    // The dead don't move: reports during the death animation are dropped
    // (the client's local body is frozen in its death anim anyway; respawn
    // resets the baseline).
    if (p.dyingTimer > 0) return;

    // Void fall: below the line is a DEATH, not a violation. Echo where
    // they fell (what other screens render for the death) and let the
    // dyingTimer respawn cycle take over.
    if (y < world.voidY) {
      p.hp = 0;
      p.dyingTimer = DEATH_ANIMATION_SECONDS;
      p.report = { x, y, z, yaw, vx: 0, vy: 0, vz: 0, walking: false, sprint: false, jumping: false, grounded: false };
      p.lastReportAt = now;
      p.rejectStreak = 0;
      return;
    }

    // The tiny light checks: distance from the last ACCEPTED position and
    // the implied speed (dt floored at the report interval so a spammer
    // cannot shrink the denominator, capped so a long stall cannot
    // wholesale whitelist a huge jump).
    const dx = x - p.report.x;
    const dy = y - p.report.y;
    const dz = z - p.report.z;
    const dist = Math.hypot(dx, dy, dz);
    const dtSec = Math.min(
      REPORT_SPEED_DT_CAP_S,
      Math.max(CLIENT_REPORT_INTERVAL_MS / 1000, (now - p.lastReportAt) / 1000),
    );
    const implied = dist / dtSec;
    if (dist > REPORT_MAX_JUMP_STUDS || implied > REPORT_SPEED_TOLERANCE) {
      p.rejectStreak += 1;
      warnRejected(p, dist > REPORT_MAX_JUMP_STUDS ? 'teleport cap' : 'speed cap', dist, implied);
      if (p.rejectStreak < REPORT_REJECT_ADOPT) return; // rejected
      // else: ADOPT after a persistent streak - the relay never freezes a
      // client forever (client-authoritative by design).
    }

    // ACCEPT: the report becomes the broadcast state + drives the ghost.
    p.rejectStreak = 0;
    p.report = {
      x, y, z, yaw, vx, vy, vz,
      walking: !!m.walking, sprint: !!m.sprint, jumping: !!m.jumping, grounded: !!m.grounded,
    };
    p.lastReportAt = now;
    const body = world.getNamedCharacterBody(p.socketId);
    if (body) {
      const entry = (world as any).namedCharacters?.get(p.socketId);
      const h = entry?.height ?? 2;
      body.position.set(x, y + h / 2, z);
      body.previousPosition.copy(body.position);
      body.interpolatedPosition.copy(body.position);
      body.velocity.set(vx, vy, vz);
      body.wakeUp();
    }
  }

  function stepSim(dt: number): void {
    simClock += dt; // simulated seconds (drives keyframe deadlines)

    // 0. v6.2.1: apply queued per-player rule effects (kill/heal/damage/
    //    teleport) - the engine queues them while running triggers between
    //    ticks (timer fires, touch events, clicks, chat).
    try { applyPlayerEffects(); } catch { /* never kill the sim */ }

    // 1. Characters.
    //
    //    v6.2.8 splits this by PLAYER_NETCODE_MODE:
    //    - client-report (default): the owning clients simulate their own
    //      characters and stream state (applyReport above). All this loop
    //      does per tick is run the death/respawn timer and integrate the
    //      ghost pills' airborne arcs (gravity between reports, so a jumping
    //      or falling character's ghost pushes parts along a physical
    //      parabola instead of a straight laser line).
    //    - server-sim (SAVED, env PLAYER_NETCODE_MODE=server-sim): the
    //      input -> velocity -> cannon body simulation below, unchanged
    //      from v6.2.5-v6.2.7.
    if (PLAYER_MODE === 'client-report') {
      for (const p of players.values()) {
        const body = world.getNamedCharacterBody(p.socketId);
        if (!body) continue;
        if (p.dyingTimer > 0) {
          p.dyingTimer -= dt;
          // The ghost holds the death spot for the 1.35 s animation.
          body.velocity.set(0, 0, 0);
          if (p.dyingTimer <= 0) respawn(p);
          continue;
        }
        // Dead-reckoned ghost arc between reports: while the client says it
        // is GROUNDED the ghost holds its reported velocity exactly (a
        // standing character must never sink into - and press on - the part
        // under it); while AIRBORNE the ghost integrates gravity so jumps
        // and falls sweep a real parabola (kinematic bodies get no gravity
        // from cannon - forces only apply to DYNAMIC bodies).
        if (!p.report.grounded) {
          const nextVy = body.velocity.y + world.settings.gravity * dt;
          body.velocity.y = Math.max(-GHOST_TERMINAL_VELOCITY, nextVy);
        }
      }
    } else {
    // ─── SAVED v6.2.5-v6.2.7 server-side character simulation ───
    for (const p of players.values()) {
      const body = world.getNamedCharacterBody(p.socketId);
      if (!body) continue;

      if (p.dyingTimer > 0) {
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

      // Smoothed target velocity (the client's two-stage ramp).
      const stepped = stepHorizontalVelocity(p.velX, p.velZ, p.input.x, p.input.z, p.input.sprint, grounded, dt);
      p.velX = stepped.velX;
      p.velZ = stepped.velZ;

      // Jump: v6.2.5 the input handler fires presses the instant they
      // arrive (see the 'input' message case); this tick-path call remains
      // as the safety net for any jump that lands between handler and tick
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
        if (hSpeed < 0.75) { body.velocity.x = 0; body.velocity.z = 0; }
      }

      // Face the movement direction.
      if (isWalking) p.yaw = Math.atan2(p.velX, p.velZ);
    }
    } // end SAVED server-sim

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

    // Void: fallen parts are deleted (when_destroyed fires); fallen
    // players die and respawn.
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
    for (const p of players.values()) {
      // v6.2.8: in client-report mode the REPORT is the player's position
      // (the ghost is only a physics proxy - its dead-reckoned body can
      // fall below the world during a rejected streak and must NEVER be
      // allowed to kill the owner or break interest management). In
      // server-sim mode the simulated body is the truth.
      const py = PLAYER_MODE === 'client-report' ? p.report.y : world.getNamedCharacterBody(p.socketId)?.position.y;
      if (py !== undefined && p.dyingTimer <= 0 && py < world.voidY) {
        p.hp = 0;
        p.dyingTimer = DEATH_ANIMATION_SECONDS;
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
        if (!isPart(obj) || obj.isCharacterPart || obj.isCharacterRoot) return;
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
        if (!obj || !isPart(obj) || obj.isCharacterPart || obj.isCharacterRoot) gone.push(id);
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
    sleepPassAccum += dt;
    if (sleepPassAccum >= 1 / 3 && players.size > 0) {
      sleepPassAccum = 0;
      const px: number[] = [], py: number[] = [], pz: number[] = [];
      for (const p of players.values()) {
        // v6.2.8: client-report mode centers interest on the REPORTED
        // position (the ghost can lag it by a dead-reckoning drift).
        if (PLAYER_MODE === 'client-report') {
          px.push(p.report.x); py.push(p.report.y); pz.push(p.report.z);
        } else {
          const b = world.getNamedCharacterBody(p.socketId);
          if (b) { px.push(b.position.x); py.push(b.position.y); pz.push(b.position.z); }
        }
      }
      if (px.length > 0) {
        for (const id of activeIds) {
          const pb = world.bodies.get(id);
          const cb = world.getCannonBody(id);
          if (!pb || !cb || pb.anchored || cb.mass === 0) continue;
          let inRange = false;
          for (let i = 0; i < px.length; i++) {
            const dx = pb.position.x - px[i];
            const dy = pb.position.y - py[i];
            const dz = pb.position.z - pz[i];
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
    const keyframe = simClock >= nextPlayerKeyframeAt;
    if (keyframe) nextPlayerKeyframeAt = simClock + PLAYER_KEYFRAME_SECONDS;
    const playersOut: any[] = [];
    for (const p of players.values()) {
      const body = world.getNamedCharacterBody(p.socketId);
      if (!body) continue;
      const entry = (world as any).namedCharacters?.get(p.socketId);
      const height = entry?.height ?? 2;
      // v6.2.8: WHERE the broadcast transform comes from:
      //   client-report: the player's last ACCEPTED report (what the owning
      //     client said, relayed verbatim - the ghost body is only the
      //     physics proxy). velocity rides along so every client (the owner
      //     included, for its drift-valve dead reckoning) can dead-reckon.
      //   server-sim (SAVED): the simulated body's transform.
      let x: number, y: number, z: number, yaw: number;
      let velocity: [number, number, number];
      let anim: { walking: boolean; jumping: boolean; dying: boolean; sprint: boolean };
      if (PLAYER_MODE === 'client-report') {
        x = p.report.x;
        y = p.report.y;
        z = p.report.z;
        yaw = p.report.yaw;
        velocity = [p.report.vx, p.report.vy, p.report.vz];
        anim = {
          walking: p.report.walking && p.dyingTimer <= 0,
          jumping: p.report.jumping && p.dyingTimer <= 0,
          dying: p.dyingTimer > 0,
          sprint: p.report.sprint && p.dyingTimer <= 0,
        };
      } else {
        const isWalking = Math.hypot(p.velX, p.velZ) > 0.01;
        x = body.position.x;
        y = body.position.y - height / 2;
        z = body.position.z;
        yaw = p.yaw;
        velocity = [body.velocity.x, body.velocity.y, body.velocity.z];
        anim = {
          walking: isWalking && p.dyingTimer <= 0,
          // v6.2.4: the LATCHED flag (see RuntimePlayer.airborneFromJump). The
          // old velocity-y > 0.5 test flipped false at the apex (landing cues
          // fired mid-air) and true again on the landing impact spike (the
          // "jump animation and sound play twice" bug).
          jumping: p.dyingTimer <= 0 && p.airborneFromJump,
          dying: p.dyingTimer > 0,
          sprint: isWalking && p.input.sprint,
        };
      }
      const hp = Math.round(p.hp);
      const prev = lastPlayerBroadcast.get(p.socketId);
      const changed = !prev ||
        Math.abs(prev.x - x) > 0.01 ||
        Math.abs(prev.y - y) > 0.01 ||
        Math.abs(prev.z - z) > 0.01 ||
        Math.abs(prev.yaw - yaw) > 0.02 ||
        prev.hp !== hp ||
        prev.walking !== anim.walking ||
        prev.jumping !== anim.jumping ||
        prev.dying !== anim.dying ||
        prev.sprint !== anim.sprint;
      if (!keyframe && !changed) continue; // nothing new to say about them
      lastPlayerBroadcast.set(p.socketId, {
        x, y, z, yaw, hp,
        walking: anim.walking, jumping: anim.jumping, dying: anim.dying, sprint: anim.sprint,
      });
      playersOut.push({
        socketId: p.socketId,
        username: p.username,
        position: [x, y, z],
        rotation: [0, yaw, 0],
        // v6.2.8: the character's velocity (client-reported or simulated) -
        // used by the owner's drift valve for dead reckoning; harmless (and
        // ignored) everywhere else.
        velocity,
        anim,
        hp,
        dying: p.dyingTimer > 0,
      });
    }

    // Player positions (interest tests for parts).
    // v6.2.8: client-report mode centers interest on the REPORTED
    // positions (the ghost pills can lag them by dead-reckoning drift).
    const plX: number[] = [], plY: number[] = [], plZ: number[] = [];
    for (const p of players.values()) {
      if (PLAYER_MODE === 'client-report') {
        plX.push(p.report.x); plY.push(p.report.y); plZ.push(p.report.z);
      } else {
        const b = world.getNamedCharacterBody(p.socketId);
        if (b) { plX.push(b.position.x); plY.push(b.position.y); plZ.push(b.position.z); }
      }
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
    const objects = useStudioStore.getState().objects;
    // v6.2.7: part DELETIONS. The delta loop below only iterates what
    // EXISTS; ids that were in the last snapshot's object map but are gone
    // now were deleted since (void falls -> removeObject, rule
    // destroy_part, moderation clears). Clients do not simulate parts
    // anymore (v6.2.7 netcode), so without this list a deleted part would
    // freeze mid-air on every screen instead of disappearing. Computed
    // BEFORE the loop refreshes lastObjectsRef (which only ever adds or
    // updates entries, so the order is safe either way).
    const removedOut: string[] = [];
    if (lastObjectsRef) {
      for (const id of lastObjectsRef.keys()) {
        if (!objects.has(id)) removedOut.push(id);
      }
      // Drop them from the diff base so each deletion broadcasts EXACTLY
      // once (a lingering entry would re-fire on every later snapshot).
      for (const id of removedOut) lastObjectsRef.delete(id);
    }
    if (lastObjectsRef) {
      let budget = 200; // per-snapshot cap keeps huge rule storms bounded
      objects.forEach((obj: any, id: string) => {
        if (budget <= 0) return;
        if (!isPart(obj)) return;
        const prev = lastObjectsRef!.get(id);
        if (prev === obj) return;
        lastObjectsRef!.set(id, obj);
        if (ourSyncIds.has(id) && prev) {
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
      removedOut.length === 0 &&
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
      // v6.2.7: part ids deleted since the last snapshot (void falls,
      // rule destroys). Clients drop the part (mesh + collider + its
      // interpolation history) the moment this arrives.
      removed: removedOut,
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
