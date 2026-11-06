// ═══════════════════════════════════════════════════════════════════
// WeildBuild - Build to Survive: the pre-added game's client simulation.
// ═══════════════════════════════════════════════════════════════════
// Self-contained building + disaster-survival system that activates inside
// StudioPlayViewport when gameMode === 'build-to-survive'. Mirrors the
// Tower Sword Fight pattern: a plain class that ticks in useFrame, reads
// the player's live transform through a bridge, and drives the studio
// store / physics world for damage + placed-block collision.
//
// PHASES: build (2:30, claim a plot, place/break parts, saves to the
// device) -> disaster (one of 7: tsunami, flood, meteorites, acid rain,
// zombies, the ground is lava, tornado; lasts 20s) -> next round (keep your build).
//
// PLACED BLOCKS are real studio objects added via useStudioStore.addObject,
// so the existing PartMesh renders them and rebuildIfNeeded() (which fires
// when the store's object count changes) gives them physics colliders -
// players stand on them with no manual body juggling. The manager keeps a
// parallel Map of the blocks it owns (name prefix 'bts_placed_') for
// save/load, break targets, and stack-height queries.
//
// MULTIPLAYER (pass 12, fix 3): when StudioPlayViewport links the manager
// to a live game session (setNetwork + lib/bts-net), the manager switches
// to NETWORK mode: the server (gamehost bts-rooms.ts) owns the phases,
// the disasters, the zombies, every player's hp and the plot claims, and
// this client only (a) applies the bts:state snapshots, (b) mirrors the
// blocks that arrive via the game:state partUpdates channel into its
// placed-block map (same render + collision path as solo), and (c) sends
// place/break/rotate/claim requests. Test Play and offline sessions run
// the full local simulation exactly as before.

import * as THREE from 'three';
import { useStudioStore } from './studio-store';
import type { BtsServerState, BtsAction } from './bts-net';
import {
  BTS_PLOTS, BTS_DISASTER, BTS_DISASTERS, BTS_DISASTER_NAMES,
  type BtsPlot, type BtsDisasterId,
} from '@/data/buildToSurviveArena';
import { BTS_PARTS, type BtsPartDef, type BtsToolId } from '@/data/buildToSurviveItems';

// ─── Constants ───
const BTS_MAX_HP = 100;
const BTS_INVINCIBLE = 3;          // spawn invincibility (s)
const BTS_BUILD_TIME = BTS_DISASTER.BUILD_TIME_SECONDS;     // 150 (2:30)
const BTS_DISASTER_TIME = 20;      // survive this long (pass 11: 20s)
const BTS_BLOCK_SIZE = 1;          // grid cell size
const BTS_BREAK_HOLD = 2;          // hold to break (s) - spec
const BTS_PLACE_COOLDOWN = 0.18;   // anti-spam between placements (s)
const BTS_REACH = 7;               // pass 11: raycast reach (blocks)
const BTS_PLOT_FLOOR = 0.625;      // pass 11: plot slab top - blocks rest on it

// Zombie tuning (spec: 20 zombies, 20 dmg on touch, forest-green + plain shirt + camo pants + spooked face)
const BTS_ZOMBIE_COUNT = BTS_DISASTER.ZOMBIE_COUNT;
const BTS_ZOMBIE_SPEED = 4.5;
const BTS_ZOMBIE_TOUCH = 1.7;      // touch range
const BTS_ZOMBIE_DMG = 20;         // spec
const BTS_ZOMBIE_HIT_CD = 1.0;     // per-zombie attack cooldown
const BTS_ZOMBIE_SOUND_INTERVAL = 5; // random groan every ~5s
const BTS_ZOMBIE_SPAWN = BTS_DISASTER.ZOMBIE_SPAWN;

// Disasters
const BTS_TSUNAMI_SPEED = 14;      // z-units/sec the wall advances
const BTS_TSUNAMI_DMG = 40;        // per second caught in the water
const BTS_FLOOD_RISE = 8;          // y-units/sec the flood rises
const BTS_FLOOD_DMG = 12;          // per second submerged
const BTS_METEORITE_INTERVAL = 1.2;// spawn a meteorite every ~1.2s
const BTS_METEORITE_SPEED_MIN = 28;
const BTS_METEORITE_SPEED_MAX = 55;
const BTS_METEORITE_RADIUS = 5;    // explosion radius (like TSF bomb)
const BTS_METEORITE_DMG = 60;      // at centre
const BTS_ACID_DMG = 10;           // per second sky-exposed (spec)
const BTS_LAVA_DMG = 12;           // per second on the baseplate (spec)
const BTS_TORNADO_SPEED = 7;       // wander speed
const BTS_TORNADO_PULL = 18;       // pull strength
const BTS_TORNADO_PULL_RANGE = 22; // starts pulling within this
const BTS_TORNADO_KILL = 3.2;      // touch = death

// The zombie avatar (spec: forest green skin, plain shirt, camo pants, spooked face).
export const BTS_ZOMBIE_AVATAR = {
  face: 'FACE-3',     // Spooked Face
  skin: '#228B22',    // forest green
  shirt: 'SHIRT-9',   // Plain Shirt
  left_leg: 'PANTS-3',// camo (#556B2F)
  right_leg: 'PANTS-3',
};

// ─── Bridges (host writes these each frame; the manager reads them) ───
export interface BtsPlayerBridge {
  x: number; y: number; z: number;
  bodyYaw: number;
  camDir: [number, number, number]; // camera look direction (normalized)
  grounded: boolean;
}
export const BTS_PLAYER_BRIDGE: BtsPlayerBridge = {
  x: 0, y: 0, z: 0, bodyYaw: 0, camDir: [0, 0, -1], grounded: true,
};

export const BTS_AIM: { camera: THREE.Camera | null; dom: HTMLElement | null } = {
  camera: null, dom: null,
};
export function setBtsAimCamera(camera: THREE.Camera | null, dom: HTMLElement | null) {
  BTS_AIM.camera = camera;
  BTS_AIM.dom = dom;
}

// pass 11: the right-arm override ref (mirrors TSF_ARM_OVERRIDE). The held-
// tool renderer writes the tool-hold angle here each frame; WeildBuildCharacter
// (the player) reads it via rightArmRotationRef and overrides the walk anim.
export const BTS_ARM_OVERRIDE: { current: number | null } = { current: null };

// ─── Types ───
export type BtsPhase = 'build' | 'disaster' | 'ended';
export type BtsMode = 'place' | 'break' | 'wrench' | null;

export interface BtsPlacedBlock {
  id: string;
  shape: BtsPartDef['shape'];
  color: string;
  cell: [number, number];     // integer grid cell [cx, cz]
  y: number;                  // centre y
  sizeY: number;
  rot: [number, number, number]; // pass 11: wrench rotation (Euler XYZ degrees)
}

export interface BtsZombie {
  id: number;
  x: number; y: number; z: number;
  yaw: number;
  swingT: number;             // arm-swing animation timer (0..1), >0 while attacking
  hitCd: number;              // attack cooldown
  soundCd: number;            // random groan cooldown
  alive: boolean;
}

