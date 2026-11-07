export interface MaterialDefinition {
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  // Physical properties (WeildBuild-inspired)
  friction: number;      // 0.0 - 1.0
  elasticity: number;    // 0.0 - 1.0 (bounciness)
  density: number;       // kg/stud³ (affects mass = volume * density)
  physicalType: 'hard' | 'soft' | 'hardsoft' | 'water' | 'ice'; // Terrain collision category
  /**
   * PBR texture set loaded lazily from /textures/<textureSet>/.
   * When set, the part renderer loads albedo.png (map), normal.png
   * (normalMap) and roughness.png (roughnessMap) via THREE.TextureLoader
   * (useLoader, so three.js dedupes + caches across parts). Omitted for
   * flat-colour materials. The maps are served from Vercel's edge CDN as
   * static public/ assets, so they never touch the build/prerender pass.
   */
  textureSet?: string;
  /**
   * True for the build-safe Wireframe material. Renders the part as a
   * wireframe by setting `wireframe: true` on the standard material - a
   * built-in three.js flag, NO onBeforeCompile / shader injection (that
   * was the pass-14 approach that crashed the Vercel prerender).
   */
  wireframe?: boolean;
  /**
   * How many times the albedo/normal/roughness maps tile across one stud
   * of part surface. Defaults to 1 (one tile per stud). Lower = larger
   * feature size, higher = finer tiling.
   */
  textureRepeat?: number;
}

export const MATERIALS: Record<string, MaterialDefinition> = {
  Plastic:       { name: 'Plastic',       color: '#8c8c8c', roughness: 0.5,  metalness: 0.0, friction: 0.5,  elasticity: 0.2,  density: 1.0,  physicalType: 'hard', textureSet: 'plastic', textureRepeat: 1 },
  SmoothPlastic: { name: 'SmoothPlastic', color: '#8c8c8c', roughness: 0.2,  metalness: 0.0, friction: 0.3,  elasticity: 0.15, density: 1.0,  physicalType: 'hard' },
  Wood:          { name: 'Wood',          color: '#8B6914', roughness: 0.8,  metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.6,  physicalType: 'hard', textureSet: 'wood', textureRepeat: 1 },
  WoodPlanks:    { name: 'WoodPlanks',    color: '#9B7431', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.55, physicalType: 'hard', textureSet: 'wood_planks', textureRepeat: 1 },
  Slate:         { name: 'Slate',         color: '#4A4A5A', roughness: 0.9,  metalness: 0.1, friction: 0.6,  elasticity: 0.15, density: 2.5,  physicalType: 'hard', textureSet: 'slate_roof_tiles', textureRepeat: 1 },
  Concrete:      { name: 'Concrete',      color: '#8C8C8C', roughness: 0.95, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 2.3,  physicalType: 'hard', textureSet: 'concrete', textureRepeat: 1 },
  Metal:         { name: 'Metal',         color: '#A0A0B0', roughness: 0.3,  metalness: 0.9, friction: 0.4,  elasticity: 0.3,  density: 7.8,  physicalType: 'hard', textureSet: 'metal', textureRepeat: 1 },
  CorrodedMetal: { name: 'CorrodedMetal', color: '#7A6E52', roughness: 0.7,  metalness: 0.5, friction: 0.6,  elasticity: 0.15, density: 5.0,  physicalType: 'hard', textureSet: 'coroded_metal', textureRepeat: 1 },
  DiamondPlate:  { name: 'DiamondPlate',  color: '#8C9CA5', roughness: 0.4,  metalness: 0.8, friction: 0.5,  elasticity: 0.25, density: 7.8,  physicalType: 'hard', textureSet: 'diamond_plate', textureRepeat: 1 },
  Foil:          { name: 'Foil',          color: '#C0C0D0', roughness: 0.1,  metalness: 1.0, friction: 0.3,  elasticity: 0.1,  density: 2.7,  physicalType: 'hard', textureSet: 'foil', textureRepeat: 1 },
  Grass:         { name: 'Grass',         color: '#4B8B2A', roughness: 0.9,  metalness: 0.0, friction: 0.8,  elasticity: 0.05, density: 0.3,  physicalType: 'soft', textureSet: 'grass', textureRepeat: 1 },
  Ice:           { name: 'Ice',           color: '#B0D4F1', roughness: 0.1,  metalness: 0.1, opacity: 0.7, friction: 0.05, elasticity: 0.05, density: 0.9, physicalType: 'ice', textureSet: 'ice', textureRepeat: 1 },
  Brick:         { name: 'Brick',         color: '#9B4A3C', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 1.9,  physicalType: 'hard', textureSet: 'normal_bricks', textureRepeat: 1 },
  Sand:          { name: 'Sand',          color: '#C2B280', roughness: 0.95, metalness: 0.0, friction: 0.9,  elasticity: 0.02, density: 1.6,  physicalType: 'soft', textureSet: 'sand', textureRepeat: 1 },
  Fabric:        { name: 'Fabric',        color: '#9B7A5A', roughness: 0.95, metalness: 0.0, friction: 0.9,  elasticity: 0.02, density: 0.2,  physicalType: 'soft' },
  Granite:       { name: 'Granite',       color: '#6A6A7A', roughness: 0.85, metalness: 0.1, friction: 0.65, elasticity: 0.12, density: 2.7,  physicalType: 'hardsoft', textureSet: 'granite', textureRepeat: 1 },
  Marble:        { name: 'Marble',        color: '#D4D0C8', roughness: 0.3,  metalness: 0.1, friction: 0.4,  elasticity: 0.15, density: 2.7,  physicalType: 'hard', textureSet: 'marble', textureRepeat: 1 },
  Neon:          { name: 'Neon',          color: '#FF4444', roughness: 0.0,  metalness: 0.0, emissive: '#FF4444', emissiveIntensity: 2.0, friction: 0.3, elasticity: 0.2, density: 1.0, physicalType: 'hard' },
  Cobblestone:   { name: 'Cobblestone',   color: '#7A7A7A', roughness: 0.9,  metalness: 0.0, friction: 0.75, elasticity: 0.1,  density: 2.5,  physicalType: 'hardsoft', textureSet: 'cobblestone', textureRepeat: 1 },
  Pebble:        { name: 'Pebble',        color: '#8A8A7A', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.12, density: 2.3,  physicalType: 'hardsoft', textureSet: 'pebble', textureRepeat: 1 },
  // Wireframe: build-safe re-introduction of the pass-14 stud-grid look.
  // Renders as a true wireframe via the standard material's built-in
  // `wireframe` flag - NO onBeforeCompile / GLSL injection (the pass-14
  // approach that crashed the Vercel prerender build). Kept as its own
  // entry so users can apply it to any part from the material picker.
  Wireframe:     { name: 'Wireframe',     color: '#cfcfd6', roughness: 0.6,  metalness: 0.0, friction: 0.5,  elasticity: 0.2,  density: 1.0,  physicalType: 'hard', wireframe: true },
};

