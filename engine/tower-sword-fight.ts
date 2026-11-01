// ════════════════════════════════════════════════════════════════════
// WeildBuild - Tower Sword Fight (embedded game mode, v7.1 pass 4)
// ════════════════════════════════════════════════════════════════════
// Self-contained combat / NPC / inventory system that activates inside
// StudioPlayViewport when gameMode === 'tower-sword-fight'. It does NOT
// touch how the platform treats normal user-built games: the whole
// system is gated behind that one flag, and every hook early-returns
// when the flag is off.
//
// v7.1 pass 4 (this file), per the owner's review:
//   - TEAMS ARE GONE. 5 NPCs, and they hunt THE PLAYER only (never each
//     other). The player and every NPC respawn at a RANDOM spawn point
//     (the arena's four Spawn parts), keeping the 5s spawn shield.
//   - ROPE SLIDES ARE GONE (the feature was buggy).
//   - NEW TOOL: the Grappling Hook (the owner's grappling_hook.wbworld).
//     Same crosshair as the bazooka while held; on use it fires the hook
//     along the view direction (like the bazooka rocket). The hook has a
//     10s lifetime, the tool an 11s cooldown. Once the hook ATTACHES to
//     something it stops decaying for 30s instead. The player is dragged
//     through the air to the attachment point; if the hook times out
//     first, the player just falls. A rope is drawn from the tool to the
//     hook the whole time it is out.
//   - NPC DEATH now explodes the NPC into body-part debris (same
//     disintegration effect as the player's death).
//   - NPCs JUMP (real cannon impulses): to escape pits/corners, when
//     chasing across a height gap, and occasionally while closing in.
//   - NPC AI, per the owner's spec:
//       * avoid walking off the baseplate / platforms (edge probing)
//       * real PATHFINDING: a waypoint graph over the arena's walkable
//         surfaces, A* between nodes, NPC hop lists
//       * far away  -> grappling hook or bazooka
//       * close     -> sword, or plant a bomb when the player is occupied
//       * low HP    -> retreat while HOLDING THE STAFF to regen
//   - Music (TowerSwordFightMusic): a track can't repeat until every
//     other track has played.
//
// The simulation lives outside React (a plain class) and ticks in
// useFrame without re-rendering; React reads snapshots/live accessors
// for rendering. All positions are FEET-origin world space, matching
// the platform convention (the visible avatar's group origin is at its
// feet).
// ════════════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { DEFAULT_CHARACTER_HITBOX_SIZE } from '@/lib/game-engine/physics';
export { TSF_ROCKET_PART, TSF_HOOK_PARTS } from '@/data/towerSwordFightItems';

// ─── Spawns (no teams) ───

/** The arena's four Spawn parts (by name). Used as the RANDOM respawn
 *  pool for both the player and the NPCs, and as the AI waypoint seeds. */
export const TSF_SPAWN_NAMES = [
  'Blue_Spawn_Location',
  'Red_Spawn_Location',
  'Yellow_Spawn_Location',
  'Green_Spawn_Location',
] as const;

// ─── Combat constants ───

export const TSF_MAX_HP = 100;
export const TSF_SPAWN_INVINCIBLE = 5;       // seconds after (re)spawn
export const TSF_FLEE_HP_PCT = 0.3;          // NPC flees below this HP fraction
export const TSF_NPC_SPEED = 7.5;            // studs/sec (under player walk 10.8)
export const TSF_NPC_SPRINT_SPEED = 12.5;    // pass 5: sprint - ABOVE player walk, used when far + straight-line
export const TSF_RESPAWN_DELAY = 2.5;        // seconds dead before respawn
export const TSF_NPC_COUNT = 6;              // pass 5: 6 NPCs, player-hunters only
export const TSF_VOID_Y = -25;               // NPCs below this die (fell/flung off)
export const TSF_NPC_JUMP_SPEED = 11.5;      // matches CHAR_JUMP_SPEED (player parity)

// Sword (spec: 20 dmg, 0.8s per swing). The swing is VISIBLE: the arm
// chops and damage lands at the CONTACT point (60% through the swing),
// once per swing.
export const TSF_SWORD_DAMAGE = 20;
export const TSF_SWORD_COOLDOWN = 0.8;
export const TSF_SWORD_RANGE = 3.2;
export const TSF_SWORD_ARC = Math.PI * 0.55;
// Pass 6: the sword arc is checked FLAT (X/Z) - without this vertical
// gate an NPC on the ground could hit a player standing on a tower 10
// studs above (and vice versa). ~2.2 = one body height + a small margin:
// same level or one small step connects, a tower height does not.
export const TSF_SWORD_Y_TOLERANCE = 2.2;
export const TSF_SWING_TIME = 0.45;            // seconds, wall-to-wall
export const TSF_SWING_CONTACT_AT = 0.6;       // fraction of the swing when damage lands

// Bomb (spec: spawn at feet, 5s timer with 1s black->red ticks, 0.25s
// ticks for the last 2s, 10x10x10 blast, damage + push scale with range)
export const TSF_BOMB_FUSE = 5;
export const TSF_BOMB_COOLDOWN = 6;           // spec: 6s cooldown
export const TSF_BOMB_RADIUS = 5;             // 10x10x10
export function tsfBlastDamage(distToCenter: number, radius: number): number {
  const t = Math.max(0, Math.min(1, 1 - distToCenter / radius));
  return Math.round(20 + 60 * t);              // 80 at the center, 20 at the edge
}
export function tsfBlastPush(distToCenter: number, radius: number): number {
  return Math.max(0, Math.min(1, 1 - distToCenter / radius));
}

// Bazooka (spec: 2s between launches; rocket flies straight, 1 minute
// lifetime, 5x5x5 explosion on contact - same damage/push curve)
export const TSF_ROCKET_SPEED = 40;
export const TSF_ROCKET_LIFETIME = 60;         // the "until it decays" cap
export const TSF_ROCKET_RADIUS = 2.5;          // 5x5x5
export const TSF_ROCKET_COOLDOWN = 2;          // spec: 2s between launches

// Healing staff (spec: +10 HP/s while held; on use, take the HP needed to
// heal from all enemies in a 4x4x4 region and heal to max; 5s cooldown)
export const TSF_STAFF_REGEN = 10;            // HP/sec while held
export const TSF_STAFF_COOLDOWN = 5;          // spec: 5s
export const TSF_STAFF_RADIUS = 2;            // 4x4x4

// ─── Grappling hook (pass 4, the owner's spec) ───
// On use the hook fires along the view direction (bazooka-style). It has
// a 10 SECOND LIFETIME; the tool an 11 SECOND cooldown (1s longer so a
// fresh hook is always ready before the tool recharges). Once ATTACHED,
// the hook stops decaying for 30 SECONDS instead - and the player is
// dragged through the air to the attachment point. If the hook expires
// first (in flight OR attached), the rope vanishes and the player just
// falls.
export const TSF_HOOK_SPEED = 55;             // studs/sec flight
export const TSF_HOOK_LIFETIME = 10;          // total life: it ALWAYS decays 10s after firing - attached or not (pass 5)
export const TSF_HOOK_COOLDOWN = 11;         // tool cooldown (1s > lifetime)
export const TSF_HOOK_DRAG_SPEED = 26;        // studs/sec pull toward the anchor
export const TSF_HOOK_ARRIVE_DIST = 1.6;      // stop dragging this close
export const TSF_HOOK_NPC_RANGE = 60;         // AI: hook only when this far
export const TSF_HOOK_NPC_MIN_RANGE = 18;     // ...and at least this far (else walk)

// NPC hitbox: identical to the player's default pill (the platform's
// CharacterRoot part was removed in v1.3, so the player body uses
// DEFAULT_CHARACTER_HITBOX_SIZE with no size opts - matching it keeps
// the engine's shared characterHeight/characterSize coherent).
export const TSF_NPC_HITBOX = { ...DEFAULT_CHARACTER_HITBOX_SIZE };

// Must mirror GROUP_CHARACTER in game-engine/physics.ts (module-private
// there). Setting an NPC body's mask to ~GROUP_CHARACTER makes NPC<->NPC
// and NPC<->player pass through (per spec) while NPC<->world collides.
const CHARACTER_GROUP = 4;

// ─── Player bridge ───
// The player's LIVE transform, written EVERY FRAME by GamePlayerCharacter
// (position, body yaw, camera view direction via getWorldDirection) and
// read by the manager + the held-tool renderer.
export interface TSFPlayerBridge {
  /** Feet-origin position of the player. */
  x: number; y: number; z: number;
  /** Body yaw (radians, +Z forward at 0) - faces the movement direction. */
  bodyYaw: number;
  /** NORMALIZED camera view direction (where the player is looking). */
  camX: number; camY: number; camZ: number;
  /** Camera horizontal facing (radians, +Z forward) - atan2 of camX/camZ. */
  camYaw: number;
  grounded: boolean;
}
export const TSF_PLAYER_BRIDGE: TSFPlayerBridge = {
  x: 0, y: 0, z: 0, bodyYaw: 0, camX: 0, camY: 0, camZ: 1, camYaw: 0, grounded: true,
};

/** The player's right-arm rotation override (radians about X; null = the
 *  normal walk animation owns the arm). Set per frame by the TSF view,
 *  applied by CharacterPartsRenderer (player) and WeildBuildCharacter
 *  (NPCs via their own local refs). */
export const TSF_ARM_OVERRIDE: { current: number | null } = { current: null };

// ─── Tools (inventory) ───

export type TSFToolId = 'sword' | 'bomb' | 'bazooka' | 'staff' | 'hook';

export interface TSFToolDef {
  id: TSFToolId;
  label: string;
  hotkey: string;          // '1'..'5'
  cooldown: number;        // seconds between uses of THIS tool
  drawSound?: string;      // played on select
  useSound?: string;       // played on use
  icon: TSFToolId;         // the hotbar model key (same set as the id)
}

