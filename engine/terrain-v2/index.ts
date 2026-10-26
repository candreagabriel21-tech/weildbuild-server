// ═══════════════════════════════════════════════════════════════════
// terrain-v2 - public entry point
// ═══════════════════════════════════════════════════════════════════

export { PerlinNoise } from './noise';
export type {
  TerrainHeightmap,
  TerrainPreset,
  TerrainGeneratorConfig,
  TerrainLayer,
} from './generator';
export {
  DEFAULT_TERRAIN_LAYERS,
  DEFAULT_TERRAIN_CONFIG,
  generateHeightmap,
  getHeightAt,
  gridToWorld,
  worldToGrid,
  terrainWorldSize,
  getCellColor,
  paintCell,
  clearCellPaint,
} from './generator';
export type {
  BrushType,
  BrushSettings,
} from './brushes';
export {
  DEFAULT_BRUSH,
  BRUSH_LABELS,
  BRUSH_DESCRIPTIONS,
  applyBrush,
  applyBrushStroke,
} from './brushes';
export type { WaterBody } from './water';
export {
  createWaterBody,
  isPointInWater,
  getCurrentForce,
} from './water';
export type {
  TreeVariant,
  TreeInstance,
  TreeBlock,
} from './trees';
export {
  createTree,
  generateTreeBlocks,
  scatterTrees,
} from './trees';