export interface BtsMeteorite { id: number; x: number; y: number; z: number; vy: number; }
export interface BtsExplosion { id: number; x: number; y: number; z: number; t: number; }
export interface BtsGhost {
  visible: boolean; valid: boolean; mode: BtsMode;
  shape: BtsPlacedBlock['shape']; color: string;
  x: number; y: number; z: number; sizeY: number;
  breakId: string | null; breakProgress: number; // 0..1
  // pass 11: raycast-driven placement target + wrench selection.
  placeCx: number; placeCy: number; placeCz: number;
  wrenchId: string | null;
}

export interface BtsDisasterState {
  id: BtsDisasterId | null;
  name: string;
  t: number;                   // elapsed in disaster phase
  // visuals:
  tsunamiZ: number;            // the wall's current z
  floodY: number;              // the flood water's current top y
  meteorites: BtsMeteorite[];
  explosions: BtsExplosion[];
  tornado: { x: number; z: number; t: number } | null;
  rain: boolean;
  lava: boolean;
}

export interface BtsSnapshot {
  active: boolean;
  phase: BtsPhase;
  buildTimer: number;          // seconds left in build phase
  disasterT: number;           // seconds left in disaster phase
  round: number;
  claimedPlotId: string | null;
  mode: BtsMode;
  selectedPartId: string | null;
  // pass 11: tool + wrench selection + plot proximity + claimer name.
  tool: BtsToolId | null;
  wrenchSelectedId: string | null;
  currentPlotId: string | null;   // plot the player is standing in (claim pop-up)
  claimerName: string;            // who claimed the local player's plot (labels)
  claims: Record<string, string>; // pass 12: plotId -> username (multiplayer labels)
  onlineCount: number;            // pass 12: players in the room (multiplayer HUD)
  ghost: BtsGhost;
  disaster: BtsDisasterState;
  zombies: BtsZombie[];
  player: { hp: number; max: number; alive: boolean; deaths: number; survived: number };
  rev: number;
}

// ─── Helpers ───
function gridSnap(v: number): number { return Math.round(v / BTS_BLOCK_SIZE) * BTS_BLOCK_SIZE; }

/** Which plot (if any) contains a horizontal position. */
export function btsPlotAt(x: number, z: number): BtsPlot | null {
  for (const p of BTS_PLOTS) {
    if (x >= p.xMin && x <= p.xMax && z >= p.zMin && z <= p.zMax) return p;
  }
  return null;
}

/** Build a studio object for a placed part (added via addObject -> auto render + collide). */
let btsIdCounter = 1;
function makePlacedPart(def: BtsPartDef, cx: number, cy: number, cz: number, rot: [number, number, number] = [0, 0, 0]): any {
  const id = `bts_placed_${Date.now().toString(36)}_${btsIdCounter++}`;
  const isSphere = def.shape === 'Sphere';
  const isWedge = def.shape === 'Wedge';
  return {
    id,
    name: `bts_placed_${def.id}`,
    type: def.shape,
    position: { x: cx, y: cy, z: cz },
    size: { x: BTS_BLOCK_SIZE, y: BTS_BLOCK_SIZE, z: BTS_BLOCK_SIZE },
    rotation: { x: rot[0], y: rot[1], z: rot[2] },
    color: def.color,
    material: 'Plastic',
    transparency: 0,
    reflectance: 0,
    anchored: true,
    canCollide: true,
    friction: 0.5,
    elasticity: 0.2,
    density: 1,
    bodyMovers: [],
    effects: [],
    isSpawnPoint: false,
    isBaseplate: false,
    children: [],
    parentId: null,
    _bts: true, // tag (non-enumerable-ish; harmless if persisted)
    // sphere/wedge renderers read size as full extents, same as studio blocks
    _shape: def.shape,
  };
}

// ═══════════════════════════════════════════════════════════════════
// The manager
// ═══════════════════════════════════════════════════════════════════
export class BuildToSurviveManager {
  active = false;
  started = false;

  phase: BtsPhase = 'build';
  buildTimer = BTS_BUILD_TIME;
  disasterT = 0;
  round = 1;

  claimedPlot: BtsPlot | null = null;
  placed = new Map<string, BtsPlacedBlock>();   // id -> block record (manager-owned)

  mode: BtsMode = null;
  selectedPartId: string | null = null;
  // pass 11: the active tool (hammer/pickaxe/wrench) + the wrench-selected
  // block + the local player's name (drives the plot-claim labels).
  tool: BtsToolId | null = null;
  wrenchSelectedId: string | null = null;
  localUsername = 'You';
  claimerName = '';
  /** pass 12 (fix 4): last pointer position on the canvas in NDC
   *  (-1..1, +y up). Written by the host on pointer move/down; the aim
   *  raycast unprojects THROUGH it so place/break/select act where the
   *  player actually clicked ("click anywhere"), not at the crosshair.
   *  Null until the first pointer event - then the aim falls back to the
   *  camera look direction. */
  pointerNdc: { x: number; y: number } | null = null;
  private placeCd = 0;
  private breakHoldId: string | null = null;
  private breakHoldT = 0;

  zombies: BtsZombie[] = [];
  private zombieId = 1;
  private meteoriteId = 1;
  private explosionId = 1;
  meteorites: BtsMeteorite[] = [];
  explosions: BtsExplosion[] = [];
  tornado: { x: number; z: number; t: number; dx: number; dz: number } | null = null;

  // ─── pass 12 (fix 3): multiplayer state ───
  // True while a gamehost session drives the phases/disasters/zombies/hp
  // (see lib/bts-net). The local simulation is suspended; snapshots rule.
  netMode = false;
  private sendAction: ((action: BtsAction) => void) | null = null;
  private storeUnsub: (() => void) | null = null;
  private claims: Record<string, string> = {};
  onlineCount = 1;
  private seenExplosionIds = new Set<number>();

  disaster: BtsDisasterState = {
    id: null, name: '', t: 0,
    tsunamiZ: 0, floodY: 0, meteorites: [], explosions: [],
    tornado: null, rain: false, lava: false,
  };

  player = { hp: BTS_MAX_HP, max: BTS_MAX_HP, alive: true, deaths: 0, survived: 0 };
  private invincibleFor = BTS_INVINCIBLE;
  private playerPos = new THREE.Vector3();
  private camDir = new THREE.Vector3();

  rev = 0;

  // callbacks (wired by the host)
  private onPlayerHurtCb?: (hp: number, max: number) => void;
  private onPlayerDieCb?: () => void;
  private onPhaseCb?: (phase: BtsPhase, disaster: BtsDisasterId | null) => void;
  private playSoundCb?: (name: string, vol?: number) => void;

  onPlayerHurt(cb: (hp: number, max: number) => void) { this.onPlayerHurtCb = cb; }
  onPlayerDie(cb: () => void) { this.onPlayerDieCb = cb; }
  onPhaseChange(cb: (phase: BtsPhase, disaster: BtsDisasterId | null) => void) { this.onPhaseCb = cb; }
  setPlaySound(cb: (name: string, vol?: number) => void) { this.playSoundCb = cb; }
  setLocalUsername(name: string) { this.localUsername = name; }

