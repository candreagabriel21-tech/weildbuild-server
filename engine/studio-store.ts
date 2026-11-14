import { create } from 'zustand';
import * as THREE from 'three';
import { WeildCodeRule } from './weildcode-types';
import type { WeluScript } from './welu/welu-types';
import { getDupeOffset, loadEditorSettings, saveEditorSettings } from './editor-settings';
// v13.4: the store fires WeildCode events (when_destroyed, on_property_change).
// Circular import is safe: both modules only touch each other INSIDE functions
// at runtime, never during module initialization.
import { weildCodeEngine } from './weildcode-engine';
// v7.4: the store also fires WeLua's onDestroy (same lifecycle as the rules).
import { weluRuntime } from './welu/welu-runtime';
import type {
  TerrainHeightmap as TerrainHeightmapV2,
  TerrainGeneratorConfig,
  TerrainLayer,
  BrushType,
  BrushSettings,
  WaterBody as WaterBodyV2,
  TreeInstance as TreeInstanceV2,
  TreeVariant,
} from './terrain-v2';
import {
  DEFAULT_TERRAIN_CONFIG,
  DEFAULT_TERRAIN_LAYERS,
  DEFAULT_BRUSH,
  generateHeightmap,
  getHeightAt as getHeightAtV2,
  applyBrush as applyBrushV2,
  applyBrushStroke as applyBrushStrokeV2,
  createWaterBody as createWaterBodyV2,
  createTree as createTreeV2,
  scatterTrees as scatterTreesV2,
} from './terrain-v2';

export type PartType = 'Block' | 'Sphere' | 'Wedge' | 'Cylinder' | 'Spawn' | 'Button' | 'Sign' | 'Panel';

/** v7.5: the UI part family — clickable boards with text labels that
 *  players add from the Insert Part palette. They resize/rotate/colour
 *  like every other part and fire the usual click/touch rules + WeLua. */
export const UI_PART_TYPES: readonly PartType[] = ['Button', 'Sign', 'Panel'];

/** v7.6: default on-screen rects (normalized center x/y + size w/h). */
export const UI_SCREEN_DEFAULT_RECT: Record<'Button' | 'Sign' | 'Panel', { x: number; y: number; w: number; h: number }> = {
  Button: { x: 0.5, y: 0.5, w: 0.18, h: 0.08 },
  Sign:   { x: 0.5, y: 0.5, w: 0.24, h: 0.06 },
  Panel:  { x: 0.5, y: 0.5, w: 0.34, h: 0.22 },
};
export function isUiPartType(type: string): boolean {
  return type === 'Button' || type === 'Sign' || type === 'Panel';
}

// ─── v13.5: hard value limits (single source of truth) ───
//
// Every write path - the resize handles, the gizmos, the properties panel,
// WeildCode rules - funnels through updateObject, which clamps these values.
// No part can ever end up with a zero, negative, NaN or absurd size again,
// and rotation is always stored in [0, 360).
export const PART_MIN_SIZE = 0.05;
export const PART_MAX_SIZE = 2048;

export function clampPartSizeValue(v: number): number {
  if (!Number.isFinite(v)) return PART_MIN_SIZE;
  return Math.min(Math.max(v, PART_MIN_SIZE), PART_MAX_SIZE);
}

/** Wrap a rotation (degrees) into [0, 360). NaN becomes 0. */
export function normalizeRotationValue(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return ((v % 360) + 360) % 360;
}

export function clampUnitValue(v: number): number {
  // 0..1 fields (transparency, reflectance)
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), 1);
}

// ToolMode now includes terrain brush tools. When a brush tool is active,
// clicking on the terrain applies that brush at the click location.
export type ToolMode =
  | 'Select' | 'Move' | 'Scale' | 'Rotate' | 'Group' | 'Delete' | 'Union'
  // Terrain brush tools - each maps to a BrushType
  | 'BrushRaise' | 'BrushLower' | 'BrushSmooth' | 'BrushFlatten' | 'BrushErode' | 'BrushSculpt' | 'BrushPaint'
  // Tree placement tool - click terrain to drop a tree
  | 'PlaceTree';

// Re-export the new terrain types so consumers can import them from the store
export type {
  TerrainHeightmap as TerrainHeightmapV2,
  WaterBody as WaterBodyV2,
  TreeInstance as TreeInstanceV2,
  TreeVariant,
  BrushSettings,
  BrushType,
  TerrainGeneratorConfig,
  TerrainLayer,
} from './terrain-v2';


// ─── Clipboard ───

export interface ClipboardEntry {
  objects: StudioObject[];  // Can include both StudioPart and StudioModel (groups)
  cutFromIds: string[] | null; // null = copy, non-null = cut (original ids for reference)
}
export type StudioTab = 'File' | 'Home' | 'Model' | 'Terrain' | 'Settings';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export type MaterialType =
  | 'Plastic' | 'RoughPlastic' | 'Wood' | 'WoodPlanks' | 'WoodBark' | 'Slate' | 'Concrete'
  | 'Metal' | 'CorrodedMetal' | 'DiamondPlate' | 'Foil' | 'Grass' | 'Ice'
  | 'Brick' | 'NormalBricks' | 'Sand' | 'Fabric' | 'Granite' | 'Marble'
  | 'Cobblestone' | 'SmallCobblestone' | 'Pebble' | 'Stone' | 'RoughStone'
  | 'RockyGround' | 'Dirt' | 'Snow' | 'Tiles' | 'GeometricTiles'
  | 'Cardboard' | 'Leather' | 'Lava' | 'Magma' | 'Neon' | 'Wireframe';

// ─── BodyMovers (WeildBuild force appliers) ───

export type BodyMoverType =
  | 'BodyForce'
  | 'BodyVelocity'
  | 'BodyGyro'
  | 'BodyPosition'
  | 'BodyThrust'
  | 'BodyAngularVelocity';

export interface BodyMover {
  id: string;
  type: BodyMoverType;
  enabled: boolean;
  force?: Vector3;
  velocity?: Vector3;
  maxForce?: Vector3;
  P?: number;
  D?: number;
  cframe?: Vector3;
  maxTorque?: Vector3;
  position?: Vector3;
  location?: Vector3;
  angularVelocity?: Vector3;
  /** Duration in seconds after which this mover auto-removes (e.g. explosion impulse) */
  duration?: number;
  /** Internal: elapsed time since creation (used for duration expiry) */
  _elapsed?: number;
}

// ─── Joints (WeildBuild connections) ───

export type JointType = 'Weld' | 'Motor' | 'Snap' | 'Glue' | 'Rotate' | 'Hinge' | 'Rope';

export interface Joint {
  id: string;
  type: JointType;
  partAId: string;
  partBId: string;
  enabled: boolean;
  C0?: Vector3;
  C1?: Vector3;
  motorSpeed?: number;
  motorMaxTorque?: number;
  /**
   * v1.3 (user request): the Rope's length in studs. A rope is a MAX-distance
   * constraint - the parts can get CLOSER than this (the rope goes slack and
   * sags), but never farther apart. This replaces the legacy hack where the
   * length was smuggled into `motorMaxTorque` (that field is kept for
   * backwards compatibility with old saves: ropes without `length` fall back
   * to `motorMaxTorque ?? 5` when loaded).
   */
  length?: number;
}

// ─── Effects (Fire, Smoke, Light) ───

export interface PartEffect {
  id: string;
  type: 'Fire' | 'Smoke' | 'Light';
  color: string;
  size: number;
  enabled: boolean;
  brightness?: number;
  range?: number;
  opacity?: number;
}

// ─── Global Variables & Timers (accessible by all objects in Logic) ───

export interface GlobalTimer {
  id: string;
  name: string;
  interval: number; // seconds
  repeat: 'once' | 'every';
  enabled: boolean;
}

// ─── StudioPart (enhanced with physics properties) ───

export interface StudioPart {
  id: string;
  name: string;
  type: PartType;
  /** v7.5: UI parts (Button/Sign/Panel) — the text shown on the part. */
  label?: string;
  /**
   * v7.6: TRUE = a screen-space 2D element (StarterUI), not a 3D world
   * part. Rendered by the ScreenUiLayer overlay in the studio + play
   * viewports; the 3D renderers, physics and the click-to-place ghost
   * all skip these.
   */
  isScreenUi?: boolean;
  /**
   * v7.6: the 2D element's rect on the virtual UI canvas. x/y = CENTER
   * position, w/h = size, all normalized 0..1 of the viewport, so the
   * layout scales to any window size.
   */
  screenRect?: { x: number; y: number; w: number; h: number };
  position: Vector3;
  size: Vector3;
  rotation: Vector3;
  color: string;
  material: MaterialType;
  transparency: number;
  reflectance: number;
  anchored: boolean;
  canCollide: boolean;
  /**
   * pass 21 (camera rebuild): the camera's "can't look through solid
   * objects" occlusion ignores parts with this flag - even solid ones -
   * so walls you're meant to see through (arena glass, cutscene walls)
   * never retract the camera. Character parts default to TRUE (the camera
   * orbits its own character, the character must never occlude it) and
   * the flag switches itself OFF automatically the moment canCollide is
   * turned off (a non-solid part occluding nothing).
   */
  cameraCanLookThrough?: boolean;
  friction: number;
  elasticity: number;
  density: number;
  children: string[];
  parentId: string | null;
  bodyMovers: BodyMover[];
  effects?: PartEffect[];
  isSpawnPoint?: boolean;
  /** @deprecated pass 14/15: the baseplate is a plain Block (Plastic
   *  material) now. This flag is only read by the save migration (it strips
   *  it and re-tags the part) - never set it on new parts, and no runtime
   *  code special-cases it anymore. */
  isBaseplate?: boolean;
  spawnTeam?: 'Neutral' | 'Blue' | 'Red';
  /** True if this part is a character body part (head, torso, arm, leg, face). */
  isCharacterPart?: boolean;
  /** Which body part this is - used to assemble the character in-game. */
  characterPartType?: 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'face';
  // v1.3 (user request): the CharacterRoot part is DELETED. It used to be a
  // special translucent part that acted as the character's spawn point +
  // physics hitbox. Now the character simply spawns at the first Spawn part
  // (or the world's Spawn Position setting) and uses the standard hitbox
  // (DEFAULT_CHARACTER_HITBOX_SIZE in game-engine/physics.ts). Old saves
  // that contain an isCharacterRoot part have it stripped on load (see
  // restoreStudioState).
  /**
   * Show in World toggle. When true, the object works normally (rendered,
   * physical, runs code). When false, the object acts as if deleted - no
   * rendering, no physics, no collision, no WeildCode - but stays in the
   * explorer so other parts can re-enable it. Character parts default to
   * false so the character doesn't appear until the player spawns.
   */
  showInWorld?: boolean;
  // ─── Avatar Modification (character parts only) ───
  // When true, the corresponding property is overridden by the joining
  // player's avatar at runtime. Lets creators make one character rig that
  // adapts to each player's skin/face/shirt/pants.
  modifyColorToAvatar?: boolean;
  modifySizeToAvatar?: boolean;
  modifyFaceToAvatar?: boolean;
  /** Item key override (e.g. "FACE-1", "SHIRT-3") for face/chest/legs parts. */
  avatarItemKey?: string;
  rules?: WeildCodeRule[];
  /** WeLua scripts (real Lua code, run by the WeLua runtime in play mode). */
  weluScripts?: WeluScript[];
  /** True when the part has been negated (acts as a solid-modeling cutout). */
  negated?: boolean;
  /** Color the part had before being negated - used by "De-negate" to restore. */
  preNegateColor?: string;
  /** Transparency the part had before being negated - used by "De-negate" to restore. */
  preNegateTransparency?: number;
  /** Per-object variables - scoped to this part only (vs globalVariables which are universal). */
  objectVariables?: Record<string, number | string>;
}

export interface StudioModel {
  id: string;
  name: string;
  children: string[];
  parentId: string | null;
}

export type StudioObject = StudioPart | StudioModel;

export function isPart(obj: StudioObject): obj is StudioPart {
  // v7.5: the UI part family (Button/Sign/Panel) is parts too — without
  // them here, every isPart() gate (rendering, physics, serialisation)
  // would misread a UI part as a group.
  return 'type' in obj && (['Block', 'Sphere', 'Wedge', 'Cylinder', 'Spawn'] as string[]).concat(UI_PART_TYPES as unknown as string[]).includes(obj.type);
}

// ─── Player Inventory (project-level items) ───
// A player-inventory item is a serialized part / group subtree ("template")
// that lives OUTSIDE the world. Items are shown in the Explorer's Player ▸
// Inventory folder, given to players in play mode (hotbar + backpack), and
// can be spawned back into the world at any time.

export interface InventoryItemData {
  id: string;
  /** Display name (defaults to the source object's name). */
  name: string;
  sourceType: 'part' | 'group';
  /** The serialized subtree (parts + models, parent/child links intact). */
  objects: StudioObject[];
  /** Root id within `objects`. */
  rootId: string;
  createdAt: number;
}

export const HOTBAR_SLOT_COUNT = 4;

export interface ConsoleMessage {
  id: string;
  type: 'info' | 'warn' | 'error' | 'success';
  message: string;
  timestamp: number;
}

export interface ScreenMessage {
  id: string;
  message: string;
  position: 'top' | 'bottom';
  textColor: string;
  fontStyle: 'normal' | 'bold' | 'italic' | 'bold-italic';
  fontSize: number;
  backgroundColor: string;
  duration: number;        // seconds to show
  startTime: number;       // performance.now() when created
}

export interface TerrainSettings {
  width: number;
  length: number;
  amplitude: number;
  frequency: number;
  waterHeight: number;
  baseHeight: number;
  preset: 'Nature' | 'Mountain' | 'Island' | 'Field';
  terrainStyle: 'blocky';
  maxHeight: number;
  minHeight: number;
  seaLevel: number;
  treeDensity: number;
  blockSize: number;
  terrainColor: string;
  seed: number;
}

export interface PlayState {
  isPlaying: boolean;
  isTestPlay: boolean; // true = Test Play (physics + character), false = Play (physics only)
  characterPosition: Vector3;
  characterVelocity: Vector3;
  isGrounded: boolean;
  characterRotation: number; // Y-axis rotation in radians
  // ─── Player Health ───
  // Read/written by WeildCode rules (modify_player_health, kill_player, heal_player).
  // The GamePlayer / PlayCharacter UI can read this to display a health bar.
  characterHealth: number;
  characterMaxHealth: number;
  // ─── Teleport Request ───
  // When set to a non-null Vector3, PlayCharacter moves the character controller
  // to this position on the next frame, then clears it. This is how WeildCode
  // teleport_player / teleport_player_to_part actions move the player - they
  // can't touch the controller directly (it lives inside PlayCharacter), so
  // they write to this field and PlayCharacter picks it up.
  teleportPosition: Vector3 | null;
  // ─── v7: rule-driven player state ───
  /** Walk speed in studs/second. 0 = the default CHAR_WALK_SPEED. */
  characterSpeed: number;
  /** A custom respawn position set by set_spawn_point rules (null = world spawn). */
  spawnPointOverride: Vector3 | null;
  /** Bumped by respawn_player rules; the play viewports teleport + heal when it changes. */
  pendingRespawn: number;
}

// ─── Simulation State (inline physics, no character) ───

export interface SimulationState {
  isSimulating: boolean;
}

// ─── v1.1: Netcode mode ───
// 'local'  - singleplayer / Test Play: physics + WeildCode rules run 100%
//            on this machine (the classic behavior).
// 'server' - multiplayer on a gamehost: the SERVER runs physics + rules for
//            everyone. The local sim keeps running only as PREDICTION and
//            gets corrected by authoritative snapshots; the local WeildCode
//            engine stays OFF (the server's engine is the authority).
export interface NetcodeState {
  mode: 'local' | 'server';
}

// ─── Physics World Settings ───

export interface PhysicsSettings {
  gravity: number;
  collisionsEnabled: boolean;
  waterForce: number;
  waterDirection: Vector3;
  experimentalSolver: boolean;
}

// ─── World Settings (shown in Properties when nothing selected) ───

export interface WorldSettings {
  skyColorTop: string;
  skyColorBottom: string;
  ambientLightIntensity: number;
  baseplateSize: number;
  gravity: number;
  maxPlayers: number;
  spawnPointPosition: Vector3;
  // Sky system
  sunEnabled: boolean;
  sunColor: string;
  sunSize: number;
  moonEnabled: boolean;
  moonColor: string;
  moonSize: number;
  cloudsEnabled: boolean;
  cloudColor: string;
  cloudDensity: number;
  cloudSpeed: number;        // 0-10 (multiplier)
  windDirection: number;     // 0-360 (degrees, 0=North, 90=East, 180=South, 270=West)
  starsEnabled: boolean;
  starCount: number;         // 0-5000
  dayNightEnabled: boolean;
  timeOfDay: number;        // 0-24 (hours), e.g. 12 = noon, 0 = midnight
  dayLength: number;         // real-time seconds for a full day/night cycle
  weatherType: 'clear' | 'cloudy' | 'rain' | 'snow';
  weatherIntensity: number;  // 0-1
  // ─── pass 21 (camera rebuild): play-camera behaviour flags ───
  // The owner's cutscene-ready camera controls. All four default to the
  // classic behaviour (follow + look at character + orbit enabled +
  // occlusion on), so existing worlds are unchanged until a creator
  // (or a WeildCode rule - see the placeholder actions) flips one.
  /** Camera ALWAYS follows the character. When false the camera stays put
   *  no matter where the character walks (fixed-shot / cutscene camera). */
  cameraFollowCharacter: boolean;
  /** Camera ALWAYS points at the character. When false it keeps whatever
   *  orientation it had (free-look / custom aim, e.g. a weildcode rule
   *  drives camera_yaw for a cutscene pan). */
  cameraCharacterLookLock: boolean;
  /** Camera can orbit the character (drag / touch). When false it stays in
   *  one place no matter how much the player tries to move it. */
  cameraCanOrbit: boolean;
  /** Global "can't look through solid objects" toggle. When false the
   *  camera never retracts for occluders (per-part "Camera Can Look
   *  Through" checkboxes are the fine-grained version of this). */
  cameraCanLookThroughObjects: boolean;
}

// ─── Universes (multiple scenes within a project) ───

export interface UniverseData {
  id: string;
  name: string;
  objects: StudioObject[];
  joints: Joint[];
}

export interface StudioStore {
  // Objects
  objects: Map<string, StudioObject>;
  selectedIds: string[];

  // Universes (multi-scene support)
  universes: Map<string, UniverseData>;
  currentUniverseId: string;