export const TSF_TOOLS: TSFToolDef[] = [
  { id: 'sword',   label: 'Sword',   hotkey: '1', cooldown: TSF_SWORD_COOLDOWN, drawSound: 'tsf_draw_sword',         useSound: 'tsf_sword_use',         icon: 'sword' },
  { id: 'bomb',    label: 'Bomb',    hotkey: '2', cooldown: TSF_BOMB_COOLDOWN,  drawSound: undefined,               useSound: undefined,               icon: 'bomb' },
  { id: 'bazooka', label: 'Bazooka', hotkey: '3', cooldown: TSF_ROCKET_COOLDOWN, drawSound: undefined,             useSound: 'tsf_bazooka_shoot',     icon: 'bazooka' },
  { id: 'staff',   label: 'Staff',   hotkey: '4', cooldown: TSF_STAFF_COOLDOWN, drawSound: 'tsf_draw_regen_staff', useSound: 'used_tool',             icon: 'staff' },
  { id: 'hook',    label: 'Hook',    hotkey: '5', cooldown: TSF_HOOK_COOLDOWN,  drawSound: 'tsf_grap_hook_select', useSound: 'tsf_hook_shoot',        icon: 'hook' },
];

/** Tools that show the aiming crosshair while held (spec: bazooka; the
 *  hook uses the same crosshair per the owner's pass-4 spec). */
export const TSF_CROSSHAIR_TOOLS: ReadonlySet<TSFToolId> = new Set(['bazooka', 'hook']);

// ─── NPC entity ───

export type TSFNpcMode = 'chase' | 'flee' | 'attack' | 'flee-bomb' | 'ranged' | 'hook-flight' | 'circle';

export interface TSFNpc {
  id: string;
  // FEET-origin world position + facing yaw (radians, +Z forward at 0 -
  // the body faces the MOVEMENT direction, like the player).
  position: THREE.Vector3;
  yaw: number;
  velocity: THREE.Vector3;   // desired horizontal velocity from the AI
  hp: number;
  maxHp: number;
  alive: boolean;
  invincibleFor: number;     // > 0 = spawn invincibility active
  respawnIn: number;         // > 0 = dead, counting down to respawn
  mode: TSFNpcMode;
  /** The tool the NPC is holding (renders in its hand; the staff regens
   *  while held, like the player's). */
  heldTool: TSFToolId | null;
  attackCooldown: number;
  /** > 0: seconds left of the current swing (starts at TSF_SWING_TIME).
   *  Damage lands when this crosses the CONTACT point. */
  swingTimer: number;        // 0 = not swinging
  swingLanded: boolean;      // one contact per swing
  /** Randomized avatar (spec: random skin tone, face, shirt, pants). */
  skin: string;
  shirt: string;
  pants: string;
  face: string;
  /** Distance-driven walk cycle (same convention as the player). */
  walkPhase: number;
  /** Seconds the walk phase keeps decaying for after velocity hits 0. */
  jumping: boolean;
  // Unstick bookkeeping: seconds spent wanting to move but not moving,
  // and a timed sidestep (wiggleFor > 0) that breaks wall-hugging.
  stuckFor: number;
  wiggleFor: number;
  wiggleDir: number;
  // Rolling movement probe for the stuck meter (every 0.8s).
  stuckProbe?: { x: number; z: number; t: number };
  // Jump bookkeeping.
  jumpCooldown: number;      // seconds until allowed to jump again
  lastGroundedY: number;
  // Pass-5 duel behavior: circling the player (angle in radians around
  // the player, plus the direction of orbit ±1).
  circleAround: number | null;  // the ANGLE to hold while orbiting, null = off
  circleDir: 1 | -1;
  // Sprint timer: the AI sets this to run at sprint speed; the tick
  // decays it (the walk-cycle driver is velocity-based either way).
  sprintFor: number;
  // A* path (world positions, feet-origin) + progress index.
  path: THREE.Vector3[];
  targetId: string | null;
  pathIndex: number;
  pathRepaintIn: number;     // seconds until the path is recomputed
  // Live cannon body (only while alive + physics attached).
  body?: any;
  // NPC hook (independent of the player's, so several can fly at once).
  hook?: TSFHook | null;
}

// ─── Tool entities ───

export interface TSFBomb {
  id: string;
  position: THREE.Vector3;  // on the ground where planted
  timer: number;            // seconds until it blows
  /** The CURRENT body color: black -> red on the spec's tick schedule
   *  (1s apart, 0.25s for the last 2s). The renderer reads this. */
  red: boolean;
  /** Ticks elapsed (drives the tick sound + color flips). */
  nextFlipIn: number;
  alive: boolean;
}

export interface TSFRocket {
  id: string;
  /** 'player' or the owning NPC's id (pass 5: NPCs dodge the PLAYER's
   *  rockets, and a rocket never collides with its own owner). */
  ownerId: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;             // seconds until it decays on its own
  alive: boolean;
}

/**
 * One grappling hook in flight or attached (player OR NPC owned).
 * Lifetime (pass 5): the FULL 10 seconds from firing, ALWAYS. Attached
 * hooks used to rebill to 30s - that's why the rope would hang around
 * forever. Now: 10s from the shot, attached or not; drag runs while
 * attached; at 0 the hook (and its rope) is destroyed and the owner, if
 * being dragged, just falls.
 */
export interface TSFHook {
  id: string;
  /** 'player' or the owning NPC's id. */
  ownerId: string;
  /** true = embedded in the world; the owner is dragged to the anchor. */
  attached: boolean;
  position: THREE.Vector3;  // hook center (the touchpoint)
  velocity: THREE.Vector3;  // flight direction * TSF_HOOK_SPEED
  life: number;             // seconds left before destruction
  /** Where the rope is tied on the tool side (updated per frame by the
   *  manager: the owner's fist). The renderer draws tool->hook. */
  ropeFrom: THREE.Vector3;
  alive: boolean;
}

export interface TSFExplosion {
  id: string;
  position: THREE.Vector3;
  radius: number;
  age: number;              // seconds since it blew (the renderer fades it)
}

/** NPC death debris (the disintegration burst) - one entry per body
 *  part + gibs, animated by the renderer, aged out by the manager. */
export interface TSFDeathBit {
  id: string;
  meshPos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  size: THREE.Vector3;
  color: string;
  life: number;
}

// ─── Snapshot exposed to React for rendering ───

export interface TSFPlayerState {
  hp: number;
  maxHp: number;
  alive: boolean;
  invincibleFor: number;
  selectedTool: TSFToolId | null;
  cooldowns: Record<string, number>;   // per-tool remaining cooldown
  swingTimer: number;
  swingLanded: boolean;                // one contact per swing
  kills: number;
  deaths: number;
  /** The player's hook (in flight / attached), if any. */
  hook: TSFHook | null;
}

export interface TSFSnapshot {
  active: boolean;
  player: TSFPlayerState;
  npcs: ReadonlyArray<TSFNpc>;
  rev: number;
}

// ─── Avatar randomization (matches the player's catalog format) ───

const SKIN_TONES = ['#f5f0e6', '#f8ff6d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a1664e'];
const SHIRTS = ['SHIRT-4', 'SHIRT-9', 'SHIRT-2', 'SHIRT-7', 'SHIRT-12'];
const PANTS = ['PANTS-2', 'PANTS-6', 'PANTS-3', 'PANTS-8'];
const FACES = ['FACE-1', 'FACE-3', 'FACE-5', 'FACE-7'];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function randomAvatar() {
  return {
    skin: pick(SKIN_TONES),
    shirt: pick(SHIRTS),
    pants: pick(PANTS),
    face: pick(FACES),
  };
}

// ─── Pathfinding: the arena waypoint graph ───
//
// A hand-free graph is impossible to hard-code for a user-built arena,
// so the host calls setWalkGraph with nodes sampled from the arena's
// collidable top surfaces (see buildTsfWalkGraph in the view): every
// spawn, every platform top, plus a ring over the baseplate. Edges are
// built by line-of-sight + jump-reachability tests, so an NPC can path
// from its tower to the player's position across the whole arena.
export interface TSFWalkNode {
  pos: THREE.Vector3;      // standing spot (feet-origin)
}

interface PathEdge { to: number; cost: number }

class WalkGraph {
  nodes: THREE.Vector3[] = [];
  edges: PathEdge[][] = [];
  /** Nearest node to a world point (unbounded scan - the graph is small). */
  nearest(p: THREE.Vector3): number {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const d = this.nodes[i].distanceToSquared(p);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  /** A*: returns the node-index path from `a` to `b` (inclusive), or null. */
  find(a: number, b: number): number[] | null {
    if (a < 0 || b < 0 || a >= this.nodes.length || b >= this.nodes.length) return null;
    if (a === b) return [a];
    const open: number[] = [a];
    const g = new Map<number, number>([[a, 0]]);
    const f = new Map<number, number>([[a, this.nodes[a].distanceTo(this.nodes[b])]]);
    const came = new Map<number, number>();
    const closed = new Set<number>();
    while (open.length) {
      open.sort((x, y) => (f.get(x) ?? Infinity) - (f.get(y) ?? Infinity));
      const cur = open.shift()!;
      if (cur === b) {
        const out: number[] = [b];
        let c = b;
        while (came.has(c)) { c = came.get(c)!; out.push(c); }
        return out.reverse();
      }
      closed.add(cur);
      for (const e of this.edges[cur] ?? []) {
        if (closed.has(e.to)) continue;
        const tentative = (g.get(cur) ?? Infinity) + e.cost;
        if (tentative < (g.get(e.to) ?? Infinity)) {
          came.set(e.to, cur);
          g.set(e.to, tentative);
          f.set(e.to, tentative + this.nodes[e.to].distanceTo(this.nodes[b]));
          if (!open.includes(e.to)) open.push(e.to);
        }
      }
    }
    return null;
  }
}

// ─── The manager ───

export class TowerSwordFightManager {
  active = false;
  private started = false;
  private npcs: TSFNpc[] = [];
  private bombs: TSFBomb[] = [];
  private rockets: TSFRocket[] = [];
  private hooks: TSFHook[] = [];
  private explosions: TSFExplosion[] = [];
  private deathBits: TSFDeathBit[] = [];
  private nextId = 1;

