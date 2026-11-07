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
   *
   * pass 17: for the Wireframe material, textureSet is 'wireframe_grid'
   * (a 10×10 stud baseplate grid baked into one tile). For the surface
   * materials (Cobblestone, Brick, Grass, …) the albedo map is NOT bound
   * to the mesh — only the normal + roughness maps are — so the part's
   * `color` tints the surface instead of being multiplied with a coloured
   * albedo (green grass on a red ball reads as red grass, not black). The
   * wireframe_grid albedo IS bound because the grid lines are the whole
   * point of the material.
   */
  textureSet?: string;
  /**
   * True for materials that should render with the built-in three.js
   * `wireframe` flag (triangle outlines). Kept on the type for legacy
   * saves; pass 17 no longer sets it on any material — the Wireframe
   * material now renders via the wireframe_grid texture instead.
   */
  wireframe?: boolean;
  /**
   * How many times the albedo/normal/roughness maps tile across one stud
   * of part surface. Defaults to 1 (one tile per stud). Lower = larger
   * feature size, higher = finer tiling. (Legacy field — the pass-17
   * renderer derives tile size from part size with a 2:1 growth cap, and
   * uses textureTileStuds for fixed-size tiles like the wireframe grid.)
   */
  textureRepeat?: number;
  /**
   * Fixed world-space tile size in studs. When set, the texture tiles at
   * exactly this size on every face regardless of part dimensions (e.g.
   * the wireframe grid always shows a 1-stud minor grid + 10-stud major
   * grid because one tile = 10 studs). When unset, the renderer derives
   * tile size from the part's longest axis (1 stud for small parts,
   * growing up to 2 studs for big walls — the "max 2:1 stretch" cap).
   */
  textureTileStuds?: number;
  /**
   * True for materials whose emissive glow should match the part's own
   * `color` (so a blue Neon part glows blue, not the fixed red the
   * material definition would otherwise force). The renderer sets
   * `emissive = partColor` and uses `emissiveIntensity` for the strength.
   * Neon is the only material that sets this.
   */
  emissiveMatchesColor?: boolean;
}

