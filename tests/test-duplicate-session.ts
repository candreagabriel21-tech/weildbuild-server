// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.2 duplicate session guard test
// ═══════════════════════════════════════════════════════════════════
// The reported bug: joining the same game twice with the same account
// produced TWO bodies in the room (the second one often with a default
// avatar, the "naked clone"). The guard must:
//
//   1. REJECT a second ACTIVE session of the same account with
//      game:error { code: "duplicate_session" } + kick the newcomer.
//   2. Keep the first session playing (snapshots keep flowing to it).
//   3. Let a REFRESH race through: after the old socket dies without
//      game:leave, a new join with the same account is accepted (the
//      stale entry is evicted silently - players must never be locked
//      out of a game by their own dead connection).
//
// Usage: npx tsx tests/test-duplicate-session.ts

import assert from "node:assert";
import { createServer } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { io, Socket } from "socket.io-client";

// The jwt module reads AUTH_SECRET at import time - set the env BEFORE
// the dynamic import below (same pattern as test-netcode-e2e).
let signSessionToken: (u: string) => Promise<string>;

const GAMEHOST_PORT = 3906;
const STUB_MAIN_PORT = 3907;
const AUTH_SECRET = "test-secret-duplicate-session";
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
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {}, avatar: {},
  worldSettings: { maxPlayers: 10, gravity: -35 },
  physicsSettings: { gravity: -35 },
};

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

/** Pre-attachable disconnect promise: the gamehost emits game:error and
 * disconnects back-to-back, so both events can arrive in the SAME frame -
 * a waitEvent-style listener attached only AFTER awaiting the error would
 * miss the disconnect entirely (the race that made this test flake). */
function recordDisconnect(s: Socket): Promise<void> {
  return new Promise((resolve) => { s.once('disconnect', () => resolve()); });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms)),
  ]);
}

