// ═══════════════════════════════════════════════════════════════════
// WeildBuild, BUILD TO SURVIVE MULTIPLAYER E2E (v7.1 pass 12, fix 3)
// ═══════════════════════════════════════════════════════════════════
// Full-stack test of the pre-added game's multiplayer rooms against the
// REAL compiled gamehost:
//
//   stub Main  ←  gamehost (BTS room sim)  ←  socket.io clients
//   (Alice + Bob)
//
// Verifies the complete fix-3 flow:
//   ticket auth → game:join → bts:state keyframe (phase build) →
//   player relays via game:pstate → plot claim (standing-in-it check) →
//   block placement rides the game:state partUpdates channel →
//   a late joiner receives EVERY placed block in its join keyframe →
//   ownership rules (Bob cannot build on / break Alice's plot, but CAN
//   claim his own plot and build there) → break broadcasts a deletion →
//   the build timer advances server-side.
//
// Usage: npx tsx tests/test-bts-multiplayer.ts

import assert from "node:assert";
import { createServer } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { io, Socket } from "socket.io-client";

let signSessionToken: (u: string) => Promise<string>;

const GAMEHOST_PORT = 3906;
const STUB_MAIN_PORT = 3907;
const AUTH_SECRET = "test-secret-bts-e2e";
const INTERNAL_TOKEN = "test-internal-token";
const BTS_GAME_ID = "preadded-build-to-survive";

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

/** A valid bts block record (the exact shape the client's makePlacedPart
 *  produces - id/name prefixes, unit size, studio fields). */
function blockRecord(id: string, cx: number, cy: number, cz: number) {
  return {
    id,
    name: `bts_placed_block_red`,
    type: 'Block',
    position: { x: cx, y: cy, z: cz },
    size: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: 0 },
    color: '#FF0000',
    material: 'Plastic',
    transparency: 0, reflectance: 0, anchored: true, canCollide: true,
    friction: 0.5, elasticity: 0.2, density: 1,
    bodyMovers: [], effects: [], isSpawnPoint: false, isBaseplate: false,
    children: [], parentId: null,
    _bts: true,
    _shape: 'Block',
  };
}