  // ─── pass 12 (fix 3): multiplayer mode ───

  /**
   * Link/unlink the manager to a live gamehost session. With a sender the
   * manager suspends its local phase/disaster/zombie simulation and runs
   * from the server's bts:state snapshots (applied via applyServerState);
   * with null it returns to the full local solo simulation.
   */
  setNetwork(send: ((action: BtsAction) => void) | null) {
    this.sendAction = send;
    const wasNet = this.netMode;
    this.netMode = !!send;
    if (this.netMode && !wasNet) {
      // Going online: mirror every _bts block already in the studio store
      // (they may have arrived via the game:state partUpdates channel
      // before the link was wired) and keep mirroring from now on.
      this.mirrorBlocksFromStore();
      this.storeUnsub = useStudioStore.subscribe(() => this.mirrorBlocksFromStore());
    } else if (!this.netMode && wasNet) {
      // Going offline: stop mirroring and resume the local simulation.
      if (this.storeUnsub) { try { this.storeUnsub(); } catch { /* gone */ } this.storeUnsub = null; }
      this.claims = {};
      this.seenExplosionIds.clear();
    }
  }

  /**
   * Mirror the studio store's _bts blocks into the placed-block map so the
   * ghost/break/wrench raycasts see EVERY block (locally placed, placed by
   * other players via partUpdates, or synced on join). Idempotent by id.
   */
  private mirrorBlocksFromStore() {
    const objects = useStudioStore.getState().objects;
    if (!objects) return;
    const liveIds = new Set<string>();
    objects.forEach((obj: any) => {
      if (!obj || obj._bts !== true) return;
      liveIds.add(obj.id);
      const pos = obj.position, size = obj.size, rot = obj.rotation;
      if (!pos || !size) return;
      const rotDeg: [number, number, number] = [
        (rot?.x ?? 0), (rot?.y ?? 0), (rot?.z ?? 0),
      ];
      const existing = this.placed.get(obj.id);
      const entry: BtsPlacedBlock = {
        id: obj.id,
        shape: (obj._shape ?? obj.type ?? 'Block') as BtsPlacedBlock['shape'],
        color: obj.color ?? '#fff',
        cell: [Number(pos.x) || 0, Number(pos.z) || 0],
        y: Number(pos.y) || 0,
        sizeY: Number(size.y) || 1,
        rot: rotDeg,
      };
      if (!existing ||
        existing.cell[0] !== entry.cell[0] || existing.cell[1] !== entry.cell[1] ||
        existing.y !== entry.y || existing.rot[0] !== rotDeg[0] ||
        existing.rot[1] !== rotDeg[1] || existing.rot[2] !== rotDeg[2]) {
        this.placed.set(obj.id, entry);
      }
    });
    // Drop entries whose studio object vanished (broken by anyone).
    for (const id of Array.from(this.placed.keys())) {
      if (!liveIds.has(id)) this.placed.delete(id);
    }
  }

  /**
   * Apply one bts:state snapshot from the authority (gamehost bts-rooms).
   * Owns the phase machine, the disaster state, the zombies, the claims
   * and every player's life state while in net mode.
   */
  applyServerState(s: BtsServerState) {
    if (!this.netMode || !s || typeof s !== 'object') return;

    // ── Phase machine (server-owned) ──
    const prevPhase = this.phase;
    const prevDisasterId = this.disaster.id;
    this.phase = s.phase === 'ended' ? 'ended' : (s.phase === 'disaster' ? 'disaster' : 'build');
    this.buildTimer = Math.max(0, Number(s.buildTimer) || 0);
    this.disasterT = Math.max(0, Number(s.disasterT) || 0);
    this.round = Number(s.round) || this.round;
    if (this.phase === 'disaster') {
      this.disaster = {
        id: (s.disaster?.id ?? null) as BtsDisasterId | null,
        name: String(s.disaster?.name ?? ''),
        t: this.disaster.t,
        tsunamiZ: Number(s.disaster?.tsunamiZ) || 0,
        floodY: Number(s.disaster?.floodY) || 0,
        meteorites: Array.isArray(s.disaster?.meteorites) ? s.disaster.meteorites : [],
        explosions: Array.isArray(s.disaster?.explosions) ? s.disaster.explosions : [],
        tornado: s.disaster?.tornado ? { ...s.disaster.tornado } : null,
        rain: !!s.disaster?.rain,
        lava: !!s.disaster?.lava,
      };
      this.meteorites = this.disaster.meteorites;
      this.explosions = this.disaster.explosions;
      this.tornado = this.disaster.tornado
        ? { ...this.disaster.tornado, dx: 0, dz: 0 }
        : null;
    } else {
      this.disaster = {
        id: null, name: '', t: 0, tsunamiZ: 0, floodY: 0,
        meteorites: [], explosions: [], tornado: null, rain: false, lava: false,
      };
      this.meteorites = [];
      this.explosions = [];
      this.tornado = null;
      this.zombies = [];
    }

    // ── Zombies (server-simulated; the renderer reads this.zombies) ──
    if (Array.isArray(s.zombies)) {
      this.zombies = s.zombies.map((z) => ({
        id: Number(z.id) || 0,
        x: Number(z.x) || 0, y: Number(z.y) || 0, z: Number(z.z) || 0,
        yaw: Number(z.yaw) || 0,
        swingT: Number(z.swingT) || 0,
        hitCd: 0, soundCd: 0,
        alive: z.alive !== false,
      }));
    }

    // ── Claims (plotId -> username) ──
    this.claims = (s.claims && typeof s.claims === 'object') ? { ...s.claims } : {};
    const ownPlotId = Object.keys(this.claims).find((pid) => this.claims[pid] === this.localUsername);
    if (ownPlotId) {
      const plot = BTS_PLOTS.find((p) => p.id === ownPlotId) ?? null;
      if (plot && this.claimedPlot?.id !== plot.id) this.claimedPlot = plot;
      if (!this.claimerName) this.claimerName = this.localUsername;
    }

    // ── Own life state (server-owned hp; the death/respawn visual flow
    //    stays on the existing client path, driven by these mirrors) ──
    const players = s.players && typeof s.players === 'object' ? s.players : {};
    this.onlineCount = Math.max(1, Object.keys(players).length);
    let own: { hp: number; alive: boolean; deaths: number; survived: number } | null = null;
    for (const key of Object.keys(players)) {
      const entry = players[key];
      if (entry && typeof entry.username === 'string' && entry.username === this.localUsername) {
        own = { hp: entry.hp, alive: entry.alive, deaths: entry.deaths, survived: entry.survived };
        break;
      }
    }
    if (own) {
      const prevHp = this.player.hp;
      this.player.hp = Math.max(0, Number(own.hp) || 0);
      this.player.deaths = Number(own.deaths) || 0;
      this.player.survived = Number(own.survived) || 0;
      if (this.player.hp !== prevHp) this.onPlayerHurtCb?.(this.player.hp, this.player.max);
      if (this.player.alive && own.alive === false) {
        this.player.alive = false;
        this.playSoundCb?.('scream', 0.5);
        this.onPlayerDieCb?.();
      } else if (!this.player.alive && own.alive === true) {
        this.player.alive = true;
        this.invincibleFor = BTS_INVINCIBLE;
      }
    }

    // ── Phase-change cues (the same sounds the solo transitions play) ──
    if (prevPhase !== this.phase) {
      if (this.phase === 'disaster' && this.disaster.id && this.disaster.id !== prevDisasterId) {
        this.mode = null;
        this.selectedPartId = null;
        this.tool = null;
        this.wrenchSelectedId = null;
        this.playSoundCb?.('bts_disaster_warn', 0.7);
        this.onPhaseCb?.('disaster', this.disaster.id);
      } else if (this.phase === 'build') {
        this.playSoundCb?.('bts_survive', 0.6);
        this.onPhaseCb?.('build', null);
      }
    }
  }

