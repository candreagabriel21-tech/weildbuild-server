// ═══════════════════════════════════════════════════════════════════
// WeildBuild — SERVER-AUTHORITATIVE world runtime (v1.1)
// ═══════════════════════════════════════════════════════════════════
// Runs INSIDE A WORKER THREAD, one per game instance, on the gamehost.
// It loads the game's studio state, then runs THE SAME ENGINE THE CLIENT
// RUNS - imported directly from the platform source, bundled by esbuild:
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
//     { t: 'input', socketId, x, z, jump, sprint, yaw }
//     { t: 'click', socketId, partId }
//     { t: 'chat', username, message }        (Phase 5: chat rules)
//     { t: 'stop' }
//   ←  { t: 'ready' }
//     { t: 'snapshot', seq, players, parts, partUpdates, fx, messages }
//     { t: 'error', message }
//
// This file is NOT compiled by the server's tsc - scripts/build-world-
// runtime.mjs bundles it (and the platform sources it imports) with
// esbuild into dist/gamehost/world-runtime.bundle.js.

import { parentPort } from 'node:worker_threads';

// ─── Browser-API polyfills (BEFORE the platform imports) ───
// The WeildCode engine drives itself with requestAnimationFrame; in a
// worker we map that onto a ~60 Hz timer so its timers/waits/fades tick.
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

interface RuntimePlayer {
  socketId: string;
  username: string;
  input: { x: number; z: number; jump: boolean; sprint: boolean; yaw: number };
  hp: number;
  dyingTimer: number;   // > 0 while the death animation plays
  jumpCooldown: number;
  velX: number;         // smoothed horizontal velocity (prediction mirror)
  velZ: number;
  yaw: number;
  touched: Set<string>; // part ids currently touched (when_touched re-arm)
}

