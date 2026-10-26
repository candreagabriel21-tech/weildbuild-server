// ═══════════════════════════════════════════════════════════════════
// WeildBuild — SERVER-AUTHORITATIVE MULTIPLAYER E2E (v1.1)
// ═══════════════════════════════════════════════════════════════════
// Full-stack netcode test against the REAL gamehost process:
//
//   stub Main (serves the game's encrypted world)  ←  gamehost  ←  2
//   socket.io clients (Alice + Bob) trading game:input for game:state.
//
// Verifies the complete authority loop:
//   ticket auth → game:join → instance sim boot (world fetch + decrypt +
//   worker) → input → server-side movement/jump physics → snapshots
//   broadcast to the room → legacy game:move ignored while a sim lives.
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
    { id: 'root', name: 'CharacterRoot', type: 'Block',
      position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.2, y: 3, z: 1.2 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isCharacterRoot: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    { id: 'ball', name: 'Boulder', type: 'Sphere',
      position: { x: 4, y: 12, z: 4 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#f24b4b', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: false, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {}, avatar: {},
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

  // ── 1. Stub Main: serves the game (encrypted world) + host registration ──
  const worldB64 = bufferToBase64(encryptWbworldPayload({
    format: 'wbworld', version: 1, name: 'Netcode E2E', description: '',
    multiplayer: true, max_players: 10, spawn_point: [0, 0, 0],
    studioState, exportedAt: new Date().toISOString(), exportedBy: 'e2e',
  }));
  const gameRow = {
    id: 'e2egame1', name: 'Netcode E2E', description: '', creator: 'e2e',
    plays: 0, max_players: 10, multiplayer: true, world_b64: worldB64,
  };
  const stubMain = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${STUB_MAIN_PORT}`);
    if (url.pathname === '/api/games' && url.searchParams.get('id')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(gameRow));
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

    // ── 4. Two clients join with real signed tickets ──
    const ticketA = await signSessionToken('Alice');
    const ticketB = await signSessionToken('Bob');
    const alice: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: ticketA }, reconnection: false,
    });
    const bob: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: ticketB }, reconnection: false,
    });

    alice.on('game:error', (e: any) => { throw new Error(`alice game:error: ${e?.message}`); });
    bob.on('game:error', (e: any) => { throw new Error(`bob game:error: ${e?.message}`); });

    alice.emit('game:join', { instanceId, gameId: 'e2egame1', username: 'Alice', avatar: {} });
    bob.emit('game:join', { instanceId, gameId: 'e2egame1', username: 'Bob', avatar: {} });
    const playersA: any = await waitEvent(alice, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice'));
    assert.ok(playersA.length >= 1, 'alice sees herself in the player list');
    const both: any = await waitEvent(alice, 'game:players', (m: any) => m.some((p: any) => p.username === 'Bob'));
    assert.equal(both.length, 2, 'both players in the room list');
    console.log('✓ ticket auth + game:join + player roster');

    // ── 5. The authoritative sim boots: game:state snapshots arrive ──
    const snap1: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players) && m.players.length >= 2, 30000);
    const a = snap1.players.find((p: any) => p.username === 'Alice');
    const b = snap1.players.find((p: any) => p.username === 'Bob');
    assert.ok(a && b, 'snapshot carries both players');
    assert.equal(a.hp, 100, 'full health');
    console.log('✓ game:state snapshots flowing (sim booted from the encrypted world)');

    // Bob must ALSO receive snapshots (room broadcast)
    const bobSnap: any = await waitEvent(bob, 'game:state', (m: any) => Array.isArray(m.players) && m.players.length >= 2, 10000);
    assert.ok(bobSnap.players.some((p: any) => p.username === 'Alice'), 'bob sees alice in snapshots');
    console.log('✓ snapshots broadcast to the whole room');

    // ── 6. The unanchored boulder falls server-side (physics for everyone) ──
    const fell = await waitEvent(alice, 'game:state', (m: any) => (m.parts || []).some((p: any) => p.id === 'ball' && p.y < 6), 15000).catch(() => null);
    assert.ok(fell, 'the boulder fell in the authoritative physics');
    console.log('✓ world physics simulated server-side (boulder fell)');

    // ── 7. Alice walks: input -> server movement -> snapshots ──
    const startX = a.position[0];
    const walk = setInterval(() => {
      alice.emit('game:input', { instanceId, x: 1, z: 0, jump: false, sprint: false, yaw: 0 });
    }, 50);
    const moved = await waitEvent(alice, 'game:state',
      (m: any) => m.players?.some((p: any) => p.username === 'Alice' && p.position[0] > startX + 1), 8000).catch(() => null);
    clearInterval(walk);
    alice.emit('game:input', { instanceId, x: 0, z: 0, jump: false, sprint: false, yaw: 0 });
    assert.ok(moved, `alice moved +X server-side (${startX.toFixed(2)} -> ?)`);
    const aMoved = moved.players.find((p: any) => p.username === 'Alice');
    console.log(`✓ movement authority: Alice ${startX.toFixed(2)} -> ${aMoved.position[0].toFixed(2)}`);

    // Bob sees Alice move in HIS snapshots too
    const bobSees = await waitEvent(bob, 'game:state',
      (m: any) => m.players?.some((p: any) => p.username === 'Alice' && p.position[0] > startX + 1), 8000).catch(() => null);
    assert.ok(bobSees, 'bob observed alice moving');
    console.log('✓ bob observed alice moving');

    // ── 8. Alice jumps ──
    alice.emit('game:input', { instanceId, x: 0, z: 0, jump: true, sprint: false, yaw: 0 });
    const jumped = await waitEvent(alice, 'game:state',
      (m: any) => m.players?.some((p: any) => p.username === 'Alice' && p.position[1] > 0.8), 8000).catch(() => null);
    assert.ok(jumped, 'jump went airborne');
    console.log('✓ jump authority');

    // ── 9. Legacy game:move is IGNORED while a sim lives (anti-cheat) ──
    const beforeMove: any = await waitEvent(alice, 'game:state', (m: any) => true, 5000);
    const axBefore = beforeMove.players.find((p: any) => p.username === 'Alice').position[0];
    alice.emit('game:move', { instanceId, position: [axBefore + 500, 0, 0], rotation: [0, 0, 0] });
    await sleep(400);
    const afterMove: any = await waitEvent(alice, 'game:state', (m: any) => true, 5000);
    const axAfter = afterMove.players.find((p: any) => p.username === 'Alice').position[0];
    assert.ok(Math.abs(axAfter - axBefore) < 50, `game:move ignored (x ${axBefore.toFixed(1)} -> ${axAfter.toFixed(1)})`);
    console.log('✓ legacy game:move (client-claimed position) rejected by the authority');

    // ── 10. Leave: player leaves the sim and the roster ──
    bob.emit('game:leave', { instanceId });
    const left = await waitEvent(alice, 'game:playerLeft', (m: any) => m.username === 'Bob', 8000).catch(() => null);
    assert.ok(left, 'game:playerLeft fired');
    const noBob = await waitEvent(alice, 'game:state',
      (m: any) => Array.isArray(m.players) && !m.players.some((p: any) => p.username === 'Bob'), 8000).catch(() => null);
    assert.ok(noBob, 'bob gone from snapshots');
    console.log('✓ leave lifecycle');

    alice.disconnect();
    bob.disconnect();
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
