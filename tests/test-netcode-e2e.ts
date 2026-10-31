// ═══════════════════════════════════════════════════════════════════
// WeildBuild, ROBLOX-STYLE MULTIPLAYER E2E (v6.2.6)
// ═══════════════════════════════════════════════════════════════════
// Full-stack netcode test against the REAL gamehost process:
//
//   stub Main (serves the game's world)  ←  gamehost  ←  socket.io
//   clients (Alice + Bob + Carol) trading 0.25 s game:pstate reports
//   for game:state relays.
//
// Verifies the complete v6.2.6 flow:
//   ticket auth → game:join → instance sim boot → spawn-slot tp flags →
//   game:syncWorld: FRESH instance answers "skip", a LIVED-IN instance
//   streams the live world state (settled physics, joints, variables) →
//   pstate reports relayed to the room (Roblox-style client ownership) →
//   light checks reject impossible report jumps → legacy game:move still
//   ignored while a sim lives.
//
// Usage: npx tsx tests/test-netcode-e2e.ts

import assert from "node:assert";
import { createServer } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { io, Socket } from "socket.io-client";
import { encryptWbworldPayload, bufferToBase64 } from "../src/shared/wbworld";

// The jwt module reads AUTH_SECRET at import time - the env must be set
// BEFORE the (dynamic) import below. The gamehost subprocess receives the
// same secret through its spawn env.
let signSessionToken: (u: string) => Promise<string>;

const GAMEHOST_PORT = 3904;
const STUB_MAIN_PORT = 3905;
const AUTH_SECRET = "test-secret-netcode-e2e";
const INTERNAL_TOKEN = "test-internal-token";