export function getMaterialProps(materialName: string): MaterialDefinition {
  return MATERIALS[materialName] || MATERIALS.Plastic;
}

export function getMaterialNames(): string[] {
  return Object.keys(MATERIALS);
}

/**
 * Calculate mass of a part based on its volume and material density.
 * Mass = Volume (m³) × Density (kg/m³)
 * WeildBuild: mass is determined by part size and material
 */
export function calculateMass(
  partType: string,
  size: { x: number; y: number; z: number },
  materialName: string,
  densityOverride?: number
): number {
  const material = getMaterialProps(materialName);
  const density = densityOverride ?? material.density;

  let volume: number;
  switch (partType) {
    case 'Block':
      volume = size.x * size.y * size.z;
      break;
    case 'Sphere':
      const radius = Math.max(size.x, size.y, size.z) / 2;
      volume = (4 / 3) * Math.PI * radius * radius * radius;
      break;
    case 'Cylinder':
      const cylRadius = Math.max(size.x, size.z) / 2;
      volume = Math.PI * cylRadius * cylRadius * size.y;
      break;
    case 'Wedge':
      // Wedge is approximately half a block
      volume = (size.x * size.y * size.z) / 2;
      break;
    default:
      volume = size.x * size.y * size.z;
  }

  return Math.max(volume * density, 0.01);
}

/**
 * Get combined friction coefficient for two colliding parts.
 * Uses geometric mean: sqrt(frictionA * frictionB)
 */
export function combinedFriction(frictionA: number, frictionB: number): number {
  return Math.sqrt(frictionA * frictionB);
}

/**
 * Get combined elasticity (coefficient of restitution) for two colliding parts.
 * Uses maximum: max(elasticityA, elasticityB) - WeildBuild behavior
 */
export function combinedElasticity(elasticityA: number, elasticityB: number): number {
  return Math.max(elasticityA, elasticityB);
}