export const MATERIALS: Record<string, MaterialDefinition> = {
  // pass 18: every material with a matching PBR set now binds it. Surface
  // materials (everything except Wireframe and CorrodedMetal) drop the
  // albedo in the renderer (useAlbedo=false) so the part's `color` tints
  // the surface — green grass on a red ball reads as red grass. Two
  // exceptions keep the albedo: Wireframe (the grid IS the point) and
  // CorrodedMetal/rust (the owner wants the rust's own red preserved, and
  // the albedo's transparent areas let the part colour show through).
  Plastic:       { name: 'Plastic',       color: '#8c8c8c', roughness: 0.5,  metalness: 0.0, friction: 0.5,  elasticity: 0.2,  density: 1.0,  physicalType: 'hard', textureSet: 'plastic' },
  SmoothPlastic: { name: 'SmoothPlastic', color: '#8c8c8c', roughness: 0.2,  metalness: 0.0, friction: 0.3,  elasticity: 0.15, density: 1.0,  physicalType: 'hard', textureSet: 'plastic' },
  Wood:          { name: 'Wood',          color: '#8B6914', roughness: 0.8,  metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.6,  physicalType: 'hard', textureSet: 'wood' },
  WoodPlanks:    { name: 'WoodPlanks',    color: '#9B7431', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.55, physicalType: 'hard', textureSet: 'wood_planks' },
  Slate:         { name: 'Slate',         color: '#4A4A5A', roughness: 0.9,  metalness: 0.1, friction: 0.6,  elasticity: 0.15, density: 2.5,  physicalType: 'hard', textureSet: 'slate_roof_tiles' },
  Concrete:      { name: 'Concrete',      color: '#8C8C8C', roughness: 0.95, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 2.3,  physicalType: 'hard', textureSet: 'concrete' },
  Metal:         { name: 'Metal',         color: '#A0A0B0', roughness: 0.3,  metalness: 0.9, friction: 0.4,  elasticity: 0.3,  density: 7.8,  physicalType: 'hard', textureSet: 'metal' },
  CorrodedMetal: { name: 'CorrodedMetal', color: '#7A6E52', roughness: 0.7,  metalness: 0.5, friction: 0.6,  elasticity: 0.15, density: 5.0,  physicalType: 'hard', textureSet: 'rust' },
  DiamondPlate:  { name: 'DiamondPlate',  color: '#8C9CA5', roughness: 0.4,  metalness: 0.8, friction: 0.5,  elasticity: 0.25, density: 7.8,  physicalType: 'hard', textureSet: 'diamond_plate' },
  Foil:          { name: 'Foil',          color: '#C0C0D0', roughness: 0.1,  metalness: 1.0, friction: 0.3,  elasticity: 0.1,  density: 2.7,  physicalType: 'hard', textureSet: 'foil' },
  Grass:         { name: 'Grass',         color: '#4B8B2A', roughness: 0.9,  metalness: 0.0, friction: 0.8,  elasticity: 0.05, density: 0.3,  physicalType: 'soft', textureSet: 'grass' },
  Ice:           { name: 'Ice',           color: '#B0D4F1', roughness: 0.1,  metalness: 0.1, opacity: 0.7, friction: 0.05, elasticity: 0.05, density: 0.9, physicalType: 'ice', textureSet: 'ice' },
  Brick:         { name: 'Brick',         color: '#9B4A3C', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 1.9,  physicalType: 'hard', textureSet: 'brick' },
  Sand:          { name: 'Sand',          color: '#C2B280', roughness: 0.95, metalness: 0.0, friction: 0.9,  elasticity: 0.02, density: 1.6,  physicalType: 'soft', textureSet: 'sand' },
  Fabric:        { name: 'Fabric',        color: '#9B7A5A', roughness: 0.95, metalness: 0.0, friction: 0.9,  elasticity: 0.02, density: 0.2,  physicalType: 'soft', textureSet: 'carpet' },
  Granite:       { name: 'Granite',       color: '#6A6A7A', roughness: 0.85, metalness: 0.1, friction: 0.65, elasticity: 0.12, density: 2.7,  physicalType: 'hardsoft', textureSet: 'granite' },
  Marble:        { name: 'Marble',        color: '#D4D0C8', roughness: 0.3,  metalness: 0.1, friction: 0.4,  elasticity: 0.15, density: 2.7,  physicalType: 'hard', textureSet: 'marble' },
  // Neon: the glow follows the part's own colour (emissiveMatchesColor),
  // so a blue Neon part glows blue — not the fixed #FF4444 red it used to
  // (which made every Neon part read as red-ish pink). emissiveIntensity
  // 2.0 keeps the bright glow.
  Neon:          { name: 'Neon',          color: '#FF4444', roughness: 0.0,  metalness: 0.0, emissive: '#FF4444', emissiveIntensity: 2.0, emissiveMatchesColor: true, friction: 0.3, elasticity: 0.2, density: 1.0, physicalType: 'hard' },
  Cobblestone:   { name: 'Cobblestone',   color: '#7A7A7A', roughness: 0.9,  metalness: 0.0, friction: 0.75, elasticity: 0.1,  density: 2.5,  physicalType: 'hardsoft', textureSet: 'cobblestone' },
  Pebble:        { name: 'Pebble',        color: '#8A8A7A', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.12, density: 2.3,  physicalType: 'hardsoft', textureSet: 'pebble' },
  // Wireframe: the classic baseplate grid. Pass 17 baked the grid into a
  // static texture (white surface + light-gray 1-stud minor + 10-stud
  // major grid) tiled at a fixed 10-stud size. Pass 18 made the material
  // colour pure white so the wireframe renders white (the pass-17 gray
  // colour darkened the major grid lines to near-black). The grid albedo
  // IS bound (the lines are the point); `color` tints it.
  Wireframe:     { name: 'Wireframe',     color: '#ffffff', roughness: 0.6,  metalness: 0.0, friction: 0.5,  elasticity: 0.2,  density: 1.0,  physicalType: 'hard', textureSet: 'wireframe_grid', textureTileStuds: 10 },
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