  /** pass 12: forward a build/claim request to the authority (net mode). */
  private netSend(action: BtsAction) {
    this.sendAction?.(action);
  }

  // ─── Lifecycle ───
  tryStart(): boolean {
    if (this.started) return true;
    // The arena is loaded by the time the manager is constructed; nothing
    // extra to probe (plots are constants). Start immediately.
    this.started = true;
    this.active = true;
    this.phase = 'build';
    this.buildTimer = BTS_BUILD_TIME;
    this.onPhaseCb?.('build', null);
    return true;
  }

  stop() {
    this.active = false;
    this.started = false;
    // Remove every placed block from the studio store so they don't leak
    // into the next game (the save in localStorage persists them).
    const store = useStudioStore.getState();
    for (const id of this.placed.keys()) {
      try { store.removeObject(id); } catch { /* already gone */ }
    }
    this.placed.clear();
    this.zombies = [];
    this.meteorites = [];
    this.explosions = [];
    this.tornado = null;
    this.mode = null;
    this.selectedPartId = null;
    this.tool = null;
    this.wrenchSelectedId = null;
    this.claimerName = '';
    // pass 12: drop any network session state.
    if (this.storeUnsub) { try { this.storeUnsub(); } catch { /* gone */ } this.storeUnsub = null; }
    this.netMode = false;
    this.sendAction = null;
    this.claims = {};
    this.onlineCount = 1;
    this.seenExplosionIds.clear();
  }

  // ─── Plot claim ───
  claimPlot(): { ok: boolean; reason?: string; plot?: BtsPlot } {
    if (this.claimedPlot) return { ok: false, reason: 'already claimed' };
    const p = btsPlotAt(this.playerPos.x, this.playerPos.z);
    if (!p) return { ok: false, reason: 'stand on a plot to claim it' };
    if (this.netMode) {
      // pass 12: the server owns the claims - it verifies we are standing
      // on the plot (from our position reports) and confirms to everyone.
      if (this.claims[p.id] && this.claims[p.id] !== this.localUsername) {
        return { ok: false, reason: 'plot already claimed' };
      }
      this.claims[p.id] = this.localUsername; // optimistic; the server confirms
      this.netSend({ kind: 'claim', plotId: p.id });
    }
    this.claimedPlot = p;
    this.claimerName = this.localUsername;
    // Load any saved build for this plot from the device (solo only - a
    // multiplayer world belongs to the server).
    if (!this.netMode) this.loadBuild(p.id);
    this.playSoundCb?.('bts_claim', 0.6);
    return { ok: true, plot: p };
  }

  /** Minecraft-like raycast against the placed blocks + the plot floor
   *  (pass 12, fix 4). The ray goes through the POINTER position on the
   *  canvas (unprojected via the live camera), NOT the screen-centre
   *  look direction - "click anywhere to place, delete and select". If
   *  no pointer position is known yet (fresh load, controller), it falls
   *  back to the camera look direction (crosshair behaviour).
   *  Returns the first hit, its face normal, and the cell a new block
   *  would occupy if placed on that face (so you can place on tops AND
   *  sides, like Minecraft). Reach is BTS_REACH blocks; the plot floor
   *  sits at BTS_PLOT_FLOOR so blocks rest on top of the plot slab, not
   *  embedded in it. */
  private raycastAim(): {
    hitBlock: BtsPlacedBlock | null;
    groundHit: boolean;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    place: { cx: number; cy: number; cz: number };
    valid: boolean;
  } {
    const cam = BTS_AIM.camera;
    let origin: THREE.Vector3;
    let dir: THREE.Vector3;
    if (cam && this.pointerNdc) {
      // pass 12 (fix 4): aim through where the pointer actually is.
      origin = cam.position.clone();
      dir = new THREE.Vector3(this.pointerNdc.x, this.pointerNdc.y, 0.5)
        .unproject(cam)
        .sub(origin)
        .normalize();
    } else {
      origin = cam
        ? cam.position.clone()
        : new THREE.Vector3(this.playerPos.x, this.playerPos.y + 1.5, this.playerPos.z);
      dir = this.camDir.lengthSq() > 1e-6 ? this.camDir.clone().normalize() : new THREE.Vector3(0, 0, -1);
    }
    const reach = BTS_REACH;

    let bestT = Infinity;
    let bestBlock: BtsPlacedBlock | null = null;
    const bestPoint = new THREE.Vector3();
    const bestNormal = new THREE.Vector3(0, 1, 0);

    // Slab-method ray-AABB against each placed block (unit cubes).
    for (const b of this.placed.values()) {
      const cx = b.cell[0], cz = b.cell[1];
      const hx = BTS_BLOCK_SIZE / 2, hy = b.sizeY / 2, hz = BTS_BLOCK_SIZE / 2;
      const minX = cx - hx, maxX = cx + hx;
      const minY = b.y - hy, maxY = b.y + hy;
      const minZ = cz - hz, maxZ = cz + hz;
      // Parallel-axis guard: if the ray is parallel to a slab and the
      // origin is outside it, no hit on this block; if inside, that axis
      // imposes no constraint (±1e18 sentinel).
      const sx = Math.abs(dir.x) < 1e-8 ? (origin.x >= minX && origin.x <= maxX ? -1e18 : 1e18) : 1 / dir.x;
      const sy = Math.abs(dir.y) < 1e-8 ? (origin.y >= minY && origin.y <= maxY ? -1e18 : 1e18) : 1 / dir.y;
      const sz = Math.abs(dir.z) < 1e-8 ? (origin.z >= minZ && origin.z <= maxZ ? -1e18 : 1e18) : 1 / dir.z;
      const tx1 = (minX - origin.x) * sx, tx2 = (maxX - origin.x) * sx;
      const ty1 = (minY - origin.y) * sy, ty2 = (maxY - origin.y) * sy;
      const tz1 = (minZ - origin.z) * sz, tz2 = (maxZ - origin.z) * sz;
      const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
      const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
      if (tmax < Math.max(0, tmin) || tmin > reach) continue;
      const t = Math.max(0, tmin);
      if (t < bestT) {
        bestT = t;
        bestBlock = b;
        bestPoint.copy(origin).addScaledVector(dir, t);
        // Face normal: the axis whose hit point is nearest its slab face.
        const lx = bestPoint.x - cx, ly = bestPoint.y - b.y, lz = bestPoint.z - cz;
        const ax = Math.abs(lx) / hx, ay = Math.abs(ly) / hy, az = Math.abs(lz) / hz;
        if (ax >= ay && ax >= az) bestNormal.set(lx > 0 ? 1 : -1, 0, 0);
        else if (ay >= ax && ay >= az) bestNormal.set(0, ly > 0 ? 1 : -1, 0);
        else bestNormal.set(0, 0, lz > 0 ? 1 : -1);
      }
    }

    // Plot floor plane (y = BTS_PLOT_FLOOR) - only if no block is closer.
    if (dir.y < -1e-4) {
      const t = (BTS_PLOT_FLOOR - origin.y) / dir.y;
      if (t >= 0 && t < reach && t < bestT) {
        const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
        if (this.claimedPlot &&
            px >= this.claimedPlot.xMin && px <= this.claimedPlot.xMax &&
            pz >= this.claimedPlot.zMin && pz <= this.claimedPlot.zMax) {
          bestT = t; bestBlock = null;
          bestPoint.set(px, BTS_PLOT_FLOOR, pz);
          bestNormal.set(0, 1, 0);
        }
      }
    }
    const groundHit = !bestBlock && bestT < Infinity;

    // Place target = the cell adjacent to the hit face.
    const place = { cx: 0, cy: 0, cz: 0 };
    if (bestBlock) {
      place.cx = bestBlock.cell[0] + Math.round(bestNormal.x);
      place.cz = bestBlock.cell[1] + Math.round(bestNormal.z);
      place.cy = bestBlock.y + bestNormal.y * bestBlock.sizeY;
    } else if (groundHit) {
      place.cx = gridSnap(bestPoint.x);
      place.cz = gridSnap(bestPoint.z);
      place.cy = BTS_PLOT_FLOOR + BTS_BLOCK_SIZE / 2;
    }

    const valid = !!this.claimedPlot &&
      place.cx >= this.claimedPlot.xMin && place.cx <= this.claimedPlot.xMax &&
      place.cz >= this.claimedPlot.zMin && place.cz <= this.claimedPlot.zMax &&
      (place.cy + BTS_BLOCK_SIZE / 2) < BTS_DISASTER.BUILD_HEIGHT_MAX;

    return { hitBlock: bestBlock, groundHit, point: bestPoint, normal: bestNormal, place, valid };
  }