  private player: TSFPlayerState = {
    hp: TSF_MAX_HP,
    maxHp: TSF_MAX_HP,
    alive: true,
    invincibleFor: TSF_SPAWN_INVINCIBLE,
    selectedTool: 'sword',
    cooldowns: { sword: 0, bomb: 0, bazooka: 0, staff: 0, hook: 0 },
    swingTimer: 0,
    swingLanded: false,
    kills: 0,
    deaths: 0,
    hook: null,
  };

  // The player's live feet position + facing, pushed in each frame.
  private playerPos = new THREE.Vector3();

  /** The four Spawn part positions (feet-space), the random respawn pool. */
  private spawns: THREE.Vector3[] = [];

  /** Walkable-surface graph for NPC pathfinding. */
  private walkGraph = new WalkGraph();

  /** Collidable arena surfaces for edge avoidance + hook attachment
   *  (host-provided AABB scan, same one the rockets use). */
  private worldHitTest: ((p: THREE.Vector3) => boolean) | null = null;
  /** Downward surface probe: returns the highest surface Y under (x, z)
   *  below `fromY`, or null (the void). Host-provided. */
  private groundProbe: ((x: number, z: number, fromY: number) => number | null) | null = null;

  // Physics engine handle.
  private physics: any = null;

  private rev = 0;
  private onPlayerHurtCb: ((hp: number, max: number) => void) | null = null;
  private onPlayerDieCb: (() => void) | null = null;
  private playSoundCb: ((name: string, volume: number) => void) | null = null;

  // ─── Lifecycle ───

  /**
   * Try to start the match. The host calls this every frame until it
   * returns true; `probe` reads the studio store and returns the four
   * Spawn parts' FEET-space positions, or null while the world isn't
   * loaded yet. This keeps the start independent of React mount order.
   */
  tryStart(
    probe: () => { x: number; y: number; z: number }[] | null,
  ): boolean {
    if (this.started) return true;
    const found = probe();
    if (!found || found.length === 0) return false;
    this.spawns = found.map((s) => new THREE.Vector3(s.x, s.y, s.z));
    this.started = true;
    this.active = true;
    // 5 NPCs (pass 4: no teams - they all hunt the player only).
    this.npcs = [];
    for (let i = 0; i < TSF_NPC_COUNT; i++) this.npcs.push(this.makeNpc());
    // The player starts at a random spawn too.
    this.player.hp = TSF_MAX_HP;
    this.player.alive = true;
    this.player.invincibleFor = TSF_SPAWN_INVINCIBLE;
    this.player.selectedTool = 'sword';
    this.player.kills = 0;
    this.player.deaths = 0;
    this.player.hook = null;
    this.hooks = [];
    // Physics may already be attached - hand out the bodies now.
    if (this.physics) this.npcs.forEach((n) => this.addNpcBody(n));
    this.rev++;
    return true;
  }

  stop() {
    this.detachPhysics();
    this.npcs = [];
    this.bombs = [];
    this.rockets = [];
    this.hooks = [];
    this.explosions = [];
    this.deathBits = [];
    this.started = false;
    this.active = false;
    this.rev++;
  }

  // ─── Physics (NPC pill bodies) ───

  attachPhysics(world: any) {
    if (!world || this.physics === world) return;
    this.physics = world;
    if (this.started) this.npcs.forEach((n) => { if (n.alive) this.addNpcBody(n); });
  }

  detachPhysics() {
    if (!this.physics) return;
    this.npcs.forEach((n) => this.removeNpcBody(n));
    this.physics = null;
  }

  private addNpcBody(npc: TSFNpc) {
    const w = this.physics;
    if (!w || npc.body) return;
    const body = w.addNamedCharacterBody(
      npc.id,
      { x: npc.position.x, y: npc.position.y, z: npc.position.z },
      { size: TSF_NPC_HITBOX },
    );
    if (!body) return;
    body.collisionFilterMask = ~CHARACTER_GROUP;
    body.velocity.set(npc.velocity.x, 0, npc.velocity.z);
    npc.body = body;
  }

  private removeNpcBody(npc: TSFNpc) {
    if (!this.physics) { npc.body = null; return; }
    try { this.physics.removeNamedCharacterBody(npc.id); } catch { /* already gone */ }
    npc.body = null;
  }

  // ─── Host-provided probes ───

  /** Coarse world-collision test (rocket flight + hook attachment). */
  setWorldHitTest(fn: ((p: THREE.Vector3) => boolean) | null) { this.worldHitTest = fn; }

  /** Downward surface probe for edge avoidance + drops. */
  setGroundProbe(fn: ((x: number, z: number, fromY: number) => number | null) | null) { this.groundProbe = fn; }

  /** Waypoint graph over the arena's walkable surfaces. */
  setWalkGraph(nodes: { x: number; y: number; z: number }[]) {
    const g = new WalkGraph();
    g.nodes = nodes.map((n) => new THREE.Vector3(n.x, n.y, n.z));
    // Edges: connect nodes that can reach each other - same level (walk,
    // <=8 studs apart) or a jump-climb (<=5.5 up, <=10 across).
    for (let i = 0; i < g.nodes.length; i++) {
      g.edges.push([]);
    }
    for (let i = 0; i < g.nodes.length; i++) {
      for (let j = i + 1; j < g.nodes.length; j++) {
        const a = g.nodes[i], b = g.nodes[j];
        const dy = b.y - a.y;
        const flat = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).length();
        const reachable =
          (Math.abs(dy) <= 0.6 && flat <= 10) ||          // walk (same level)
          (dy > 0.6 && dy <= 5.5 && flat <= 10) ||       // jump up onto
          (dy < -0.6 && dy >= -30 && flat <= 14);        // drop down
        if (!reachable) continue;
        const cost = flat + Math.abs(dy) * 1.5;
        g.edges[i].push({ to: j, cost });
        g.edges[j].push({ to: i, cost });
      }
    }
    this.walkGraph = g;
    // Existing NPCs re-path onto the new graph next tick.
    for (const n of this.npcs) { n.path = []; n.pathIndex = 0; n.pathRepaintIn = 0; }
    this.rev++;
  }

  // ─── Callbacks the host wires up ───

  onPlayerHurt(cb: (hp: number, max: number) => void) { this.onPlayerHurtCb = cb; }
  onPlayerDie(cb: () => void) { this.onPlayerDieCb = cb; }
  setPlaySound(cb: (name: string, volume: number) => void) { this.playSoundCb = cb; }

  // ─── Inputs the host pushes in ───

  updatePlayerTransform() {
    this.playerPos.set(TSF_PLAYER_BRIDGE.x, TSF_PLAYER_BRIDGE.y, TSF_PLAYER_BRIDGE.z);
  }

  /** The player's CURRENT camera view direction (for aiming). */
  getPlayerCamDir(): THREE.Vector3 {
    return new THREE.Vector3(TSF_PLAYER_BRIDGE.camX, TSF_PLAYER_BRIDGE.camY, TSF_PLAYER_BRIDGE.camZ);
  }

  getPlayerPos(): THREE.Vector3 { return this.playerPos; }
  getPlayerBodyYaw(): number { return TSF_PLAYER_BRIDGE.bodyYaw; }

  selectTool(tool: TSFToolId | null) {
    if (!this.active || this.player.selectedTool === tool) return;
    this.player.selectedTool = tool;
    // Pass 5: putting the hook away (switching to anything else) kills
    // the player's live hook INSTANTLY - rope included.
    if (this.player.hook?.alive) this.killHook(this.player.hook);
    this.rev++;
    const def = TSF_TOOLS.find((t) => t.id === tool);
    if (def?.drawSound) this.playSoundCb?.(def.drawSound, 0.5);
  }

  /** Player used the selected tool (click / E). Returns true if it fired. */
  playerUseTool(): boolean {
    if (!this.active || !this.player.alive) return false;
    const tool = this.player.selectedTool;
    if (!tool) return false;
    if (this.player.cooldowns[tool] > 0) return false;
    const def = TSF_TOOLS.find((t) => t.id === tool);
    if (!def) return false;
    this.player.cooldowns[tool] = def.cooldown;
    if (def.useSound) this.playSoundCb?.(def.useSound, 0.55);

    // Tools aim along the CAMERA view direction (the crosshair).
    const cam = this.getPlayerCamDir();

    switch (tool) {
      case 'sword': {
        this.player.swingTimer = TSF_SWING_TIME;
        this.player.swingLanded = false;
        this.playSoundCb?.('tsf_sword_use', 0.55);
        break;
      }
      case 'bomb': {
        const at = this.playerPos.clone();
        this.bombs.push({
          id: `tsf-bomb-${this.nextId++}`,
          position: at,
          timer: TSF_BOMB_FUSE,
          red: false,
          nextFlipIn: 1,
          alive: true,
        });
        this.rev++;
        break;
      }
      case 'bazooka': {
        const origin = this.playerPos.clone();
        origin.y += 1.2;
        origin.addScaledVector(cam, 1.0);
        this.rockets.push({
          id: `tsf-rocket-${this.nextId++}`,
          ownerId: 'player',
          position: origin,
          velocity: cam.clone().multiplyScalar(TSF_ROCKET_SPEED),
          life: TSF_ROCKET_LIFETIME,
          alive: true,
        });
        this.rev++;
        break;
      }
      case 'hook': {
        // fireHook kills the previous hook first (one hook per owner) -
        // re-firing replaces the old hook + rope instantly.
        this.fireHook('player', this.playerPos, cam);
        break;
      }
      case 'staff': {
        // Spec: on use, take the HP needed from all enemies in a 4x4x4
        // region and heal the player TO MAX.
        const missing = Math.max(0, this.player.maxHp - this.player.hp);
        if (missing > 0) {
          const inRange = this.npcs
            .filter((n) => n.alive && n.invincibleFor <= 0
              && n.position.distanceTo(this.playerPos) <= TSF_STAFF_RADIUS)
            .sort((a, b) => a.position.distanceTo(this.playerPos) - b.position.distanceTo(this.playerPos));
          let need = missing;
          for (const npc of inRange) {
            if (need <= 0) break;
            const before = npc.hp;
            const take = Math.min(need, before);
            this.damageNpc(npc.id, take);
            need -= Math.max(0, before - npc.hp);
          }
          const collected = missing - need;
          if (collected > 0) {
            this.player.hp = Math.min(this.player.maxHp, this.player.hp + collected);
            this.onPlayerHurtCb?.(this.player.hp, this.player.maxHp);
          }
        }
        this.rev++;
        break;
      }
    }
    return true;
  }

