// ═══════════════════════════════════════════════════════════════════
// Terrain Heightmap Generator (Minecraft-style, seed-driven)
// ═══════════════════════════════════════════════════════════════════

import { PerlinNoise } from './noise';

/** Stored terrain heightmap. Mutable - brushes modify the heights array. */
/** A single terrain layer (depth band below the surface). */
export interface TerrainLayer {
  /** Display name shown in the settings UI */
  name: string;
  /** Color of blocks in this layer */
  color: string;
  /** How many blocks thick this layer is (from the surface downward) */
  thickness: number;
}

/** Default layers: grass surface → dirt → stone → bedrock */
export const DEFAULT_TERRAIN_LAYERS: TerrainLayer[] = [
  { name: 'Surface', color: '#4a7c3f', thickness: 1 },
  { name: 'Dirt', color: '#8b7355', thickness: 3 },
  { name: 'Stone', color: '#6e6e6e', thickness: 5 },
  { name: 'Bedrock', color: '#3a3a3a', thickness: 4 },
];

/** Stored terrain heightmap. Mutable - brushes modify the heights array. */
export interface TerrainHeightmap {
  /** Grid cells along X axis */
  width: number;
  /** Grid cells along Z axis */
  length: number;
  /** World units per grid cell */
  cellSize: number;
  /** heights[x * length + z] - top surface height in world Y units */
  heights: Float32Array;
  /** Seed used to generate this heightmap (for reproducibility) */
  seed: number;
  /**
   * Per-cell paint color overrides. When a cell index is present here, the
   * renderer uses this color instead of the biome/layer color.
   * Key = x * length + z, Value = hex color string.
   */
  paintColors?: Map<number, string>;
}

export type TerrainPreset = 'Nature' | 'Mountain' | 'Island' | 'Field' | 'Flat';

export interface TerrainGeneratorConfig {
  seed: number;
  width: number;
  length: number;
  cellSize: number;
  baseHeight: number;
  amplitude: number;
  frequency: number;
  octaves: number;
  seaLevel: number;
  preset: TerrainPreset;
  /** Optional island falloff - 0 = none, 1 = full island */
  islandFalloff?: number;
}

export const DEFAULT_TERRAIN_CONFIG: TerrainGeneratorConfig = {
  seed: 42,
  width: 64,
  length: 64,
  cellSize: 2,
  baseHeight: 0,
  amplitude: 8,
  frequency: 0.05,
  octaves: 4,
  seaLevel: 1,
  preset: 'Nature',
  islandFalloff: 0,
};

/**
 * Generate a fresh heightmap from the given config + seed.
 * Same seed + same config → byte-identical heightmap.
 *
 * Strategy (Minecraft-style layered):
 *   1. Continental shape - very low frequency, sets broad hills/valleys.
 *   2. Base detail - fbm noise, the rolling hills.
 *   3. Ridged noise - adds mountain ridges where amplitude is high.
 *   4. Optional island falloff - pulls edges down to/below sea level.
 *
 * The result is smooth and natural rather than noisy - fbm with 4 octaves
 * and 0.5 persistence gives that "rolling hills" feel without harsh spikes.
 */
