// ═══════════════════════════════════════════════════════════════════
// Terrain Brushes - paint-based terrain editing
// ═══════════════════════════════════════════════════════════════════

import { TerrainHeightmap, paintCell } from './generator';

export type BrushType = 'raise' | 'lower' | 'smooth' | 'flatten' | 'erode' | 'sculpt' | 'paint';

export interface BrushSettings {
  type: BrushType;
  /** Brush radius in world units */
  size: number;
  /** Brush strength 0–1 (controls how much each stroke changes the terrain) */
  strength: number;
  /** Target height for 'flatten' brush */
  targetHeight?: number;
  /** Paint color for 'paint' brush */
  paintColor?: string;
}

export const DEFAULT_BRUSH: BrushSettings = {
  type: 'raise',
  size: 6,
  strength: 0.4,
};

export const BRUSH_LABELS: Record<BrushType, string> = {
  raise: 'Raise',
  lower: 'Lower',
  smooth: 'Smooth',
  flatten: 'Flatten',
  erode: 'Erode',
  sculpt: 'Sculpt',
  paint: 'Paint',
};

export const BRUSH_DESCRIPTIONS: Record<BrushType, string> = {
  raise: 'Raise terrain - adds height in a circular area',
  lower: 'Lower terrain - removes height in a circular area',
  smooth: 'Smooth - averages heights toward the local mean',
  flatten: 'Flatten - pulls terrain toward a target height',
  erode: 'Erode - aggressive terrain equalization (stronger than smooth)',
  sculpt: 'Sculpt - sharp, narrow raise for detail work',
  paint: 'Paint - changes the surface color of terrain cells',
};

/**
 * Apply a brush at the given world coordinates. Returns a NEW heightmap
 * (immutable update - the original is not modified, which keeps React/Zustand
 * happy and makes undo/redo trivial).
 *
 * Falloff is cosine-based for a smooth, natural brush shape:
 *   weight = cos(dist/radius * π/2) at the edge → 0, at center → 1.
 */
export function applyBrush(
  heightmap: TerrainHeightmap,
  worldX: number,
  worldZ: number,
  brush: BrushSettings
): TerrainHeightmap {
  if (brush.size <= 0 || brush.strength <= 0) return heightmap;

  const radius = brush.size;
  const radiusSq = radius * radius;
  const halfW = (heightmap.width * heightmap.cellSize) / 2;
  const halfL = (heightmap.length * heightmap.cellSize) / 2;

  // Brush center in grid coords
  const centerGx = (worldX + halfW) / heightmap.cellSize - 0.5;
  const centerGz = (worldZ + halfL) / heightmap.cellSize - 0.5;
  const radiusCells = Math.ceil(radius / heightmap.cellSize);

  const x0 = Math.max(0, Math.floor(centerGx - radiusCells));
  const x1 = Math.min(heightmap.width - 1, Math.ceil(centerGx + radiusCells));
  const z0 = Math.max(0, Math.floor(centerGz - radiusCells));
  const z1 = Math.min(heightmap.length - 1, Math.ceil(centerGz + radiusCells));

  // ── Paint brush: modifies paintColors, not heights ──
  if (brush.type === 'paint') {
    const paintColor = brush.paintColor || '#ffffff';
    let result = heightmap;
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const cellWorldX = (x + 0.5) * heightmap.cellSize - halfW;
        const cellWorldZ = (z + 0.5) * heightmap.cellSize - halfL;
        const dx = cellWorldX - worldX;
        const dz = cellWorldZ - worldZ;
        const distSq = dx * dx + dz * dz;
        if (distSq > radiusSq) continue;
        // Paint at full strength within the radius - color blending is done
        // by the strength slider (low strength = lighter touch, but since we're
        // setting a discrete color, we just paint all cells in the radius).
        const gridIndex = x * heightmap.length + z;
        result = paintCell(result, gridIndex, paintColor);
      }
    }
    return result;
  }

  // ── Height-modifying brushes ──
  const newHeights = new Float32Array(heightmap.heights);

  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const cellWorldX = (x + 0.5) * heightmap.cellSize - halfW;
      const cellWorldZ = (z + 0.5) * heightmap.cellSize - halfL;
      const dx = cellWorldX - worldX;
      const dz = cellWorldZ - worldZ;
      const distSq = dx * dx + dz * dz;

      if (distSq > radiusSq) continue;

      const dist = Math.sqrt(distSq);
      // Cosine falloff: smooth, peaks at center, 0 at edge
      const falloff = Math.cos((dist / radius) * (Math.PI / 2));
      const idx = x * heightmap.length + z;
      const currentHeight = newHeights[idx];

      switch (brush.type) {
        case 'raise':
          newHeights[idx] = currentHeight + falloff * brush.strength * 2;
          break;

        case 'lower':
          newHeights[idx] = currentHeight - falloff * brush.strength * 2;
          break;

        case 'smooth': {
          // 3x3 box average
          let sum = 0;
          let count = 0;
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            for (let dz2 = -1; dz2 <= 1; dz2++) {
              const nx = x + dx2;
              const nz = z + dz2;
              if (nx >= 0 && nx < heightmap.width && nz >= 0 && nz < heightmap.length) {
                sum += heightmap.heights[nx * heightmap.length + nz];
                count++;
              }
            }
          }
          const avg = sum / count;
          newHeights[idx] = currentHeight + (avg - currentHeight) * falloff * brush.strength;
          break;
        }

        case 'flatten': {
          const target = brush.targetHeight ?? currentHeight;
          newHeights[idx] = currentHeight + (target - currentHeight) * falloff * brush.strength;
          break;
        }

        case 'erode': {
          // 3x3 box average, more aggressive than smooth + slight downward bias
          let sum = 0;
          let count = 0;
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            for (let dz2 = -1; dz2 <= 1; dz2++) {
              const nx = x + dx2;
              const nz = z + dz2;
              if (nx >= 0 && nx < heightmap.width && nz >= 0 && nz < heightmap.length) {
                sum += heightmap.heights[nx * heightmap.length + nz];
                count++;
              }
            }
          }
          const avg = sum / count;
          // Erode pulls high points down toward average faster than it lifts low points
          const diff = avg - currentHeight;
          const erosionBias = diff < 0 ? 1.5 : 0.7; // more lowering than raising
          newHeights[idx] =
            currentHeight + diff * falloff * brush.strength * erosionBias;
          break;
        }

        case 'sculpt': {
          // Sharper, narrower falloff (squared) for detail work
          const sharpFalloff = falloff * falloff;
          newHeights[idx] = currentHeight + sharpFalloff * brush.strength * 3;
          break;
        }
      }
    }
  }

  return { ...heightmap, heights: newHeights };
}

/**
 * Apply multiple brush strokes in one pass (used for drag-painting so we don't
 * spawn a new heightmap per move event). Strokes are sampled along the path
 * from (x1,z1) to (x2,z2) at cellSize intervals.
 */
export function applyBrushStroke(
  heightmap: TerrainHeightmap,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  brush: BrushSettings
): TerrainHeightmap {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const dist = Math.sqrt(dx * dx + dz * dz);
  // Sample at ~1 cell apart so we don't miss cells on fast drags
  const step = Math.max(0.5, heightmap.cellSize * 0.75);
  const steps = Math.max(1, Math.ceil(dist / step));

  let result = heightmap;
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const sx = x1 + dx * t;
    const sz = z1 + dz * t;
    result = applyBrush(result, sx, sz, brush);
  }
  return result;
}