  // Tools
  activeTool: ToolMode;
  activeTab: StudioTab;

  // Play mode
  playState: PlayState;
  // v1.1: netcode mode (see NetcodeState). NOT part of playState on purpose -
  // playState is snapshotted/restored around play sessions; the netcode mode
  // describes HOW this session is hosted and must survive restores.
  netcode: NetcodeState;
  setNetcodeMode: (mode: 'local' | 'server') => void;

  // Simulation mode (inline physics, no character)
  simulationState: SimulationState;

  // Terrain
  terrainSettings: TerrainSettings;
  showTerrain: boolean;

  // ─── Terrain v2 (rebuilt terrain system) ───
  /** Live heightmap - null until the user generates terrain. Brushedits modify this in place (immutable update). */
  terrainHeightmap: TerrainHeightmapV2 | null;
  /** Terrain generator config - seed, dimensions, amplitude, etc. */
  terrainConfig: TerrainGeneratorConfig;
  /** Per-instance water bodies (independent objects, not tied to terrain). */
  waterBodies: WaterBodyV2[];
  /** Per-instance trees (blocky, stylized). */
  treeInstances: TreeInstanceV2[];
  /** Brush settings used by the brush tools in the Terrain tab. */
  brushSettings: BrushSettings;
  /** Selected tree variant for the PlaceTree tool. */
  activeTreeVariant: TreeVariant;
  /** Global terrain surface color (overrides per-cell biome coloring when set). */
  terrainColor: string;
  /** Global water color (used as the default when creating new water bodies). */
  waterColor: string;
  /** Terrain layers - depth bands below the surface, each with its own color. */
  terrainLayers: TerrainLayer[];
  /** Paint color used by the BrushPaint tool. */
  brushPaintColor: string;

  // Console
  consoleMessages: ConsoleMessage[];

  // Screen messages (WeildCode print_message action)
  screenMessages: ScreenMessage[];

  // Grid
  showGrid: boolean;
  snapToGrid: boolean;
  gridSize: number;
  // v1.1 (user request): while true, the snap setting is temporarily
  // INVERTED (snap on becomes snap off, and vice versa). Set by holding G
  // during a drag. Cleared on keyup. Lives in the store so the
  // viewport drag handlers can read it without prop-drilling.
  snapInvert: boolean;

  // Panel visibility (View tab toggles)
  showExplorer: boolean;
  showProperties: boolean;
  showOutput: boolean;
  showAxisGizmo: boolean;
  /** Show the character body parts preview in the editor viewport. */
  showCharacterPreview: boolean;

  // Global variables & timers (accessible by all objects in Logic)
  globalVariables: Record<string, number | string | boolean>;
  globalTimers: GlobalTimer[];

  // Clipboard
  clipboard: ClipboardEntry | null;

  // Physics settings
  physicsSettings: PhysicsSettings;

  // Joints (stored globally, not per-part)
  joints: Joint[];

  // World settings
  worldSettings: WorldSettings;

  // Avatar data - so play mode uses the REAL character, not a cheap replica
  avatar: {
    skin: string;
    face: string | null;
    shirt: string | null;
    left_leg: string | null;
    right_leg: string | null;
  };

  // Group mode
  groupModeIds: string[];
  // Union multi-select mode (parallel to groupModeIds)
  unionModeIds: string[];

  // Explosion visuals (for Viewport3D to render)
  explosionVisuals: Array<{ id: string; position: Vector3; radius: number; startTime: number }>;

  // ─── v13.9: published-game editing session ───
  // When the studio is opened to EDIT an already-published game (Inventory ▸
  // Edit), this holds that game's identity. While set, the Publish and Save
  // flows UPDATE that game (PUT /games) instead of creating a new one (POST).
  // Cleared when the user leaves the editor back to the platform.
  editingPublishedGame: { id: string; name: string; description: string; isPublic: boolean } | null;
  setEditingPublishedGame: (info: { id: string; name: string; description: string; isPublic: boolean } | null) => void;

  // Undo/Redo
  undoStack: string[];
  redoStack: string[];
  undo: () => void;
  redo: () => void;

  // Play mode snapshot (internal - not exposed to consumers)
  _playSnapshot: string | null;
  /** pass 26: the editor's timeOfDay when play started — stopPlayMode
   *  restores it, so a day/night cycle running during Test Play can never
   *  bleed back into the saved project ("test play until noon, exit, and
   *  the project is still midnight"). */
  _timeOfDayAtPlayStart: number | null;

  // ─── Atomic Play/Simulate Mode Functions ───
  // These handle the complete start/stop lifecycle, including snapshot save/restore.
  // CRITICAL: stopPlayMode() sets isPlaying=false BEFORE restoring the snapshot,
  // so that useFrame loops bail out immediately and don't overwrite restored state.
  startPlayMode: () => void;
  stopPlayMode: () => void;
  startTestPlayMode: (spawnPosition: Vector3) => void;
  startSimulationMode: () => void;
  stopSimulationMode: () => void;

  // Actions
  addObject: (obj: StudioObject) => void;
  removeObject: (id: string) => void;
  updateObject: (id: string, updates: Partial<StudioObject>) => void;
  selectObject: (id: string | null, multi?: boolean) => void;
  clearSelection: () => void;
  // ─── v13.6 additions ───
  /** Monotonic version of the objects map STRUCTURE (add/remove/rename/group).
   *  Position/rotation/size-only writes do NOT bump it, so the explorer tree
   *  doesn't re-render while you drag parts (v13.6 editor lag fix). */
  objectsVersion: number;
  /** pass 26.1: bumped whenever a whole world is (re)loaded — the
   *  explorer uses it to remount its nodes so every folder comes back
   * COLLAPSED (user request). */
  worldLoadNonce: number;
  /** pass 13 (rotate hitbox): bumped ONLY when a part's rotation or size
   *  changes (not position drags). The play-mode collision cache watches it so
   *  the wrench rotate tool updates a block's collider immediately, instead of
   *  waiting up to 1s for the count/timer rebuild. Position-only drags don't
   *  bump it, so the per-drag-frame editor re-render the team avoided stays
   *  avoided. */
  partsTransformVersion: number;
  /** True between beginTransformGesture/endTransformGesture (a gizmo/resize drag). */
  _transformGesture: boolean;
  /** Push ONE undo snapshot at drag start and suppress per-frame pushes during the drag. */
  beginTransformGesture: () => void;
  /** End a transform gesture (see beginTransformGesture). Safe to call when not dragging. */
  endTransformGesture: () => void;
  /** v1.1: apply position/rotation/size updates to MANY parts in ONE atomic
   *  store write (a single Map copy). Used by the group gizmo drag path so a
   *  200-part model stays 60 fps live-draggable - one updateObject per part
   *  per frame would copy the objects Map once per part per frame.
   *  Values are sanitized (size clamp / rotation normalize / NaN guard) but
   *  NO character-root auto-sync or WeildCode property events fire: the group
   *  path computes character rig conversions itself and gesture-undo wraps it. */
  transformPartsBulk: (updates: Array<{ id: string; position?: Vector3; rotation?: Vector3; size?: Vector3 }>) => void;
  // v1.2 (user request): group Position/Size/Rotation are now editable
  // from the Properties panel. These helpers compute the per-leaf deltas
  // (move all children by the same offset, scale all sizes + pivot-relative
  // positions by the size ratio, rotate all positions around the pivot +
  // add the rotation delta) and apply them via transformPartsBulk.
  setGroupPosition: (groupId: string, newCenter: Vector3) => void;
  setGroupSize: (groupId: string, newSize: Vector3) => void;
  setGroupRotation: (groupId: string, newRotation: Vector3) => void;
  /** Part type waiting for the user to click a spot in the 3D view to place it there. */
  pendingPlacement: PartType | null;
  /** Enter click-to-place mode: the next click in the viewport spawns `type` there. */
  beginPlacement: (type: PartType) => void;
  /** Leave click-to-place mode without spawning (Esc / right-click). */
  cancelPlacement: () => void;
  /** Ask the editor camera to frame/focus an object (F key). Read by Viewport3D. */
  cameraFocusRequest: { id: string; nonce: number } | null;
  requestCameraFocus: (id: string) => void;
  setActiveTool: (tool: ToolMode) => void;
  setActiveTab: (tab: StudioTab) => void;
  duplicateSelected: () => void;
  /** pass 26: normalize parent/child links — orphaned parts (parent gone)
   *  become visible top-level objects, models drop dead/stale child ids. */
  repairObjectTree: () => void;
  /** pass 26.1: move objects into a group (parentId) or to the top level
   *  (null), optionally at a child index. Powers explorer drag-and-drop. */
  reparentObjects: (ids: string[], parentId: string | null, index?: number) => void;
  /** pass 26.1: move the (single) selected object up (-1) / down (+1)
   *  among its siblings. Powers the explorer's arrow-key reordering. */
  moveSelectionInTree: (direction: -1 | 1) => void;
  deleteSelected: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  addPart: (type: PartType) => void;
  addConsoleMessage: (type: ConsoleMessage['type'], message: string) => void;
  clearConsole: () => void;
  addScreenMessage: (msg: Omit<ScreenMessage, 'id' | 'startTime'>) => void;
  removeScreenMessage: (id: string) => void;
  clearScreenMessages: () => void;
  setPlayState: (updates: Partial<PlayState>) => void;
  setSimulationState: (updates: Partial<SimulationState>) => void;
  setTerrainSettings: (updates: Partial<TerrainSettings>) => void;
  setShowTerrain: (show: boolean) => void;
  // ─── Terrain v2 actions ───
  /** Update the terrain generator config (does NOT auto-regenerate - call generateTerrain to apply). */
  setTerrainConfig: (updates: Partial<TerrainGeneratorConfig>) => void;
  /** Generate a fresh heightmap from the current terrainConfig. */
  generateTerrain: () => void;
  /** Apply a single brush stroke at world coords. */
  applyBrushAt: (worldX: number, worldZ: number) => void;
  /** Apply a brush stroke along a path (for drag-painting). */
  applyBrushStroke: (x1: number, z1: number, x2: number, z2: number) => void;
  /** Update brush settings (type, size, strength). */
  setBrushSettings: (updates: Partial<BrushSettings>) => void;
  /** Add a new water body. Returns its id. */
  addWaterBody: (opts?: Partial<WaterBodyV2>) => string;
  /** Update an existing water body. */
  updateWaterBody: (id: string, updates: Partial<WaterBodyV2>) => void;
  /** Remove a water body. */
  removeWaterBody: (id: string) => void;
  /** Add a new tree. Returns its id. */
  addTree: (opts?: Partial<TreeInstanceV2>) => string;
  /** Update an existing tree. */
  updateTree: (id: string, updates: Partial<TreeInstanceV2>) => void;
  /** Remove a tree. */
  removeTree: (id: string) => void;
  /** Remove all trees. */
  clearTrees: () => void;
  /** Scatter N random trees across the current terrain. */
  scatterTrees: (count: number) => void;
  /** Set the active tree variant for the PlaceTree tool. */
  setActiveTreeVariant: (variant: TreeVariant) => void;
  /** Set global terrain surface color. */
  setTerrainColor: (color: string) => void;
  /** Set global water color (also applied as default for new water bodies). */
  setWaterColor: (color: string) => void;
  /** Set the terrain layers (depth bands below surface). */
  setTerrainLayers: (layers: TerrainLayer[]) => void;
  /** Update a single terrain layer by index. */
  updateTerrainLayer: (index: number, updates: Partial<TerrainLayer>) => void;
  /** Add a new terrain layer. */
  addTerrainLayer: () => void;
  /** Remove a terrain layer by index. */
  removeTerrainLayer: (index: number) => void;
  /** Set the paint color for the BrushPaint tool. */
  setBrushPaintColor: (color: string) => void;
  setSnapToGrid: (snap: boolean) => void;
  setGridSize: (size: number) => void;
  setSnapInvert: (invert: boolean) => void;
  /** v1.1: the EFFECTIVE snap state right now (snapToGrid XOR snapInvert).
   *  Drag handlers should consult THIS, not snapToGrid directly, so the
   *  hold-G-to-invert keybind works mid-drag. */
  isSnappingActive: () => boolean;
  getObjectById: (id: string) => StudioObject | undefined;
  getChildren: (parentId: string | null) => StudioObject[];
  getGroupLeafPartIds: (groupId: string) => string[];
  getGroupCenter: (groupId: string) => Vector3;
  loadProject: (data: { objects: StudioObject[] }) => void;
  // ─── Progressive part reveal (v13.4 loading performance) ───
  /** How many parts the 3D scene is currently allowed to render. Infinity = all. */
  partRevealLimit: number;
  /** Loading overlay state: { active, total, mounted, physicsPending } - drives the loading screen. */
  loadProgress: { active: boolean; total: number; mounted: number; physicsPending?: boolean };
  /** v13.6: set while the play-mode physics world is still being built in batches. */
  setPhysicsLoadPending: (pending: boolean) => void;
  /** Reveal `count` more parts in the scene. Returns nothing; updates loadProgress. */
  revealMoreParts: (count: number) => void;
  /** Mark progressive loading as finished instantly (used when stopping play, clearing, etc.). */
  finishPartReveal: () => void;
  /** v13.4: restart progressive mounting (Test Play page swap). */
  restartPartReveal: () => void;
  /**
   * v13.4 PERF: batch-write physics positions in ONE store update.
   * The old path called updateObject once per moving part per frame - with
   * 2,155 unanchored parts on the city map that was 2,155 full Map clones
   * (5,801 entries each) per frame = 12.5M entry copies/frame = a 10-second
   * frame. One batched set() means ONE new Map and ONE subscriber pass.
   */
  syncPhysicsPositions: (updates: Array<{ id: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }>) => void;
  // Physics actions
  setPhysicsSettings: (updates: Partial<PhysicsSettings>) => void;
  addJoint: (joint: Joint) => void;
  removeJoint: (id: string) => void;
  updateJoint: (id: string, updates: Partial<Joint>) => void;
  addBodyMover: (partId: string, mover: BodyMover) => void;
  removeBodyMover: (partId: string, moverId: string) => void;
  updateBodyMover: (partId: string, moverId: string, updates: Partial<BodyMover>) => void;
  createExplosion: (position: Vector3, blastRadius: number, blastPressure: number) => void;
  makeJoints: (partId: string) => number;
  breakJoints: (partId: string) => void;
  // Effects actions
  addEffect: (partId: string, effect: PartEffect) => void;
  removeEffect: (partId: string, effectId: string) => void;
  updateEffect: (partId: string, effectId: string, updates: Partial<PartEffect>) => void;
  // Spawn point
  addSpawnPoint: (opts?: { team?: string }) => void;
  addBaseplate: () => void;
  /** Create the 7 default character body parts (head, torso, arms, legs, face). */
  addDefaultCharacterParts: () => void;
  // v1.3: ensureCharacterRoot was DELETED with the CharacterRoot part.
  // World settings
  setWorldSettings: (updates: Partial<WorldSettings>) => void;
  // Avatar
  setAvatar: (avatar: { skin: string; face: string | null; shirt: string | null; left_leg: string | null; right_leg: string | null }) => void;

  // Group mode
  setGroupModeIds: (ids: string[]) => void;
  // Union multi-select mode - same UX as Group mode but confirms with a Union operation
  setUnionModeIds: (ids: string[]) => void;
  // Per-object variables (scoped to a single StudioPart)
  setObjectVariable: (partId: string, name: string, value: number | string) => void;
  deleteObjectVariable: (partId: string, name: string) => void;
  // Remove joints of a specific type (e.g. only Ropes) touching a given part
  removeJointsOfType: (partId: string, type: JointType) => number;
  // Universes actions
  addUniverse: (name: string) => string; // returns new universe id
  switchUniverse: (universeId: string) => void;
  deleteUniverse: (universeId: string) => void;
  renameUniverse: (universeId: string, newName: string) => void;
  // Clear project (new universe)
  clearProject: () => void;
  // Explosion visual cleanup
  removeExplosionVisual: (id: string) => void;
  // Clipboard actions
  copySelected: () => void;
  cutSelected: () => void;
  pasteClipboard: () => void;
  setShowGrid: (show: boolean) => void;
  setShowExplorer: (show: boolean) => void;
  setShowProperties: (show: boolean) => void;
  setShowOutput: (show: boolean) => void;
  setShowAxisGizmo: (show: boolean) => void;
  setShowCharacterPreview: (show: boolean) => void;
  // Global variables & timers
  setGlobalVariable: (name: string, value: number | string | boolean) => void;
  deleteGlobalVariable: (name: string) => void;
  addGlobalTimer: (timer: GlobalTimer) => void;
  updateGlobalTimer: (id: string, updates: Partial<GlobalTimer>) => void;
  deleteGlobalTimer: (id: string) => void;
  // WeildCode rule management
  addRule: (partId: string, rule: WeildCodeRule) => void;
  removeRule: (partId: string, ruleId: string) => void;
  updateRule: (partId: string, ruleId: string, updates: Partial<WeildCodeRule>) => void;
  // ─── v1.5: GAME-level rules (player join/leave, chat...) ───
  /** Rules attached to the GAME itself (not a part). Fired by the engine's
   *  player/chat hooks - on the gamehost worker in multiplayer, locally in
   *  singleplayer. Persisted inside studioState like everything else. */
  gameRules: WeildCodeRule[];
  addGameRule: (rule: WeildCodeRule) => void;
  removeGameRule: (ruleId: string) => void;
  updateGameRule: (ruleId: string, updates: Partial<WeildCodeRule>) => void;

  // ─── WeLua (real Lua scripting; runs beside WeildCode in play mode) ───
  /** Game-level WeLua scripts (run for the whole game, no part context). */
  gameWeluScripts: WeluScript[];
  addGameWeluScript: (script: WeluScript) => void;
  updateGameWeluScript: (scriptId: string, updates: Partial<WeluScript>) => void;
  removeGameWeluScript: (scriptId: string) => void;
  addWeluScript: (partId: string, script: WeluScript) => void;
  updateWeluScript: (partId: string, scriptId: string, updates: Partial<WeluScript>) => void;
  removeWeluScript: (partId: string, scriptId: string) => void;

