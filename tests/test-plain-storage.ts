// v2.0 storage test: plain studioState server storage + legacy world_b64
// decrypt paths + the boot migration (GameWorld rows -> plain JSON).
// Requires the embedded postgres on :5433 (scripts/start-pg.mjs).
// Usage: DATABASE_URL=postgresql://postgres:postgres@localhost:5433/weildbuild npx tsx tests/test-plain-storage.ts

import assert from "node:assert";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/weildbuild";

let prisma: typeof import("../src/db/client").prisma;
let createGameRecord: typeof import("../src/db/data").createGameRecord;
let updateGameRecord: typeof import("../src/db/data").updateGameRecord;
let getGame: typeof import("../src/db/data").getGame;
let encryptWbworldPayload: typeof import("../src/shared/wbworld").encryptWbworldPayload;
let ensureDatabase: typeof import("../src/db/ensure").ensureDatabase;

const studioState = (pad: string) => ({
  objects: [
    { id: 'p1', name: `Block_${pad}`, type: 'Block',
      position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#4ff7f5', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {}, avatar: {},
  worldSettings: {}, physicsSettings: {},
});

async function main() {
  ({ prisma } = await import("../src/db/client"));
  ({ createGameRecord, updateGameRecord, getGame } = await import("../src/db/data"));
  ({ encryptWbworldPayload } = await import("../src/shared/wbworld"));
  ({ ensureDatabase } = await import("../src/db/ensure"));

  // ── 1. v2.0 publish: PLAIN studioState stored as-is ──
  const created = await createGameRecord({
    name: 'Plain Publish', description: '', creator: 'storage-test',
    max_players: 10, multiplayer: true, studioState: studioState('plain'),
  } as any);
  assert.ok(created.id, 'game created');
  const got = await getGame(created.id);
  assert.ok(got?.studioState && Array.isArray(got.studioState.objects), 'getGame returns the plain studioState');
  assert.equal(got!.studioState.objects[0].name, 'Block_plain', 'plain world content intact');
  assert.equal((got as any).world_b64, undefined, 'no encrypted blob in the response');
  const row1 = await prisma.game.findUnique({ where: { id: created.id } });
  assert.ok((row1!.extraData as any).studioState, 'row stores studioState PLAIN in extra_data');
  console.log('✓ v2.0 publish: plain studioState stored + served');

  // ── 2. Legacy client (world_b64): decrypted on arrival, stored PLAIN ──
  const legacyBlob = encryptWbworldPayload({
    format: 'wbworld', version: 1, name: 'Legacy Client', description: '',
    multiplayer: true, max_players: 10, spawn_point: [0, 0, 0],
    studioState: studioState('legacy'), exportedAt: new Date().toISOString(), exportedBy: 'legacy-client',
  });
  const created2 = await createGameRecord({
    name: 'Legacy Client Publish', description: '', creator: 'storage-test',
    max_players: 10, multiplayer: true, world_b64: (legacyBlob.toString('base64')),
  } as any);
  const got2 = await getGame(created2.id);
  assert.ok(got2?.studioState?.objects?.[0]?.name === 'Block_legacy', `legacy blob decrypted on arrival (got ${got2?.studioState?.objects?.[0]?.name})`);
  const row2 = await prisma.game.findUnique({ where: { id: created2.id } });
  assert.ok((row2!.extraData as any).studioState, 'legacy publish stored PLAIN');
  const worldRows2 = await prisma.gameWorld.findMany({ where: { gameId: created2.id } });
  assert.equal(worldRows2.length, 0, 'no GameWorld side row created');
  console.log('✓ legacy world_b64 publish: decrypted on arrival, stored plain');

  // ── 3. Tampered legacy blob: dropped cleanly, game row still created ──
  const created3 = await createGameRecord({
    name: 'Tampered', description: '', creator: 'storage-test',
    world_b64: Buffer.from('garbage-not-wbworld').toString('base64'),
  } as any);
  assert.ok(created3.id, 'tampered publish still creates the game row');
  const got3 = await getGame(created3.id);
  assert.ok(!got3?.studioState, 'tampered blob dropped (no world)');
  console.log('✓ tampered world_b64 dropped cleanly');

  // ── 4. Update path: republish replaces the world, metadata-only update keeps it ──
  await updateGameRecord(created.id, { name: 'Plain Publish v2', studioState: studioState('v2') } as any);
  const gotUpd = await getGame(created.id);
  assert.equal(gotUpd!.name, 'Plain Publish v2', 'metadata update applied');
  assert.equal(gotUpd!.studioState.objects[0].name, 'Block_v2', 'republish replaced the world');
  await updateGameRecord(created.id, { description: 'only metadata' } as any);
  const gotMeta = await getGame(created.id);
  assert.equal(gotMeta!.studioState.objects[0].name, 'Block_v2', 'metadata-only update KEEPS the world');
  assert.equal(gotMeta!.description, 'only metadata', 'description updated');
  console.log('✓ update path: republish replaces, metadata-only keeps the world');

  // ── 5. Boot migration: a v1.x GameWorld side-row migrates to plain ──
  const v14game = await createGameRecord({
    name: 'v1.x Row', description: '', creator: 'storage-test',
    max_players: 10, multiplayer: true,
  } as any);
  await prisma.gameWorld.create({
    data: {
      gameId: v14game.id,
      world: encryptWbworldPayload({
        format: 'wbworld', version: 1, name: 'v1.x Row', description: '',
        multiplayer: true, max_players: 10, spawn_point: [0, 0, 0],
        studioState: studioState('v1x'), exportedAt: new Date().toISOString(), exportedBy: 'v1.x',
      }) as any,
      bytesLen: 0,
    },
  });
  // Pre-migration read: getGame decrypts the side-row transparently.
  const pre = await getGame(v14game.id);
  assert.equal(pre!.studioState.objects[0].name, 'Block_v1x', 'pre-migration read decrypts the side-row');

  // Run the boot migration (the same code the server runs on startup).
  await ensureDatabase();
  const worldAfter = await prisma.gameWorld.findMany({ where: { gameId: v14game.id } });
  assert.equal(worldAfter.length, 0, 'migration removed the side-row');
  const rowAfter = await prisma.game.findUnique({ where: { id: v14game.id } });
  assert.equal((rowAfter!.extraData as any).studioState.objects[0].name, 'Block_v1x', 'migration wrote the plain studioState into extra_data');
  // Second boot run is a no-op (idempotent).
  await ensureDatabase();
  console.log('✓ boot migration: v1.x side-row -> plain JSON (idempotent)');

  // ── 6. List view stays light: getAllGames never carries the world ──
  const { getAllGames } = await import("../src/db/data");
  const list = await getAllGames();
  assert.ok(list.length >= 3, 'games listed');
  assert.ok(list.every((g: any) => !g.studioState && !g.world_b64), 'list views carry no world data');
  console.log('✓ list views stay light (no studioState in lists)');

  // Cleanup
  for (const id of [created.id, created2.id, created3.id, v14game.id]) {
    await prisma.gameWorld.deleteMany({ where: { gameId: id } }).catch(() => {});
    await prisma.game.deleteMany({ where: { id } }).catch(() => {});
  }

  console.log('\n✓ plain storage + migration: ALL PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ plain storage test failed:', e);
  process.exit(1);
});