  /** Top surface y at a cell (baseplate top 0.5, or the highest placed block there). */
  private cellTopY(cx: number, cz: number): number {
    let top = 0.5; // baseplate top
    for (const b of this.placed.values()) {
      if (b.cell[0] === cx && b.cell[1] === cz) {
        const t = b.y + b.sizeY / 2;
        if (t > top) top = t;
      }
    }
    return top;
  }

  private topBlockAt(cx: number, cz: number): BtsPlacedBlock | null {
    let best: BtsPlacedBlock | null = null;
    let bestTop = -Infinity;
    for (const b of this.placed.values()) {
      if (b.cell[0] === cx && b.cell[1] === cz) {
        const t = b.y + b.sizeY / 2;
        if (t > bestTop) { bestTop = t; best = b; }
      }
    }
    return best;
  }

  // ─── Tool / part selection (pass 11: hammer / pickaxe / wrench) ───
  selectTool(tool: BtsToolId | null) {
    this.tool = tool;
    this.wrenchSelectedId = null;
    this.breakHoldId = null; this.breakHoldT = 0;
    if (tool === 'hammer') {
      // place mode only if a part is already chosen; otherwise the menu opens
      this.mode = this.selectedPartId ? 'place' : null;
    } else if (tool === 'pickaxe') {
      this.mode = 'break'; this.selectedPartId = null;
    } else if (tool === 'wrench') {
      this.mode = 'wrench'; this.selectedPartId = null;
    } else {
      this.mode = null; this.selectedPartId = null;
    }
  }
  selectPart(partId: string | null) {
    if (partId === null) { this.selectedPartId = null; if (this.tool === 'hammer') this.mode = null; return; }
    this.selectedPartId = partId;
    this.tool = 'hammer';
    this.mode = 'place';
    this.wrenchSelectedId = null;
    this.breakHoldId = null; this.breakHoldT = 0;
  }
  setMode(mode: BtsMode) {
    this.mode = mode;
    if (mode !== 'break') { this.breakHoldId = null; this.breakHoldT = 0; }
    if (mode === null) this.selectedPartId = null;
  }
  /** Skip the rest of the build phase and start the disaster now. */
  startDisasterNow() {
    if (this.phase === 'build') this.beginDisaster();
  }

  // ─── Place / break / select / rotate (triggered by the host on click / tap) ───
  private placeAtGhost() {
    if (this.phase !== 'build' || !this.claimedPlot || this.tool !== 'hammer' || !this.selectedPartId) return;
    if (this.placeCd > 0) return;
    const def = BTS_PARTS.find(p => p.id === this.selectedPartId);
    if (!def) return;
    const aim = this.raycastAim();
    if (!aim.valid) return;
    const { cx, cy, cz } = aim.place;
    const sizeY = BTS_BLOCK_SIZE;
    if (cy + sizeY / 2 > BTS_DISASTER.BUILD_HEIGHT_MAX) return;
    const part = makePlacedPart(def, cx, cy, cz);
    try {
      useStudioStore.getState().addObject(part);
    } catch { return; }
    this.placed.set(part.id, {
      id: part.id, shape: def.shape, color: def.color,
      cell: [cx, cz], y: cy, sizeY, rot: [0, 0, 0],
    });
    this.placeCd = BTS_PLACE_COOLDOWN;
    this.playSoundCb?.('bts_place', 0.5);
    // pass 12: net mode forwards the record to the authority (it validates
    // the plot + cooldown and rebroadcasts to the room); solo saves the
    // build to the device.
    if (this.netMode) this.netSend({ kind: 'place', part });
    else this.saveBuild();
  }

  /** Pickaxe: instantly break the block under the aim ray (no hold timer). */
  private breakAtAim() {
    if (this.phase !== 'build' || this.tool !== 'pickaxe') return;
    const aim = this.raycastAim();
    const target = aim.hitBlock;
    if (!target) return;
    try { useStudioStore.getState().removeObject(target.id); } catch { /* gone */ }
    this.placed.delete(target.id);
    if (this.wrenchSelectedId === target.id) this.wrenchSelectedId = null;
    this.playSoundCb?.('bts_break', 0.6);
    if (this.netMode) this.netSend({ kind: 'break', id: target.id });
    else this.saveBuild();
  }

  /** Wrench: select the block under the aim ray for rotation. */
  private selectAtAim() {
    if (this.phase !== 'build' || this.tool !== 'wrench') return;
    const aim = this.raycastAim();
    this.wrenchSelectedId = aim.hitBlock ? aim.hitBlock.id : null;
  }