  // ─── Player Inventory (project items given to players in play mode) ───
  /** Items in the project's player inventory (serialized part/group templates). */
  inventory: InventoryItemData[];
  /** Which project inventory item occupies each hotbar slot (1-4). */
  hotbarItemIds: (string | null)[];
  /** Move the current selection (parts and/or groups) into the inventory. */
  sendSelectionToInventory: () => void;
  /** Send a single object (part or group) into the inventory. */
  sendObjectToInventory: (id: string) => void;
  /** Delete an inventory item (the template only - nothing is spawned). */
  removeInventoryItem: (itemId: string) => void;
  /** Rename an inventory item. */
  renameInventoryItem: (itemId: string, name: string) => void;
  /** Spawn an inventory item back into the world (and remove it from the
   *  inventory). Returns the new root id, or null. */
  spawnInventoryItem: (itemId: string, position?: Vector3) => string | null;
  /** Assign (or clear with null) which item sits in a hotbar slot (0-3). */
  setHotbarItem: (slot: number, itemId: string | null) => void;

}

let partCounter = 0;

export function collectDescendants(objects: Map<string, StudioObject>, id: string): string[] {
  const obj = objects.get(id);
  if (!obj || !('children' in obj)) return [id];
  let ids = [id];
  for (const childId of (obj as any).children || []) {
    ids = ids.concat(collectDescendants(objects, childId));
  }
  return ids;
}

/** Collect only leaf StudioPart IDs from a group (recursive) */
export function collectLeafPartIds(objects: Map<string, StudioObject>, id: string): string[] {
  const obj = objects.get(id);
  if (!obj) return [];
  if (isPart(obj)) return [id];
  // It's a model - collect leaves from all children
  const leaves: string[] = [];
  if ('children' in obj) {
    for (const childId of (obj as StudioModel).children) {
      leaves.push(...collectLeafPartIds(objects, childId));
    }
  }
  return leaves;
}

/** pass 26 (ghost-objects fix): the selected ids that are NOT a descendant
 *  of another selected id. Copy/cut/dupe used to process EVERY selected id,
 *  so selecting a group together with one of its own children cloned the
 *  child twice — once inside the cloned group, once loose. The loose copy
 *  was the "ghost / suddenly ungrouped object" report. Every clone path now
 *  operates on the top-most selection only. */
export function topMostSelectedIds(objects: Map<string, StudioObject>, selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  const keep: string[] = [];
  for (const id of selectedIds) {
    let parentId = objects.get(id)?.parentId ?? null;
    let nested = false;
    while (parentId) {
      if (selected.has(parentId)) { nested = true; break; }
      parentId = objects.get(parentId)?.parentId ?? null;
    }
    if (!nested) keep.push(id);
  }
  return keep;
}

/** pass 26.1 (user request — better naming): strip copy-number suffixes
 *  from an object name: "Block (7) (8)" / "Block 7" → "Block". Repeated
 *  suffixes from the old clone chain collapse in one go. */
export function stripObjectNameSuffix(name: string): string {
  let out = name.trim();
  for (let i = 0; i < 10; i++) {
    const next = out.replace(/\s*\(\d+\)\s*$/, '').replace(/\s+\d+$/, '').trim();
    if (next === out || !next) break;
    out = next;
  }
  return out || name.trim();
}

/** pass 26.1 (user request — better naming): the next free copy name for
 *  `base` among `objects` — "Block" → "Block 2", "Block 3", … instead of
 *  the old ever-growing "Block6 (7) (8) … (89)" pile. Old-style names
 *  ("Block (7)", "Block 7") still count as occupied numbers for their
 *  base, so renumbering never collides. */
export function nextObjectName(base: string, objects: Map<string, StudioObject>): string {
  const clean = stripObjectNameSuffix(base);
  // Which FAMILY SLOTS are taken? Every object whose name reduces to the
  // same base occupies its number slot ("Wall" = 1, "Wall 2" = 2,
  // "Wall (4)" = 4 — old-style names count too, so renumbering never
  // collides). The first free slot wins: a fresh family starts at the
  // plain base name, otherwise the first free "base N" from 2 up.
  const taken = new Set<number>();
  objects.forEach((o) => {
    if (stripObjectNameSuffix(o.name) !== clean) return;
    if (o.name === clean) { taken.add(1); return; }
    const spaced = /^(.*)\s+(\d+)$/.exec(o.name.trim());
    if (spaced) { taken.add(parseInt(spaced[2], 10)); return; }
    const parens = /^(.*)\s*\((\d+)\)$/.exec(o.name.trim());
    if (parens) taken.add(parseInt(parens[2], 10));
  });
  if (!taken.has(1)) return clean;
  let n = 2;
  while (taken.has(n)) n++;
  return `${clean} ${n}`;
}

/** pass 26.1: rebuild the objects map so ROOT objects iterate in the given
 *  order (the explorer renders roots in map order). Children keep their
 *  entries; only the root sequence changes. */
function reorderRootsInMap(
  objects: Map<string, StudioObject>,
  rootOrder: string[],
): Map<string, StudioObject> {
  const next = new Map<string, StudioObject>();
  for (const id of rootOrder) {
    const o = objects.get(id);
    if (o) next.set(id, o);
  }
  objects.forEach((o, id) => {
    if (!next.has(id)) next.set(id, o);
  });
  return next;
}

/** pass 26.1: the ids of the root-level objects, in map (= display) order. */
export function rootOrderOf(objects: Map<string, StudioObject>): string[] {
  const ids: string[] = [];
  objects.forEach((o, id) => {
    if (o.parentId === null) ids.push(id);
  });
  return ids;
}

/** pass 26 (ghost-objects fix): normalizes the parent/child tree both ways.
 *  - A model's children list drops ids that don't exist, or that point at
 *    a different parent (stale listings rendered + dragged objects twice).
 *  - A part whose parent is gone (or never listed it) becomes top-level:
 *    it used to stay in the map invisible to the Explorer while the game
 *    still rendered it — the exact "ghost objects aren't there but the
 *    game treats them as real" report. Re-parenting to root keeps the
 *    user's data instead of deleting it. */
export function repairObjectTreeData(objects: Map<string, StudioObject>): Map<string, StudioObject> {
  const next = new Map(objects);
  // Pass A: clean every model's children list.
  next.forEach((obj, id) => {
    if ('children' in obj && !isPart(obj)) {
      const model = obj as StudioModel;
      const alive = model.children.filter((cid) => {
        const child = next.get(cid);
        return !!child && (child.parentId ?? null) === id;
      });
      if (alive.length !== model.children.length) {
        next.set(id, { ...model, children: alive });
      }
    }
  });
  // Pass B: orphans and unlisted children become top-level.
  next.forEach((obj, id) => {
    if (obj.parentId) {
      const parent = next.get(obj.parentId);
      const listed = !!parent && 'children' in parent && (parent as StudioModel).children.includes(id);
      if (!listed) {
        next.set(id, { ...obj, parentId: null } as StudioObject);
      }
    }
  });
  return next;
}


/** Compute the center position of a group from its leaf parts */
export function computeGroupCenter(objects: Map<string, StudioObject>, groupId: string): Vector3 {
  const leafIds = collectLeafPartIds(objects, groupId);
  if (leafIds.length === 0) return { x: 0, y: 0, z: 0 };
  let sumX = 0, sumY = 0, sumZ = 0;
  leafIds.forEach(id => {
    const obj = objects.get(id);
    if (obj && isPart(obj)) {
      sumX += obj.position.x;
      sumY += obj.position.y;
      sumZ += obj.position.z;
    }
  });
  return { x: sumX / leafIds.length, y: sumY / leafIds.length, z: sumZ / leafIds.length };
}

/**
 * v1.1: axis-aligned bounding-box center of a set of parts (WORLD space).
 * This is the PIVOT groups rotate/scale around - the same convention Roblox
 * uses for a Model's default pivot (bounds center, not the average of part
 * centers - a part far off to one side correctly pulls the pivot toward it).
 * Rotated parts contribute their AABB approximation, which is what the
 * character root refit uses too.
 */