export function generateHeightmap(config: TerrainGeneratorConfig): TerrainHeightmap {
  const noise = new PerlinNoise(config.seed);
  const ridgeNoise = new PerlinNoise(config.seed ^ 0x5a5a5a5a); // different permutation for ridges
  const heights = new Float32Array(config.width * config.length);

  // Preset modifiers - keep them gentle so manual editing is still pleasant.
  let effectiveFrequency = config.frequency;
  let effectiveAmplitude = config.amplitude;
  let effectiveOctaves = config.octaves;
  let islandFalloff = config.islandFalloff ?? 0;

  switch (config.preset) {
    case 'Mountain':
      effectiveFrequency = config.frequency * 0.6;
      effectiveAmplitude = config.amplitude * 1.8;
      effectiveOctaves = Math.min(6, config.octaves + 1);
      break;
    case 'Island':
      islandFalloff = 1;
      effectiveFrequency = config.frequency * 0.9;
      effectiveAmplitude = config.amplitude * 0.9;
      break;
    case 'Field':
      effectiveFrequency = config.frequency * 0.5;
      effectiveAmplitude = config.amplitude * 0.25;
      effectiveOctaves = Math.max(2, config.octaves - 1);
      break;
    case 'Flat':
      effectiveAmplitude = 0;
      break;
    case 'Nature':
    default:
      break;
  }

  for (let x = 0; x < config.width; x++) {
    for (let z = 0; z < config.length; z++) {
      // World coords of this cell center
      const worldX = (x + 0.5) * config.cellSize;
      const worldZ = (z + 0.5) * config.cellSize;

      const nx = worldX * effectiveFrequency;
      const nz = worldZ * effectiveFrequency;

      // Layer 1: base rolling hills (fbm)
      const base = noise.fbm2D(nx, nz, effectiveOctaves, 0.5, 2);

      // Layer 2: continent shape (very low freq)
      const continent = noise.fbm2D(nx * 0.15, nz * 0.15, 2, 0.5, 2);

      // Layer 3: ridged noise for mountains (only contributes at high altitudes)
      const ridge = ridgeNoise.ridged2D(nx * 0.8, nz * 0.8, 3);

      // Blend - base terrain is mostly fbm + continent; ridges add peaks
      // when continent is high (i.e. mountainous regions only).
      const mountainMask = Math.max(0, continent - 0.1);
      const height =
        config.baseHeight +
        (base * 0.55 + continent * 0.3 + ridge * mountainMask * 0.6) * effectiveAmplitude;

      // Island falloff: pull edges down to below sea level
      if (islandFalloff > 0) {
        const dx = (x / config.width - 0.5) * 2;
        const dz = (z / config.length - 0.5) * 2;
        const dist = Math.min(1, Math.sqrt(dx * dx + dz * dz));
        const falloff = Math.max(0, 1 - dist * 1.3);
        const eased = falloff * falloff * (3 - 2 * falloff); // smoothstep
        heights[x * config.length + z] = config.baseHeight + (height - config.baseHeight) * eased * islandFalloff
          + (1 - islandFalloff) * (height - config.baseHeight);
        // For full-island preset (falloff=1) this simplifies to:
        //   baseHeight + (height - baseHeight) * eased
        if (islandFalloff >= 1) {
          heights[x * config.length + z] = config.baseHeight + (height - config.baseHeight) * eased
            - (1 - eased) * (config.amplitude * 0.5); // dip edges below water
        }
      } else {
        heights[x * config.length + z] = height;
      }
    }
  }

  return {
    width: config.width,
    length: config.length,
    cellSize: config.cellSize,
    heights,
    seed: config.seed,
    paintColors: new Map<number, string>(),
  };
}

/**
 * Sample the heightmap at world coordinates with bilinear interpolation.
 * Returns 0 for points outside the terrain footprint.
 */
export function getHeightAt(heightmap: TerrainHeightmap, worldX: number, worldZ: number): number {
  const halfW = (heightmap.width * heightmap.cellSize) / 2;
  const halfL = (heightmap.length * heightmap.cellSize) / 2;
  const gx = (worldX + halfW) / heightmap.cellSize - 0.5;
  const gz = (worldZ + halfL) / heightmap.cellSize - 0.5;

  if (gx < 0 || gx >= heightmap.width - 1 || gz < 0 || gz >= heightmap.length - 1) {
    return 0;
  }

  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;

  const h00 = heightmap.heights[x0 * heightmap.length + z0];
  const h10 = heightmap.heights[(x0 + 1) * heightmap.length + z0];
  const h01 = heightmap.heights[x0 * heightmap.length + (z0 + 1)];
  const h11 = heightmap.heights[(x0 + 1) * heightmap.length + (z0 + 1)];

  // Smoothstep for smoother interpolation between cells
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);

  const h0 = h00 * (1 - sx) + h10 * sx;
  const h1 = h01 * (1 - sx) + h11 * sx;
  return h0 * (1 - sz) + h1 * sz;
}