  /** Wrench: rotate the selected block 90deg on the given axis (x / y / z).
   *  The block is a real 3D studio object, so its rotation is written back
   *  to the store and re-rendered immediately. */
  rotateSelected(axis: 'x' | 'y' | 'z') {
    if (this.phase !== 'build' || this.tool !== 'wrench' || !this.wrenchSelectedId) return;
    const b = this.placed.get(this.wrenchSelectedId);
    if (!b) { this.wrenchSelectedId = null; return; }
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    b.rot[i] = (b.rot[i] + 90) % 360;
    try {
      useStudioStore.getState().updateObject(b.id, { rotation: { x: b.rot[0], y: b.rot[1], z: b.rot[2] } });
    } catch { /* ignore */ }
    this.playSoundCb?.('bts_place', 0.3);
    if (this.netMode) this.netSend({ kind: 'rotate', id: b.id, rotation: { x: b.rot[0], y: b.rot[1], z: b.rot[2] } });
    else this.saveBuild();
  }

  /** Host calls this on the click/tap trigger (place / break / select).
   *  pass 12 (fix 4): pass the click's NDC so the action ray goes through
   *  the actual click point on screen; without arguments the last known
   *  pointer position is used (HUD buttons), falling back to the camera
   *  look direction when no pointer has been seen yet. */
  triggerAction(ndcX?: number, ndcY?: number) {
    if (this.phase !== 'build') return;
    if (typeof ndcX === 'number' && typeof ndcY === 'number' && isFinite(ndcX) && isFinite(ndcY)) {
      this.pointerNdc = { x: ndcX, y: ndcY };
    }
    if (this.tool === 'hammer') this.placeAtGhost();
    else if (this.tool === 'pickaxe') this.breakAtAim();
    else if (this.tool === 'wrench') this.selectAtAim();
  }

  /** pass 12 (fix 4): update the aim pointer position (NDC, +y up). The
   *  ghost preview and every place/break/select action raycast through
   *  this point, so what you see under the cursor is what you act on. */
  setPointerNdc(x: number, y: number) {
    if (isFinite(x) && isFinite(y)) this.pointerNdc = { x, y };
  }