export function computePartsBoundsCenter(parts: StudioPart[]): Vector3 {
  if (parts.length === 0) return { x: 0, y: 0, z: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const hw = p.size.x / 2, hh = p.size.y / 2, hd = p.size.z / 2;
    minX = Math.min(minX, p.position.x - hw); maxX = Math.max(maxX, p.position.x + hw);
    minY = Math.min(minY, p.position.y - hh); maxY = Math.max(maxY, p.position.y + hh);
    minZ = Math.min(minZ, p.position.z - hd); maxZ = Math.max(maxZ, p.position.z + hd);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

function deepClonePart(part: StudioPart, objects: Map<string, StudioObject>, idOverride?: string, nameOverride?: string, positionOffset?: Vector3): StudioPart {
  partCounter++;
  return {
    ...part,
    id: idOverride || generateId(),
    // pass 26.1: the next free copy of the source's BASE name.
    name: nameOverride || nextObjectName(part.name, objects),
    position: positionOffset
      ? { x: part.position.x + positionOffset.x, y: part.position.y + positionOffset.y, z: part.position.z + positionOffset.z }
      : { ...part.position },
    rotation: { ...part.rotation },
    size: { ...part.size },
    parentId: null,
    children: [],
    bodyMovers: [],
    effects: [],
    rules: [],
  };
}

function generateId(): string {
  return `obj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

const defaultPartProps = {
  color: '#4a90d9',
  material: 'Plastic' as MaterialType,
  transparency: 0,
  reflectance: 0,
  anchored: true,
  canCollide: true,
  friction: 0.5,
  elasticity: 0.2,
  density: 1.0,
  bodyMovers: [] as BodyMover[],
  effects: [] as PartEffect[],
  isSpawnPoint: false,
};

// Default colors per shape type - bright, distinct, WeildBuild defaults
// v13.6: exported so the PlacementGhost in Viewport3D can preview the exact
// default size of the part about to be placed.
export const PART_DEFAULTS: Record<string, { color: string; size: { x: number; y: number; z: number } }> = {
  Block:     { color: '#4ff7f5', size: { x: 1, y: 1, z: 1 } },  // Bright cyan
  Sphere:    { color: '#f24b4b', size: { x: 1, y: 1, z: 1 } },  // Bright red
  Cylinder:  { color: '#37e62e', size: { x: 1, y: 1, z: 1 } },  // Bright green
  Wedge:     { color: '#f7f54f', size: { x: 1, y: 1, z: 1 } },  // Bright yellow
  CornerWedge: { color: '#f7f54f', size: { x: 1, y: 1, z: 1 } }, // Bright yellow
  Spawn:     { color: '#4a90d9', size: { x: 3, y: 0.3, z: 3 } },  // Blue spawn pad
  // v7.5: UI parts — thin boards, anchored by default (a button you can
  // push across the map is a very confusing button).
  Button:    { color: '#f0ad4e', size: { x: 4, y: 1.6, z: 0.6 } },  // Chunky gold button
  Sign:      { color: '#e7e5e4', size: { x: 6, y: 3, z: 0.4 } },    // Big pale signboard
  Panel:     { color: '#6d5ae0', size: { x: 8, y: 5, z: 0.3 } },    // Wide violet panel
};

// ─── Undo/Redo helpers ───

function snapshotState(
  objects: Map<string, StudioObject>,
  joints: Joint[],
  inventory?: InventoryItemData[],
  hotbarItemIds?: (string | null)[],
): string {
  const objs: StudioObject[] = [];
  objects.forEach((obj) => objs.push(JSON.parse(JSON.stringify(obj))));
  // v7.6: inventory + hotbar ride along so Ctrl+Z can undo item deletions
  // (the user-reported bug). Both optional: the play-mode snapshot passes
  // only objects+joints, and pre-v7.6 snapshots simply have them missing.
  return JSON.stringify({ objects: objs, joints, inventory: inventory ?? [], hotbarItemIds: hotbarItemIds ?? null });
}

function restoreSnapshot(snapshot: string): {
  objects: Map<string, StudioObject>;
  joints: Joint[];
  inventory: InventoryItemData[] | null;
  hotbarItemIds: (string | null)[] | null;
} {
  const parsed = JSON.parse(snapshot);
  const objects = new Map<string, StudioObject>();
  parsed.objects.forEach((obj: StudioObject) => objects.set(obj.id, obj));
  return {
    objects,
    joints: parsed.joints || [],
    inventory: Array.isArray(parsed.inventory) ? (parsed.inventory as InventoryItemData[]) : null,
    hotbarItemIds: Array.isArray(parsed.hotbarItemIds) ? (parsed.hotbarItemIds as (string | null)[]) : null,
  };
}

const MAX_UNDO_STACK = 50;

// ─── Undo performance guards (v13.4) ───
// Two rules that make undo SAFE instead of catastrophic on big maps:
//
// 1. NO undo snapshots during Play / Simulation mode. Physics writes object
//    positions up to 60 times per second; each old push deep-cloned + stringified
//    the ENTIRE world (3+ MB on the city map) → memory explosion + frame drops.
//    Play mode already has its own snapshot/restore (startPlayMode/stopPlayMode),
//    so undo entries for physics writes were pure waste (and got clobbered on stop).
//
// 2. Coalesce rapid-fire editor pushes: gizmo drags and WeildCode rules call
//    updateObject many times per second. One undo entry per 400 ms of continuous
//    editing is indistinguishable from the old per-call behavior for a human,
//    but avoids hundreds of full-world clones during a single drag.
let _lastUndoPushAt = 0;
const UNDO_COALESCE_MS = 400;
// v13.6: nonce counter for camera focus requests (F key)
let _focusNonce = 0;

// Internal undo helper - defined outside the store so it can be used by action implementations
function _pushUndo(get: () => StudioStore, set: (partial: Partial<StudioStore> | ((s: StudioStore) => Partial<StudioStore>)) => void) {
  const state = get();

  // Rule 0 (v13.6): during a transform gesture (gizmo/resize drag) do NOTHING.
  // The gesture pushed exactly ONE snapshot when it began; per-frame pushes
  // (even coalesced to 400 ms) are full-world JSON clones that made dragging
  // laggy on big maps.
  if (state._transformGesture) return;

  // Rule 1: never snapshot while physics is running (the play snapshot/restore
  // owns the state; also skip the version bump - the explorer is hidden and
  // stopPlayMode bumps once when the editor state comes back).
  if (state.playState.isPlaying || state.simulationState.isSimulating) return;

  // v13.6: every non-gesture, non-play call here is a "cold" action
  // (add/remove/rename/group/panel edit). Bump the explorer version so the
  // tree re-renders exactly once per action - but never during drags, where
  // only position/rotation/size change and the tree doesn't need to update.
  set({ objectsVersion: state.objectsVersion + 1 });

  // Rule 2: coalesce bursts (rule ticks, rapid panel edits) into one undo entry
  const now = Date.now();
  if (now - _lastUndoPushAt < UNDO_COALESCE_MS) return;
  _lastUndoPushAt = now;

  const snapshot = snapshotState(state.objects, state.joints, state.inventory, state.hotbarItemIds);
  const undoStack = [...state.undoStack, snapshot];
  if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
  set({ undoStack, redoStack: [] });
}

// v1.3 (user request): the CharacterRoot <-> body-part sync helpers
// (syncCharacterPartsToRootScale / rotateCharacterPartsToRoot /
// refitCharacterRootToParts) were DELETED along with the CharacterRoot
// part itself. Character body parts are still fully editable - they just
// no longer auto-scale/refit to a root hitbox.

export const useStudioStore = create<StudioStore>((set, get) => ({
  objects: new Map<string, StudioObject>(),
  selectedIds: [],

  // Universes - start with a default universe called "Start"
  universes: new Map<string, UniverseData>([
    ['place_default', { id: 'place_default', name: 'Start', objects: [], joints: [] }],
  ]),
  currentUniverseId: 'place_default',

  activeTool: 'Select',
  activeTab: 'Home',
  playState: {
    isPlaying: false,
    isTestPlay: false,
    characterPosition: { x: 0, y: 5, z: 0 },
    characterVelocity: { x: 0, y: 0, z: 0 },
    isGrounded: false,
    characterRotation: 0,
    characterHealth: 100,
    characterMaxHealth: 100,
    teleportPosition: null,
    characterSpeed: 0,
    spawnPointOverride: null,
    pendingRespawn: 0,
  },
  simulationState: {
    isSimulating: false,
  },
  // v1.1: netcode mode - 'local' unless a server-hosted multiplayer session
  // switched it (GamePlayer sets 'server' while placed on a gamehost).
  netcode: {
    mode: 'local',
  },
  setNetcodeMode: (mode) => set({ netcode: { mode } }),
  // ─── Progressive part reveal (v13.4) ───
  // partRevealLimit caps how many parts the 3D scene renders, so huge maps
  // (like the 5,801-part city) mount in smooth batches instead of one giant
  // multi-second freeze. Infinity = everything mounted (the normal case).
  partRevealLimit: Infinity,
  loadProgress: { active: false, total: 0, mounted: 0 },
  objectsVersion: 1,
  partsTransformVersion: 0,
  _transformGesture: false,
  pendingPlacement: null,
  cameraFocusRequest: null,
  terrainSettings: {
    width: 100,
    length: 100,
    amplitude: 10,
    frequency: 0.1,
    waterHeight: 2,
    baseHeight: 0,
    terrainStyle: 'blocky',
    preset: 'Nature',
    maxHeight: 20,
    minHeight: 0,
    seaLevel: 2,
    treeDensity: 0.3,
    blockSize: 4,
    terrainColor: '#4a7c3f',
    seed: 42,
  },
  showTerrain: false,
  // ─── Terrain v2 initial state ───
  terrainHeightmap: null,
  terrainConfig: { ...DEFAULT_TERRAIN_CONFIG },
  waterBodies: [],
  treeInstances: [],
  brushSettings: { ...DEFAULT_BRUSH },
  activeTreeVariant: 'oak',
  terrainColor: '#4a7c3f',
  waterColor: '#2c7be0',
  terrainLayers: DEFAULT_TERRAIN_LAYERS.map(l => ({ ...l })),
  brushPaintColor: '#ff6600',
  consoleMessages: [],
  screenMessages: [],
  showGrid: false,
  snapToGrid: true,
  // pass 26.1: the snap unit is a saved device setting now.
  gridSize: loadEditorSettings().snapUnit,
  worldLoadNonce: 0,
  snapInvert: false,
  showExplorer: true,
  showProperties: true,
  showOutput: true,
  showAxisGizmo: true,
  showCharacterPreview: true,
  globalVariables: {},
  globalTimers: [],
  // WeLua + player inventory
  gameWeluScripts: [],
  inventory: [],
  hotbarItemIds: [null, null, null, null],
  clipboard: null,
  physicsSettings: {
    gravity: -35,
    collisionsEnabled: true,
    waterForce: 1,
    waterDirection: { x: 1, y: 0, z: 0 },
    experimentalSolver: false,
  },
  joints: [],
  worldSettings: {
    skyColorTop: '#6699e6',
    skyColorBottom: '#b3cce6',
    ambientLightIntensity: 0.4,
    baseplateSize: 100,
    gravity: -35,
    maxPlayers: 10,
    spawnPointPosition: { x: 0, y: 1, z: 0 },
    sunEnabled: true,
    sunColor: '#fff4e0',
    sunSize: 1.0,
    moonEnabled: true,
    moonColor: '#e8e8f0',
    moonSize: 0.8,
    cloudsEnabled: true,
    cloudColor: '#ffffff',
    cloudDensity: 0.4,
    cloudSpeed: 1.0,
    windDirection: 90,
    starsEnabled: true,
    starCount: 1200,
    dayNightEnabled: false,
    timeOfDay: 12,
    dayLength: 120,
    weatherType: 'clear',
    weatherIntensity: 0.5,
    // pass 21 (camera rebuild): classic camera behaviour by default.
    cameraFollowCharacter: true,
    cameraCharacterLookLock: true,
    cameraCanOrbit: true,
    cameraCanLookThroughObjects: true,
  },
  groupModeIds: [],
  unionModeIds: [],
  explosionVisuals: [],
  editingPublishedGame: null,
  setEditingPublishedGame: (info) => set({ editingPublishedGame: info }),
  undoStack: [],
  redoStack: [],
  _playSnapshot: null,
  _timeOfDayAtPlayStart: null,
  avatar: {
    skin: '#f8ff6d',
    face: 'FACE-1',
    shirt: 'SHIRT-1',
    left_leg: 'PANTS-1',
    right_leg: 'PANTS-1',
  },

  addObject: (obj) => {
    _pushUndo(get, set);
    set((state) => {
      const newObjects = new Map(state.objects);
      newObjects.set(obj.id, obj);
      return { objects: newObjects };
    });
  },

  removeObject: (id) => {
    _pushUndo(get, set);
    // v13.4: fire WeildCode when_destroyed BEFORE the part (and its rules) leave
    // the store. fireTrigger reads the part's rules, so it must run while the
    // part still exists. The engine has its own re-entrancy guard so a rule
    // that deletes its own part can't loop forever.
    const doomed = get().objects.get(id);
    if (doomed && isPart(doomed)) {
      try { weildCodeEngine.handleDestroyed(id); } catch { /* never let rules break deleting */ }
      try { weluRuntime.handleDestroyed(id); } catch { /* never let scripts break deleting */ }
      // Also fire for child parts inside a deleted group - they are destroyed too.
      collectDescendants(get().objects, id).forEach((childId) => {
        const child = get().objects.get(childId);
        if (child && isPart(child)) {
          try { weildCodeEngine.handleDestroyed(childId); } catch { /* ignore */ }
          try { weluRuntime.handleDestroyed(childId); } catch { /* ignore */ }
        }
      });
    }
    set((state) => {
      const newObjects = new Map(state.objects);
      const allIdsToDelete = new Set(collectDescendants(state.objects, id));
      const obj = newObjects.get(id);
      if (obj && obj.parentId) {
        const parent = newObjects.get(obj.parentId);
        if (parent && 'children' in parent) {
          newObjects.set(obj.parentId, {
            ...parent,
            children: parent.children.filter((c) => !allIdsToDelete.has(c)),
          });
        }
      }
      allIdsToDelete.forEach((deleteId) => newObjects.delete(deleteId));
      const updatedJoints = state.joints.filter(j => !allIdsToDelete.has(j.partAId) && !allIdsToDelete.has(j.partBId));
      return {
        objects: newObjects,
        selectedIds: state.selectedIds.filter((sid) => !allIdsToDelete.has(sid)),
        joints: updatedJoints,
      };
    });
  },

  updateObject: (id, updates) => {
    _pushUndo(get, set);
    set((state) => {
      const newObjects = new Map(state.objects);
      const obj = newObjects.get(id);
      if (obj) {
        const partUpdates = updates as Partial<StudioPart>;
        let mergedUpdates: Record<string, unknown> = { ...updates };
        // Deep merge bodyMovers: if updates contains partial bodyMover entries, merge with existing
        if (partUpdates.bodyMovers && isPart(obj)) {
          mergedUpdates.bodyMovers = partUpdates.bodyMovers.map((updateMover: BodyMover) => {
            const existing = obj.bodyMovers.find((m) => m.id === updateMover.id);
            return existing ? { ...existing, ...updateMover } : updateMover;
          });
        }
        // Deep merge effects: if updates contains partial effect entries, merge with existing
        if (partUpdates.effects && isPart(obj)) {
          mergedUpdates.effects = partUpdates.effects.map((updateEffect: PartEffect) => {
            const existing = (obj.effects || []).find((e) => e.id === updateEffect.id);
            return existing ? { ...existing, ...updateEffect } : updateEffect;
          });
        }

        // ── v13.5: sanitize hard-limited values for PARTS ──
        // Applies to every caller: the resize face handles, gizmos, the
        // properties panel, WeildCode rules. A part can never end up with a
        // zero/negative/NaN/oversized size; rotation always lands in [0, 360);
        // transparency/reflectance stay in [0, 1]. Groups pass through untouched.
        if (isPart(obj)) {
          if (mergedUpdates.size && typeof mergedUpdates.size === 'object') {
            const s = mergedUpdates.size as { x: number; y: number; z: number };
            mergedUpdates.size = {
              x: clampPartSizeValue(Number(s.x)),
              y: clampPartSizeValue(Number(s.y)),
              z: clampPartSizeValue(Number(s.z)),
            };
          }
          if (mergedUpdates.rotation && typeof mergedUpdates.rotation === 'object') {
            const r = mergedUpdates.rotation as { x: number; y: number; z: number };
            mergedUpdates.rotation = {
              x: normalizeRotationValue(Number(r.x)),
              y: normalizeRotationValue(Number(r.y)),
              z: normalizeRotationValue(Number(r.z)),
            };
          }
          if (typeof mergedUpdates.transparency === 'number') {
            mergedUpdates.transparency = clampUnitValue(mergedUpdates.transparency);
          }
          if (typeof mergedUpdates.reflectance === 'number') {
            mergedUpdates.reflectance = clampUnitValue(mergedUpdates.reflectance);
          }
          // pass 21 (camera rebuild): "camera_can_look_through" switches
          // itself OFF the moment canCollide is turned off - a non-solid
          // part occludes nothing, so the flag would be meaningless (and
          // the checkbox UI stays truthful about what the camera does).
          if (mergedUpdates.canCollide === false) {
            mergedUpdates.cameraCanLookThrough = false;
          }
          // v13.6: NaN position guard. A NaN coordinate (e.g. a broken grid
          // size from an old save making Math.round(x/NaN)) would teleport the
          // part into oblivion - keep the previous position instead. Silent
          // by design (no toasts - clean and professional).
          if (mergedUpdates.position && typeof mergedUpdates.position === 'object') {
            const p = mergedUpdates.position as { x: number; y: number; z: number };
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
              mergedUpdates.position = { ...obj.position };
            }
          }
        }

        // v13.4: fire WeildCode on_property_change for keys that actually changed.
        // The engine throttles this internally (150 ms per part+property) so drag
        // frames and physics ticks don't spam rules. During play mode, continuous
        // physics keys (position/rotation) are skipped - use when_touched for those.
        // v13.5: runs against the SANITIZED updates, so rules fire on the values
        // that were actually written.
        if (isPart(obj)) {
          const isRunning = state.playState.isPlaying || state.simulationState.isSimulating;
          for (const key of Object.keys(mergedUpdates)) {
            if (isRunning && (key === 'position' || key === 'rotation')) continue;
            const before = (obj as any)[key];
            const after = (mergedUpdates as any)[key];
            if (JSON.stringify(before) !== JSON.stringify(after)) {
              try { weildCodeEngine.handlePropertyChanged(id, key); } catch { /* ignore */ }
            }
          }
        }
        newObjects.set(id, { ...obj, ...mergedUpdates } as StudioObject);
        // v1.3: the CharacterRoot <-> body-part sync block was deleted with
        // the CharacterRoot part itself (body parts are plain editable parts).
        // pass 13 (rotate hitbox): a rotation or size change must refresh the
        // play-mode collider cache THIS frame (the wrench rotate tool's block
        // otherwise kept its old hitbox for up to 1s). Position-only writes are
        // excluded so the per-drag-frame editor re-render the team avoided
        // (see the objectsVersion comment) stays avoided.
        const transformChanged =
          ('rotation' in mergedUpdates) || ('size' in mergedUpdates);
        return transformChanged
          ? { objects: newObjects, partsTransformVersion: state.partsTransformVersion + 1 }
          : { objects: newObjects };
      }
      return { objects: newObjects };
    });
  },

  selectObject: (id, multi = false) =>
    set((state) => {
      if (id === null) return { selectedIds: [] };
      if (multi) {
        const exists = state.selectedIds.includes(id);
        return {
          selectedIds: exists
            ? state.selectedIds.filter((sid) => sid !== id)
            : [...state.selectedIds, id],
        };
      }
      return { selectedIds: [id] };
    }),

  clearSelection: () => set({ selectedIds: [] }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  duplicateSelected: () => {
    _pushUndo(get, set);
    const state = get();
    const newObjects = new Map(state.objects);
    const newIds: string[] = [];
    // pass 26: the offset is the user's Dupe Offset setting (Settings →
    // Editor; was hardcoded +2 x).
    const offset = { x: getDupeOffset(), y: 0, z: 0 };
    // pass 26 (ghost fix): duplicate only the TOP-MOST selected objects.
    // A selection containing a group plus one of its own children used to
    // clone the child twice (loose + inside the cloned group); nested
    // groups double-cloned their subtrees the same way.
    const topIds = topMostSelectedIds(state.objects, state.selectedIds);
    // ONE shared remap for the whole operation, so an object can never be
    // cloned twice (the old code built a fresh map per top-level id).
    const idRemap = new Map<string, string>();
    const cloneObjectTree = (sourceId: string): string | null => {
      const source = newObjects.get(sourceId);
      if (!source) return null;
      if (isPart(source)) {
        const newPart = deepClonePart(source, newObjects, undefined, undefined, offset);
        newObjects.set(newPart.id, newPart);
        newIds.push(newPart.id);
        idRemap.set(sourceId, newPart.id);
        return newPart.id;
      }
      if ('children' in source) {
        partCounter++;
        const newModelId = generateId();
        const clonedChildren: string[] = [];
        source.children.forEach((childId) => {
          const clonedChildId = cloneObjectTree(childId);
          if (clonedChildId) clonedChildren.push(clonedChildId);
        });
        if (clonedChildren.length === 0) return null;
        const newModel: StudioModel = {
          id: newModelId,
          name: nextObjectName(source.name, newObjects),
          children: clonedChildren,
          parentId: null,
        };
        clonedChildren.forEach((cid) => {
          const child = newObjects.get(cid);
          if (child) {
            newObjects.set(cid, { ...child, parentId: newModelId } as StudioObject);
          }
        });
        newObjects.set(newModelId, newModel);
        newIds.push(newModelId);
        idRemap.set(sourceId, newModelId);
        return newModelId;
      }
      return null;
    };
    topIds.forEach((id) => {
      const obj = newObjects.get(id);
      if (!obj) return;
      if (isPart(obj)) {
        const newObj = deepClonePart(obj, newObjects, undefined, undefined, offset);
        newObjects.set(newObj.id, newObj);
        newIds.push(newObj.id);
      } else if ('children' in obj) {
        cloneObjectTree(id);
      }
    });
    // pass 26 (ghost fix): normalize the result so no loose/orphaned clone
    // can leak through (defensive — the top-most pass already prevents them).
    const repaired = repairObjectTreeData(newObjects);
    set({ objects: repaired, selectedIds: newIds });
    if (newIds.length > 0) {
      state.addConsoleMessage('info', `Duplicated ${newIds.length} object(s)`);
    }
  },

  copySelected: () => {
    const state = get();
    const clipboardObjects: StudioObject[] = [];
    // pass 26 (ghost fix): only the TOP-MOST selected objects. A selection
    // that contains a group AND one of its children used to copy the child
    // twice (once via the group's descendants, once standalone) — pasting
    // then produced a loose, ungrouped extra copy.
    const seen = new Set<string>();
    topMostSelectedIds(state.objects, state.selectedIds).forEach((id) => {
      if (seen.has(id)) return;
      const obj = state.objects.get(id);
      if (!obj) return;
      if (isPart(obj)) {
        // Single part - deep clone it
        clipboardObjects.push(JSON.parse(JSON.stringify(obj)));
        seen.add(id);
      } else if ('children' in obj) {
        // Group (StudioModel) - deep clone the model AND all its descendant parts
        const model = JSON.parse(JSON.stringify(obj)) as StudioModel;
        clipboardObjects.push(model);
        seen.add(id);
        // Also clone all descendant parts recursively
        const descendantIds = collectDescendants(state.objects, id);
        descendantIds.forEach(descId => {
          if (descId === id) return; // Skip the model itself
          if (seen.has(descId)) return; // never copy an object twice
          const desc = state.objects.get(descId);
          if (desc) {
            clipboardObjects.push(JSON.parse(JSON.stringify(desc)));
            seen.add(descId);
          }
        });
      }
    });
    if (clipboardObjects.length > 0) {
      set({ clipboard: { objects: clipboardObjects, cutFromIds: null } });
      state.addConsoleMessage('info', `Copied ${clipboardObjects.length} object(s) to clipboard`);
    } else {
      state.addConsoleMessage('warn', 'Nothing to copy. Select some parts first.');
    }
  },

  cutSelected: () => {
    _pushUndo(get, set);
    set((s) => {
      const clipboardObjects: StudioObject[] = [];
      const cutFromIds: string[] = [];
      const allIdsToDelete = new Set<string>();
      // pass 26 (ghost fix): cut only the TOP-MOST selected objects — the
      // same dedupe copy/copy/paste got (a selected child of a selected
      // group used to land in the clipboard twice).
      const seen = new Set<string>();
      topMostSelectedIds(s.objects, s.selectedIds).forEach(id => {
        const obj = s.objects.get(id);
        if (!obj) return;
        cutFromIds.push(id);
        allIdsToDelete.add(id);

        if (isPart(obj)) {
          clipboardObjects.push(JSON.parse(JSON.stringify(obj)));
          seen.add(id);
        } else if ('children' in obj) {
          // Group - clone model and all descendants, then delete them all
          clipboardObjects.push(JSON.parse(JSON.stringify(obj)));
          seen.add(id);
          const descendantIds = collectDescendants(s.objects, id);
          descendantIds.forEach(descId => {
            if (descId === id) return;
            allIdsToDelete.add(descId);
            if (seen.has(descId)) return;
            const desc = s.objects.get(descId);
            if (desc) {
              clipboardObjects.push(JSON.parse(JSON.stringify(desc)));
              seen.add(descId);
            }
          });
        }
      });

      // Clean up: remove from parent's children array, cascade delete descendants
      const newObjects = new Map(s.objects);
      allIdsToDelete.forEach(id => {
        const obj = newObjects.get(id);
        if (obj && obj.parentId) {
          const parent = newObjects.get(obj.parentId);
          if (parent && 'children' in parent) {
            newObjects.set(obj.parentId, {
              ...parent,
              children: parent.children.filter((c) => !allIdsToDelete.has(c)),
            });
          }
        }
        newObjects.delete(id);
      });

      const updatedJoints = s.joints.filter(j => !allIdsToDelete.has(j.partAId) && !allIdsToDelete.has(j.partBId));
      return {
        clipboard: { objects: clipboardObjects, cutFromIds },
        objects: newObjects,
        selectedIds: [],
        joints: updatedJoints,
      };
    });
    const state = get();
    if (state.clipboard && state.clipboard.objects.length > 0) {
      state.addConsoleMessage('info', `Cut ${state.clipboard.objects.length} object(s) to clipboard`);
    } else {
      state.addConsoleMessage('warn', 'Nothing to cut. Select some parts first.');
    }
  },

  pasteClipboard: () => {
    const state = get();
    if (!state.clipboard) {
      state.addConsoleMessage('warn', 'Nothing to paste. Clipboard is empty.');
      return;
    }
    _pushUndo(get, set);
    const newObjects = new Map(state.objects);
    const newIds: string[] = [];
    // pass 26: the offset is the user's Dupe Offset setting (was +3 x).
    const offset = { x: getDupeOffset(), y: 0, z: 0 };
    // Map old IDs → new IDs for rebuilding parent/child relationships
    const idMap = new Map<string, string>();
    // pass 26 (ghost fix): a clipboard must never contain the same object
    // twice (old clipboards from before the top-most copy fix could) — the
    // second clone would overwrite the idMap entry and the first clone
    // leaked out as a loose, ungrouped "ghost" object.
    const seen = new Set<string>();

    // First pass: clone all objects with new IDs
    state.clipboard.objects.forEach((obj) => {
      if (seen.has(obj.id)) return;
      seen.add(obj.id);
      if (isPart(obj)) {
        const newObj = deepClonePart(obj, newObjects, undefined, undefined, offset);
        idMap.set(obj.id, newObj.id);
        newObjects.set(newObj.id, newObj);
        newIds.push(newObj.id);
      } else if ('children' in obj) {
        // It's a model/group - clone with new ID
        partCounter++;
        const newId = generateId();
        idMap.set(obj.id, newId);
        const newModel: StudioModel = {
          id: newId,
          name: nextObjectName(obj.name, newObjects),
          children: [], // Will be remapped in second pass
          parentId: null,
        };
        newObjects.set(newId, newModel);
        newIds.push(newId);
      }
    });

    // Second pass: rebuild parent/child relationships with new IDs
    state.clipboard.objects.forEach((obj) => {
      if ('children' in obj && !isPart(obj)) {
        const newModelId = idMap.get(obj.id);
        if (!newModelId) return;
        const newModel = newObjects.get(newModelId) as StudioModel;
        // Remap children to new IDs
        newModel.children = obj.children
          .map(oldChildId => idMap.get(oldChildId))
          .filter(Boolean) as string[];
        // Set parentId on each child
        newModel.children.forEach(childId => {
          const child = newObjects.get(childId);
          if (child) {
            newObjects.set(childId, { ...child, parentId: newModelId } as StudioObject);
          }
        });
        newObjects.set(newModelId, newModel);
      } else if (isPart(obj) && obj.parentId) {
        // Part had a parent - remap if the parent was also in the clipboard
        const newObjId = idMap.get(obj.id);
        if (!newObjId) return;
        const newObj = newObjects.get(newObjId) as StudioPart;
        const newParentId = obj.parentId ? idMap.get(obj.parentId) : null;
        if (newParentId) {
          newObj.parentId = newParentId;
          newObjects.set(newObjId, newObj);
        }
      }
    });

    // Select the top-level pasted objects (those with parentId = null)
    const topLevelIds = newIds.filter(id => {
      const obj = newObjects.get(id);
      return obj && obj.parentId === null;
    });

    // pass 26 (ghost fix): normalize the pasted tree — every pasted object
    // ends up either properly grouped under its pasted parent or honestly
    // top-level. No invisible-to-the-Explorer orphans.
    const repaired = repairObjectTreeData(newObjects);
    set({ objects: repaired, selectedIds: topLevelIds.length > 0 ? topLevelIds : newIds });
    state.addConsoleMessage('info', `Pasted ${newIds.length} object(s) from clipboard`);
  },

  reparentObjects: (ids, parentId, index) => {
    const state = get();
    if (ids.length === 0) return;
    // Only groups can hold children.
    if (parentId !== null) {
      const target = state.objects.get(parentId);
      if (!target || isPart(target)) {
        state.addConsoleMessage('warn', 'Objects can only be moved into groups.');
        return;
      }
      // Never allow a group to be dropped inside itself or its own subtree.
      for (const id of ids) {
        let walker: string | null = parentId;
        while (walker) {
          if (walker === id) {
            state.addConsoleMessage('warn', "A group can't be moved inside itself.");
            return;
          }
          walker = state.objects.get(walker)?.parentId ?? null;
        }
      }
    }
    // A multi-drag moves the top-most dragged objects (dragging a group
    // drags its contents with it — a separately dragged child is skipped).
    const moving = topMostSelectedIds(state.objects, ids);
    if (moving.length === 0) return;
    _pushUndo(get, set);

    const newObjects = new Map(state.objects);
    // 1) detach from the old parent's children list
    moving.forEach((id) => {
      const o = newObjects.get(id);
      if (o?.parentId) {
        const oldParent = newObjects.get(o.parentId);
        if (oldParent && 'children' in oldParent) {
          newObjects.set(oldParent.id, { ...oldParent, children: oldParent.children.filter((c) => c !== id) } as StudioObject);
        }
      }
    });
    // 2) attach
    if (parentId === null) {
      // to the top level — insert at a root position when given, else append.
      let rootOrder = rootOrderOf(newObjects).filter((id) => !moving.includes(id));
      if (typeof index === 'number' && index >= 0 && index <= rootOrder.length) {
        rootOrder = [...rootOrder.slice(0, index), ...moving, ...rootOrder.slice(index)];
      } else {
        rootOrder = [...rootOrder, ...moving];
      }
      const reordered = reorderRootsInMap(newObjects, rootOrder);
      moving.forEach((id) => {
        const o = reordered.get(id);
        if (o) reordered.set(id, { ...o, parentId: null } as StudioObject);
      });
      set({ objects: reorderRootsInMap(reordered, rootOrder), objectsVersion: get().objectsVersion + 1 });
    } else {
      const parent = newObjects.get(parentId);
      if (parent && 'children' in parent) {
        const children = [...(parent as StudioModel).children.filter((c) => !moving.includes(c))];
        const at = typeof index === 'number' ? Math.max(0, Math.min(index, children.length)) : children.length;
        children.splice(at, 0, ...moving);
        newObjects.set(parentId, { ...parent, children } as StudioObject);
        moving.forEach((id) => {
          const o = newObjects.get(id);
          if (o) newObjects.set(id, { ...o, parentId } as StudioObject);
        });
        set({ objects: repairObjectTreeData(newObjects), objectsVersion: get().objectsVersion + 1 });
      }
    }
    state.addConsoleMessage('info', `Moved ${moving.length} object${moving.length > 1 ? 's' : ''} ${parentId === null ? 'to the top level' : 'into "' + (state.objects.get(parentId)?.name ?? 'group') + '"'}.`);
  },

  moveSelectionInTree: (direction) => {
    const state = get();
    const id = state.selectedIds[0];
    if (!id) return;
    const obj = state.objects.get(id);
    if (!obj) return;
    // Siblings: the parent's children list, or the root order.
    const siblings = obj.parentId
      ? ((state.objects.get(obj.parentId) as StudioModel | undefined)?.children ?? [])
      : rootOrderOf(state.objects);
    const i = siblings.indexOf(id);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    _pushUndo(get, set);
    if (obj.parentId) {
      const parent = state.objects.get(obj.parentId);
      if (parent && 'children' in parent) {
        const children = [...(parent as StudioModel).children];
        [children[i], children[j]] = [children[j], children[i]];
        const newObjects = new Map(state.objects);
        newObjects.set(parent.id, { ...parent, children } as StudioObject);
        set({ objects: newObjects, objectsVersion: get().objectsVersion + 1 });
      }
    } else {
      // Roots render in map order — rebuild the map with the two swapped.
      const rootOrder = rootOrderOf(state.objects);
      [rootOrder[i], rootOrder[j]] = [rootOrder[j], rootOrder[i]];
      set({ objects: reorderRootsInMap(state.objects, rootOrder), objectsVersion: get().objectsVersion + 1 });
    }
  },

  repairObjectTree: () => {
    const state = get();
    const repaired = repairObjectTreeData(state.objects);
    if (repaired.size !== state.objects.size || Array.from(repaired.entries()).some(([id, o]) => state.objects.get(id) !== o)) {
      set({ objects: repaired, objectsVersion: state.objectsVersion + 1 });
      state.addConsoleMessage('info', 'Object tree repaired: orphaned parts returned to the top level.');
    }
  },

  setShowGrid: (show) => set({ showGrid: show }),
  setShowExplorer: (show) => set({ showExplorer: show }),
  setShowProperties: (show) => set({ showProperties: show }),
  setShowOutput: (show) => set({ showOutput: show }),
  setShowAxisGizmo: (show) => set({ showAxisGizmo: show }),
  setShowCharacterPreview: (show) => set({ showCharacterPreview: show }),
  // Global variables & timers
  setGlobalVariable: (name, value) => set(state => ({ globalVariables: { ...state.globalVariables, [name]: value } })),
  deleteGlobalVariable: (name) => set(state => {
    const vars = { ...state.globalVariables };
    delete vars[name];
    return { globalVariables: vars };
  }),
  addGlobalTimer: (timer) => set(state => ({ globalTimers: [...state.globalTimers, timer] })),
  updateGlobalTimer: (id, updates) => set(state => ({
    globalTimers: state.globalTimers.map(t => t.id === id ? { ...t, ...updates } : t),
  })),
  deleteGlobalTimer: (id) => set(state => ({
    globalTimers: state.globalTimers.filter(t => t.id !== id),
  })),

  deleteSelected: () => {
    _pushUndo(get, set);
    const state = get();
    const newObjects = new Map(state.objects);
    const deletedIds = new Set(state.selectedIds);
    state.selectedIds.forEach((id) => {
      const obj = newObjects.get(id);
      if (obj && 'children' in obj) {
        // v1.1 FIX: groups now delete their ENTIRE descendant tree (nested
        // models included). The old code only removed direct children, so
        // grandchildren of nested groups leaked into the map as orphans.
        collectDescendants(newObjects, id).forEach((descId) => {
          if (descId === id) return;
          newObjects.delete(descId);
          deletedIds.add(descId);
        });
      }
      if (obj && obj.parentId) {
        const parent = newObjects.get(obj.parentId);
        if (parent && 'children' in parent) {
          newObjects.set(obj.parentId, {
            ...parent,
            children: parent.children.filter((c) => !deletedIds.has(c) && c !== id),
          });
        }
      }
      newObjects.delete(id);
    });
    const updatedJoints = state.joints.filter(j => !deletedIds.has(j.partAId) && !deletedIds.has(j.partBId));
    set({ objects: newObjects, selectedIds: [], joints: updatedJoints });
  },

  groupSelected: () => {
    const state = get();
    if (state.selectedIds.length < 2) return;
    _pushUndo(get, set);
    const newObjects = new Map(state.objects);
    const modelId = generateId();
    const model: StudioModel = {
      id: modelId,
      name: nextObjectName('Model', state.objects),
      children: [...state.selectedIds],
      parentId: null,
    };
    state.selectedIds.forEach((id) => {
      const obj = newObjects.get(id);
      if (obj) {
        // Remove from old parent's children array to avoid dangling refs
        if (obj.parentId) {
          const oldParent = newObjects.get(obj.parentId);
          if (oldParent && 'children' in oldParent) {
            const updatedOldParent = { ...oldParent, children: oldParent.children.filter((c: string) => c !== id) };
            newObjects.set(obj.parentId, updatedOldParent);
          }
        }
        newObjects.set(id, { ...obj, parentId: modelId } as StudioObject);
      }
    });
    newObjects.set(modelId, model);
    set({ objects: newObjects, selectedIds: [modelId] });
  },

  ungroupSelected: () => {
    _pushUndo(get, set);
    const state = get();
    const newObjects = new Map(state.objects);
    const newSelectedIds: string[] = [];
    state.selectedIds.forEach((id) => {
      const obj = newObjects.get(id);
      if (obj && !isPart(obj) && 'children' in obj) {
        // Remember the group's parentId so children stay at the same level
        const groupParentId = obj.parentId;
        obj.children.forEach((childId) => {
          const child = newObjects.get(childId);
          if (child) {
            // Place children at the same level as the group was
            newObjects.set(childId, { ...child, parentId: groupParentId } as StudioObject);
            newSelectedIds.push(childId);
          }
        });
        // If the group had a parent, update the parent's children array
        // (replace group id with the group's children ids)
        if (groupParentId) {
          const parent = newObjects.get(groupParentId);
          if (parent && 'children' in parent) {
            const updatedChildren = parent.children.flatMap((cid) =>
              cid === id ? obj.children : [cid]
            );
            newObjects.set(groupParentId, { ...parent, children: updatedChildren } as StudioObject);
          }
        }
        newObjects.delete(id);
      }
    });
    set({ objects: newObjects, selectedIds: newSelectedIds });
  },

  addPart: (type) => {
    // Spawn parts delegate to addSpawnPoint for consistent creation
    if (type === 'Spawn') {
      const state = get();
      state.addSpawnPoint({ team: 'Neutral' });
      return;
    }
    _pushUndo(get, set);
    const state = get();
    partCounter++;
    const id = generateId();
    // Get per-type defaults (color + size)
    const defaults = PART_DEFAULTS[type] || PART_DEFAULTS['Block'];
    const size = { ...defaults.size };
    // v7.6: UI parts live on the SCREEN (StarterUI), not in the 3D world.
    const isScreenUi = isUiPartType(type);
    let screenRect: { x: number; y: number; w: number; h: number } | undefined;
    if (isScreenUi) {
      const base = UI_SCREEN_DEFAULT_RECT[type as 'Button' | 'Sign' | 'Panel'];
      // cascade new elements so they don't stack exactly on top of each other
      let n = 0;
      state.objects.forEach((o) => { if (isPart(o) && o.isScreenUi) n++; });
      screenRect = { ...base, x: base.x + ((n % 3) - 1) * 0.14, y: base.y - Math.floor(n / 3) * 0.14 + 0.18 };
    }
    // v13.6: spawn the part resting ON the ground surface. pass 14: the
    // baseplate is a plain Block now (no isBaseplate flag), so "the ground"
    // is simply the highest top surface among big flat parts near the
    // origin (the Baseplate at 0,0,0 top = +0.5 by default).
    // v7.6: screen UI elements skip all of this (they have no world spot).
    let groundY = 0;
    if (!isScreenUi) state.objects.forEach((obj) => {
      if (!isPart(obj) || obj.isCharacterPart || obj.isSpawnPoint) return;
      const top = obj.position.y + obj.size.y / 2;
      const withinFootprint =
        Math.abs(obj.position.x) <= obj.size.x / 2 &&
        Math.abs(obj.position.z) <= obj.size.z / 2;
      if (withinFootprint && top > groundY && obj.size.x >= 4 && obj.size.z >= 4) {
        groundY = top;
      }
    });
    const yPos = groundY + size.y / 2;
    const part: StudioPart = {
      id,
      // pass 26.1: number new parts against existing names ("Block 2"…)
      name: nextObjectName(type, state.objects),
      type,
      position: { x: 0, y: yPos, z: 0 },
      size,
      rotation: { x: 0, y: 0, z: 0 },
      ...defaultPartProps,
      color: defaults.color,
      // v7.5: UI parts carry their text label (Panel starts blank — it is
      // usually a backing board for other UI parts).
      ...(isUiPartType(type) && type !== 'Panel' ? { label: type } : {}),
      // v7.6: screen-space flag + on-screen rect (StarterUI elements).
      ...(isScreenUi ? { isScreenUi: true, screenRect } : {}),
      children: [],
      parentId: null,
    };
    const newObjects = new Map(state.objects);
    newObjects.set(id, part);
    set({ objects: newObjects, selectedIds: [id] });
    const addMsg = state.addConsoleMessage;
    addMsg('info', `Created ${type}: ${part.name}`);
  },

  addConsoleMessage: (type, message) =>
    set((state) => {
      const newMsg: ConsoleMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        type,
        message,
        timestamp: Date.now(),
      };
      return {
        consoleMessages: [...state.consoleMessages.slice(-499), newMsg],
      };
    }),

  clearConsole: () => set({ consoleMessages: [] }),

  addScreenMessage: (msg) =>
    set((state) => ({
      // v1.7 PERF: cap concurrent screen messages (a fast repeat rule used
      // to stack unbounded overlays + React re-renders). Oldest dropped.
      screenMessages: [...state.screenMessages.slice(-7), {
        ...msg,
        id: `scrmsg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        startTime: performance.now(),
      }],
    })),

  removeScreenMessage: (id) =>
    set((state) => ({
      screenMessages: state.screenMessages.filter((m) => m.id !== id),
    })),

  clearScreenMessages: () => set({ screenMessages: [] }),

  setPlayState: (updates) =>
    set((state) => ({
      playState: { ...state.playState, ...updates },
    })),

  setSimulationState: (updates) =>
    set((state) => ({
      simulationState: { ...state.simulationState, ...updates },
    })),

  setTerrainSettings: (updates) =>
    set((state) => ({
      terrainSettings: { ...state.terrainSettings, ...updates },
    })),

  setShowTerrain: (show) => set({ showTerrain: show }),

  // ─── Terrain v2 action implementations ───

  setTerrainConfig: (updates) =>
    set((state) => ({
      terrainConfig: { ...state.terrainConfig, ...updates },
    })),

  generateTerrain: () => {
    const state = get();
    const heightmap = generateHeightmap(state.terrainConfig);
    set({
      terrainHeightmap: heightmap,
      showTerrain: true,
    });
    get().addConsoleMessage(
      'success',
      `Terrain generated with seed ${state.terrainConfig.seed}, ${heightmap.width}×${heightmap.length} cells`
    );
  },

  applyBrushAt: (worldX, worldZ) => {
    const state = get();
    if (!state.terrainHeightmap) return;
    const next = applyBrushV2(state.terrainHeightmap, worldX, worldZ, state.brushSettings);
    set({ terrainHeightmap: next });
  },

  applyBrushStroke: (x1, z1, x2, z2) => {
    const state = get();
    if (!state.terrainHeightmap) return;
    const next = applyBrushStrokeV2(state.terrainHeightmap, x1, z1, x2, z2, state.brushSettings);
    set({ terrainHeightmap: next });
  },

  setBrushSettings: (updates) =>
    set((state) => ({
      brushSettings: { ...state.brushSettings, ...updates },
    })),

  addWaterBody: (opts) => {
    const state = get();
    // Auto-stretch water to fit the terrain footprint exactly (full width × full length).
    // This makes "Add Water" immediately useful - the water covers the whole map
    // at sea level, and the user can resize/raise it from there.
    const terrainW = state.terrainConfig.width * state.terrainConfig.cellSize;
    const terrainL = state.terrainConfig.length * state.terrainConfig.cellSize;
    const body = createWaterBodyV2({
      position: opts?.position ?? {
        x: 0,
        y: state.terrainConfig.seaLevel + state.terrainConfig.baseHeight,
        z: 0,
      },
      size: opts?.size ?? {
        x: terrainW,
        y: Math.max(6, state.terrainConfig.amplitude + 4),
        z: terrainL,
      },
      color: opts?.color ?? state.waterColor,
      ...opts,
    });
    set({ waterBodies: [...state.waterBodies, body] });
    get().addConsoleMessage('info', `Added water body "${body.name}" at (${body.position.x}, ${body.position.y}, ${body.position.z}): ${body.size.x.toFixed(0)}×${body.size.z.toFixed(0)} units`);
    return body.id;
  },

  updateWaterBody: (id, updates) =>
    set((state) => ({
      waterBodies: state.waterBodies.map((w) => (w.id === id ? { ...w, ...updates } : w)),
    })),

  removeWaterBody: (id) => {
    const state = get();
    const body = state.waterBodies.find((w) => w.id === id);
    set({ waterBodies: state.waterBodies.filter((w) => w.id !== id) });
    if (body) get().addConsoleMessage('info', `Removed water body "${body.name}"`);
  },

  addTree: (opts) => {
    const state = get();
    const tree = createTreeV2({
      variant: state.activeTreeVariant,
      ...opts,
    });
    set({ treeInstances: [...state.treeInstances, tree] });
    return tree.id;
  },

  updateTree: (id, updates) =>
    set((state) => ({
      treeInstances: state.treeInstances.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  removeTree: (id) => {
    const state = get();
    set({ treeInstances: state.treeInstances.filter((t) => t.id !== id) });
  },

  clearTrees: () => {
    const state = get();
    const count = state.treeInstances.length;
    set({ treeInstances: [] });
    if (count > 0) get().addConsoleMessage('info', `Cleared ${count} tree(s)`);
  },

  scatterTrees: (count) => {
    const state = get();
    if (!state.terrainHeightmap) {
      get().addConsoleMessage('warn', 'Generate terrain first before scattering trees');
      return;
    }
    const halfW = state.terrainConfig.width * state.terrainConfig.cellSize;
    const halfL = state.terrainConfig.length * state.terrainConfig.cellSize;
    const seed = state.terrainConfig.seed ^ 0x12345;
    const newTrees = scatterTreesV2(
      count,
      seed,
      halfW,
      halfL,
      (x, z) => getHeightAtV2(state.terrainHeightmap!, x, z)
    );
    set({ treeInstances: [...state.treeInstances, ...newTrees] });
    get().addConsoleMessage('success', `Scattered ${newTrees.length} trees across the terrain`);
  },

  setActiveTreeVariant: (variant) => set({ activeTreeVariant: variant }),

  setTerrainColor: (color) => set({ terrainColor: color }),

  setWaterColor: (color) => set({ waterColor: color }),

  setTerrainLayers: (layers) => set({ terrainLayers: layers }),

  updateTerrainLayer: (index, updates) =>
    set((state) => ({
      terrainLayers: state.terrainLayers.map((l, i) => (i === index ? { ...l, ...updates } : l)),
    })),

  addTerrainLayer: () =>
    set((state) => ({
      terrainLayers: [...state.terrainLayers, { name: `Layer ${state.terrainLayers.length + 1}`, color: '#888888', thickness: 2 }],
    })),

  removeTerrainLayer: (index) =>
    set((state) => ({
      terrainLayers: state.terrainLayers.filter((_, i) => i !== index),
    })),

  setBrushPaintColor: (color) => set({ brushPaintColor: color }),

  setSnapToGrid: (snap) => set({ snapToGrid: snap }),

  setSnapInvert: (invert) => set({ snapInvert: invert }),

  isSnappingActive: () => {
    const s = get();
    // XOR: snapping is active when snapToGrid is on AND G is NOT held,
    // OR when snapToGrid is off AND G IS held (temporary snap on).
    return s.snapToGrid !== s.snapInvert;
  },

  // ─── v13.6: transform gestures (editor drag lag fix) ───
  beginTransformGesture: () => {
    const state = get();
    if (state._transformGesture) return;
    // ONE undo snapshot BEFORE the first change of the drag; _pushUndo is
    // suppressed for the rest of the gesture (no full-world clones mid-drag).
    _pushUndo(get, set);
    set({ _transformGesture: true });
  },

  endTransformGesture: () => {
    if (!get()._transformGesture) return;
    set({ _transformGesture: false });
    // No objectsVersion bump needed: a drag only changes
    // position/rotation/size, which the explorer tree doesn't display.
  },

  // ─── v1.1: bulk part transforms (group gizmo drag path) ───
  transformPartsBulk: (updates) => {
    if (updates.length === 0) return;
    set((state) => {
      const newObjects = new Map(state.objects);
      for (const u of updates) {
        const obj = newObjects.get(u.id);
        if (!obj || !isPart(obj)) continue;
        const next: Record<string, unknown> = {};
        if (u.position) {
          const p = u.position;
          next.position = (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
            ? { x: p.x, y: p.y, z: p.z }
            : { ...obj.position };
        }
        if (u.rotation) {
          const r = u.rotation;
          next.rotation = {
            x: normalizeRotationValue(Number(r.x)),
            y: normalizeRotationValue(Number(r.y)),
            z: normalizeRotationValue(Number(r.z)),
          };
        }
        if (u.size) {
          const s = u.size;
          next.size = {
            x: clampPartSizeValue(Number(s.x)),
            y: clampPartSizeValue(Number(s.y)),
            z: clampPartSizeValue(Number(s.z)),
          };
        }
        if (Object.keys(next).length === 0) continue;
        newObjects.set(u.id, { ...obj, ...next } as StudioObject);
      }
      return { objects: newObjects };
    });
  },

  // ─── v1.2 (user request): editable group transforms ───
  // The Properties panel for a group shows Position (AABB center), Size
  // (AABB extents), Rotation (first child). When the user types into those
  // fields, these helpers compute per-leaf updates and apply them via
  // transformPartsBulk so the whole group moves/scales/rotates together.
  setGroupPosition: (groupId, newCenter) => {
    const state = get();
    const group = state.objects.get(groupId);
    if (!group || !('children' in group)) return;
    const leaves = group.children
      .map((cid) => state.objects.get(cid))
      .filter((o): o is StudioPart => !!o && isPart(o));
    if (leaves.length === 0) return;
    // AABB of all leaves (current center).
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of leaves) {
      const hx = p.size.x / 2, hy = p.size.y / 2, hz = p.size.z / 2;
      minX = Math.min(minX, p.position.x - hx); maxX = Math.max(maxX, p.position.x + hx);
      minY = Math.min(minY, p.position.y - hy); maxY = Math.max(maxY, p.position.y + hy);
      minZ = Math.min(minZ, p.position.z - hz); maxZ = Math.max(maxZ, p.position.z + hz);
    }
    const oldCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
    const dx = newCenter.x - oldCenter.x;
    const dy = newCenter.y - oldCenter.y;
    const dz = newCenter.z - oldCenter.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return;
    // Begin a gesture so this is ONE undo entry (not one per leaf).
    state.beginTransformGesture();
    try {
      state.transformPartsBulk(leaves.map((p) => ({
        id: p.id,
        position: { x: p.position.x + dx, y: p.position.y + dy, z: p.position.z + dz },
      })));
    } finally {
      state.endTransformGesture();
    }
  },

  setGroupSize: (groupId, newSize) => {
    const state = get();
    const group = state.objects.get(groupId);
    if (!group || !('children' in group)) return;
    const leaves = group.children
      .map((cid) => state.objects.get(cid))
      .filter((o): o is StudioPart => !!o && isPart(o));
    if (leaves.length === 0) return;
    // AABB extents (current).
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of leaves) {
      const hx = p.size.x / 2, hy = p.size.y / 2, hz = p.size.z / 2;
      minX = Math.min(minX, p.position.x - hx); maxX = Math.max(maxX, p.position.x + hx);
      minY = Math.min(minY, p.position.y - hy); maxY = Math.max(maxY, p.position.y + hy);
      minZ = Math.min(minZ, p.position.z - hz); maxZ = Math.max(maxZ, p.position.z + hz);
    }
    const oldW = Math.max(maxX - minX, 0.001);
    const oldH = Math.max(maxY - minY, 0.001);
    const oldD = Math.max(maxZ - minZ, 0.001);
    const pivot = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
    // Per-axis scale factor (newSize / oldSize), guarded against divide-by-zero.
    const sx = Number.isFinite(newSize.x) && newSize.x > 0.001 ? newSize.x / oldW : 1;
    const sy = Number.isFinite(newSize.y) && newSize.y > 0.001 ? newSize.y / oldH : 1;
    const sz = Number.isFinite(newSize.z) && newSize.z > 0.001 ? newSize.z / oldD : 1;
    state.beginTransformGesture();
    try {
      state.transformPartsBulk(leaves.map((p) => {
        // Scale each leaf's size by the per-axis factor (clamped to min).
        const newPartSize = {
          x: clampPartSizeValue(p.size.x * sx),
          y: clampPartSizeValue(p.size.y * sy),
          z: clampPartSizeValue(p.size.z * sz),
        };
        // Position scales relative to pivot (so the whole group grows
        // around its center, just like the gizmo's group scale path).
        const rel = { x: p.position.x - pivot.x, y: p.position.y - pivot.y, z: p.position.z - pivot.z };
        return {
          id: p.id,
          size: newPartSize,
          position: { x: pivot.x + rel.x * sx, y: pivot.y + rel.y * sy, z: pivot.z + rel.z * sz },
        };
      }));
    } finally {
      state.endTransformGesture();
    }
  },

  setGroupRotation: (groupId, newRotation) => {
    const state = get();
    const group = state.objects.get(groupId);
    if (!group || !('children' in group)) return;
    const leaves = group.children
      .map((cid) => state.objects.get(cid))
      .filter((o): o is StudioPart => !!o && isPart(o));
    if (leaves.length === 0) return;
    // AABB center = rotation pivot.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of leaves) {
      const hx = p.size.x / 2, hy = p.size.y / 2, hz = p.size.z / 2;
      minX = Math.min(minX, p.position.x - hx); maxX = Math.max(maxX, p.position.x + hx);
      minY = Math.min(minY, p.position.y - hy); maxY = Math.max(maxY, p.position.y + hy);
      minZ = Math.min(minZ, p.position.z - hz); maxZ = Math.max(maxZ, p.position.z + hz);
    }
    const pivot = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
    // Use the first child's rotation as the "current" rotation (the panel
    // shows the first child's rotation as a representative value).
    const firstChild = leaves[0];
    const oldRot = firstChild.rotation;
    // Compute per-axis delta in radians.
    const ddx = (newRotation.x - oldRot.x) * Math.PI / 180;
    const ddy = (newRotation.y - oldRot.y) * Math.PI / 180;
    const ddz = (newRotation.z - oldRot.z) * Math.PI / 180;
    // Build the delta rotation as a quaternion.
    const dQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(ddx, ddy, ddz, 'XYZ'));
    state.beginTransformGesture();
    try {
      state.transformPartsBulk(leaves.map((p) => {
        // Rotate each leaf's position around the pivot.
        const rel = new THREE.Vector3(p.position.x - pivot.x, p.position.y - pivot.y, p.position.z - pivot.z);
        rel.applyQuaternion(dQuat);
        // Add the rotation delta to the leaf's own rotation.
        const leafQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          p.rotation.x * Math.PI / 180,
          p.rotation.y * Math.PI / 180,
          p.rotation.z * Math.PI / 180,
        ));
        leafQuat.premultiply(dQuat);
        const leafEuler = new THREE.Euler().setFromQuaternion(leafQuat, 'XYZ');
        return {
          id: p.id,
          position: { x: pivot.x + rel.x, y: pivot.y + rel.y, z: pivot.z + rel.z },
          rotation: {
            x: normalizeRotationValue(leafEuler.x * 180 / Math.PI),
            y: normalizeRotationValue(leafEuler.y * 180 / Math.PI),
            z: normalizeRotationValue(leafEuler.z * 180 / Math.PI),
          },
        };
      }));
    } finally {
      state.endTransformGesture();
    }
  },

  // ─── v13.6: click-to-place spawning ───
  beginPlacement: (type) => {
    set({ pendingPlacement: type, selectedIds: [] });
  },

  cancelPlacement: () => {
    if (get().pendingPlacement !== null) set({ pendingPlacement: null });
  },

  // ─── v13.6: camera focus requests (F key) ───
  requestCameraFocus: (id) => {
    set({ cameraFocusRequest: { id, nonce: ++_focusNonce } });
  },

  setPhysicsLoadPending: (pending) => {
    const lp = get().loadProgress;
    if (!!lp.physicsPending === pending) return;
    set({ loadProgress: { ...lp, physicsPending: pending } });
  },

  setGridSize: (size) => {
    // pass 26.1: 0 is valid (no snapping) and the value is SAVED on this
    // device (it used to clamp to a 0.1 minimum and reset on reload).
    const v = Number.isFinite(size) ? Math.min(Math.max(size, 0), 100) : 1;
    set({ gridSize: v });
    saveEditorSettings({ snapUnit: v });
  },

  getObjectById: (id) => get().objects.get(id),

  getChildren: (parentId) => {
    const objects = get().objects;
    const children: StudioObject[] = [];
    objects.forEach((obj) => {
      if (obj.parentId === parentId) {
        children.push(obj);
      }
    });
    return children;
  },

  getGroupLeafPartIds: (groupId) => {
    return collectLeafPartIds(get().objects, groupId);
  },

  getGroupCenter: (groupId) => {
    return computeGroupCenter(get().objects, groupId);
  },

  loadProject: (data) => {
    const newObjects = new Map<string, StudioObject>();
    data.objects.forEach((obj) => {
      if (isPart(obj)) {
        // pass 15 (baseplate -> plain Block): same migration as
        // restoreStudioState - a legacy isBaseplate part becomes a normal
        // Block with the standard Plastic material, keeping its saved
        // transform. (Also upgrades old default-transparent spawn points to
        // opaque.) NOTE: pass 16 re-introduced the build-safe Wireframe
        // material, so legacy pass-14 saves carrying material: 'Wireframe'
        // are now PRESERVED (the new Wireframe uses the standard material's
        // built-in wireframe flag, no shader injection, prerender-safe).
        if ((obj as any).isBaseplate) {
          delete (obj as any).isBaseplate;
          (obj as any).material = 'Plastic';
          if (!obj.color || obj.color.toLowerCase() === '#3d6666') {
            (obj as any).color = '#397941';
          }
        }
        if (obj.isSpawnPoint && Number(obj.transparency) === 0.6) {
          (obj as any).transparency = 0;
        }
        // v13.5: repair broken values from old files at the door. Files saved
        // by older versions (or hand-edited) can carry zero/negative/huge
        // sizes or 370-degree rotations - once inside the store, that state
        // is invisible to every future clamp. Normalize here so the invariant
        // "no part in the store has a bad size/rotation" always holds.
        newObjects.set(obj.id, {
          ...obj,
          size: {
            x: clampPartSizeValue(Number(obj.size?.x ?? 1)),
            y: clampPartSizeValue(Number(obj.size?.y ?? 1)),
            z: clampPartSizeValue(Number(obj.size?.z ?? 1)),
          },
          rotation: {
            x: normalizeRotationValue(Number(obj.rotation?.x ?? 0)),
            y: normalizeRotationValue(Number(obj.rotation?.y ?? 0)),
            z: normalizeRotationValue(Number(obj.rotation?.z ?? 0)),
          },
          transparency: clampUnitValue(Number(obj.transparency ?? 0)),
          reflectance: clampUnitValue(Number(obj.reflectance ?? 0)),
        } as StudioPart);
      } else {
        newObjects.set(obj.id, obj);
      }
    });
    // v13.4 progressive reveal: big projects mount in batches so the app never
    // freezes and the loading screen can show real progress. Small projects
    // (< 300 objects) mount instantly like before.
    const PART_REVEAL_THRESHOLD = 300;
    const partCount = data.objects.filter((o) => isPart(o)).length;
    const progressive = partCount > PART_REVEAL_THRESHOLD;
    set({
      objects: newObjects,
      selectedIds: [],
      joints: [],
      explosionVisuals: [],
      groupModeIds: [],
      unionModeIds: [],
      consoleMessages: [],
      partRevealLimit: progressive ? 0 : Infinity,
      loadProgress: { active: progressive, total: partCount, mounted: 0 },
      objectsVersion: get().objectsVersion + 1,
      worldLoadNonce: get().worldLoadNonce + 1,
    });
  },

  revealMoreParts: (count) => {
    const state = get();
    // Nothing to reveal if we're not in a progressive load
    if (!state.loadProgress.active) return;
    const mounted = Math.min(state.partRevealLimit + count, state.loadProgress.total);
    const done = mounted >= state.loadProgress.total;
    set({
      // Back to Infinity when done: the reveal limit must NEVER cap future
      // parts (user adds a part after loading a big map - it must render).
      partRevealLimit: done ? Infinity : mounted,
      loadProgress: { active: !done, total: state.loadProgress.total, mounted },
    });
  },

  finishPartReveal: () => {
    set({
      partRevealLimit: Infinity,
      loadProgress: { active: false, total: 0, mounted: 0 },
    });
  },

  /**
   * v13.4: restart progressive mounting (used when Test Play swaps to the
   * GamePlayer page - its canvas mounts every part fresh, and mounting
   * 5,801 components in one React commit freezes even fast machines).
   */
  restartPartReveal: () => {
    const state = get();
    const partCount = Array.from(state.objects.values()).filter((o) => isPart(o)).length;
    if (partCount <= 300) {
      set({ partRevealLimit: Infinity, loadProgress: { active: false, total: partCount, mounted: partCount } });
      return;
    }
    set({ partRevealLimit: 0, loadProgress: { active: true, total: partCount, mounted: 0 } });
  },

  syncPhysicsPositions: (updates) => {
    if (updates.length === 0) return;
    set((state) => {
      // Skip entirely during undo snapshotting? No - physics writes don't push
      // undo (see _pushUndo guard); this is purely a state merge.
      const newObjects = new Map(state.objects);
      for (const u of updates) {
        const obj = newObjects.get(u.id);
        if (!obj || !isPart(obj)) continue;
        newObjects.set(u.id, {
          ...obj,
          position: { x: u.position.x, y: u.position.y, z: u.position.z },
          // v13.5: normalize like updateObject so play-mode physics can't
          // leave rotation as 370 or -90 in the stored data.
          rotation: {
            x: normalizeRotationValue(u.rotation.x),
            y: normalizeRotationValue(u.rotation.y),
            z: normalizeRotationValue(u.rotation.z),
          },
        } as StudioPart);
      }
      return { objects: newObjects };
    });
  },

  setPhysicsSettings: (updates) =>
    set((state) => ({
      physicsSettings: { ...state.physicsSettings, ...updates },
    })),

  addJoint: (joint) =>
    set((state) => ({
      joints: [...state.joints, joint],
    })),

  removeJoint: (id) =>
    set((state) => ({
      joints: state.joints.filter((j) => j.id !== id),
    })),

  updateJoint: (id, updates) =>
    set((state) => ({
      joints: state.joints.map((j) => (j.id === id ? { ...j, ...updates } : j)),
    })),

  addBodyMover: (partId, mover) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      newObjects.set(partId, { ...obj, bodyMovers: [...obj.bodyMovers, mover] } as StudioPart);
      return { objects: newObjects };
    });
  },

  removeBodyMover: (partId, moverId) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      newObjects.set(partId, { ...obj, bodyMovers: obj.bodyMovers.filter((m) => m.id !== moverId) } as StudioPart);
      return { objects: newObjects };
    });
  },

  updateBodyMover: (partId, moverId, updates) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      newObjects.set(partId, { ...obj, bodyMovers: obj.bodyMovers.map((m) =>
        m.id === moverId ? { ...m, ...updates } : m
      ) } as StudioPart);
      return { objects: newObjects };
    });
  },

  createExplosion: (position, blastRadius, blastPressure) => {
    const state = get();
    const addMsg = state.addConsoleMessage;
    addMsg('info', `Explosion at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}) - radius: ${blastRadius}, pressure: ${blastPressure}`);

    const newObjects = new Map(state.objects);
    state.objects.forEach((obj) => {
      if (!isPart(obj) || obj.anchored) return;

      const dx = obj.position.x - position.x;
      const dy = obj.position.y - position.y;
      const dz = obj.position.z - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distance < blastRadius && distance > 0.01) {
        const force = blastPressure * (1 - distance / blastRadius);
        const dirX = dx / distance;
        const dirY = dy / distance + 0.5;
        const dirZ = dz / distance;

        const explosionMover: BodyMover = {
          id: `explosion_${Date.now()}_${obj.id}`,
          type: 'BodyForce',
          enabled: true,
          force: {
            x: dirX * force * 1000,
            y: dirY * force * 1000,
            z: dirZ * force * 1000,
          },
          duration: 0.15, // Auto-remove after EXPLOSION_IMPULSE_DURATION seconds
          _elapsed: 0,
        };

        const updatedMovers = [...obj.bodyMovers, explosionMover];
        newObjects.set(obj.id, { ...obj, bodyMovers: updatedMovers } as StudioPart);
      }
    });

    const brokenJoints = state.joints.filter((j) => {
      const partA = state.objects.get(j.partAId);
      if (!partA || !isPart(partA)) return false;
      const dx = partA.position.x - position.x;
      const dy = partA.position.y - position.y;
      const dz = partA.position.z - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return distance < blastRadius;
    });

    const updatedJoints = state.joints.filter(
      (j) => !brokenJoints.some((bj) => bj.id === j.id)
    );

    // Add explosion visual
    const explosionVisual = {
      id: `explosion_vis_${Date.now()}`,
      position: { ...position },
      radius: blastRadius,
      startTime: Date.now(),
    };

    set({ objects: newObjects, joints: updatedJoints, explosionVisuals: [...state.explosionVisuals, explosionVisual] });
    if (brokenJoints.length > 0) {
      addMsg('info', `Explosion broke ${brokenJoints.length} joint(s)`);
    }
  },

  makeJoints: (partId) => {
    const state = get();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return 0;

    // v13.8: TOUCHING counts too (with a small tolerance) - the old strict
    // overlap test (<, no epsilon) skipped parts whose faces merely touched,
    // which is exactly how users place things they want welded.
    const TOUCH_EPS = 0.06;
    const newJoints: Joint[] = [];
    state.objects.forEach((obj) => {
      if (!isPart(obj) || obj.id === partId) return;

      const overlapX = Math.abs(part.position.x - obj.position.x) < (part.size.x + obj.size.x) / 2 + TOUCH_EPS;
      const overlapY = Math.abs(part.position.y - obj.position.y) < (part.size.y + obj.size.y) / 2 + TOUCH_EPS;
      const overlapZ = Math.abs(part.position.z - obj.position.z) < (part.size.z + obj.size.z) / 2 + TOUCH_EPS;

      if (overlapX && overlapY && overlapZ) {
        const exists = state.joints.some(
          (j) =>
            (j.partAId === partId && j.partBId === obj.id) ||
            (j.partAId === obj.id && j.partBId === partId)
        );
        if (!exists) {
          newJoints.push({
            id: `joint_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            type: 'Weld',
            partAId: partId,
            partBId: obj.id,
            enabled: true,
            C0: { x: 0, y: 0, z: 0 },
            C1: { x: obj.position.x - part.position.x, y: obj.position.y - part.position.y, z: obj.position.z - part.position.z },
          });
        }
      }
    });

    if (newJoints.length > 0) {
      set((s) => ({ joints: [...s.joints, ...newJoints] }));
      state.addConsoleMessage('info', `Created ${newJoints.length} weld joint(s) for ${part.name}`);
    } else {
      state.addConsoleMessage('info', `No touching parts found for ${part.name}`);
    }
    return newJoints.length;
  },

  breakJoints: (partId) => {
    const state = get();
    const removed = state.joints.filter(
      (j) => j.partAId === partId || j.partBId === partId
    );
    set({
      joints: state.joints.filter(
        (j) => j.partAId !== partId && j.partBId !== partId
      ),
    });
    state.addConsoleMessage('info', `Broke ${removed.length} joint(s)`);
  },

  addEffect: (partId, effect) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      newObjects.set(partId, { ...obj, effects: [...(obj.effects || []), effect] } as StudioPart);
      return { objects: newObjects };
    });
    const obj = get().objects.get(partId);
    if (obj && isPart(obj)) {
      get().addConsoleMessage('info', `Added ${effect.type} effect to ${obj.name}`);
    }
  },

  removeEffect: (partId, effectId) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      newObjects.set(partId, { ...obj, effects: (obj.effects || []).filter((e) => e.id !== effectId) } as StudioPart);
      return { objects: newObjects };
    });
  },

  updateEffect: (partId, effectId, updates) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      newObjects.set(partId, { ...obj, effects: (obj.effects || []).map((e) =>
        e.id === effectId ? { ...e, ...updates } : e
      ) } as StudioPart);
      return { objects: newObjects };
    });
  },

  addSpawnPoint: (opts?: { team?: string }) => {
    _pushUndo(get, set);
    const state = get();
    partCounter++;
    const id = generateId();
    const team = (opts?.team as 'Neutral' | 'Blue' | 'Red') || 'Neutral';
    const spawnColor = team === 'Blue' ? '#3366cc' : team === 'Red' ? '#cc3333' : '#4a90d9';
    const spawnPart: StudioPart = {
      id,
      name: nextObjectName('Spawn_Location', get().objects),
      type: 'Spawn',
      // v13.6: spawn spawns exactly at 0, 0.5, 0 - resting on the default
      // baseplate's surface (baseplate at 0,0,0 with height 1 -> top at 0.5)
      position: { x: 0, y: 0.5, z: 0 },
      size: { x: 3, y: 0.3, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      color: spawnColor,
      material: 'Neon',
      // pass 14 (user request): spawn points are fully OPAQUE now (the old
      // 0.6 semi-transparent marker default is gone). The SpawnMarker ring
      // renders above the pad, so nothing is lost visually.
      transparency: 0,
      reflectance: 0,
      anchored: true,
      canCollide: false, // Not a physical object - it's a visual marker only
      friction: 0.5,
      elasticity: 0.2,
      density: 1.0,
      children: [],
      parentId: null,
      bodyMovers: [],
      effects: [],
      isSpawnPoint: true,
      spawnTeam: team,
    };
    const newObjects = new Map(state.objects);
    newObjects.set(id, spawnPart);
    set({ objects: newObjects, selectedIds: [] });
    state.addConsoleMessage('info', `Created SpawnLocation: ${spawnPart.name}`);
  },

  addBaseplate: () => {
    const state = get();
    // pass 20 (user request): the baseplate defaults to the Wireframe
    // material (white) so a fresh studio shows the classic 1-stud grid
    // baseplate. It's still a plain Block — movable, rotatable,
    // recolorable, deletable — just with the wireframe-grid texture and a
    // white base colour. The pass-14 GLSL-grid Wireframe that broke the
    // Vercel prerender is gone for good (pass 16+ uses a baked static
    // texture). Old saves keep whatever material they had. Structurally
    // it's a normal 100×1×100 block: it can be MOVED (the old gizmo guard
    // that pinned it at 0,0,0 is gone), rotated, recolored, even deleted.
    let exists = false;
    state.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      if ((obj as any).isBaseplate) { exists = true; return; } // legacy flag
      if (obj.name === 'Baseplate') exists = true;
    });
    if (exists) return; // Don't add a duplicate baseplate

    _pushUndo(get, set);
    const currentState = get();
    partCounter++;
    const id = generateId();
    const bpSize = currentState.worldSettings.baseplateSize;
    const baseplatePart: StudioPart = {
      id,
      name: 'Baseplate',
      type: 'Block',
      position: { x: 0, y: 0, z: 0 },
      size: { x: bpSize, y: 1, z: bpSize },
      rotation: { x: 0, y: 0, z: 0 },
      // pass 21: back to the classic GREEN baseplate (the owner asked for
      // green again after pass 20 made it white). It keeps the Wireframe
      // material - the grid texture's albedo is white with gray lines and
      // the part colour multiplies through, so green shows a green plate
      // with darker-green grid lines (the classic coloured-baseplate look).
      color: '#397941',
      material: 'Wireframe',
      transparency: 0,
      reflectance: 0,
      anchored: true,
      canCollide: true,
      friction: 0.5,
      elasticity: 0.2,
      density: 1.0,
      children: [],
      parentId: null,
      bodyMovers: [],
      effects: [],
    };
    const newObjects = new Map(currentState.objects);
    newObjects.set(id, baseplatePart);
    set({ objects: newObjects });
    currentState.addConsoleMessage('info', `Created Baseplate`);
  },

  // ─── Character body parts ───
  // Creates 7 StudioParts representing the character's body. These are REAL
  // parts - they can be selected, colored, resized, have effects/rules, and
  // even deleted (delete the head → no head in-game). The game player reads
  // these parts to assemble the character instead of using a hardcoded mesh.
  addDefaultCharacterParts: () => {
    const state = get();
    const hasCharacterParts = Array.from(state.objects.values()).some(
      (obj) => isPart(obj) && obj.isCharacterPart
    );
    if (hasCharacterParts) return;

    const S = 2.0 / 2.55;
    const TORSO_H = 1.0 * S, TORSO_W = 0.875 * S, TORSO_D = 0.6 * S;
    const HEAD_W = 0.625 * S, HEAD_H = 0.625 * S, HEAD_D = 0.6 * S;
    const ARM_W = 0.4375 * S, ARM_H = 0.975 * S, ARM_D = 0.5 * S;
    const LEG_W = 0.4375 * S, LEG_H = 0.875 * S, LEG_D = 0.5 * S;
    const ARM_GAP = 0.02 * S, HEAD_GAP = 0.05 * S, LEG_GAP = 0.05 * S;

    const torsoY = LEG_H;
    const headY = LEG_H + TORSO_H + HEAD_GAP;

    const skinColor = state.avatar.skin || '#f8ff6d';
    const shirtColor = '#CC0000';
    const pantsColor = '#2196F3';

    const makeCharPart = (
      name: string,
      partType: 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'face',
      pos: { x: number; y: number; z: number },
      size: { x: number; y: number; z: number },
      color: string,
    ): StudioPart => ({
      id: generateId(),
      name,
      type: 'Block',
      position: pos,
      size,
      rotation: { x: 0, y: 0, z: 0 },
      color,
      material: 'Plastic',
      transparency: 0,
      reflectance: 0,
      anchored: true,
      canCollide: false,
      friction: 0.5,
      elasticity: 0.2,
      density: 1.0,
      children: [],
      parentId: null,
      bodyMovers: [],
      effects: [],
      isCharacterPart: true,
      characterPartType: partType,
      showInWorld: true, // visible in editor and during gameplay
      // pass 21 (camera rebuild): character parts never occlude the camera
      // (it orbits its own character - the body must not retract it).
      cameraCanLookThrough: true,
      // ─── Avatar Modification defaults ───
      // Enable "Modify Color to Player's Avatar" by default for all body parts
      // so the joining player's equipped skin/shirt/pants override the part's
      // own color in play mode. Without this, the checkboxes are all unchecked
      // and the player's avatar doesn't apply to the character rig.
      // - head/arms → use avatar.skin
      // - torso     → use avatar.shirt (by ID)
      // - legs      → use avatar.left_leg / avatar.right_leg (by ID)
      modifyColorToAvatar: true,
      // Enable "Modify Face to Player's Avatar" by default for face parts so
      // the joining player's equipped face (avatar.face, by ID) overrides the
      // face part's own texture in play mode.
      modifyFaceToAvatar: partType === 'face',
    });

    const parts: StudioPart[] = [
      makeCharPart('Head', 'head', { x: 0, y: headY + HEAD_H / 2, z: 0 }, { x: HEAD_W, y: HEAD_H, z: HEAD_D }, skinColor),
      makeCharPart('Face', 'face', { x: 0, y: headY + HEAD_H / 2, z: HEAD_D / 2 + 0.002 }, { x: HEAD_W * 0.95, y: HEAD_H * 0.95, z: 0.01 }, skinColor),
      makeCharPart('Torso', 'torso', { x: 0, y: torsoY + TORSO_H / 2, z: 0 }, { x: TORSO_W, y: TORSO_H, z: TORSO_D }, shirtColor),
      // PASS-4 FIX (limb swap): the character's own LEFT side is +X (the
      // platform's characters face +Z at yaw 0, so left = +X, right = -X).
      // The old placement had left/right swapped everywhere.
      makeCharPart('LeftArm', 'leftArm', { x: TORSO_W / 2 + ARM_W / 2 + ARM_GAP, y: torsoY + ARM_H / 2, z: 0 }, { x: ARM_W, y: ARM_H, z: ARM_D }, skinColor),
      makeCharPart('RightArm', 'rightArm', { x: -(TORSO_W / 2 + ARM_W / 2 + ARM_GAP), y: torsoY + ARM_H / 2, z: 0 }, { x: ARM_W, y: ARM_H, z: ARM_D }, skinColor),
      makeCharPart('LeftLeg', 'leftLeg', { x: LEG_W / 2 + LEG_GAP / 2, y: LEG_H / 2, z: 0 }, { x: LEG_W, y: LEG_H, z: LEG_D }, pantsColor),
      makeCharPart('RightLeg', 'rightLeg', { x: -(LEG_W / 2 + LEG_GAP / 2), y: LEG_H / 2, z: 0 }, { x: LEG_W, y: LEG_H, z: LEG_D }, pantsColor),
    ];

    const newObjects = new Map(state.objects);
    for (const part of parts) newObjects.set(part.id, part);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
    state.addConsoleMessage('info', `Created character body parts (${parts.length} parts)`);
    // v1.3: the CharacterRoot part is gone - the character spawns at the
    // Spawn part (or the world's Spawn Position setting) and uses the
    // standard hitbox (DEFAULT_CHARACTER_HITBOX_SIZE).
  },

  setWorldSettings: (updates) =>
    set((state) => ({
      worldSettings: { ...state.worldSettings, ...updates },
    })),

  setAvatar: (avatar) => set({ avatar }),

  setGroupModeIds: (ids) => set({ groupModeIds: ids }),
  setUnionModeIds: (ids) => set({ unionModeIds: ids }),

  // ─── Per-object variables ───
  // Stored on the part itself so they are scoped to that part only (vs globalVariables).
  setObjectVariable: (partId, name, value) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj)) return {};
      const newObjects = new Map(s.objects);
      const nextVars = { ...(obj.objectVariables || {}) };
      nextVars[name] = value;
      newObjects.set(partId, { ...obj, objectVariables: nextVars } as StudioPart);
      return { objects: newObjects };
    });
  },

  deleteObjectVariable: (partId, name) => {
    set((s) => {
      const obj = s.objects.get(partId);
      if (!obj || !isPart(obj) || !obj.objectVariables) return {};
      const newObjects = new Map(s.objects);
      const nextVars = { ...obj.objectVariables };
      delete nextVars[name];
      newObjects.set(partId, { ...obj, objectVariables: nextVars } as StudioPart);
      return { objects: newObjects };
    });
  },

  // ─── Typed joint removal (e.g. only Ropes) ───
  removeJointsOfType: (partId, type) => {
    const state = get();
    const matching = state.joints.filter(
      (j) => j.type === type && (j.partAId === partId || j.partBId === partId)
    );
    if (matching.length === 0) return 0;
    const matchingIds = new Set(matching.map((j) => j.id));
    set({
      joints: state.joints.filter((j) => !matchingIds.has(j.id)),
    });
    return matching.length;
  },

  // ─── Universes actions ───

  addUniverse: (name: string) => {
    const state = get();
    // Save current scene to the current universe first
    const currentUniverseId = state.currentUniverseId;
    const currentObjects: StudioObject[] = [];
    state.objects.forEach((obj) => currentObjects.push(JSON.parse(JSON.stringify(obj))));
    const currentJoints = [...state.joints];

    const newUniverseId = `place_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newUniverse: UniverseData = { id: newUniverseId, name, objects: [], joints: [] };

    const newUniverses = new Map(state.universes);
    // Update the current universe with its latest objects
    newUniverses.set(currentUniverseId, {
      ...newUniverses.get(currentUniverseId)!,
      objects: currentObjects,
      joints: currentJoints,
    });
    // Add the new universe
    newUniverses.set(newUniverseId, newUniverse);

    // Switch to the new universe (clear objects and joints, create fresh scene)
    partCounter = 0;
    set({
      universes: newUniverses,
      currentUniverseId: newUniverseId,
      objects: new Map<string, StudioObject>(),
      selectedIds: [],
      joints: [],
      groupModeIds: [],
      unionModeIds: [],
      explosionVisuals: [],
      consoleMessages: [],
    });
    return newUniverseId;
  },

  switchUniverse: (universeId: string) => {
    const state = get();
    if (universeId === state.currentUniverseId) return;

    // Save current scene to the current universe
    const currentObjects: StudioObject[] = [];
    state.objects.forEach((obj) => currentObjects.push(JSON.parse(JSON.stringify(obj))));
    const currentJoints = [...state.joints];

    const newUniverses = new Map(state.universes);
    newUniverses.set(state.currentUniverseId, {
      ...newUniverses.get(state.currentUniverseId)!,
      objects: currentObjects,
      joints: currentJoints,
    });

    // Load the target universe's objects
    const targetUniverse = newUniverses.get(universeId);
    if (!targetUniverse) return;

    const newObjects = new Map<string, StudioObject>();
    targetUniverse.objects.forEach((obj) => newObjects.set(obj.id, obj));

    set({
      universes: newUniverses,
      currentUniverseId: universeId,
      objects: newObjects,
      selectedIds: [],
      joints: [...targetUniverse.joints],
      groupModeIds: [],
      unionModeIds: [],
      explosionVisuals: [],
      objectsVersion: get().objectsVersion + 1,
    });
  },

  deleteUniverse: (universeId: string) => {
    const state = get();
    if (state.universes.size <= 1) return; // Don't delete the last universe
    if (universeId === state.currentUniverseId) return; // Can't delete active universe

    const newUniverses = new Map(state.universes);
    newUniverses.delete(universeId);
    set({ universes: newUniverses });
  },

  renameUniverse: (universeId: string, newName: string) => {
    const state = get();
    const newUniverses = new Map(state.universes);
    const universe = newUniverses.get(universeId);
    if (!universe) return;
    newUniverses.set(universeId, { ...universe, name: newName });
    set({ universes: newUniverses });
  },

  clearProject: () => {
    partCounter = 0;
    set({
      objects: new Map<string, StudioObject>(),
      selectedIds: [],
      joints: [],
      groupModeIds: [],
      unionModeIds: [],
      explosionVisuals: [],
      clipboard: null,
      consoleMessages: [],
      activeTool: 'Select',
      activeTab: 'Home',
      // WeLua + player inventory reset with the world
      gameWeluScripts: [],
      inventory: [],
      hotbarItemIds: [null, null, null, null],
      // v13.4: cancel any in-flight progressive load
      partRevealLimit: Infinity,
      loadProgress: { active: false, total: 0, mounted: 0 },
      objectsVersion: get().objectsVersion + 1,
      worldLoadNonce: get().worldLoadNonce + 1,
      pendingPlacement: null,
      _transformGesture: false,
      playState: {
        isPlaying: false,
        isTestPlay: false,
        characterPosition: { x: 0, y: 5, z: 0 },
        characterVelocity: { x: 0, y: 0, z: 0 },
        isGrounded: false,
        characterRotation: 0,
        characterHealth: 100,
        characterMaxHealth: 100,
        teleportPosition: null,
        characterSpeed: 0,
        spawnPointOverride: null,
        pendingRespawn: 0,
      },
      simulationState: {
        isSimulating: false,
      },
      physicsSettings: {
        gravity: -35,
        collisionsEnabled: true,
        waterForce: 1,
        waterDirection: { x: 1, y: 0, z: 0 },
        experimentalSolver: false,
      },
      terrainSettings: {
        width: 100,
        length: 100,
        amplitude: 10,
        frequency: 0.1,
        waterHeight: 2,
        baseHeight: 0,
        terrainStyle: 'blocky',
        preset: 'Nature',
        maxHeight: 20,
        minHeight: 0,
        seaLevel: 2,
        treeDensity: 0.3,
        blockSize: 4,
        terrainColor: '#4a7c3f',
        seed: 42,
      },
      showTerrain: false,
      // Reset terrain v2 state too - new project = fresh terrain
      terrainHeightmap: null,
      terrainConfig: { ...DEFAULT_TERRAIN_CONFIG },
      waterBodies: [],
      treeInstances: [],
      brushSettings: { ...DEFAULT_BRUSH },
      activeTreeVariant: 'oak',
      terrainColor: '#4a7c3f',
      waterColor: '#2c7be0',
      terrainLayers: DEFAULT_TERRAIN_LAYERS.map(l => ({ ...l })),
      brushPaintColor: '#ff6600',
      worldSettings: {
        skyColorTop: '#6699e6',
        skyColorBottom: '#b3cce6',
        ambientLightIntensity: 0.4,
        baseplateSize: 100,
        gravity: -35,
        maxPlayers: 10,
        spawnPointPosition: { x: 0, y: 1, z: 0 },
        sunEnabled: true,
        sunColor: '#fff4e0',
        sunSize: 1.0,
        moonEnabled: true,
        moonColor: '#e8e8f0',
        moonSize: 0.8,
        cloudsEnabled: true,
        cloudColor: '#ffffff',
        cloudDensity: 0.4,
        cloudSpeed: 1.0,
        windDirection: 90,
        starsEnabled: true,
        starCount: 1200,
        dayNightEnabled: false,
        timeOfDay: 12,
        dayLength: 120,
        weatherType: 'clear',
        weatherIntensity: 0.5,
        // pass 21 (camera rebuild): classic camera behaviour by default.
        cameraFollowCharacter: true,
        cameraCharacterLookLock: true,
        cameraCanOrbit: true,
        cameraCanLookThroughObjects: true,
      },
      avatar: {
        skin: '#f8ff6d',
        face: 'FACE-1',
        shirt: 'SHIRT-1',
        left_leg: 'PANTS-1',
        right_leg: 'PANTS-1',
      },
      showGrid: true,
      snapToGrid: true,
      gridSize: 1,
      snapInvert: false,
      universes: new Map<string, UniverseData>([
        ['place_default', { id: 'place_default', name: 'Start', objects: [], joints: [] }],
      ]),
      currentUniverseId: 'place_default',
      undoStack: [],
      redoStack: [],
    });
  },

  removeExplosionVisual: (id) =>
    set((state) => ({
      explosionVisuals: state.explosionVisuals.filter((e) => e.id !== id),
    })),

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) return;
    const currentSnapshot = snapshotState(state.objects, state.joints, state.inventory, state.hotbarItemIds);
    const undoStack = [...state.undoStack];
    const previousSnapshot = undoStack.pop()!;
    const redoStack = [...state.redoStack, currentSnapshot];
    if (redoStack.length > MAX_UNDO_STACK) redoStack.shift();
    const restored = restoreSnapshot(previousSnapshot);
    // v7.6: inventory/hotbar restore when the snapshot carries them (pre-v7.6
    // snapshots keep the current values instead of wiping them).
    set({
      objects: restored.objects,
      joints: restored.joints,
      ...(restored.inventory !== null ? { inventory: restored.inventory } : {}),
      ...(restored.hotbarItemIds !== null ? { hotbarItemIds: restored.hotbarItemIds } : {}),
      undoStack, redoStack, selectedIds: [], objectsVersion: state.objectsVersion + 1,
    });
    state.addConsoleMessage('info', 'Undo');
  },

  redo: () => {
    const state = get();
    if (state.redoStack.length === 0) return;
    const currentSnapshot = snapshotState(state.objects, state.joints, state.inventory, state.hotbarItemIds);
    const redoStack = [...state.redoStack];
    const nextSnapshot = redoStack.pop()!;
    const undoStack = [...state.undoStack, currentSnapshot];
    if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
    const restored = restoreSnapshot(nextSnapshot);
    set({
      objects: restored.objects,
      joints: restored.joints,
      ...(restored.inventory !== null ? { inventory: restored.inventory } : {}),
      ...(restored.hotbarItemIds !== null ? { hotbarItemIds: restored.hotbarItemIds } : {}),
      undoStack, redoStack, selectedIds: [], objectsVersion: state.objectsVersion + 1,
    });
    state.addConsoleMessage('info', 'Redo');
  },

  // ─── WeildCode Rule Management ───

  // ─── v1.5: game-level rules ───
  gameRules: [],
  addGameRule: (rule: WeildCodeRule) => {
    set((state) => ({ gameRules: [...state.gameRules, rule] }));
  },
  removeGameRule: (ruleId: string) => {
    set((state) => ({ gameRules: state.gameRules.filter((r) => r.id !== ruleId) }));
  },
  updateGameRule: (ruleId: string, updates: Partial<WeildCodeRule>) => {
    set((state) => ({
      gameRules: state.gameRules.map((r) => (r.id === ruleId ? { ...r, ...updates } : r)),
    }));
  },

  addRule: (partId: string, rule: WeildCodeRule) => {
    const state = get();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const newObjects = new Map(state.objects);
    const existingRules = obj.rules || [];
    newObjects.set(partId, { ...obj, rules: [...existingRules, rule] } as StudioPart);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
  },

  removeRule: (partId: string, ruleId: string) => {
    const state = get();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const newObjects = new Map(state.objects);
    const existingRules = obj.rules || [];
    newObjects.set(partId, { ...obj, rules: existingRules.filter((r) => r.id !== ruleId) } as StudioPart);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
  },

  updateRule: (partId: string, ruleId: string, updates: Partial<WeildCodeRule>) => {
    const state = get();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const newObjects = new Map(state.objects);
    const existingRules = obj.rules || [];
    newObjects.set(partId, {
      ...obj,
      rules: existingRules.map((r) => r.id === ruleId ? { ...r, ...updates } : r),
    } as StudioPart);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
  },

  // ─── WeLua script management (same shape as the rule management) ───

  addWeluScript: (partId, script) => {
    const state = get();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const newObjects = new Map(state.objects);
    newObjects.set(partId, { ...obj, weluScripts: [...(obj.weluScripts || []), script] } as StudioPart);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
  },

  updateWeluScript: (partId, scriptId, updates) => {
    const state = get();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const newObjects = new Map(state.objects);
    newObjects.set(partId, {
      ...obj,
      weluScripts: (obj.weluScripts || []).map((s) => s.id === scriptId ? { ...s, ...updates } : s),
    } as StudioPart);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
  },

  removeWeluScript: (partId, scriptId) => {
    const state = get();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const newObjects = new Map(state.objects);
    newObjects.set(partId, {
      ...obj,
      weluScripts: (obj.weluScripts || []).filter((s) => s.id !== scriptId),
    } as StudioPart);
    set({ objects: newObjects, objectsVersion: state.objectsVersion + 1 });
  },

  addGameWeluScript: (script) => {
    set((state) => ({ gameWeluScripts: [...state.gameWeluScripts, script] }));
  },

  updateGameWeluScript: (scriptId, updates) => {
    set((state) => ({
      gameWeluScripts: state.gameWeluScripts.map((s) => s.id === scriptId ? { ...s, ...updates } : s),
    }));
  },

  removeGameWeluScript: (scriptId) => {
    set((state) => ({
      gameWeluScripts: state.gameWeluScripts.filter((s) => s.id !== scriptId),
    }));
  },

  // ─── Player Inventory ───
  // Moving an object into the inventory serializes its whole subtree
  // (parts + groups + their rules/weluScripts) and REMOVES it from the
  // world — "grab and move objects and groups to inventory and back".
  // Spawning re-instantiates the template with fresh ids.

  sendObjectToInventory: (id) => {
    const state = get();
    const obj = state.objects.get(id);
    if (!obj) return;
    _pushUndo(get, set);

    // Collect the subtree (single object or group + descendants).
    const subtreeIds = new Set(collectDescendants(state.objects, id));
    const objects: StudioObject[] = [];
    state.objects.forEach((o) => {
      if (subtreeIds.has(o.id)) objects.push(JSON.parse(JSON.stringify(o)));
    });
    if (objects.length === 0) return;

    const item: InventoryItemData = {
      id: `item_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: obj.name,
      sourceType: isPart(obj) ? 'part' : 'group',
      objects,
      rootId: id,
      createdAt: Date.now(),
    };

    // Remove the subtree from the world (without firing when_destroyed —
    // "grabbed" is its own event, not a destruction).
    set((s) => {
      const newObjects = new Map(s.objects);
      subtreeIds.forEach((deleteId) => newObjects.delete(deleteId));
      const root = s.objects.get(id);
      if (root?.parentId) {
        const parent = newObjects.get(root.parentId);
        if (parent && 'children' in parent) {
          newObjects.set(root.parentId, { ...parent, children: parent.children.filter((c) => !subtreeIds.has(c)) });
        }
      }
      return {
        objects: newObjects,
        selectedIds: s.selectedIds.filter((sid) => !subtreeIds.has(sid)),
        joints: s.joints.filter((j) => !subtreeIds.has(j.partAId) && !subtreeIds.has(j.partBId)),
        inventory: [...s.inventory, item],
        objectsVersion: s.objectsVersion + 1,
      };
    });
    state.addConsoleMessage('success', `[Inventory] "${item.name}" moved to the player inventory.`);
  },

  sendSelectionToInventory: () => {
    const state = get();
    const topIds = topMostSelectedIds(state.objects, state.selectedIds);
    if (topIds.length === 0) return;
    for (const id of topIds) {
      get().sendObjectToInventory(id);
    }
  },

  removeInventoryItem: (itemId) => {
    // v7.6 BUG FIX: deleting an inventory item is undoable now (the user
    // reported Ctrl+Z doing nothing here).
    _pushUndo(get, set);
    set((state) => ({
      inventory: state.inventory.filter((i) => i.id !== itemId),
      hotbarItemIds: state.hotbarItemIds.map((slotItemId) => slotItemId === itemId ? null : slotItemId),
    }));
  },

  renameInventoryItem: (itemId, name) => {
    _pushUndo(get, set);
    set((state) => ({
      inventory: state.inventory.map((i) => i.id === itemId ? { ...i, name } : i),
    }));
  },

  spawnInventoryItem: (itemId, position) => {
    _pushUndo(get, set);
    const state = get();
    const item = state.inventory.find((i) => i.id === itemId);
    if (!item) return null;

    // Fresh ids for every node (the template's ids may collide with the world).
    const idRemap = new Map<string, string>();
    for (const o of item.objects) {
      idRemap.set(o.id, generateId());
    }
    const newObjects = new Map(state.objects);
    const spawnedRoots: string[] = [];
    for (const o of item.objects) {
      const clone = JSON.parse(JSON.stringify(o)) as StudioObject;
      clone.id = idRemap.get(o.id)!;
      clone.parentId = o.parentId ? (idRemap.get(o.parentId) ?? null) : null;
      if ('children' in clone) {
        clone.children = clone.children.map((c) => idRemap.get(c) ?? c);
      }
      newObjects.set(clone.id, clone);
      if (!clone.parentId) spawnedRoots.push(clone.id);
    }

    // Reposition the root(s) so the item spawns where asked (default: at
    // the world's spawn area, offset per root so a multi-root template
    // doesn't stack up).
    let spawnBase: Vector3 = position
      ? { ...position }
      : { ...state.worldSettings.spawnPointPosition };
    spawnedRoots.forEach((rootId, index) => {
      const root = newObjects.get(rootId);
      if (root && isPart(root)) {
        newObjects.set(rootId, {
          ...root,
          position: { x: spawnBase.x + index * 3, y: spawnBase.y, z: spawnBase.z },
        } as StudioPart);
      }
    });

    set({
      objects: newObjects,
      inventory: state.inventory.filter((i) => i.id !== itemId),
      hotbarItemIds: state.hotbarItemIds.map((slotItemId) => slotItemId === itemId ? null : slotItemId),
      objectsVersion: state.objectsVersion + 1,
    });
    state.addConsoleMessage('success', `[Inventory] "${item.name}" spawned into the world.`);
    return spawnedRoots[0] ?? null;
  },

  setHotbarItem: (slot, itemId) => {
    _pushUndo(get, set);
    set((state) => {
      if (slot < 0 || slot >= HOTBAR_SLOT_COUNT) return {};
      const next = [...state.hotbarItemIds];
      // An item can only occupy one slot: clear it from the others first.
      if (itemId) {
        for (let i = 0; i < next.length; i++) {
          if (i !== slot && next[i] === itemId) next[i] = null;
        }
      }
      next[slot] = itemId ?? null;
      return { hotbarItemIds: next };
    });
  },

  // ─── Atomic Play/Simulate Mode Functions ───
  // These handle the complete start/stop lifecycle atomically.
  // CRITICAL DESIGN: On stop, we set isPlaying/isSimulating=false FIRST,
  // so that useFrame loops (PhysicsSimulation, PlayCharacter, SimulationOnly)
  // bail out immediately and never overwrite the restored snapshot state.

  startPlayMode: () => {
    const state = get();
    // Save snapshot of current state before any physics/modifications occur
    const snapshot = snapshotState(state.objects, state.joints);
    // pass 26: remember the editor's time-of-day so a day/night cycle that
    // runs during play can never leak back into the project.
    const timeAtStart = state.worldSettings.timeOfDay;
    set({
      _playSnapshot: snapshot,
      _timeOfDayAtPlayStart: timeAtStart,
      playState: {
        isPlaying: true,
        isTestPlay: false,
        characterPosition: { x: 0, y: 5, z: 0 },
        characterVelocity: { x: 0, y: 0, z: 0 },
        isGrounded: false,
        characterRotation: 0,
        characterHealth: 100,
        characterMaxHealth: 100,
        teleportPosition: null,
        characterSpeed: 0,
        spawnPointOverride: null,
        pendingRespawn: 0,
      },
    });
  },

  stopPlayMode: () => {
    const state = get();
    if (!state._playSnapshot) return;

    // STEP 1: Set isPlaying=false FIRST - this causes all useFrame loops
    // (PhysicsSimulation, PlayCharacter) to bail out on their very next read
    // of useStudioStore.getState().playState.isPlaying. Since zustand updates
    // synchronously and useFrame runs on the next animation frame, no physics
    // step can fire between this set() and the snapshot restore below.
    set({
      playState: {
        isPlaying: false,
        isTestPlay: false,
        characterPosition: { x: 0, y: 5, z: 0 },
        characterVelocity: { x: 0, y: 0, z: 0 },
        isGrounded: false,
        characterRotation: 0,
        characterHealth: 100,
        characterMaxHealth: 100,
        teleportPosition: null,
        characterSpeed: 0,
        spawnPointOverride: null,
        pendingRespawn: 0,
      },
    });

    // STEP 2: Now that all loops are stopped, safely restore the snapshot.
    // Nothing can overwrite this because isPlaying === false.
    const restored = restoreSnapshot(state._playSnapshot);
    // pass 26: put the editor's clock back too — "test play it until it
    // gets from midnight to noon, exit, and your project is still
    // midnight" (the auto-cycle may only run inside games).
    const timeAtStart = state._timeOfDayAtPlayStart;
    set({
      objects: restored.objects,
      joints: restored.joints,
      _playSnapshot: null,
      _timeOfDayAtPlayStart: null,
      worldSettings: timeAtStart !== null
        ? { ...get().worldSettings, timeOfDay: timeAtStart }
        : get().worldSettings,
      explosionVisuals: [],
      screenMessages: [],
      objectsVersion: get().objectsVersion + 1,
    });
  },

  startTestPlayMode: (spawnPosition: Vector3) => {
    const state = get();
    // Save snapshot of current state before any physics/modifications occur
    const snapshot = snapshotState(state.objects, state.joints);
    // pass 26: remember the editor's time-of-day (see startPlayMode).
    const timeAtStart = state.worldSettings.timeOfDay;
    set({
      _playSnapshot: snapshot,
      _timeOfDayAtPlayStart: timeAtStart,
      playState: {
        isPlaying: true,
        isTestPlay: true,
        characterPosition: { ...spawnPosition },
        characterVelocity: { x: 0, y: 0, z: 0 },
        isGrounded: false,
        characterRotation: 0,
        characterHealth: 100,
        characterMaxHealth: 100,
        teleportPosition: null,
        characterSpeed: 0,
        spawnPointOverride: null,
        pendingRespawn: 0,
      },
    });
  },

  startSimulationMode: () => {
    const state = get();
    // Save snapshot of current state before any physics/modifications occur
    const snapshot = snapshotState(state.objects, state.joints);
    set({
      _playSnapshot: snapshot,
      simulationState: { isSimulating: true },
    });
  },

  stopSimulationMode: () => {
    const state = get();
    if (!state._playSnapshot) return;

    // STEP 1: Set isSimulating=false FIRST - this causes SimulationOnly's
    // useFrame loop to bail out immediately on the next read.
    set({ simulationState: { isSimulating: false } });

    // STEP 2: Now that the simulation loop is stopped, safely restore.
    const restored = restoreSnapshot(state._playSnapshot);
    set({
      objects: restored.objects,
      joints: restored.joints,
      _playSnapshot: null,
      explosionVisuals: [],
      screenMessages: [],
      objectsVersion: get().objectsVersion + 1,
    });
  },
}));

// E2E/dev handle (matches __weildPhysicsWorld / __tsfManager): live
// verification scripts and the studio can drive the store from the
// console, e.g. restoring the embedded Tower Sword Fight arena for its
// card thumbnail capture.
if (typeof window !== 'undefined') {
  (window as any).__weildStudioStore = useStudioStore;
}

