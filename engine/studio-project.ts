// ═══════════════════════════════════════════════════════════════════
// StudioProjectState - Serializable snapshot of the full studio state
// ═══════════════════════════════════════════════════════════════════
//
// This is the SINGLE source of truth for what gets serialized when a
// user publishes a game (or hits Test Play). It captures EVERYTHING
// the editor needs to reconstruct the scene 1:1 in the game player:
//   - All objects (parts + groups) with their physics, effects, rules
//   - All joints
//   - All world settings (sky, sun, moon, clouds, weather, day/night)
//   - All terrain v2 state (heightmap, water bodies, trees, layers)
//   - All global variables / timers (for WeildCode)
//   - Physics settings
//   - Avatar (so the right character shows up)
//
// GameData.studioState?: StudioProjectState is the field that carries
// this payload. It is optional so legacy games (saved before this fix)
// still load via the fallback primitive converter.

import type {
  StudioObject,
  StudioPart,
  Joint,
  WorldSettings,
  PhysicsSettings,
  GlobalTimer,
} from './studio-store';
import { useStudioStore, isPart, clampPartSizeValue, normalizeRotationValue, clampUnitValue } from './studio-store';
import type { WeildCodeRule } from './weildcode-types';
import type {
  TerrainHeightmap as TerrainHeightmapV2,
  TerrainGeneratorConfig,
  TerrainLayer,
  WaterBody as WaterBodyV2,
  TreeInstance as TreeInstanceV2,
} from './terrain-v2';

// ─── Serializable Studio State ───

export interface StudioProjectState {
  // Core scene
  objects: StudioObject[];
  joints: Joint[];

  // World / sky / weather / day-night
  worldSettings: WorldSettings;

  // Physics
  physicsSettings: PhysicsSettings;

  // Terrain v2
  terrainHeightmap: TerrainHeightmapV2 | null;
  terrainConfig: TerrainGeneratorConfig;
  waterBodies: WaterBodyV2[];
  treeInstances: TreeInstanceV2[];
  terrainLayers: TerrainLayer[];
  terrainColor: string;
  waterColor: string;

  // WeildCode
  globalVariables: Record<string, number | string | boolean>;
  globalTimers: GlobalTimer[];
  /** v1.5: rules attached to the GAME itself (player join/leave, chat). */
  gameRules?: WeildCodeRule[];

  // Character
  avatar: {
    skin: string;
    face: string | null;
    shirt: string | null;
    left_leg: string | null;
    right_leg: string | null;
  };

  // Metadata
  schemaVersion: 1;
}

// ─── Deep-clone helper (avoids sharing references between store & snapshot) ───

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

// ─── Snapshot: capture the full studio state from the live store ───

export function snapshotStudioState(): StudioProjectState {
  const s = useStudioStore.getState();

  const objects: StudioObject[] = [];
  s.objects.forEach((obj) => objects.push(deepClone(obj)));

  return {
    objects,
    joints: deepClone(s.joints),
    worldSettings: { ...s.worldSettings },
    physicsSettings: { ...s.physicsSettings },
    terrainHeightmap: s.terrainHeightmap ? deepClone(s.terrainHeightmap) : null,
    terrainConfig: { ...s.terrainConfig },
    waterBodies: deepClone(s.waterBodies),
    treeInstances: deepClone(s.treeInstances),
    terrainLayers: deepClone(s.terrainLayers),
    terrainColor: s.terrainColor,
    waterColor: s.waterColor,
    globalVariables: { ...s.globalVariables },
    globalTimers: deepClone(s.globalTimers),
    gameRules: deepClone(s.gameRules),
    avatar: { ...s.avatar },
    schemaVersion: 1,
  };
}

// ─── Restore: load a serialized studio state back into the live store ───