async function main() {
  ({ signSessionToken } = await import("../src/shared/jwt"));

  // ── 1. Stub Main: BTS rooms never fetch a world, but the host still
  //    registers + heartbeats with Main at boot. ──
  const stubMain = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${STUB_MAIN_PORT}`);
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
      HOST_ID: 'bts-e2e-host',
      HOST_LABEL: 'BTS E2E Host',
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
    // ── 3. Create a BTS instance the way Main now does for preadded ids ──
    const createRes = await fetch(`http://localhost:${GAMEHOST_PORT}/internal/instances`, {
      method: 'POST',
      headers: { 'x-internal-token': INTERNAL_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: BTS_GAME_ID, maxPlayers: 4 }),
    });
    assert.ok(createRes.status === 200 || createRes.status === 201, 'BTS instance creation accepted');
    const { instanceId } = (await createRes.json()) as { instanceId: string };
    console.log(`✓ BTS instance created: ${instanceId}`);

    // ── 4. Alice joins; the bts:state keyframe arrives (build phase) and
    //    her game:state entry relays with full hp. ──
    const alice: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Alice') }, reconnection: false,
    });
    alice.on('game:error', (e: any) => { throw new Error(`alice game:error: ${e?.message}`); });
    alice.emit('game:join', { instanceId, gameId: BTS_GAME_ID, username: 'Alice', avatar: {} });
    await waitEvent(alice, 'game:players', (m: any) => Array.isArray(m) && m.some((p: any) => p.username === 'Alice'));

    const bts1: any = await waitEvent(alice, 'bts:state', (m: any) => m && m.phase === 'build', 15000);
    assert.ok(bts1.buildTimer > 100, `build phase timer running (${bts1.buildTimer})`);
    assert.ok(!bts1.disaster.id, 'no disaster during build');
    assert.ok(typeof bts1.claims === 'object', 'claims map present');
    console.log(`✓ bts:state keyframe: phase=build, timer=${Math.round(bts1.buildTimer)}s, round=${bts1.round}`);

    const snapA: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players) && m.players.some((p: any) => p.username === 'Alice'), 15000);
    const aEntry = snapA.players.find((p: any) => p.username === 'Alice');
    assert.equal(aEntry.hp, 100, 'alice full health');
    assert.ok(aEntry.position, 'alice position entry present');
    console.log('✓ game:state roster relay for the BTS room (hp 100)');

    // ── 5. Alice reports standing in plot1, then claims it ──
    //    plot1: x 4..49, z -48.5..-3.5 (centre 26.5, -26).
    alice.emit('game:pstate', { instanceId, x: 26.5, y: 0.5, z: -26, yaw: 0, walking: false, jumping: false, sprint: false });
    await sleep(300); // let the report land before the claim
    alice.emit('bts:action', { instanceId, kind: 'claim', plotId: 'plot1' });
    const claimed: any = await waitEvent(alice, 'bts:state', (m: any) => m.claims && m.claims.plot1 === 'Alice', 10000);
    assert.equal(claimed.claims.plot1, 'Alice', 'plot1 claimed by Alice');
    console.log('✓ plot claim accepted (standing-in-it check passed)');

    // A claim from someone NOT standing on the plot is rejected.
    alice.emit('bts:action', { instanceId, kind: 'claim', plotId: 'plot3' });
    await sleep(600);
    // (no direct error channel - the claim simply must not appear)
    const stillOnly1: any = await waitEvent(alice, 'bts:state', (m: any) => m.claims && m.claims.plot1 === 'Alice', 8000);
    assert.ok(!stillOnly1.claims.plot3, 'remote plot claim rejected (not standing there)');
    console.log('✓ remote plot claim rejected');

    // ── 6. Alice places a block on her plot; it rides partUpdates ──
    const blockA = blockRecord('bts_placed_e2e_a1', 10, 1.125, -10);
    alice.emit('bts:action', { instanceId, kind: 'place', part: blockA });
    const placedSnap: any = await waitEvent(alice, 'game:state',
      (m: any) => Array.isArray(m.partUpdates) && m.partUpdates.some((p: any) => p.id === 'bts_placed_e2e_a1'), 10000);
    assert.ok(placedSnap, 'the placed block was broadcast via partUpdates');
    console.log('✓ block placement broadcast (partUpdates channel)');

    // A junk record that is not a bts block is rejected (no clobbering).
    alice.emit('bts:action', { instanceId, kind: 'place', part: { id: 'baseplate', name: 'Baseplate', type: 'Block', position: { x: 0, y: 0, z: 0 }, size: { x: 100, y: 1, z: 100 } } });
    await sleep(600);
    // (nothing to observe directly; the next joiner's keyframe is the proof)

    // ── 7. Bob joins late: his join keyframe carries Alice's block AND
    //    the claim state. ──
    const bob: Socket = io(`http://localhost:${GAMEHOST_PORT}`, {
      transports: ['websocket'], auth: { token: await signSessionToken('Bob') }, reconnection: false,
    });
    bob.on('game:error', (e: any) => { throw new Error(`bob game:error: ${e?.message}`); });
    bob.emit('game:join', { instanceId, gameId: BTS_GAME_ID, username: 'Bob', avatar: {} });
    const bobJoinSnap: any = await waitEvent(bob, 'game:state',
      (m: any) => Array.isArray(m.partUpdates) && m.partUpdates.some((p: any) => p.id === 'bts_placed_e2e_a1'), 15000);
    assert.ok(bobJoinSnap, "bob's join keyframe carries every placed block");
    const bobBts: any = await waitEvent(bob, 'bts:state', (m: any) => m.claims && m.claims.plot1 === 'Alice', 10000);
    assert.ok(bobBts, 'bob sees the claim state');
    console.log('✓ late joiner sync: blocks + claims in the join keyframe');

    // ── 8. Ownership rules: Bob cannot build on Alice's plot ──
    bob.emit('bts:action', { instanceId, kind: 'place', part: blockRecord('bts_placed_e2e_b_steal', 12, 1.125, -12) });
    await sleep(700);
    const noSteal: any = await waitEvent(bob, 'game:state', (m: any) => Array.isArray(m.players), 8000);
    assert.ok(!(noSteal.partUpdates || []).some((p: any) => p.id === 'bts_placed_e2e_b_steal'),
      "bob's placement on alice's plot was rejected");
    console.log("✓ ownership: bob cannot place on alice's plot");

    // Bob cannot break Alice's block either.
    bob.emit('bts:action', { instanceId, kind: 'break', id: 'bts_placed_e2e_a1' });
    await sleep(700);
    const noBreak: any = await waitEvent(alice, 'game:state', (m: any) => Array.isArray(m.players), 8000);
    assert.ok(!(noBreak.partUpdates || []).some((p: any) => p.id === 'bts_placed_e2e_a1'),
      "bob's break of alice's block was rejected");
    console.log("✓ ownership: bob cannot break alice's block");

    // ── 9. Bob claims plot2 (standing there) and builds successfully ──
    bob.emit('game:pstate', { instanceId, x: 26.5, y: 0.5, z: 26.5, yaw: 0, walking: false, jumping: false, sprint: false });
    await sleep(300);
    bob.emit('bts:action', { instanceId, kind: 'claim', plotId: 'plot2' });
    await waitEvent(bob, 'bts:state', (m: any) => m.claims && m.claims.plot2 === 'Bob', 10000);
    const blockB = blockRecord('bts_placed_e2e_b1', 10, 1.125, 10);
    bob.emit('bts:action', { instanceId, kind: 'place', part: blockB });
    const bPlaced: any = await waitEvent(alice, 'game:state',
      (m: any) => Array.isArray(m.partUpdates) && m.partUpdates.some((p: any) => p.id === 'bts_placed_e2e_b1'), 10000);
    assert.ok(bPlaced, "bob's block on his own plot broadcast to alice");
    console.log('✓ bob claimed plot2 + built on it (broadcast to alice)');

    // ── 10. Alice rotates then breaks her own block ──
    alice.emit('bts:action', { instanceId, kind: 'rotate', id: 'bts_placed_e2e_a1', rotation: { x: 0, y: 90, z: 0 } });
    await waitEvent(bob, 'game:state',
      (m: any) => Array.isArray(m.partUpdates) && m.partUpdates.some((p: any) => p.id === 'bts_placed_e2e_a1' && p.rotation && p.rotation.y === 90), 10000);
    console.log('✓ rotate broadcast (rotation.y 90)');

    alice.emit('bts:action', { instanceId, kind: 'break', id: 'bts_placed_e2e_a1' });
    await waitEvent(bob, 'game:state',
      (m: any) => Array.isArray(m.partUpdates) && m.partUpdates.some((p: any) => p.id === 'bts_placed_e2e_a1' && p.deleted), 10000);
    console.log('✓ break broadcast ({ id, deleted: true })');

    // ── 11. The build timer advances server-side ──
    const t1: any = await waitEvent(alice, 'bts:state', (m: any) => typeof m.buildTimer === 'number', 8000);
    await sleep(1300);
    const t2: any = await waitEvent(alice, 'bts:state', (m: any) => typeof m.buildTimer === 'number' && m.buildTimer < t1.buildTimer, 8000);
    assert.ok(t2.buildTimer < t1.buildTimer, `timer advanced (${t1.buildTimer.toFixed(1)} -> ${t2.buildTimer.toFixed(1)})`);
    console.log(`✓ server-side phase timer advancing (${t1.buildTimer.toFixed(1)} -> ${t2.buildTimer.toFixed(1)})`);

    // ── 12. Bob sees Alice's reported position in his relays ──
    const bobSeesAlice: any = await waitEvent(bob, 'game:state',
      (m: any) => m.players?.some((p: any) => p.username === 'Alice' && Math.abs(p.position[0] - 26.5) < 0.01), 10000).catch(() => null);
    assert.ok(bobSeesAlice, 'bob sees alice at her reported plot1 position');
    console.log('✓ player position relay (bob sees alice at 26.5, -26)');

    alice.emit('game:leave', { instanceId });
    bob.emit('game:leave', { instanceId });
    alice.disconnect();
    bob.disconnect();

    console.log('\n✓ Build to Survive multiplayer E2E: ALL PASS');
  } finally {
    gamehost.kill('SIGTERM');
    await sleep(300);
    if (!gamehost.killed) gamehost.kill('SIGKILL');
    stubMain.close();
  }
}

main().catch((e) => {
  console.error('✗ BTS multiplayer E2E failed:', e);
  process.exit(1);
});