  // ─── Hooks ───

  /** Shared hook firing (player + NPCs). */
  private fireHook(ownerId: string, fromPos: THREE.Vector3, dir: THREE.Vector3): TSFHook | null {
    // Kill the owner's previous hook first (one hook per owner).
    const old = this.hooks.find((h) => h.ownerId === ownerId && h.alive);
    if (old) old.alive = false;
    const origin = fromPos.clone();
    origin.y += 1.2;
    origin.addScaledVector(dir, 0.8);
    const hook: TSFHook = {
      id: `tsf-hook-${this.nextId++}`,
      ownerId,
      attached: false,
      position: origin,
      velocity: dir.clone().multiplyScalar(TSF_HOOK_SPEED),
      life: TSF_HOOK_LIFETIME,
      ropeFrom: origin.clone(),
      alive: true,
    };
    this.hooks.push(hook);
    if (ownerId === 'player') this.player.hook = hook;
    else {
      const npc = this.npcs.find((n) => n.id === ownerId);
      if (npc) npc.hook = hook;
    }
    this.playSoundCb?.('tsf_hook_shoot', 0.55);
    this.rev++;
    return hook;
  }

  private killHook(hook: TSFHook) {
    hook.alive = false;
    if (hook.ownerId === 'player') {
      if (this.player.hook === hook) this.player.hook = null;
    } else {
      const npc = this.npcs.find((n) => n.id === hook.ownerId);
      if (npc && npc.hook === hook) npc.hook = null;
      if (npc && npc.mode === 'hook-flight') npc.mode = 'chase';
    }
    this.rev++;
  }

  /** Per-frame hook tick: flight, attachment, lifetime, and dragging the
   *  owner toward the anchor. `dt` clamped by the caller. */
  private tickHooks(dt: number) {
    for (const h of this.hooks) {
      if (!h.alive) continue;

      if (!h.attached) {
        // Flight: advance; the rope tail follows the owner's hand.
        this.updateHookRopeFrom(h);
        h.position.addScaledVector(h.velocity, dt);
        h.life -= dt;
        // Attach: the hook center enters a collidable surface. The life
        // keeps counting down from the SAME 10s (no rebill) - attached
        // hooks decay 10s after firing, exactly like the spec.
        if (this.worldHitTest?.(h.position)) {
          h.attached = true;
          h.velocity.set(0, 0, 0);
          this.rev++;
        } else if (h.life <= 0) {
          this.killHook(h);
          continue;
        }
      } else {
        // Attached: hold the anchor, drag the owner through the air.
        h.life -= dt;
        if (h.life <= 0) {
          this.killHook(h);   // mid-drag expiry: the owner just falls
          continue;
        }
        this.dragHookOwner(h, dt);
      }
    }
    this.hooks = this.hooks.filter((h) => h.alive);
    if (this.player.hook && !this.player.hook.alive) this.player.hook = null;
    for (const n of this.npcs) if (n.hook && !n.hook.alive) n.hook = null;
  }

  /** Keep the rope's tool end at the owner's fist height. */
  private updateHookRopeFrom(h: TSFHook) {
    if (h.ownerId === 'player') {
      h.ropeFrom.set(this.playerPos.x, this.playerPos.y + 1.2, this.playerPos.z);
    } else {
      const npc = this.npcs.find((n) => n.id === h.ownerId);
      if (npc) h.ropeFrom.set(npc.position.x, npc.position.y + 1.2, npc.position.z);
    }
  }

  /** Pull the owner toward the hook anchor (mid-air drag). */
  private dragHookOwner(h: TSFHook, dt: number) {
    this.updateHookRopeFrom(h);
    const anchor = h.position;
    if (h.ownerId === 'player') {
      if (!this.player.alive) return;
      const to = anchor.clone().sub(this.playerPos);
      const dist = to.length();
      if (dist > TSF_HOOK_ARRIVE_DIST) {
        to.normalize();
        this.onPlayerDragCb?.(
          this.playerPos.x + to.x * TSF_HOOK_DRAG_SPEED * dt,
          this.playerPos.y + to.y * TSF_HOOK_DRAG_SPEED * dt,
          this.playerPos.z + to.z * TSF_HOOK_DRAG_SPEED * dt,
        );
      }
    } else {
      const npc = this.npcs.find((n) => n.id === h.ownerId);
      if (!npc || !npc.alive) return;
      const to = anchor.clone().sub(npc.position);
      const dist = to.length();
      if (dist > TSF_HOOK_ARRIVE_DIST) {
        if (npc.body) {
          to.normalize();
          // The FULL velocity (3-axis): the drag owns the flight.
          npc.body.velocity.set(
            to.x * TSF_HOOK_DRAG_SPEED,
            to.y * TSF_HOOK_DRAG_SPEED,
            to.z * TSF_HOOK_DRAG_SPEED,
          );
          npc.mode = 'hook-flight';
        }
      } else {
        npc.mode = 'chase';
      }
    }
  }

  /** Host callback: drag the player's physics body to a point (the
   *  manager owns no player body - the host moves it + reports back). */
  private onPlayerDragCb: ((x: number, y: number, z: number) => void) | null = null;
  onPlayerDrag(cb: (x: number, y: number, z: number) => void) { this.onPlayerDragCb = cb; }

  // ─── Damage ───

  /** Apply damage to the player. */
  damagePlayer(amount: number) {
    if (!this.active || !this.player.alive) return;
    if (this.player.invincibleFor > 0) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.onPlayerHurtCb?.(this.player.hp, this.player.maxHp);
    if (this.player.hp <= 0) {
      this.player.alive = false;
      this.player.deaths++;
      // A dying player loses their hook.
      if (this.player.hook) this.killHook(this.player.hook);
      this.onPlayerDieCb?.();
    }
    this.rev++;
  }

  /** Damage an NPC. Handles death, kill credit, the disintegration
   *  debris burst, and body removal. */
  private damageNpc(npcId: string, amount: number) {
    const npc = this.npcs.find((n) => n.id === npcId);
    if (!npc || !npc.alive) return;
    if (npc.invincibleFor > 0) return;
    npc.hp = Math.max(0, npc.hp - amount);
    if (npc.hp <= 0) this.killNpc(npc);
    this.rev++;
  }

  private killNpc(npc: TSFNpc) {
    if (!npc.alive) return;
    npc.alive = false;
    npc.respawnIn = TSF_RESPAWN_DELAY;
    npc.velocity.set(0, 0, 0);
    if (npc.hook) this.killHook(npc.hook);
    // Disintegration debris: one bit per body part + gibs (same recipe
    // as the player's death burst).
    this.spawnDeathBits(npc.position, npc.yaw, [
      { size: [0.44, 0.39, 0.47], color: npc.skin, off: [0, 1.56, 0] },        // head
      { size: [0.44, 0.39, 0.47], color: npc.skin, off: [0, 0.235, 0.118] },   // face
      { size: [0.69, 0.78, 0.47], color: npc.shirt, off: [0, 1.08, 0] },       // torso
      { size: [0.34, 0.76, 0.39], color: npc.skin, off: [-0.45, 1.07, 0] },    // arms
      { size: [0.34, 0.76, 0.39], color: npc.skin, off: [0.45, 1.07, 0] },
      { size: [0.34, 0.69, 0.39], color: npc.pants, off: [-0.19, 0.34, 0] },   // legs
      { size: [0.34, 0.69, 0.39], color: npc.pants, off: [0.19, 0.34, 0] },
    ]);
    this.removeNpcBody(npc);
    // Pass 6: EVERY NPC death ticks the player's kill counter - including
    // NPC-on-NPC "accidents" (their own rocket splash, a mixup bomb) and
    // void falls. The counter is the session scoreboard; there is no other
    // player to credit.
    this.player.kills++;
    this.playSoundCb?.('scream', 0.5);
    this.rev++;
  }

  /** Build the death-debris burst (shared by NPC deaths). */
  private spawnDeathBits(feet: THREE.Vector3, yaw: number, parts: { size: [number, number, number]; color: string; off: [number, number, number] }[]) {
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const mk = (wx: number, wy: number, wz: number, sx: number, sy: number, sz: number, color: string, boost: number) => {
      const outward = Math.atan2(wx - feet.x, wz - feet.z) + (Math.random() - 0.5);
      const speed = 3 + Math.random() * 4 + boost;
      this.deathBits.push({
        id: `tsf-bit-${this.nextId++}`,
        meshPos: new THREE.Vector3(wx, wy, wz),
        vel: new THREE.Vector3(Math.sin(outward) * speed, 3.5 + Math.random() * 4, Math.cos(outward) * speed),
        angVel: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
        size: new THREE.Vector3(sx, sy, sz),
        color,
        life: 1.15,
      });
    };
    for (const p of parts) {
      const wx = feet.x + p.off[0] * cos + p.off[2] * sin;
      const wy = feet.y + p.off[1];
      const wz = feet.z - p.off[0] * sin + p.off[2] * cos;
      mk(wx, wy, wz, p.size[0], p.size[1], p.size[2], p.color, 1.5);
    }
    const gibColors = ['#f8ff6d', '#CC0000', '#2196F3', '#ffffff'];
    for (let i = 0; i < 8; i++) {
      mk(
        feet.x + (Math.random() - 0.5),
        feet.y + 0.4 + Math.random() * 1.4,
        feet.z + (Math.random() - 0.5),
        0.12 + Math.random() * 0.16,
        0.12 + Math.random() * 0.16,
        0.12 + Math.random() * 0.16,
        gibColors[i % gibColors.length],
        0,
      );
    }
  }