  // ─── Save / load (per device, per plot) ───
  private saveKey() { return this.claimedPlot ? `bts_build_${this.claimedPlot.id}` : ''; }
  private saveBuild() {
    if (!this.claimedPlot) return;
    try {
      const rows = [...this.placed.values()].map(b => ({
        shape: b.shape, color: b.color, cell: b.cell, y: b.y, sizeY: b.sizeY, rot: b.rot,
      }));
      localStorage.setItem(this.saveKey(), JSON.stringify(rows));
    } catch { /* storage full / disabled */ }
  }
  private loadBuild(plotId: string) {
    let rows: any[] = [];
    try { rows = JSON.parse(localStorage.getItem(`bts_build_${plotId}`) || '[]'); } catch { rows = []; }
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) {
      const def = BTS_PARTS.find(p => p.shape === r.shape && p.color === r.color) || BTS_PARTS[0];
      const rot: [number, number, number] = Array.isArray(r.rot) ? r.rot : [0, 0, 0];
      const part = makePlacedPart(def, r.cell[0], r.y, r.cell[1], rot);
      part.color = r.color; part._shape = r.shape;
      try { useStudioStore.getState().addObject(part); } catch { continue; }
      this.placed.set(part.id, {
        id: part.id, shape: r.shape, color: r.color,
        cell: r.cell as [number, number], y: r.y, sizeY: r.sizeY, rot,
      });
    }
  }

  // ─── Damage / death ───
  damagePlayer(amount: number) {
    if (!this.active || !this.player.alive) return;
    if (this.invincibleFor > 0) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.onPlayerHurtCb?.(this.player.hp, this.player.max);
    if (this.player.hp <= 0) {
      this.player.alive = false;
      this.player.deaths++;
      this.playSoundCb?.('scream', 0.5);
      this.onPlayerDieCb?.();
    }
  }
  /** Host calls this after respawning the character. */
  revivePlayer() {
    this.player.hp = this.player.max;
    this.player.alive = true;
    this.invincibleFor = BTS_INVINCIBLE;
  }
  getRespawnPoint(): [number, number, number] {
    if (this.claimedPlot) {
      const c = this.claimedPlot.center;
      return [c[0], 5, c[2]];
    }
    return [0, 5, 0];
  }

  // ─── Phase transitions ───
  private beginDisaster() {
    const id = BTS_DISASTERS[Math.floor(Math.random() * BTS_DISASTERS.length)];
    this.phase = 'disaster';
    this.disasterT = BTS_DISASTER_TIME;
    this.disaster = {
      id, name: BTS_DISASTER_NAMES[id], t: 0,
      tsunamiZ: BTS_DISASTER.TSUNAMI_START[2],
      floodY: 0,
      meteorites: [], explosions: [],
      tornado: null, rain: false, lava: false,
    };
    this.mode = null;
    this.selectedPartId = null;
    this.tool = null;
    this.wrenchSelectedId = null;
    this.breakHoldId = null; this.breakHoldT = 0;
    if (id === 'zombies') this.spawnZombies();
    if (id === 'tornado') {
      this.tornado = { x: 0, z: 0, t: 0, dx: 1, dz: 0 };
      this.disaster.tornado = { x: 0, z: 0, t: 0 };
    }
    this.invincibleFor = BTS_INVINCIBLE;
    this.onPhaseCb?.('disaster', id);
    this.playSoundCb?.('bts_disaster_warn', 0.7);
  }
  private endDisaster() {
    this.player.survived++;
    this.playSoundCb?.('bts_survive', 0.6);
    this.round++;
    this.phase = 'build';
    this.buildTimer = BTS_BUILD_TIME;
    this.zombies = [];
    this.meteorites = [];
    this.explosions = [];
    this.tornado = null;
    this.disaster = {
      id: null, name: '', t: 0,
      tsunamiZ: 0, floodY: 0, meteorites: [], explosions: [],
      tornado: null, rain: false, lava: false,
    };
    this.player.hp = this.player.max;
    this.player.alive = true;
    this.invincibleFor = BTS_INVINCIBLE;
    this.onPhaseCb?.('build', null);
  }

  // ─── Zombies ───
  private spawnZombies() {
    this.zombies = [];
    const [sx, , sz] = BTS_ZOMBIE_SPAWN;
    for (let i = 0; i < BTS_ZOMBIE_COUNT; i++) {
      const ang = (i / BTS_ZOMBIE_COUNT) * Math.PI * 2;
      const r = 2 + (i % 5);
      this.zombies.push({
        id: this.zombieId++, x: sx + Math.cos(ang) * r, y: 0.5, z: sz + Math.sin(ang) * r,
        yaw: 0, swingT: 0, hitCd: 0, soundCd: Math.random() * BTS_ZOMBIE_SOUND_INTERVAL, alive: true,
      });
    }
  }

  // ─── Per-frame ───
  updatePlayerTransform() {
    this.playerPos.set(BTS_PLAYER_BRIDGE.x, BTS_PLAYER_BRIDGE.y, BTS_PLAYER_BRIDGE.z);
    this.camDir.set(BTS_PLAYER_BRIDGE.camDir[0], BTS_PLAYER_BRIDGE.camDir[1], BTS_PLAYER_BRIDGE.camDir[2]);
  }

  tick(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 1 / 20);
    this.updatePlayerTransform();
    if (this.invincibleFor > 0) this.invincibleFor -= dt;
    if (this.placeCd > 0) this.placeCd -= dt;

    // pass 12 (fix 3): in net mode the server owns the phase machine,
    // the disasters, the zombies and the hp - only the client-owned
    // PHYSICS effects (tornado pull, explosion knockback) run locally.
    if (this.netMode) {
      this.applyClientSideDisasterForces(dt);
      this.rev++;
      return;
    }

    if (this.phase === 'build') {
      this.buildTimer -= dt;
      if (this.buildTimer <= 0) this.beginDisaster();
    } else if (this.phase === 'disaster') {
      this.disasterT -= dt;
      this.disaster.t += dt;
      this.tickDisaster(dt);
      if (this.disasterT <= 0) this.endDisaster();
    }

    this.rev++;
  }

  /**
   * pass 12 (fix 3): client-owned disaster physics for net mode. Movement
   * is client-owned in this platform's netcode model, so the pull/shove
   * forces apply to the LOCAL body only - the tornado position and the
   * explosion list are server-synced, the damage is server-computed.
   */
  private applyClientSideDisasterForces(dt: number) {
    const world = (window as any).__weildPhysicsWorld;
    const charBody = world?.characterBody;
    if (!charBody) return;
    const px = this.playerPos.x, py = this.playerPos.y, pz = this.playerPos.z;

    // Tornado pull (same force the solo sim applies).
    if (this.disaster.id === 'tornado' && this.disaster.tornado) {
      const t = this.disaster.tornado;
      const dx = t.x - px, dz = t.z - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > BTS_TORNADO_KILL && dist < BTS_TORNADO_PULL_RANGE && dist > 0.01) {
        const pull = BTS_TORNADO_PULL * (1 - dist / BTS_TORNADO_PULL_RANGE);
        const vx = charBody.velocity.x + (dx / dist) * pull * dt * 6;
        const vz = charBody.velocity.z + (dz / dist) * pull * dt * 6;
        charBody.velocity.set(vx, charBody.velocity.y, vz);
      }
    }

    // Meteorite explosion knockback: the first time we SEE an explosion id,
    // apply the same impulse the solo sim would have (the server already
    // applied the damage; the shove is local physics).
    for (const e of this.explosions) {
      if (this.seenExplosionIds.has(e.id)) continue;
      this.seenExplosionIds.add(e.id);
      if (e.t > 0.2) continue; // first sighting is stale (a joiner's sync)
      const dx = px - e.x, dz = pz - e.z;
      const dist = Math.sqrt(dx * dx + py * py + dz * dz);
      if (dist < BTS_METEORITE_RADIUS && dist > 0.01) {
        const k = 14 * (1 - dist / BTS_METEORITE_RADIUS);
        charBody.velocity.set((dx / dist) * k, 8, (dz / dist) * k);
      }
    }
    if (this.seenExplosionIds.size > 80) this.seenExplosionIds.clear();
  }

  private tickDisaster(dt: number) {
    const id = this.disaster.id;
    const px = this.playerPos.x, py = this.playerPos.y, pz = this.playerPos.z;
    const world = (window as any).__weildPhysicsWorld;
    const charBody = world?.characterBody;

    if (id === 'tsunami') {
      this.disaster.tsunamiZ += BTS_TSUNAMI_SPEED * dt;
      // Caught: the wall has passed the player's z (wall moves +Z from -152).
      if (this.disaster.tsunamiZ >= pz && py < this.disaster.tsunamiZ + 6) {
        this.damagePlayer(BTS_TSUNAMI_DMG * dt);
      }
    } else if (id === 'flood') {
      // Rise to 80, hold 3s, reset (drain) - spec.
      if (this.disaster.floodY < BTS_DISASTER.FLOOD_MAX_Y) {
        this.disaster.floodY = Math.min(BTS_DISASTER.FLOOD_MAX_Y, this.disaster.floodY + BTS_FLOOD_RISE * dt);
      } else {
        // hold at max for FLOOD_RESET_HOLD seconds, then drain
        this.disaster.t; // (t already tracks elapsed)
        if (this.disaster.t > BTS_DISASTER.FLOOD_MAX_Y / BTS_FLOOD_RISE + BTS_DISASTER.FLOOD_RESET_HOLD) {
          this.disaster.floodY = Math.max(0, this.disaster.floodY - BTS_FLOOD_RISE * 2 * dt);
        }
      }
      if (py < this.disaster.floodY) this.damagePlayer(BTS_FLOOD_DMG * dt);
    } else if (id === 'meteorites') {
      // Spawn periodically
      const last = this.meteorites.length;
      if (Math.random() < dt / BTS_METEORITE_INTERVAL) {
        const half = BTS_DISASTER.MAP_HALF - 2;
        this.meteorites.push({
          id: this.meteoriteId++,
          x: (Math.random() * 2 - 1) * half,
          y: BTS_DISASTER.METEORITE_SPAWN_Y,
          z: (Math.random() * 2 - 1) * half,
          vy: BTS_METEORITE_SPEED_MIN + Math.random() * (BTS_METEORITE_SPEED_MAX - BTS_METEORITE_SPEED_MIN),
        });
      }
      // Fall + explode on reaching surface
      for (const m of this.meteorites) {
        m.y -= m.vy * dt;
        if (m.y <= 0.5) {
          this.explosions.push({ id: this.explosionId++, x: m.x, y: 0.5, z: m.z, t: 0 });
          this.playSoundCb?.('explosion', 0.6);
          // damage player if near
          const dx = px - m.x, dz = pz - m.z;
          const dist = Math.sqrt(dx * dx + py * py + dz * dz);
          if (dist < BTS_METEORITE_RADIUS) {
            const dmg = BTS_METEORITE_DMG * (1 - dist / BTS_METEORITE_RADIUS);
            this.damagePlayer(dmg);
            // knockback
            if (charBody && dist > 0.01) {
              const k = 14 * (1 - dist / BTS_METEORITE_RADIUS);
              charBody.velocity.set(dx / dist * k, 8, dz / dist * k);
            }
          }
          m.y = -999; // mark for removal
        }
      }
      if (last) this.meteorites = this.meteorites.filter(m => m.y > -100);
    } else if (id === 'acid_rain') {
      this.disaster.rain = true;
      // Sky-exposed: no placed block above the player's cell within a few y.
      const exposed = this.isSkyExposed(px, pz, py);
      if (exposed) this.damagePlayer(BTS_ACID_DMG * dt);
    } else if (id === 'zombies') {
      this.tickZombies(dt);
    } else if (id === 'lava') {
      this.disaster.lava = true;
      // Touching the baseplate (y near 0.5).
      if (py < 1.5) this.damagePlayer(BTS_LAVA_DMG * dt);
    } else if (id === 'tornado') {
      if (this.tornado) {
        // Wander: pick a new heading occasionally.
        this.tornado.t += dt;
        if (this.tornado.t > 2.2) {
          this.tornado.t = 0;
          const ang = Math.random() * Math.PI * 2;
          this.tornado.dx = Math.cos(ang); this.tornado.dz = Math.sin(ang);
        }
        this.tornado.x += this.tornado.dx * BTS_TORNADO_SPEED * dt;
        this.tornado.z += this.tornado.dz * BTS_TORNADO_SPEED * dt;
        // keep within map
        const half = BTS_DISASTER.MAP_HALF - 4;
        if (Math.abs(this.tornado.x) > half) this.tornado.dx = -Math.sign(this.tornado.x);
        if (Math.abs(this.tornado.z) > half) this.tornado.dz = -Math.sign(this.tornado.z);
        this.tornado.x = Math.max(-half, Math.min(half, this.tornado.x));
        this.tornado.z = Math.max(-half, Math.min(half, this.tornado.z));
        this.disaster.tornado = { x: this.tornado.x, z: this.tornado.z, t: this.tornado.t };
        // Pull + kill
        const dx = this.tornado.x - px, dz = this.tornado.z - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < BTS_TORNADO_KILL) {
          this.damagePlayer(this.player.hp + 1); // instant death
        } else if (dist < BTS_TORNADO_PULL_RANGE && charBody && dist > 0.01) {
          const pull = BTS_TORNADO_PULL * (1 - dist / BTS_TORNADO_PULL_RANGE);
          const vx = charBody.velocity.x + (dx / dist) * pull * dt * 6;
          const vz = charBody.velocity.z + (dz / dist) * pull * dt * 6;
          charBody.velocity.set(vx, charBody.velocity.y, vz);
        }
      }
    }

    // Age explosions (visual only)
    for (const e of this.explosions) e.t += dt;
    if (this.explosions.length) this.explosions = this.explosions.filter(e => e.t < 1.2);
  }

  private isSkyExposed(px: number, pz: number, py: number): boolean {
    // Exposed if no placed block sits above the player at their cell (within a small column).
    const cx = gridSnap(px), cz = gridSnap(pz);
    for (const b of this.placed.values()) {
      if (b.cell[0] === cx && b.cell[1] === cz && b.y > py + 0.5) return false;
    }
    return true;
  }

  private tickZombies(dt: number) {
    const px = this.playerPos.x, pz = this.playerPos.z;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const dx = px - z.x, dz = pz - z.z;
      const dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
      // Chase
      const sp = BTS_ZOMBIE_SPEED * dt;
      z.x += (dx / dist) * sp;
      z.z += (dz / dist) * sp;
      z.yaw = Math.atan2(dx, dz);
      // Attack cooldown + sound
      if (z.hitCd > 0) z.hitCd -= dt;
      if (z.soundCd > 0) z.soundCd -= dt;
      if (z.swingT > 0) z.swingT = Math.max(0, z.swingT - dt * 3);
      // Touch -> damage + arm swing + sounds
      if (dist < BTS_ZOMBIE_TOUCH && z.hitCd <= 0 && this.player.alive) {
        z.hitCd = BTS_ZOMBIE_HIT_CD;
        z.swingT = 1;
        this.damagePlayer(BTS_ZOMBIE_DMG);
        this.playSoundCb?.('bts_zombie_attack', 0.5);
      }
      // Random groan
      if (z.soundCd <= 0) {
        z.soundCd = BTS_ZOMBIE_SOUND_INTERVAL + Math.random() * 3;
        if (Math.random() < 0.25) this.playSoundCb?.('bts_zombie_sound', 0.35);
      }
    }
  }

  // ─── Snapshot (read by the host HUD + scene each frame) ───
  private buildGhost(): BtsGhost {
    const empty: BtsGhost = { visible: false, valid: false, mode: null, shape: 'Block', color: '#fff', x: 0, y: 0, z: 0, sizeY: 1, breakId: null, breakProgress: 0, placeCx: 0, placeCy: 0, placeCz: 0, wrenchId: null };
    if (this.phase !== 'build' || !this.claimedPlot || !this.tool) return empty;
    const aim = this.raycastAim();
    const def = this.selectedPartId ? BTS_PARTS.find(p => p.id === this.selectedPartId) : null;
    if (this.tool === 'hammer' && def) {
      const { cx, cy, cz } = aim.place;
      return { visible: true, valid: aim.valid, mode: 'place', shape: def.shape, color: def.color, x: cx, y: cy, z: cz, sizeY: BTS_BLOCK_SIZE, breakId: null, breakProgress: 0, placeCx: cx, placeCy: cy, placeCz: cz, wrenchId: null };
    }
    if (this.tool === 'pickaxe') {
      const b = aim.hitBlock;
      return { visible: !!b, valid: !!b, mode: 'break', shape: b?.shape ?? 'Block', color: b?.color ?? '#fff', x: b?.cell[0] ?? 0, y: b?.y ?? 0, z: b?.cell[1] ?? 0, sizeY: b?.sizeY ?? 1, breakId: b?.id ?? null, breakProgress: 1, placeCx: 0, placeCy: 0, placeCz: 0, wrenchId: null };
    }
    if (this.tool === 'wrench') {
      const b = aim.hitBlock;
      const sel = this.wrenchSelectedId ? this.placed.get(this.wrenchSelectedId) : null;
      const shown = sel ?? b;
      return { visible: !!shown, valid: !!shown, mode: 'wrench', shape: shown?.shape ?? 'Block', color: shown?.color ?? '#fff', x: shown?.cell[0] ?? 0, y: shown?.y ?? 0, z: shown?.cell[1] ?? 0, sizeY: shown?.sizeY ?? 1, breakId: null, breakProgress: 0, placeCx: 0, placeCy: 0, placeCz: 0, wrenchId: this.wrenchSelectedId };
    }
    return empty;
  }

  getSnapshot(): BtsSnapshot {
    return {
      active: this.active,
      phase: this.phase,
      buildTimer: Math.max(0, this.buildTimer),
      disasterT: Math.max(0, this.disasterT),
      round: this.round,
      claimedPlotId: this.claimedPlot?.id ?? null,
      mode: this.mode,
      selectedPartId: this.selectedPartId,
      tool: this.tool,
      wrenchSelectedId: this.wrenchSelectedId,
      currentPlotId: btsPlotAt(this.playerPos.x, this.playerPos.z)?.id ?? null,
      claimerName: this.claimerName,
      claims: { ...this.claims },
      onlineCount: this.onlineCount,
      ghost: this.buildGhost(),
      disaster: {
        ...this.disaster,
        meteorites: this.meteorites,
        explosions: this.explosions,
        tornado: this.tornado ? { x: this.tornado.x, z: this.tornado.z, t: this.tornado.t } : null,
      },
      zombies: this.zombies,
      player: { ...this.player },
      rev: this.rev,
    };
  }
}