const SIM_HZ = 30;
const SNAPSHOT_HZ = 15;
const DEATH_ANIMATION_SECONDS = 0.9;

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
  const { useStudioStore, isPart } = await import('../../../../platform/src/lib/studio-store');
  const { restoreStudioState } = await import('../../../../platform/src/lib/studio-project');
  const { weildCodeEngine } = await import('../../../../platform/src/lib/weildcode-engine');
  const { PhysicsWorld } = await import('../../../../platform/src/lib/game-engine/physics');
  const { setSoundSink } = await import('../../../../platform/src/lib/sounds');
  const {
    stepHorizontalVelocity, applyJump,
    ACCEL_WALK, ACCEL_STOP, AIR_RELEASE_DECAY, AIR_MOVE_FACTOR,
  } = await import('../../../../platform/src/lib/game-engine/character-constants');

  type StudioPart = import('../../../../platform/src/lib/studio-store').StudioPart;

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
    world.addNamedCharacterBody(socketId, spawnSlot(joinCounter++), { size: rootSize, rotationDeg: rootRot });
    players.set(socketId, {
      socketId,
      username,
      input: { x: 0, z: 0, jump: false, sprint: false, yaw: 0 },
      hp: useStudioStore.getState().playState.characterMaxHealth || 100,
      dyingTimer: 0,
      jumpCooldown: 0,
      velX: 0,
      velZ: 0,
      yaw: rootRot?.y ? (rootRot.y * Math.PI) / 180 : 0,
      touched: new Set(),
    });
  }

  function removePlayer(socketId: string): void {
    world.removeNamedCharacterBody(socketId);
    players.delete(socketId);
  }

  function respawn(p: RuntimePlayer): void {
    world.teleportNamedCharacterBody(p.socketId, spawnFeet);
    p.hp = useStudioStore.getState().playState.characterMaxHealth || 100;
    p.velX = 0;
    p.velZ = 0;
    p.dyingTimer = 0;
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
    // Rule-driven player health (modify_player_health / kill_player /
    // heal_player) applies to every player in this MVP: the engine's
    // health model predates multiplayer.
    if (state.playState.characterHealth !== prev.playState.characterHealth) {
      const hp = Math.max(0, Math.min(state.playState.characterMaxHealth || 100, state.playState.characterHealth));
      for (const p of players.values()) p.hp = hp;
    }
    // Rule-driven teleports (teleport_player) move every player (same
    // MVP semantics as health).
    if (state.playState.teleportPosition && state.playState.teleportPosition !== prev.playState.teleportPosition) {
      const tp = state.playState.teleportPosition;
      for (const p of players.values()) {
        world.teleportNamedCharacterBody(p.socketId, { x: tp.x, y: tp.y, z: tp.z });
        p.velX = 0;
        p.velZ = 0;
      }
    }
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

  // ─── Input / click / chat from the host ───
  parentPort!.on('message', (m: any) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'playerJoin' && typeof m.socketId === 'string') {
      if (!players.has(m.socketId)) {
        const username = String(m.username || 'Player');
        addPlayer(m.socketId, username);
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
      const p = players.get(m.socketId);
      if (!p) return;
      // Sanitize: numbers only, direction clamped to unit length.
      let x = Number(m.x) || 0;
      let z = Number(m.z) || 0;
      const len = Math.hypot(x, z);
      if (len > 1) { x /= len; z /= len; }
      if (p.dyingTimer <= 0) {
        p.input = { x, z, jump: !!m.jump, sprint: !!m.sprint, yaw: Number(m.yaw) || 0 };
      }
    } else if (m.t === 'click' && typeof m.partId === 'string') {
      try { weildCodeEngine.handleClick(m.partId); } catch { /* rules must never kill the sim */ }
    } else if (m.t === 'chat' && typeof m.message === 'string') {
      // v1.5: game rules - on_chat_message (optional username/contains filters).
      try { weildCodeEngine.handleChatMessage(String(m.username || 'Player'), String(m.message)); } catch { /* never kill the sim */ }
    } else if (m.t === 'stop') {
      shutdown();
    }
  });

  // ─── The simulation loop ───
  let running = true;
  let seq = 0;
  let simAccum = 0;
  let snapAccum = 0;
  let lastTime = Date.now();
  const SIM_DT = 1 / SIM_HZ;

  function playerTouchChecks(): void {
    // when_touched('player'): fire on the parts each player overlaps,
    // once per contact (enter fires, leave re-arms) - the same semantics
    // as the client's collisionParts loop.
    const objects = useStudioStore.getState().objects;
    for (const p of players.values()) {
      const body = world.getNamedCharacterBody(p.socketId);
      if (!body) continue;
      const entry = (world as any).namedCharacters?.get(p.socketId);
      const height = entry?.height ?? 2;
      const halfW = Math.min(entry?.size?.x ?? 0.8, entry?.size?.z ?? 0.8) / 2;
      const stillTouched = new Set<string>();
      const newlyTouched: string[] = [];
      objects.forEach((obj: any) => {
        if (!isPart(obj) || !obj.canCollide || obj.showInWorld === false) return;
        const hw = obj.size.x / 2 + halfW + 0.1;
        const hd = obj.size.z / 2 + halfW + 0.1;
        if (Math.abs(obj.position.x - body.position.x) > hw) return;
        if (Math.abs(obj.position.z - body.position.z) > hd) return;
        const hh = obj.size.y / 2 + height / 2;
        if (Math.abs(obj.position.y - body.position.y) > hh) return;
        stillTouched.add(obj.id);
        if (!p.touched.has(obj.id)) newlyTouched.push(obj.id);
      });
      for (const id of newlyTouched) {
        try { weildCodeEngine.handleTouch(id, 'player'); } catch { /* never kill the sim */ }
      }
      p.touched = stillTouched;
    }
  }

  function stepSim(dt: number): void {
    // 1. Characters: input -> velocity -> cannon bodies (the client's
    //    movement math, from character-constants.ts).
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
      world.setNamedCharacterStanding(p.socketId, grounded && p.input.x === 0 && p.input.z === 0);

      // Smoothed target velocity (the client's two-stage ramp).
      const stepped = stepHorizontalVelocity(p.velX, p.velZ, p.input.x, p.input.z, p.input.sprint, grounded, dt);
      p.velX = stepped.velX;
      p.velZ = stepped.velZ;

      // Jump: honor the cooldown, scale horizontal (a hop, not a launch).
      if (p.input.jump) {
        p.input.jump = false;
        if (grounded && p.jumpCooldown <= 0) {
          const j = applyJump(body.velocity.x, body.velocity.y, body.velocity.z, p.jumpCooldown);
          if (j) {
            body.velocity.set(j.x, j.y, j.z);
            p.jumpCooldown = 0.5;
          }
        }
      }

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
      const body = world.getNamedCharacterBody(p.socketId);
      if (body && p.dyingTimer <= 0 && body.position.y < world.voidY) {
        p.hp = 0;
        p.dyingTimer = DEATH_ANIMATION_SECONDS;
      }
    }

    // 4. Player touch triggers (when_touched 'player').
    playerTouchChecks();

    // 5. Store sync for moving parts so rules read near-current values
    //    (the client does this at 4 Hz; the worker at ~7 Hz is plenty).
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
  }

  function buildSnapshot(): any {
    seq += 1;
    // Players: authoritative transforms for everyone.
    const playersOut: any[] = [];
    for (const p of players.values()) {
      const body = world.getNamedCharacterBody(p.socketId);
      if (!body) continue;
      const entry = (world as any).namedCharacters?.get(p.socketId);
      const height = entry?.height ?? 2;
      const isWalking = Math.hypot(p.velX, p.velZ) > 0.01;
      playersOut.push({
        socketId: p.socketId,
        username: p.username,
        position: [body.position.x, body.position.y - height / 2, body.position.z],
        rotation: [0, p.yaw, 0],
        anim: {
          walking: isWalking && p.dyingTimer <= 0,
          jumping: p.dyingTimer <= 0 && body.velocity.y > 0.5,
          dying: p.dyingTimer > 0,
          sprint: isWalking && p.input.sprint,
        },
        hp: Math.round(p.hp),
        dying: p.dyingTimer > 0,
      });
    }

    // Changed part transforms since the last broadcast.
    const parts: any[] = [];
    for (const id of activeIds) {
      const pb = world.bodies.get(id);
      if (!pb || pb.anchored) continue;
      const prev = lastBroadcast.get(id);
      if (
        !prev ||
        Math.abs(prev.x - pb.position.x) > 0.01 ||
        Math.abs(prev.y - pb.position.y) > 0.01 ||
        Math.abs(prev.z - pb.position.z) > 0.01 ||
        Math.abs(prev.rx - pb.rotation.x) > 0.5 ||
        Math.abs(prev.ry - pb.rotation.y) > 0.5 ||
        Math.abs(prev.rz - pb.rotation.z) > 0.5
      ) {
        parts.push({
          id,
          x: pb.position.x, y: pb.position.y, z: pb.position.z,
          rx: pb.rotation.x, ry: pb.rotation.y, rz: pb.rotation.z,
        });
        lastBroadcast.set(id, { x: pb.position.x, y: pb.position.y, z: pb.position.z, rx: pb.rotation.x, ry: pb.rotation.y, rz: pb.rotation.z });
      }
    }

    // Rule-driven full part updates (color/size/transparency/...).
    const objects = useStudioStore.getState().objects;
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
      post(buildSnapshot());
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