  /** An explosion (bomb blast / rocket impact). */
  private explode(position: THREE.Vector3, radius: number) {
    for (const npc of this.npcs) {
      if (!npc.alive) continue;
      if (npc.invincibleFor > 0) continue;
      const d = npc.position.distanceTo(position);
      if (d > radius) continue;
      this.damageNpc(npc.id, tsfBlastDamage(d, radius));
      // Fling survivors (bodies only) - the closer, the harder.
      if (npc.alive && npc.body) {
        const dir = npc.position.clone().sub(position);
        dir.y = 0;
        if (dir.lengthSq() < 0.001) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize();
        const p = tsfBlastPush(d, radius);
        npc.body.velocity.x += dir.x * 16 * p;
        npc.body.velocity.z += dir.z * 16 * p;
        npc.body.velocity.y += 10 * p;
      }
    }
    // The player (never invincible-wrapped: their own bombs hurt them
    // too if they stand in the blast - same as the NPCs).
    if (this.player.alive && this.player.invincibleFor <= 0) {
      const d = this.playerPos.distanceTo(position);
      if (d <= radius) {
        this.damagePlayer(tsfBlastDamage(d, radius));
        if (this.player.alive) this.onPlayerKnockbackCb?.(position, radius, d);
      }
    }
    this.explosions.push({ id: `tsf-boom-${this.nextId++}`, position: position.clone(), radius, age: 0 });
    this.playSoundCb?.('explosion', 0.7);
    this.rev++;
  }

  private onPlayerKnockbackCb: ((from: THREE.Vector3, radius: number, dist: number) => void) | null = null;
  onPlayerKnockback(cb: (from: THREE.Vector3, radius: number, dist: number) => void) { this.onPlayerKnockbackCb = cb; }

  /** The attacker's frontal-cone sword hit. byPlayer=true: the player's
   *  swing (can hit NPCs). byPlayer=false: an NPC's swing (can hit the
   *  player only - the 5 NPCs never fight each other). */
  private resolveSwordHit(origin: THREE.Vector3, fwdX: number, fwdZ: number, byPlayer: boolean) {
    if (byPlayer) {
      for (const npc of this.npcs) {
        if (!npc.alive || npc.invincibleFor > 0) continue;
        const to = npc.position.clone().sub(origin);
        // Pass 6: the sword arc is FLAT - gate the hit on vertical overlap
        // FIRST. No more hitting a player on a tower from the ground.
        if (Math.abs(to.y) > TSF_SWORD_Y_TOLERANCE) continue;
        to.y = 0;
        const dist = to.length();
        if (dist > TSF_SWORD_RANGE) continue;
        if (dist > 0.001) {
          const dot = (fwdX * to.x + fwdZ * to.z) / dist;
          if (dot < Math.cos(TSF_SWORD_ARC)) continue;
        }
        this.damageNpc(npc.id, TSF_SWORD_DAMAGE);
        // Pass 6 (owner's spec): a 50% chance the struck NPC "dodges" -
        // an evasive hop away from the player the instant the blade
        // lands. Replaces the old bazooka-dodge behavior.
        if (npc.alive && npc.body && Math.random() < 0.5) {
          const away = npc.position.clone().sub(this.playerPos);
          away.y = 0;
          if (away.lengthSq() < 0.001) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          away.normalize();
          this.tryNpcJump(npc, 0.5);
          npc.body.velocity.x = away.x * TSF_NPC_SPEED * 1.15;
          npc.body.velocity.z = away.z * TSF_NPC_SPEED * 1.15;
        }
      }
    } else if (this.player.alive && this.player.invincibleFor <= 0) {
      const to = this.playerPos.clone().sub(origin);
      // Pass 6: same vertical gate for NPC swings at the player.
      if (Math.abs(to.y) > TSF_SWORD_Y_TOLERANCE) return;
      to.y = 0;
      const dist = to.length();
      if (dist <= TSF_SWORD_RANGE) {
        let inArc = true;
        if (dist > 0.001) {
          const dot = (fwdX * to.x + fwdZ * to.z) / dist;
          inArc = dot >= Math.cos(TSF_SWORD_ARC);
        }
        if (inArc) this.damagePlayer(TSF_SWORD_DAMAGE);
      }
    }
  }

  // ─── Accessors ───

  /** A RANDOM spawn point (used for the player AND NPC respawns). */
  randomSpawn(): { x: number; y: number; z: number } {
    const s = this.spawns[Math.floor(Math.random() * this.spawns.length)]
      ?? new THREE.Vector3();
    return { x: s.x, y: s.y, z: s.z };
  }

  /**
   * Revive the player immediately on the host's death callback. The host
   * owns the death animation + respawn timing; it asks for a random spawn
   * via getRandomRespawn() and applies it through spawnPointOverride.
   */
  respawnPlayerEarly() {
    this.player.hp = TSF_MAX_HP;
    this.player.alive = true;
    this.player.invincibleFor = TSF_SPAWN_INVINCIBLE;
    this.player.hook = null;
    this.rev++;
  }

  /** Random respawn point for the host to feed spawnPointOverride. */
  getRandomRespawn(): { x: number; y: number; z: number } {
    return this.randomSpawn();
  }

  /**
   * Pass 6: a death the manager can't see coming - the player falling
   * into the void (or any host-side kill outside TSF combat). TSF
   * combat deaths already kill the hook + count the death inside
   * damagePlayer(); the void path went straight to the host's death
   * animation, leaving a live hook + rope hanging in the air and no
   * DEATHS tick (the owner's "string doesn't decay if you die" report).
   * Idempotent per death: it does nothing while the manager's player
   * is already dead. Returns a FRESH random spawn for the respawn
   * teleport, or null when the call was a no-op.
   */
  externalDeath(): { x: number; y: number; z: number } | null {
    if (!this.active) return null;
    if (!this.player.alive) return null;   // already counted (TSF path)
    this.player.hp = 0;
    this.player.alive = false;
    this.player.deaths++;
    if (this.player.hook) this.killHook(this.player.hook);
    // Hand the death back through the SAME flow a TSF death uses: the
    // host plays the animation, then respawns at the returned spawn.
    this.onPlayerDieCb?.();
    return this.randomSpawn();
  }

  getNpc(id: string): TSFNpc | undefined { return this.npcs.find((n) => n.id === id); }

  getPlayerState(): TSFPlayerState { return { ...this.player, cooldowns: { ...this.player.cooldowns } }; }

  getBombs(): ReadonlyArray<TSFBomb> { return this.bombs; }
  getRockets(): ReadonlyArray<TSFRocket> { return this.rockets; }
  getHooks(): ReadonlyArray<TSFHook> { return this.hooks; }
  getExplosions(): ReadonlyArray<TSFExplosion> { return this.explosions; }
  getDeathBits(): ReadonlyArray<TSFDeathBit> { return this.deathBits; }

  getSnapshot(): TSFSnapshot {
    return {
      active: this.active,
      player: this.getPlayerState(),
      npcs: this.npcs.map((n) => ({
        ...n,
        position: n.position.clone(),
        velocity: n.velocity.clone(),
        path: n.path.map((p) => p.clone()),
      })),
      rev: this.rev,
    };
  }

  // ─── Per-frame tick (call from useFrame) ───

  tick(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 1 / 20);

    // Player timers.
    for (const k of Object.keys(this.player.cooldowns)) {
      if (this.player.cooldowns[k] > 0) this.player.cooldowns[k] = Math.max(0, this.player.cooldowns[k] - dt);
    }
    if (this.player.invincibleFor > 0) {
      this.player.invincibleFor = Math.max(0, this.player.invincibleFor - dt);
      if (this.player.invincibleFor === 0) this.rev++;
    }

    // Player sword swing: contact-timed damage.
    if (this.player.swingTimer > 0) {
      this.player.swingTimer = Math.max(0, this.player.swingTimer - dt);
      if (!this.player.swingLanded && this.player.swingTimer <= TSF_SWING_TIME * (1 - TSF_SWING_CONTACT_AT)) {
        this.player.swingLanded = true;
        const cam = this.getPlayerCamDir();
        const fwdX = cam.x, fwdZ = cam.z;
        const n = Math.hypot(fwdX, fwdZ) || 1;
        this.resolveSwordHit(this.playerPos, fwdX / n, fwdZ / n, true);
      }
      this.rev++;
    }