async function main() {
  ({ signSessionToken } = await import("../src/shared/jwt"));

  // ── 1. Stub Main ──
  const gameRow = {
    id: 'dupgame1', name: 'Duplicate Session Test', description: '', creator: 'e2e',
    plays: 0, max_players: 10, multiplayer: true, studioState,
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
      HOST_ID: 'dup-host',
      HOST_LABEL: 'Dup Host',
      MAX_INSTANCES: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hostLog = '';
  gamehost.stdout!.on('data', (d) => { hostLog += d.toString(); });
  gamehost.stderr!.on('data', (d) => { hostLog += d.toString(); });

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
    // ── 3. Create an instance ──
    const createRes = await fetch(`http://localhost:${GAMEHOST_PORT}/internal/instances`, {
      method: 'POST',
      headers: { 'x-internal-token': INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'dupgame1', maxPlayers: 10 }),
    });
    assert.ok(createRes.status === 200 || createRes.status === 201, 'instance creation accepted');
    const { instanceId } = (await createRes.json()) as { instanceId: string };
    console.log(`✓ instance created: ${instanceId}`);

    // ── 4. First Alice joins and becomes ACTIVE (sends input) ──
    const alice1: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Alice') }, reconnection: false,
    });
    const alice1Error: any[] = [];
    alice1.on('game:error', (e: any) => { alice1Error.push(e); });
    alice1.emit('game:join', { instanceId, gameId: 'dupgame1', username: 'Alice', avatar: {} });
    const roster1: any = await waitEvent(alice1, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice'));
    assert.equal(roster1.length, 1, 'exactly one Alice in the room after the first join');
    console.log('✓ first Alice joined');

    // Mark her ACTIVE: input packets refresh the socket liveness stamp.
    const keepAlive = setInterval(() => {
      alice1.emit('game:input', { instanceId, x: 0, z: 0, jump: false, sprint: false, yaw: 0 });
    }, 100);
    await sleep(400);

    // ── 5. Second Alice joins the SAME instance with the SAME account ──
    const alice2: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Alice') }, reconnection: false,
    });
    // Pre-attach BEFORE the join lands (see recordDisconnect).
    const alice2Gone = recordDisconnect(alice2);
    alice2.emit('game:join', { instanceId, gameId: 'dupgame1', username: 'Alice', avatar: {} });
    const dupErr: any = await waitEvent(alice2, 'game:error', (m: any) => m?.code === 'duplicate_session', 10000);
    assert.ok(
      typeof dupErr.message === 'string' && dupErr.message.length > 0,
      'the duplicate warning carries a readable message',
    );
    // No hyphens or em dashes in any UI-facing message (user requirement).
    assert.ok(!/[-—–]/.test(dupErr.message), `warning must not contain dashes (got "${dupErr.message}")`);
    await withTimeout(alice2Gone, 8000, 'disconnect');
    console.log(`✓ duplicate join REJECTED + kicked: "${dupErr.message}"`);

    // ── 6. The FIRST Alice keeps playing ──
    // (No new game:players is expected: the rejected join never entered
    // the roster, so the roster broadcast from step 4 is still the truth.)
    const stillPlaying: any = await waitEvent(alice1, 'game:state', (m: any) =>
      Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 10000);
    assert.ok(stillPlaying, 'first Alice still receives snapshots');
    assert.equal(alice1Error.length, 0, 'the surviving session got no error');
    console.log('✓ the original session is untouched');

    // ── 7. Parked-tab takeover: alice1 stops playing (no input for 5s+)
    //    but keeps her socket open (a background tab). A fresh window with
    //    the same account TAKES OVER the slot; the parked one is kicked
    //    with the takeover warning.
    clearInterval(keepAlive);
    await sleep(5600); // > DUPLICATE_SILENCE_MS (5000)
    assert.ok(alice1.connected, 'parked alice still connected (background tab)');

    const alice3: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Alice') }, reconnection: false,
    });
    const alice3Error: any[] = [];
    alice3.on('game:error', (e: any) => { alice3Error.push(e); });
    // Pre-attach BEFORE the join lands (see recordDisconnect).
    const alice1Gone = recordDisconnect(alice1);
    alice3.emit('game:join', { instanceId, gameId: 'dupgame1', username: 'Alice', avatar: {} });

    // The parked session gets the takeover warning + kick...
    const takeoverErr: any = await waitEvent(alice1, 'game:error', (m: any) => m?.code === 'duplicate_session', 10000);
    assert.ok(
      typeof takeoverErr.message === 'string' && takeoverErr.message.length > 0,
      'the takeover warning carries a readable message',
    );
    assert.ok(!/[-—–]/.test(takeoverErr.message), `takeover warning must not contain dashes (got "${takeoverErr.message}")`);
    await withTimeout(alice1Gone, 8000, 'disconnect');
    console.log(`✓ parked session taken over + warned: "${takeoverErr.message}"`);

    // ...and the newcomer plays in her place.
    const roster3: any = await waitEvent(alice3, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice'), 10000).catch(() => null);
    assert.ok(roster3, 'the takeover join was accepted');
    assert.equal(roster3.length, 1, 'still exactly one Alice in the room');
    assert.equal(alice3Error.length, 0, 'the takeover session got no error');
    const snap3: any = await waitEvent(alice3, 'game:state', (m: any) =>
      Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 15000).catch(() => null);
    assert.ok(snap3, 'the takeover session gets snapshots');
    console.log('✓ takeover session is in the game');

    // ── 8. Refresh race: the takeover socket dies WITHOUT game:leave ──
    //    (page refresh). A brand new join with the same account must be
    //    accepted (stale eviction) - dead connections never lock the
    //    account out.
    alice3.disconnect();
    await sleep(600); // let the host process the disconnect

    const alice4: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Alice') }, reconnection: false,
    });
    const alice4Error: any[] = [];
    alice4.on('game:error', (e: any) => { alice4Error.push(e); });
    alice4.emit('game:join', { instanceId, gameId: 'dupgame1', username: 'Alice', avatar: {} });
    const roster4: any = await waitEvent(alice4, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice'), 10000).catch(() => null);
    assert.ok(roster4, 're-join after a dead connection is ACCEPTED (no lock-out)');
    assert.equal(roster4.length, 1, 'still exactly one Alice in the room');
    assert.equal(alice4Error.length, 0, 'the re-joining session got no error');
    const snap4: any = await waitEvent(alice4, 'game:state', (m: any) =>
      Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 15000).catch(() => null);
    assert.ok(snap4, 'the re-joined Alice gets snapshots again');
    console.log('✓ refresh race handled: dead sessions never lock the account out');

    alice4.disconnect();
    alice2.disconnect();
    alice1.disconnect();

    console.log('\n✓ duplicate session guard: ALL PASS');
  } finally {
    gamehost.kill('SIGTERM');
    await sleep(300);
    if (!gamehost.killed) gamehost.kill('SIGKILL');
    stubMain.close();
  }
}

main().catch((e) => {
  console.error('✗ duplicate session test failed:', e);
  process.exit(1);
});