export function restoreStudioState(state: StudioProjectState): void {
  const newObjects = new Map<string, StudioObject>();
  for (const obj of state.objects) {
    const cloned = deepClone(obj);
    // Fix: Force character parts to be visible. Old saved projects may have
    // showInWorld=false on character parts from before the fix. Character parts
    // should always be visible in both editor and play mode.
    if (isPart(cloned) && cloned.isCharacterPart) {
      cloned.showInWorld = true;
    }
    // v13.5: same value repair as loadProject - a restored snapshot must never
    // resurrect zero/negative sizes or 370-degree rotations into the store.
    if (isPart(cloned)) {
      cloned.size = {
        x: clampPartSizeValue(Number(cloned.size?.x ?? 1)),
        y: clampPartSizeValue(Number(cloned.size?.y ?? 1)),
        z: clampPartSizeValue(Number(cloned.size?.z ?? 1)),
      };
      cloned.rotation = {
        x: normalizeRotationValue(Number(cloned.rotation?.x ?? 0)),
        y: normalizeRotationValue(Number(cloned.rotation?.y ?? 0)),
        z: normalizeRotationValue(Number(cloned.rotation?.z ?? 0)),
      };
      cloned.transparency = clampUnitValue(Number(cloned.transparency ?? 0));
      cloned.reflectance = clampUnitValue(Number(cloned.reflectance ?? 0));
    }
    newObjects.set(obj.id, cloned);
  }

  // v13.7 GRAVITY MIGRATION: projects saved before v13.7 carry the old
  // -9.81 default, which felt "moon-like". If the saved value is exactly
  // the old default, upgrade it to the new snappier -35. (A value the
  // creator deliberately customized to something else is preserved.)
  const migratedPhysics = { ...state.physicsSettings };
  if (migratedPhysics.gravity === -9.81 || migratedPhysics.gravity === -9.8) {
    migratedPhysics.gravity = -35;
  }
  const migratedWorld = { ...state.worldSettings };
  if (migratedWorld.gravity === -9.81 || migratedWorld.gravity === -9.8) {
    migratedWorld.gravity = -35;
  }

  // Single atomic setState so we don't trigger intermediate re-renders
  useStudioStore.setState({
    objects: newObjects,
    objectsVersion: (useStudioStore.getState().objectsVersion || 0) + 1,
    joints: deepClone(state.joints),
    worldSettings: migratedWorld,
    physicsSettings: migratedPhysics,
    terrainHeightmap: state.terrainHeightmap ? deepClone(state.terrainHeightmap) : null,
    terrainConfig: deepClone(state.terrainConfig),
    waterBodies: deepClone(state.waterBodies),
    treeInstances: deepClone(state.treeInstances),
    terrainLayers: deepClone(state.terrainLayers),
    terrainColor: state.terrainColor,
    waterColor: state.waterColor,
    globalVariables: { ...state.globalVariables },
    globalTimers: deepClone(state.globalTimers),
    gameRules: deepClone(state.gameRules ?? []),
    avatar: { ...state.avatar },
    showTerrain: !!state.terrainHeightmap,
    selectedIds: [],
    groupModeIds: [],
    unionModeIds: [],
    explosionVisuals: [],
    consoleMessages: [],
    screenMessages: [],
    undoStack: [],
    redoStack: [],
    clipboard: null,
    // v13.4: big states mount progressively (same rule as loadProject) so the
    // Play viewport doesn't freeze for seconds on 5,000+ part maps. Small
    // projects (under 300 parts) mount instantly like before.
    partRevealLimit: state.objects.length > 300 ? 0 : Infinity,
    loadProgress: {
      active: state.objects.length > 300,
      total: state.objects.filter((o) => isPart(o)).length,
      mounted: 0,
    },
  });

  // v13.7: games published before v13.7 have no CharacterRoot part - create
  // one (sized to the default character) so the editable hitbox + spawn
  // marker exists everywhere. No-op when the project already has one.
  useStudioStore.getState().ensureCharacterRoot();
}

// ─── Find spawn position from the LIVE store (lightweight - no snapshot) ───

/**
 * v13.7: spawn precedence: CharacterRoot part (its feet - move the root in
 * the editor to choose where players start) > Spawn part > world setting.
 * Used by Test Play and the published-games player.
 */
export function findStudioSpawn(
  objects: Map<string, StudioObject>,
  worldSettings: WorldSettings,
): { x: number; y: number; z: number } {
  let spawn: { x: number; y: number; z: number } | null = null;
  objects.forEach((obj) => {
    if (spawn) return;
    if (isPart(obj) && obj.isCharacterRoot) {
      spawn = {
        x: obj.position.x,
        y: obj.position.y - obj.size.y / 2, // feet at the bottom of the hitbox
        z: obj.position.z,
      };
    }
  });
  if (spawn) return spawn!;
  objects.forEach((obj) => {
    if (spawn) return;
    if (isPart(obj) && obj.isSpawnPoint) {
      spawn = { x: obj.position.x, y: obj.position.y + 1, z: obj.position.z };
    }
  });
  if (spawn) return spawn!;
  return { ...worldSettings.spawnPointPosition };
}

// ─── Find spawn position from studio objects ───

export function findSpawnPosition(state: StudioProjectState): { x: number; y: number; z: number } {
  // v13.7: the CharacterRoot part wins - it's the character's own spawn
  // marker, and moving it in the editor is how you choose where players start.
  for (const obj of state.objects) {
    if (isPart(obj) && (obj as StudioPart).isCharacterRoot) {
      return {
        x: obj.position.x,
        y: obj.position.y - obj.size.y / 2, // feet at the bottom of the hitbox
        z: obj.position.z,
      };
    }
  }
  for (const obj of state.objects) {
    if ('isSpawnPoint' in obj && (obj as any).isSpawnPoint) {
      return {
        x: obj.position.x,
        y: obj.position.y + (obj.size.y / 2) + 1.5,
        z: obj.position.z,
      };
    }
  }
  // Fallback: world origin
  return { x: 0, y: 3, z: 0 };
}

// ─── Validate: ensure a studio state is well-formed enough to play ───

export function isValidStudioState(state: any): state is StudioProjectState {
  if (!state || typeof state !== 'object') return false;
  if (!Array.isArray(state.objects)) return false;
  if (!state.worldSettings || typeof state.worldSettings !== 'object') return false;
  if (!state.physicsSettings || typeof state.physicsSettings !== 'object') return false;
  return true;
}