    // Staff regen while held (player).
    if (this.player.selectedTool === 'staff' && this.player.alive && this.player.hp < this.player.maxHp) {
      const before = Math.floor(this.player.hp);
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + TSF_STAFF_REGEN * dt);
      if (Math.floor(this.player.hp) !== before) {
        this.onPlayerHurtCb?.(this.player.hp, this.player.maxHp);
        this.rev++;
      }
    }

    // Hooks (flight / attach / drag / expire).
    this.tickHooks(dt);

    // Player velocity estimate (pro lead aim for NPC rockets).
    this.refreshPlayerVel(dt);

    // Bombs: spec fuse schedule.
    for (const b of this.bombs) {
      if (!b.alive) continue;
      b.timer -= dt;
      b.nextFlipIn -= dt;
      const lastStretch = b.timer <= 2;
      if (b.nextFlipIn <= 0 && b.timer > 0) {
        b.red = !b.red;
        b.nextFlipIn = lastStretch ? 0.25 : 1;
        this.playSoundCb?.('used_tool', 0.3); // the tick
        this.rev++;
      }
      if (b.timer <= 0) {
        b.alive = false;
        this.explode(b.position, TSF_BOMB_RADIUS);
      }
    }
    this.bombs = this.bombs.filter((b) => b.alive);

    // Rockets: fly straight until they hit something or decay.
    for (const r of this.rockets) {
      if (!r.alive) continue;
      r.position.addScaledVector(r.velocity, dt);
      r.life -= dt;
      if (r.life <= 0) {
        r.alive = false;
        this.explode(r.position, TSF_ROCKET_RADIUS);
        continue;
      }
      if (this.worldHitTest && this.worldHitTest(r.position)) {
        r.alive = false;
        this.explode(r.position, TSF_ROCKET_RADIUS);
        continue;
      }
      for (const npc of this.npcs) {
        if (!npc.alive) continue;
        if (r.ownerId === npc.id) continue;   // never collides with its own owner
        if (npc.position.distanceTo(r.position) < 1.4) {
          r.alive = false;
          this.explode(r.position, TSF_ROCKET_RADIUS);
          break;
        }
      }
    }
    this.rockets = this.rockets.filter((r) => r.alive);

    // Explosions age out.
    for (const e of this.explosions) e.age += dt;
    if (this.explosions.length) this.explosions = this.explosions.filter((e) => e.age < 1);

    // Death debris ages out (the renderer animates + fades it).
    for (const b of this.deathBits) b.life -= dt;
    if (this.deathBits.length) this.deathBits = this.deathBits.filter((b) => b.life > 0);

    // NPCs.
    for (const npc of this.npcs) {
      if (npc.attackCooldown > 0) npc.attackCooldown = Math.max(0, npc.attackCooldown - dt);
      if (npc.invincibleFor > 0) npc.invincibleFor = Math.max(0, npc.invincibleFor - dt);
      if (npc.jumpCooldown > 0) npc.jumpCooldown = Math.max(0, npc.jumpCooldown - dt);
      if (!npc.alive) {
        npc.respawnIn = Math.max(0, npc.respawnIn - dt);
        if (npc.respawnIn === 0) this.respawnNpc(npc);
        continue;
      }
      // NPC sword swing: contact-timed damage.
      if (npc.swingTimer > 0) {
        npc.swingTimer = Math.max(0, npc.swingTimer - dt);
        if (!npc.swingLanded && npc.swingTimer <= TSF_SWING_TIME * (1 - TSF_SWING_CONTACT_AT)) {
          npc.swingLanded = true;
          const fwdX = Math.sin(npc.yaw), fwdZ = Math.cos(npc.yaw); // +Z at yaw 0
          this.resolveSwordHit(npc.position, fwdX, fwdZ, false);
        }
        this.rev++;
      }
      // With a body: cannon owns the motion - mirror it into npc.position
      // (feet = center - H/2) before the AI reads it.
      if (npc.body) {
        npc.position.set(npc.body.position.x, npc.body.position.y - TSF_NPC_HITBOX.y / 2, npc.body.position.z);
      }
      // Jumping flag for the renderer's jump pose (airborne = fast vy).
      npc.jumping = npc.body ? Math.abs(npc.body.velocity.y) > 3 : false;
      npc.lastGroundedY = npc.position.y;
      // Void check (fallen / flung off the map). Counts as a kill for
      // the player too (pass 6: every NPC death ticks the scoreboard -
      // most void falls START with an NPC rocket/bomb fling).
      if (npc.position.y < TSF_VOID_Y) {
        this.killNpc(npc);
        this.rev++;
        continue;
      }
      this.tickNpcAi(npc, dt);
    }
  }

  private respawnNpc(npc: TSFNpc) {
    // Random spawn (pass 4: no team towers).
    const spawn = this.spawns[Math.floor(Math.random() * this.spawns.length)]?.clone()
      ?? new THREE.Vector3();
    spawn.x += (Math.random() - 0.5) * 4;
    spawn.z += (Math.random() - 0.5) * 4;
    npc.position.copy(spawn);
    npc.hp = TSF_MAX_HP;
    npc.alive = true;
    npc.invincibleFor = TSF_SPAWN_INVINCIBLE;
    npc.respawnIn = 0;
    npc.mode = 'chase';
    npc.heldTool = null;
    npc.velocity.set(0, 0, 0);
    npc.swingTimer = 0;
    npc.swingLanded = false;
    npc.stuckFor = 0;
    npc.wiggleFor = 0;
    npc.wiggleDir = 1;
    npc.jumpCooldown = 0;
    npc.walkPhase = 0;
    npc.circleAround = null;
    npc.sprintFor = 0;
    npc.path = [];
    npc.pathIndex = 0;
    npc.pathRepaintIn = 0;
    this.addNpcBody(npc);
    if (npc.body) npc.body.velocity.set(0, 0, 0);
    this.rev++;
  }

  // ─── NPC AI ───

  private tickNpcAi(npc: TSFNpc, dt: number) {
    const targetPos = this.player.alive ? this.playerPos : null;
    const targetId: string | null = this.player.alive ? 'player' : null;
    npc.targetId = targetId;

    if (!targetPos) {
      npc.mode = 'chase';
      npc.velocity.set(0, 0, 0);
      this.decayWalk(npc, dt);
      this.applyNpcVelocity(npc);
      return;
    }

    const toTarget = targetPos.clone().sub(npc.position);
    const dist = toTarget.length();
    const heightGap = Math.abs(toTarget.y);
    const toTargetFlat = toTarget.clone(); toTargetFlat.y = 0;
    const flatDist = toTargetFlat.length() || 0.001;
    const desiredYaw = Math.atan2(toTargetFlat.x, toTargetFlat.z); // +Z at 0

    // BOMB FEAR: a live bomb near the NPC overrides everything - run
    // directly away from it (the blast radius + margin is the zone).
    const bomb = this.nearestThreateningBomb(npc.position);
    if (bomb) {
      npc.mode = 'flee-bomb';
      npc.heldTool = null;
      const away = npc.position.clone().sub(bomb.position);
      away.y = 0;
      if (away.lengthSq() < 0.001) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      away.normalize();
      npc.velocity.copy(away).multiplyScalar(TSF_NPC_SPEED);
      npc.yaw = this.lerpAngle(npc.yaw, Math.atan2(away.x, away.z), Math.min(1, dt * 10));
      this.advanceWalk(npc, dt);
      this.applyNpcVelocity(npc);
      return;
    }

    // LOW HP: retreat AWAY from the player while HOLDING THE STAFF (it
    // regens while held) until back above the flee threshold.
    const lowHp = npc.hp / npc.maxHp < TSF_FLEE_HP_PCT && npc.invincibleFor <= 0;
    if (lowHp) {
      npc.mode = 'flee';
      npc.heldTool = 'staff';
      // Staff regen (same rule as the player's).
      npc.hp = Math.min(npc.maxHp, npc.hp + TSF_STAFF_REGEN * dt);
      const away = toTargetFlat.clone().multiplyScalar(-1).normalize();
      npc.velocity.copy(away).multiplyScalar(TSF_NPC_SPEED);
      npc.yaw = this.lerpAngle(npc.yaw, Math.atan2(away.x, away.z), Math.min(1, dt * 10));
      this.advanceWalk(npc, dt);
      this.applyNpcVelocity(npc);
      return;
    }

    // The body faces the target when standing, the move dir when walking.
    npc.yaw = this.lerpAngle(npc.yaw, desiredYaw, Math.min(1, dt * 8));

    // HOOK-FLIGHT: the drag owns the body velocity - the AI would
    // clobber it (this is why NPC hooks "never worked"). Skip the AI
    // entirely until the hook dies or the NPC arrives.
    if (npc.mode === 'hook-flight') {
      this.decayWalk(npc, dt);
      return;
    }

    // Unit direction to the player (flat). Computed once; the ranged,
    // melee and mid-range branches all steer along it.
    const straight = toTargetFlat.clone().normalize();

    // The body faces the target when standing, the move dir when walking.
    npc.yaw = this.lerpAngle(npc.yaw, desiredYaw, Math.min(1, dt * 8));

    // ─── Pass-6 behaviors ───

    // DROPPED THE HOOK (owner's spec): an NPC that switches away from
    // the grappling hook (or holsters it to flee) loses its live hook
    // INSTANTLY, exactly like the player's put-away rule. Otherwise a
    // fleeing NPC kept dragging itself around on a rope nobody could
    // see a reason for.
    if (npc.heldTool !== 'hook' && npc.hook?.alive) {
      this.killHook(npc.hook);
    }

    // DODGE is REMOVED (pass 6, owner's spec: "remove the dodging
    // missile from bazooka feature"). The only dodge left in the game
    // is the 50% sword-hit hop in resolveSwordHit.

    // CIRCLE: the player is swinging a SWORD at close range. The NPC
    // jumps and orbits around the player, staying OUTSIDE the blade
    // arc while still pressing the attack (it circles with its sword
    // out, ready to counter the moment the swing ends).
    const playerSwinging = this.player.swingTimer > 0;
    if (playerSwinging && flatDist <= 5.5) {
      npc.mode = 'circle';
      npc.heldTool = 'sword';
      if (npc.circleAround === null) {
        npc.circleAround = Math.atan2(npc.position.x - targetPos.x, npc.position.z - targetPos.z);
        npc.circleDir = Math.random() < 0.5 ? 1 : -1;
        if (npc.jumpCooldown <= 0) this.tryNpcJump(npc, 0);   // hop as the swing comes in
      }
      // Hold a radius just outside the sword arc (3.2) + a small margin.
      const holdR = TSF_SWORD_RANGE + 0.9;
      const orbitSpeed = 0.9 * Math.PI * 2 * (TSF_NPC_SPEED / holdR); // rad/sec at NPC speed
      npc.circleAround += orbitSpeed * dt * npc.circleDir;
      const cx = targetPos.x + Math.sin(npc.circleAround) * holdR;
      const cz = targetPos.z + Math.cos(npc.circleAround) * holdR;
      const toHold = new THREE.Vector3(cx - npc.position.x, 0, cz - npc.position.z);
      if (toHold.lengthSq() > 0.04) {
        toHold.normalize();
        npc.velocity.copy(toHold).multiplyScalar(TSF_NPC_SPEED);
        npc.yaw = this.lerpAngle(npc.yaw, Math.atan2(toHold.x, toHold.z), Math.min(1, dt * 10));
      } else {
        npc.velocity.set(0, 0, 0);
        npc.yaw = this.lerpAngle(npc.yaw, desiredYaw, Math.min(1, dt * 10));   // face the player
      }
      this.advanceWalk(npc, dt);
      this.applyNpcVelocity(npc);
      return;
    } else if (npc.circleAround !== null && !playerSwinging) {
      npc.circleAround = null;   // the swing is over - back to normal
    }

    // ─── RANGED: fire on the move, keep closing in (pass 5) ───
    // The bazooka is the FAVORED tool: it's used from 10..70 studs out,
    // at any height. The hook is the specialist tool: only when the
    // player is far away AND there's a clear anchor cast - a wall, a
    // tower side, or the ground the hook can bite into between the NPC
    // and the player. Both fire WHILE WALKING toward the player; the
    // AI never stands still at range anymore.
    // Pass 6: canSeePlayer is a TRUE 3D line-of-sight now. The old
    // height-gap escape hatch let NPCs fire rockets and hooks
    // straight through walls whenever the player was on a different
    // height - that's the owner's "they try to shoot through walls"
    // report. No more: a wall between the NPC and the player means no
    // shot; the AI closes in instead.
    const canSeePlayer = !this.straightBlocked(npc.position, targetPos);
    if (flatDist > 10 && flatDist <= 70 && canSeePlayer && npc.invincibleFor <= 0) {
      npc.mode = 'ranged';

      // Walk toward the player (closing in, per the owner's spec).
      let dir: THREE.Vector3;
      const needsPath = heightGap > 3 || this.straightBlocked(npc.position, targetPos);
      if (needsPath) {
        if (npc.pathRepaintIn <= 0) {
          npc.path = this.computePath(npc.position, targetPos);
          npc.pathIndex = 0;
          npc.pathRepaintIn = 1.2;
        }
        npc.pathRepaintIn = Math.max(0, npc.pathRepaintIn - dt);
        const wp = this.nextWaypoint(npc);
        if (wp) {
          const toWp = wp.clone().sub(npc.position);
          toWp.y = 0;
          dir = toWp.lengthSq() > 1 ? toWp.normalize() : straight;
        } else dir = straight;
      } else {
        npc.path = [];
        npc.pathIndex = 0;
        dir = straight;
      }
      dir = this.avoidEdge(npc, dir, targetPos) ?? dir;
      npc.velocity.copy(dir).multiplyScalar(TSF_NPC_SPEED);
      npc.yaw = this.lerpAngle(npc.yaw, Math.atan2(dir.x, dir.z), Math.min(1, dt * 10));
      this.advanceWalk(npc, dt);
      this.applyNpcVelocity(npc);

      // ── Tool choice: BAZOOKA first (favored), hook as the specialist ──
      // Pro aim: lead the target's motion (the player keeps moving
      // while the rocket flies).
      const leadT = flatDist / TSF_ROCKET_SPEED;
      const aimAt = targetPos.clone()
        .addScaledVector(this.lastPlayerVel(), leadT * 0.85);
      aimAt.y += 1.2;   // chest height

      const hookClear = flatDist > TSF_HOOK_NPC_MIN_RANGE + 8
        && this.hookAnchorCastClear(npc.position, targetPos);
      const useHook = flatDist > TSF_HOOK_NPC_RANGE && hookClear;

      if (useHook) {
        npc.heldTool = 'hook';
        if (npc.attackCooldown <= 0 && !npc.hook) {
          // Pro hook cast: aim at a surface that will actually catch the
          // hook - the ground/platform just BEHIND the player on their
          // side, so the drag pulls the NPC right at them.
          const aim = this.proHookAim(npc.position, targetPos);
          if (aim) {
            this.fireHook(npc.id, npc.position, aim);
            npc.attackCooldown = TSF_HOOK_COOLDOWN + Math.random() * 2;
          }
        }
      } else {
        npc.heldTool = 'bazooka';
        if (npc.attackCooldown <= 0) {
          const aim = aimAt.clone().sub(npc.position);
          aim.normalize();
          const origin = npc.position.clone();
          origin.y += 1.2;
          origin.addScaledVector(aim, 1.0);
          this.rockets.push({
            id: `tsf-rocket-${this.nextId++}`,
            ownerId: npc.id,
            position: origin,
            velocity: aim.multiplyScalar(TSF_ROCKET_SPEED),
            life: TSF_ROCKET_LIFETIME,
            alive: true,
          });
          this.playSoundCb?.('tsf_bazooka_shoot', 0.4);
          npc.attackCooldown = TSF_ROCKET_COOLDOWN + Math.random() * 1.5;
          this.rev++;
        }
      }
      return;
    }

    // MELEE (near): sword, or plant a bomb when the player is standing
    // still (occupied) at close range.
    if (flatDist <= 2.6) {
      npc.mode = 'attack';
      npc.heldTool = 'sword';
      npc.velocity.set(0, 0, 0);
      this.decayWalk(npc, dt);
      this.applyNpcVelocity(npc);
      if (npc.attackCooldown <= 0 && npc.swingTimer <= 0) {
        npc.attackCooldown = TSF_SWORD_COOLDOWN + Math.random() * 0.4;
        npc.swingTimer = TSF_SWING_TIME;
        npc.swingLanded = false;
        this.playSoundCb?.('tsf_sword_use', 0.25);
      }
      // Bomb mixup: occasionally plant one at the player's feet.
      if (npc.attackCooldown <= 0 && Math.random() < 0.012) {
        this.bombs.push({
          id: `tsf-bomb-${this.nextId++}`,
          position: npc.position.clone(),
          timer: TSF_BOMB_FUSE,
          red: false,
          nextFlipIn: 1,
          alive: true,
        });
        npc.attackCooldown = TSF_BOMB_COOLDOWN;
        this.rev++;
      }
      return;
    }

    // MID RANGE (2.6..10, or unreachable-ranged leftovers): path toward
    // the player.
    npc.mode = 'chase';
    npc.heldTool = flatDist > 12 ? 'bazooka' : 'sword';
    let dir: THREE.Vector3;

    // Pathfinding: A* over the walk graph when the straight line is
    // blocked or the target is on another level; otherwise straight.
    // (`straight` is declared before the ranged branch above.)
    const needsPath = heightGap > 3 || this.straightBlocked(npc.position, targetPos);
    if (needsPath) {
      if (npc.pathRepaintIn <= 0) {
        npc.path = this.computePath(npc.position, targetPos);
        npc.pathIndex = 0;
        npc.pathRepaintIn = 1.2;   // re-path at ~0.8 Hz
      }
      npc.pathRepaintIn = Math.max(0, npc.pathRepaintIn - dt);
      const wp = this.nextWaypoint(npc);
      if (wp) {
        const toWp = wp.clone().sub(npc.position);
        toWp.y = 0;
        if (toWp.lengthSq() > 1) dir = toWp.normalize();
        else dir = straight;
      } else dir = straight;
    } else {
      npc.path = [];
      npc.pathIndex = 0;
      dir = straight;
    }

    // EDGE AVOIDANCE: never walk off the baseplate / platform edges.
    // Probe the ground ~2.5 studs ahead; if there's none, steer along
    // the edge (rotate the direction 90° toward the target side).
    dir = this.avoidEdge(npc, dir, targetPos) ?? dir;

    // Unstick: sidestep when pinned (a wall between us and the target).
    if (npc.wiggleFor > 0) {
      npc.wiggleFor -= dt;
      const side = new THREE.Vector3(-dir.z * npc.wiggleDir, 0, dir.x * npc.wiggleDir);
      dir = side.normalize();
    } else if (npc.stuckFor >= 0.8) {
      npc.wiggleDir = Math.random() < 0.5 ? 1 : -1;
      npc.wiggleFor = 0.7;
      npc.stuckFor = 0;
      // Pinned against a wall: also try a jump (vault the lip).
      this.tryNpcJump(npc, 1);
    }
    npc.stuckProbe = npc.stuckProbe ?? { x: npc.position.x, z: npc.position.z, t: 0 };
    npc.stuckProbe.t += dt;
    if (npc.stuckProbe.t >= 0.8) {
      const moved = Math.hypot(npc.position.x - npc.stuckProbe.x, npc.position.z - npc.stuckProbe.z);
      if (moved < 0.8) npc.stuckFor += npc.stuckProbe.t;
      else npc.stuckFor = 0;
      npc.stuckProbe = { x: npc.position.x, z: npc.position.z, t: 0 };
    }

    // APPROACH THE PLAYER'S HOOK (pass 5): the player's hook is flying
    // toward something - the NPC steers to converge with the anchor
    // spot, i.e. walks toward where the hook is going to bite.
    const playerHook = this.hooks.find(
      (hh) => hh.ownerId === 'player' && hh.alive && !hh.attached,
    );
    if (playerHook) {
      const spot = playerHook.position.clone().addScaledVector(playerHook.velocity, 0.35); // ~0.35s ahead
      const toSpot = spot.clone().sub(npc.position);
      toSpot.y = 0;
      if (toSpot.length() > 4) {
        const blended = dir.clone().add(toSpot.normalize().multiplyScalar(0.8));
        if (blended.lengthSq() > 0.001) dir = blended.normalize();
      }
    }

    // SPRINT (pass 5): far away + a clear straight line = SPRINT. The
    // owner's spec: NPCs close distance like they mean it (their sprint
    // is ABOVE the player's walk speed).
    const farSprint = flatDist > 26
      && !needsPath
      && Math.abs(toTarget.y) < 4;
    npc.sprintFor = farSprint ? 0.4 : 0;
    const speed = farSprint ? TSF_NPC_SPRINT_SPEED : TSF_NPC_SPEED;

    // Mid-range jump: hopping while closing in keeps the pressure on and
    // clears small lips. Pass 5: MORE often (the owner wants lively
    // NPCs), and always a hop on the final approach.
    if (npc.jumpCooldown <= 0 && flatDist > 4 && flatDist < 30 && Math.random() < 0.05) {
      this.tryNpcJump(npc, 0);
    }

    npc.velocity.copy(dir).multiplyScalar(speed);
    npc.yaw = this.lerpAngle(npc.yaw, Math.atan2(dir.x, dir.z), Math.min(1, dt * 10));
    this.advanceWalk(npc, dt);
    this.applyNpcVelocity(npc);
  }

  /** A* over the walk graph, returned as world points (node positions). */
  private computePath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    if (this.walkGraph.nodes.length === 0) return [];
    const a = this.walkGraph.nearest(from);
    const b = this.walkGraph.nearest(to);
    const idx = this.walkGraph.find(a, b);
    if (!idx) return [];
    const out: THREE.Vector3[] = [];
    for (const i of idx) out.push(this.walkGraph.nodes[i].clone());
    return out;
  }

  /** The next waypoint worth steering at (skips ones we've passed). */
  private nextWaypoint(npc: TSFNpc): THREE.Vector3 | null {
    while (npc.pathIndex < npc.path.length) {
      const wp = npc.path[npc.pathIndex];
      const flat = new THREE.Vector3(wp.x - npc.position.x, 0, wp.z - npc.position.z);
      if (flat.lengthSq() <= 4 && Math.abs(wp.y - npc.position.y) < 2.5) {
        npc.pathIndex++;
        continue;
      }
      return wp;
    }
    return null;
  }

  /** Coarse straight-line blockage test (sampled). */
  private straightBlocked(from: THREE.Vector3, to: THREE.Vector3): boolean {
    if (!this.worldHitTest) return false;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 2) return false;
    dir.normalize();
    const steps = Math.min(24, Math.max(4, Math.floor(len / 1.5)));
    for (let i = 1; i < steps; i++) {
      const p = from.clone().addScaledVector(dir, (len * i) / steps);
      p.y += 1.0; // chest height
      if (this.worldHitTest(p)) return true;
    }
    return false;
  }

  /**
   * Edge avoidance: probe the ground under the spot ~2.5 studs ahead. If
   * there is none (the baseplate/platform ends), rotate the direction
   * along the edge. Returns null when the direction is safe as-is.
   */
  private avoidEdge(npc: TSFNpc, dir: THREE.Vector3, targetPos: THREE.Vector3): THREE.Vector3 | null {
    if (!this.groundProbe) return null;
    const ahead = npc.position.clone().addScaledVector(dir, 2.5);
    const ground = this.groundProbe(ahead.x, ahead.z, npc.position.y + 1.5);
    if (ground !== null && Math.abs(ground - npc.position.y) < 4) return null; // safe drop/walk
    // The path leaves the surface: slide along the edge instead. Pick the
    // side that keeps heading toward the target.
    const tRight = new THREE.Vector3(-dir.z, 0, dir.x);
    const tLeft = new THREE.Vector3(dir.z, 0, -dir.x);
    const toT = targetPos.clone().sub(npc.position);
    const favorRight = toT.dot(tRight) >= toT.dot(tLeft);
    for (const cand of favorRight ? [tRight, tLeft] : [tLeft, tRight]) {
      const probe = npc.position.clone().addScaledVector(cand, 2.5);
      const g = this.groundProbe(probe.x, probe.z, npc.position.y + 1.5);
      if (g !== null && Math.abs(g - npc.position.y) < 4) return cand.normalize();
    }
    // Both sides drop off (a narrow spur): just stop.
    return new THREE.Vector3(0, 0, 0);
  }

  /** Real jump impulse onto the NPC's cannon body. */
  private tryNpcJump(npc: TSFNpc, boost: number) {
    if (!npc.body || npc.jumpCooldown > 0) return;
    if (Math.abs(npc.body.velocity.y) > 3) return; // already airborne
    npc.body.velocity.y = TSF_NPC_JUMP_SPEED + boost;
    npc.jumpCooldown = 1.2 + Math.random() * 0.8;
    npc.jumping = true;
    this.playSoundCb?.('jump', 0.2);
    this.rev++;
  }

  /** Walk cycle driven by DISTANCE (like the player renderer). */
  private advanceWalk(npc: TSFNpc, dt: number) {
    const speed = Math.hypot(npc.velocity.x, npc.velocity.z);
    npc.walkPhase += speed * dt * 1.6;
  }

  /** Settle the walk to a stop. */
  private decayWalk(npc: TSFNpc, dt: number) {
    if (Math.abs(npc.walkPhase) < 0.05) { npc.walkPhase = 0; return; }
    npc.walkPhase *= Math.max(0, 1 - dt * 6);
  }

  /** The closest LIVE bomb within the danger margin, or null. */
  private nearestThreateningBomb(from: THREE.Vector3): TSFBomb | null {
    let best: TSFBomb | null = null;
    let bestD = Infinity;
    for (const b of this.bombs) {
      if (!b.alive) continue;
      const d = b.position.distanceTo(from);
      if (d < TSF_BOMB_RADIUS + 3 && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** The player's last observed velocity (a small EMA; also recorded in
   *  tick() every frame). Used for pro lead aim. */
  private lastPlayerVelCache = new THREE.Vector3();
  private lastPlayerVelAnchor: THREE.Vector3 | null = null;
  private lastPlayerVel(): THREE.Vector3 {
    // The caller wants a read-only reference; refresh is done in tick().
    return this.lastPlayerVelCache;
  }
  private refreshPlayerVel(dt: number) {
    if (dt <= 0) return;
    // First call: just seed the anchor, no velocity yet.
    if (this.lastPlayerVelAnchor === null) {
      this.lastPlayerVelAnchor = this.playerPos.clone();
      return;
    }
    const inst = new THREE.Vector3(
      (this.playerPos.x - this.lastPlayerVelAnchor.x) / dt,
      0,   // flat aim only - vertical lead fights the arc
      (this.playerPos.z - this.lastPlayerVelAnchor.z) / dt,
    );
    // Clamp to sane values (teleports shouldn't fake a 500-stud sprint).
    if (inst.length() > 30) inst.setLength(30);
    this.lastPlayerVelCache.lerp(inst, Math.min(1, dt * 6));
    this.lastPlayerVelAnchor.copy(this.playerPos);
  }

  /**
   * The player's rocket inbound on this NPC, if any: returns the
   * rocket's unit flight direction + which side this NPC should
   * sidestep to (the side it's ALREADY off the line by). NPCs do NOT
   * dodge NPC rockets (those are friendly). Only rockets that would
   * arrive within ~1.6s count - later ones get re-checked each frame.
   * REMOVED pass 6 (owner's spec): the bazooka-dodge behavior is gone;
   * nothing calls this anymore. Kept out entirely.
   */

  /**
   * Pro hook cast precondition: is there a surface for the hook to
   * BITE between here and the player (or just beyond them)? Samples
   * the flight line at chest height; true if any sample is inside
   * geometry. Without this, NPCs wasted hooks into the open air.
   */
  private hookAnchorCastClear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    if (!this.worldHitTest) return false;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 4) return false;
    dir.normalize();
    const steps = Math.min(30, Math.max(6, Math.floor(len / 1.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p = from.clone().addScaledVector(dir, len * t);
      p.y += 1.2;   // chest height on the flight line
      if (i === steps) {
        // The last sample: try a hair PAST the player too - the tower
        // side behind them is the anchor that actually catches.
        const past = from.clone().addScaledVector(dir, len * t + 2.2);
        past.y += 1.2;
        if (this.worldHitTest(p) || this.worldHitTest(past)) return true;
        continue;
      }
      if (this.worldHitTest(p)) return true;
    }
    return false;
  }

  /**
   * Pro hook aim: pick the exact direction that lands the hook ON a
   * surface (the first geometry the flight ray from the NPC's fist
   * hits, biased toward the player's tower). Returns null when nothing
   * catches within range - the AI then doesn't waste the shot.
   */
  private proHookAim(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 | null {
    if (!this.worldHitTest) return null;
    const origin = from.clone();
    origin.y += 1.2;
    // Candidate directions: straight at the player's chest, plus a few
    // pitched variants (their tower side is usually up-slope).
    const base = to.clone().sub(origin);
    const len = base.length();
    if (len < 4) return null;
    const forward = base.clone().normalize();
    const cands: THREE.Vector3[] = [forward];
    const right = new THREE.Vector3(-forward.z, 0, forward.x).normalize();
    for (const pitch of [0.25, 0.45, 0.7]) {
      cands.push(forward.clone().addScaledVector(right, 0).setY(forward.y + pitch).normalize());
      cands.push(forward.clone().addScaledVector(right, pitch * 0.6).setY(forward.y + pitch * 0.5).normalize());
      cands.push(forward.clone().addScaledVector(right, -pitch * 0.6).setY(forward.y + pitch * 0.5).normalize());
    }
    cands.push(new THREE.Vector3(forward.x, forward.y + 0.9, forward.z).normalize());
    for (const c of cands) {
      // Walk the ray; the first hit within TSF_HOOK_LIFETIME * speed
      // that ISN'T the NPC's own body column is our anchor.
      for (let d = 2; d < Math.min(TSF_HOOK_SPEED * TSF_HOOK_LIFETIME, len + 8); d += 1.1) {
        const p = origin.clone().addScaledVector(c, d);
        if (this.worldHitTest(p)) {
          // Ignore hits within 2.5 of the NPC (its own platform lip).
          if (p.distanceTo(origin) < 2.5) break;
          return c;
        }
      }
    }
    return null;
  }

  /**
   * Shared rocket firing (player + NPC). Kept inline at the call sites
   * (they differ in origin), but the owner tag + sound live here for
   * the NPC path.
   */

  /** Push the AI's desired horizontal velocity into the world. */
  private applyNpcVelocity(npc: TSFNpc) {
    if (npc.body) {
      npc.body.velocity.x = npc.velocity.x;
      npc.body.velocity.z = npc.velocity.z;
    } else {
      npc.position.x += npc.velocity.x * (1 / 60);
      npc.position.z += npc.velocity.z * (1 / 60);
    }
  }

  private lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  private makeNpc(): TSFNpc {
    // Start at a random spawn (pass 4: no team assignment).
    const spawn = this.spawns[Math.floor(Math.random() * this.spawns.length)]?.clone()
      ?? new THREE.Vector3();
    spawn.x += (Math.random() - 0.5) * 4;
    spawn.z += (Math.random() - 0.5) * 4;
    const av = randomAvatar();
    return {
      id: `tsf-npc-${this.nextId++}`,
      position: spawn,
      yaw: Math.random() * Math.PI * 2,
      velocity: new THREE.Vector3(),
      hp: TSF_MAX_HP,
      maxHp: TSF_MAX_HP,
      alive: true,
      attackCooldown: 0,
      invincibleFor: TSF_SPAWN_INVINCIBLE,
      respawnIn: 0,
      mode: 'chase',
      heldTool: null,
      swingTimer: 0,
      swingLanded: false,
      skin: av.skin,
      shirt: av.shirt,
      pants: av.pants,
      face: av.face,
      walkPhase: 0,
      jumping: false,
      jumpCooldown: 0,
      lastGroundedY: spawn.y,
      circleAround: null,
      circleDir: 1,
      sprintFor: 0,
      targetId: null,
      stuckFor: 0,
      wiggleFor: 0,
      wiggleDir: 1,
      path: [],
      pathIndex: 0,
      pathRepaintIn: 0,
    };
  }
}