/** Convert grid coords → world coords (center of the cell). */
export function gridToWorld(
  heightmap: TerrainHeightmap,
  gx: number,
  gz: number
): { x: number; z: number } {
  const halfW = (heightmap.width * heightmap.cellSize) / 2;
  const halfL = (heightmap.length * heightmap.cellSize) / 2;
  return {
    x: (gx + 0.5) * heightmap.cellSize - halfW,
    z: (gz + 0.5) * heightmap.cellSize - halfL,
  };
}

/** Convert world coords → grid coords (float, can be interpolated). */
export function worldToGrid(
  heightmap: TerrainHeightmap,
  worldX: number,
  worldZ: number
): { gx: number; gz: number } {
  const halfW = (heightmap.width * heightmap.cellSize) / 2;
  const halfL = (heightmap.length * heightmap.cellSize) / 2;
  return {
    gx: (worldX + halfW) / heightmap.cellSize - 0.5,
    gz: (worldZ + halfL) / heightmap.cellSize - 0.5,
  };
}

/** Total world-space size of the terrain footprint. */
export function terrainWorldSize(heightmap: TerrainHeightmap): { width: number; length: number } {
  return {
    width: heightmap.width * heightmap.cellSize,
    length: heightmap.length * heightmap.cellSize,
  };
}

/**
 * Get the color for a terrain cell at a given depth below the surface.
 *
 * Priority:
 *   1. If the cell has a paint color override (from the Paint brush), use it.
 *   2. Otherwise, walk the layers array from top to bottom. Each layer has a
 *      thickness - the first layer whose depth range contains `depthBelowSurface`
 *      provides the color.
 *   3. If no layer matches (depth exceeds all layers), use the last layer's color.
 *
 * @param heightmap  The terrain heightmap (contains paintColors overrides)
 * @param gridIndex  The cell index (x * length + z)
 * @param depthBelowSurface  How many blocks below the surface this cell is (0 = surface)
 * @param layers  The terrain layer config
 * @param surfaceColor  Fallback color for the surface if no layers are defined
 */
export function getCellColor(
  heightmap: TerrainHeightmap,
  gridIndex: number,
  depthBelowSurface: number,
  layers: TerrainLayer[],
  surfaceColor: string
): string {
  // 1. Paint override
  const paint = heightmap.paintColors?.get(gridIndex);
  if (paint) return paint;

  // 2. No layers → use surface color for depth 0, fallback for deeper
  if (layers.length === 0) return surfaceColor;

  // 3. Walk layers
  let accumulatedDepth = 0;
  for (const layer of layers) {
    accumulatedDepth += layer.thickness;
    if (depthBelowSurface < accumulatedDepth) {
      return layer.color;
    }
  }
  // 4. Deeper than all layers → use the last layer's color
  return layers[layers.length - 1].color;
}

/**
 * Paint a cell with a custom color. Returns a new heightmap with the updated
 * paintColors map (immutable update).
 */
export function paintCell(
  heightmap: TerrainHeightmap,
  gridIndex: number,
  color: string
): TerrainHeightmap {
  const newPaintColors = new Map(heightmap.paintColors || []);
  newPaintColors.set(gridIndex, color);
  return { ...heightmap, paintColors: newPaintColors };
}

/**
 * Clear paint from a cell (revert to layer/biome color).
 */
export function clearCellPaint(
  heightmap: TerrainHeightmap,
  gridIndex: number
): TerrainHeightmap {
  if (!heightmap.paintColors || !heightmap.paintColors.has(gridIndex)) return heightmap;
  const newPaintColors = new Map(heightmap.paintColors);
  newPaintColors.delete(gridIndex);
  return { ...heightmap, paintColors: newPaintColors };
}