const studioState = {
  objects: [
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 200, y: 1, z: 200 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // v1.3 (CharacterRoot removed): a Spawn part drives the spawn point.
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    { id: 'ball', name: 'Boulder', type: 'Sphere',
      position: { x: 4, y: 12, z: 4 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#f24b4b', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: false, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: { score: 7 }, avatar: {},
  worldSettings: { maxPlayers: 10, gravity: -35 },
  physicsSettings: { gravity: -35 },
};

// The jwt module reads AUTH_SECRET at import time - set it before the
// dynamic import inside main(). The gamehost subprocess gets the same
// secret through its spawn env.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || AUTH_SECRET;

function waitEvent<T = any>(emitter: any, event: string, predicate: (m: any) => boolean = () => true, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    const handler = (m: any) => {
      if (predicate(m)) {
        clearTimeout(timer);
        emitter.off(event, handler);
        resolve(m);
      }
    };
    emitter.on(event, handler);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // jwt import AFTER AUTH_SECRET is in the env (it reads at module load).
  ({ signSessionToken } = await import("../src/shared/jwt"));

  // ── 1. Stub Main: serves the game (v2.0 PLAIN studioState + a legacy
  //    encrypted world_b64 row) + host registration ──
  const gameRow = {
    id: 'e2egame1', name: 'Netcode E2E', description: '', creator: 'e2e',
    plays: 0, max_players: 10, multiplayer: true, studioState,
  };
  // v1.x row (pre-migration): the gamehost must still decrypt it.
  const legacyWorldB64 = bufferToBase64(encryptWbworldPayload({
    format: 'wbworld', version: 1, name: 'Netcode Legacy', description: '',
    multiplayer: true, max_players: 10, spawn_point: [0, 0, 0],
    studioState, exportedAt: new Date().toISOString(), exportedBy: 'e2e',
  }));
  const legacyRow = {
    id: 'e2egame2', name: 'Netcode Legacy', description: '', creator: 'e2e',
    plays: 0, max_players: 10, multiplayer: true, world_b64: legacyWorldB64,
  };
  const stubMain = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${STUB_MAIN_PORT}`);
    if (url.pathname === '/api/games' && url.searchParams.get('id')) {
      const row = url.searchParams.get('id') === 'e2egame2' ? legacyRow : gameRow;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(row));
      return;
    }
    if (url.pathname === '/internal/hosts/register' || url.pathname === '/internal/hosts/heartbeat') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => stubMain.listen(STUB_MAIN_PORT, r));
  console.log(`✓ stub Main listening on :${STUB_MAIN_PORT}`);

  // ── 2. Boot the REAL gamehost (compiled dist) ──
  const gamehost = spawn('node', [join(__dirname, '..', 'dist', 'gamehost', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(GAMEHOST_PORT),
      AUTH_SECRET,
      INTERNAL_TOKEN,
      MAIN_SERVER_URL: `http://localhost:${STUB_MAIN_PORT}`,
      HOST_ID: 'e2e-host',
      HOST_LABEL: 'E2E Host',
      MAX_INSTANCES: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hostLog = '';
  gamehost.stdout!.on('data', (d) => { hostLog += d.toString(); });
  gamehost.stderr!.on('data', (d) => { hostLog += d.toString(); });

  // Wait for the port to accept TCP connections (simple connect probe)
  const { createConnection } = await import('node:net');
  const canConnect = () => new Promise<boolean>((r) => {
    const sock = createConnection({ port: GAMEHOST_PORT, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); r(true); });
    sock.once('error', () => { sock.destroy(); r(false); });
  });
  let hostUp = false;
  for (let i = 0; i < 60 && !hostUp; i++) {
    await sleep(500);
    hostUp = await canConnect();
  }
  assert.ok(hostUp, `gamehost did not start. Log:\n${hostLog}`);
  console.log(`✓ gamehost listening on :${GAMEHOST_PORT}`);

  try {
    // ── 3. Create an instance the way Main does ──
    const createRes = await fetch(`http://localhost:${GAMEHOST_PORT}/internal/instances`, {
      method: 'POST',
      headers: { 'x-internal-token': INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'e2egame1', maxPlayers: 10 }),
    });
    assert.ok(createRes.status === 200 || createRes.status === 201, 'instance creation accepted');
    const { instanceId } = (await createRes.json()) as { instanceId: string };
    assert.ok(instanceId, 'instanceId returned');
    console.log(`✓ instance created: ${instanceId}`);

    // ── 4. Alice joins the FRESH instance with a real signed ticket ──
    const ticketA = await signSessionToken('Alice');
    const alice: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: ticketA }, reconnection: false,
    });
    alice.on('game:error', (e: any) => { throw new Error(`alice game:error: ${e?.message}`); });

    alice.emit('game:join', { instanceId, gameId: 'e2egame1', username: 'Alice', avatar: {} });
    const playersA: any = await waitEvent(alice, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice'));
    assert.ok(playersA.length >= 1, 'alice sees herself in the player list');
    console.log('✓ ticket auth + game:join + player roster');

    // ── 5. FRESH instance: game:syncWorld answers "skip" (nothing to sync
    //    - the published studio state IS the truth) ──
    alice.emit('game:syncWorld', {});
    const freshSync: any = await waitEvent(alice, 'game:worldState', (m: any) => m?.fresh === true, 10000);
    assert.ok(freshSync, 'a fresh instance answers game:worldState {fresh: true}');
    console.log('✓ fresh instance: world sync skipped (published state is the truth)');

    // ── 6. The authoritative sim boots: game:state snapshots arrive, and
    //    Alice's first entry carries the spawn-slot tp flag ──
    const snap1: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 30000);
    const a = snap1.players.find((p: any) => p.username === 'Alice');
    assert.equal(a.hp, 100, 'full health');
    assert.ok(a.tp === 1, "the joiner's first entry is tp-flagged (the local body teleports to its spawn slot)");
    console.log('✓ game:state snapshots flowing + spawn-slot tp flag');

    // ── 7. The unanchored boulder falls server-side (physics for everyone) ──
    const fell = await waitEvent(alice, 'game:state', (m: any) => (m.parts || []).some((p: any) => p.id === 'ball' && p.y < 6), 15000).catch(() => null);
    assert.ok(fell, 'the boulder fell in the authoritative physics');
    console.log('✓ world physics simulated server-side (boulder fell)');

    // ── 8. Bob joins the LIVED-IN instance and asks for the world state:
    //    he gets the SETTLED boulder position + joints + rule variables,
    //    not the published snapshot ──
    const ticketB = await signSessionToken('Bob');
    const bob: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: ticketB }, reconnection: false,
    });
    bob.on('game:error', (e: any) => { throw new Error(`bob game:error: ${e?.message}`); });
    bob.emit('game:join', { instanceId, gameId: 'e2egame1', username: 'Bob', avatar: {} });
    await waitEvent(bob, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice') && m.some((p: any) => p.username === 'Bob'));

    // Let the boulder fully settle before the sync ask.
    await waitEvent(alice, 'game:state', (m: any) => (m.parts || []).some((p: any) => p.id === 'ball' && p.y <= 1.05), 15000).catch(() => null);
    bob.emit('game:syncWorld', {});
    const syncedParts: any[] = [];
    let syncedJoints: any[] | undefined;
    let syncedVars: Record<string, unknown> | undefined;
    let syncDone = false;
    while (!syncDone) {
      const chunk: any = await waitEvent(bob, 'game:worldState', (m: any) => m && typeof m === 'object' && !m.fresh, 15000);
      if (Array.isArray(chunk.objects)) syncedParts.push(...chunk.objects);
      if (Array.isArray(chunk.joints)) syncedJoints = chunk.joints;
      if (chunk.globalVariables && typeof chunk.globalVariables === 'object') syncedVars = chunk.globalVariables;
      if (chunk.done) syncDone = true;
    }
    assert.ok(syncedParts.length >= 2, `the lived-in sync carries the world parts (got ${syncedParts.length})`);
    const syncedBall = syncedParts.find((o: any) => o.id === 'ball');
    assert.ok(syncedBall, 'the boulder record is in the sync');
    assert.ok(syncedBall.position.y <= 1.05,
      `the sync carries the SETTLED boulder position (y=${syncedBall.position.y.toFixed(2)}, published was 12)`);
    assert.ok(!syncedParts.some((o: any) => o.id === 'root'), 'character parts are excluded from the sync');
    assert.ok(syncedVars && (syncedVars as any).score === 7, 'rule variables ride the sync');
    console.log(`✓ lived-in sync: ${syncedParts.length} parts, boulder settled at y=${syncedBall.position.y.toFixed(2)}, variables included`);

    // ── 9. Alice walks: her client reports (0.25 s cadence) -> relays ──
    const startX = a.position[0];
    let reportX = startX;
    const walk = setInterval(() => {
      reportX += 1.4;
      alice.emit('game:pstate', { instanceId, x: reportX, y: 0, z: 0, yaw: 0, walking: true, jumping: false, sprint: false });
    }, 100);
    const moved = await waitEvent(alice, 'game:state',
      (m: any) => m.players?.some((p: any) => p.username === 'Alice' && p.position[0] > startX + 2), 8000).catch(() => null);
    clearInterval(walk);
    assert.ok(moved, `alice's reports were relayed (${startX.toFixed(2)} -> ?)`);
    const aMoved = moved.players.find((p: any) => p.username === 'Alice');
    assert.strictEqual(aMoved.anim.walking, true, 'the walking flag rides the relay');
    console.log(`✓ client ownership: Alice's pstate reports relayed (${startX.toFixed(2)} -> ${aMoved.position[0].toFixed(2)}), anim.walking = true`);

    // Bob sees Alice move in HIS snapshots too
    const bobSees = await waitEvent(bob, 'game:state',
      (m: any) => m.players?.some((p: any) => p.username === 'Alice' && p.position[0] > startX + 2), 8000).catch(() => null);
    assert.ok(bobSees, 'bob observed alice moving');
    console.log('✓ bob observed alice moving');

    // ── 10. LIGHT CHECK: an impossible 600-stud report is rejected ──
    const beforeAttack: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 5000);
    const axBefore = beforeAttack.players.find((p: any) => p.username === 'Alice').position[0];
    alice.emit('game:pstate', { instanceId, x: axBefore + 600, y: 0, z: 0, yaw: 0, walking: false, jumping: false, sprint: false });
    await sleep(400);
    const afterAttack: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 8000);
    const axAfter = afterAttack.players.find((p: any) => p.username === 'Alice').position[0];
    assert.ok(Math.abs(axAfter - axBefore) < 50, `the 600-stud report was rejected (x ${axBefore.toFixed(1)} -> ${axAfter.toFixed(1)})`);
    console.log('✓ light check: a 600-stud report jump rejected by the authority');

    // ── 11. Legacy game:move is IGNORED while a sim lives (anti-cheat) ──
    alice.emit('game:move', { instanceId, position: [axBefore + 500, 0, 0], rotation: [0, 0, 0] });
    await sleep(400);
    const afterMove: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 8000);
    const axAfterMove = afterMove.players.find((p: any) => p.username === 'Alice').position[0];
    assert.ok(Math.abs(axAfterMove - axAfter) < 50, `game:move ignored (x ${axAfter.toFixed(1)} -> ${axAfterMove.toFixed(1)})`);
    console.log('✓ legacy game:move (client-claimed position) rejected by the authority');

    // ── 12. Leave: player leaves the sim and the roster ──
    bob.emit('game:leave', { instanceId });
    const left = await waitEvent(alice, 'game:playerLeft', (m: any) => m.username === 'Bob', 8000).catch(() => null);
    assert.ok(left, 'game:playerLeft fired');
    const noBob = await waitEvent(alice, 'game:state',
      (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice') && !m.players.some((p: any) => p.username === 'Bob'), 8000).catch(() => null);
    assert.ok(noBob, 'bob gone from snapshots');
    console.log('✓ leave lifecycle');

    alice.disconnect();
    bob.disconnect();

    // ── 13. v1.x legacy row (encrypted world_b64) still boots a sim ──
    const legacyRes = await fetch(`http://localhost:${GAMEHOST_PORT}/internal/instances`, {
      method: 'POST',
      headers: { 'x-internal-token': INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'e2egame2', maxPlayers: 4 }),
    });
    assert.ok(legacyRes.status === 200 || legacyRes.status === 201, 'legacy instance creation accepted');
    const { instanceId: legacyInstanceId } = (await legacyRes.json()) as { instanceId: string };
    const carol: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Carol') }, reconnection: false,
    });
    carol.on('game:error', (e: any) => { throw new Error(`carol game:error: ${e?.message}`); });
    carol.emit('game:join', { instanceId: legacyInstanceId, gameId: 'e2egame2', username: 'Carol', avatar: {} });
    const legacySnap: any = await waitEvent(carol, 'game:state', (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Carol'), 30000).catch(() => null);
    assert.ok(legacySnap, 'legacy encrypted world decrypted + simulated (snapshot received)');
    const legacyFell = await waitEvent(carol, 'game:state', (m: any) => (m.parts || []).some((p: any) => p.id === 'ball' && p.y < 6), 15000).catch(() => null);
    assert.ok(legacyFell, 'legacy world physics runs (boulder fell)');
    carol.emit('game:leave', { instanceId: legacyInstanceId });
    carol.disconnect();
    console.log('✓ legacy encrypted world_b64 row: decrypt fallback + sim boot');

    console.log('\n✓ netcode E2E: ALL PASS');
  } finally {
    gamehost.kill('SIGTERM');
    await sleep(300);
    if (!gamehost.killed) gamehost.kill('SIGKILL');
    stubMain.close();
  }
}

main().catch((e) => {
  console.error('✗ netcode E2E failed:', e);
  process.exit(1);
});
