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
  // pass 19: every material now binds its PBR albedo (useAlbedo=true for all
  // textured materials in shared.ts) so the texture's own colour shows.
  // Pass 18 dropped the albedo for surface materials, which left only
  // normal/roughness bumps and made WoodPlanks/Concrete/Ice/Granite/Marble
  // "barely visible". The default colour is now #ffffff so the albedo renders
  // at its natural colour (white × albedoRGB = albedoRGB); the part colour
  // picker still tints if the user picks one. Metals (Metal/DiamondPlate/
  // Foil/CorrodedMetal) had metalness so high the diffuse was suppressed to
  // black with no env map; pass 19 lowers them so the albedo shows. The 14
  // new materials (WoodBark…Magma) cover the rest of the owner's texture
  // library. SmoothPlastic is removed (not needed).
  // pass 20: Plastic is now TEXTURE-LESS (flat colour) — the classic smooth
  // plastic for parts. The textured plastic PBR set moved to a new
  // RoughPlastic material. So a plain Plastic part is a flat colour, and
  // RoughPlastic shows the plastic surface texture.
  Plastic:          { name: 'Plastic',          color: '#ffffff', roughness: 0.5,  metalness: 0.0, friction: 0.5,  elasticity: 0.2,  density: 1.0,  physicalType: 'hard' },
  RoughPlastic:     { name: 'RoughPlastic',     color: '#ffffff', roughness: 0.7,  metalness: 0.0, friction: 0.55, elasticity: 0.2,  density: 1.0,  physicalType: 'hard', textureSet: 'plastic' },
  Wood:             { name: 'Wood',             color: '#ffffff', roughness: 0.8,  metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.6,  physicalType: 'hard', textureSet: 'wood' },
  WoodPlanks:       { name: 'WoodPlanks',       color: '#ffffff', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.55, physicalType: 'hard', textureSet: 'wood_planks' },
  WoodBark:         { name: 'WoodBark',         color: '#ffffff', roughness: 0.9,  metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 0.6,  physicalType: 'hard', textureSet: 'wood_bark' },
  Slate:            { name: 'Slate',            color: '#ffffff', roughness: 0.9,  metalness: 0.1, friction: 0.6,  elasticity: 0.15, density: 2.5,  physicalType: 'hard', textureSet: 'slate_roof_tiles' },
  Concrete:         { name: 'Concrete',         color: '#ffffff', roughness: 0.95, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 2.3,  physicalType: 'hard', textureSet: 'concrete' },
  Metal:            { name: 'Metal',            color: '#ffffff', roughness: 0.3,  metalness: 0.3, friction: 0.4,  elasticity: 0.3,  density: 7.8,  physicalType: 'hard', textureSet: 'metal' },
  CorrodedMetal:    { name: 'CorrodedMetal',    color: '#ffffff', roughness: 0.7,  metalness: 0.4, friction: 0.6,  elasticity: 0.15, density: 5.0,  physicalType: 'hard', textureSet: 'rust' },
  DiamondPlate:     { name: 'DiamondPlate',     color: '#ffffff', roughness: 0.4,  metalness: 0.4, friction: 0.5,  elasticity: 0.25, density: 7.8,  physicalType: 'hard', textureSet: 'diamond_plate' },
  Foil:             { name: 'Foil',             color: '#ffffff', roughness: 0.1,  metalness: 0.3, friction: 0.3,  elasticity: 0.1,  density: 2.7,  physicalType: 'hard', textureSet: 'foil' },
  Grass:            { name: 'Grass',            color: '#ffffff', roughness: 0.9,  metalness: 0.0, friction: 0.8,  elasticity: 0.05, density: 0.3,  physicalType: 'soft', textureSet: 'grass' },
  Ice:              { name: 'Ice',              color: '#ffffff', roughness: 0.1,  metalness: 0.1, opacity: 0.7, friction: 0.05, elasticity: 0.05, density: 0.9, physicalType: 'ice', textureSet: 'ice' },
  Brick:            { name: 'Brick',            color: '#ffffff', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 1.9,  physicalType: 'hard', textureSet: 'brick' },
  NormalBricks:     { name: 'NormalBricks',     color: '#ffffff', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 1.9,  physicalType: 'hard', textureSet: 'normal_bricks' },
  Sand:             { name: 'Sand',             color: '#ffffff', roughness: 0.95, metalness: 0.0, friction: 0.9,  elasticity: 0.02, density: 1.6,  physicalType: 'soft', textureSet: 'sand' },
  Fabric:           { name: 'Fabric',           color: '#ffffff', roughness: 0.95, metalness: 0.0, friction: 0.9,  elasticity: 0.02, density: 0.2,  physicalType: 'soft', textureSet: 'carpet' },
  Granite:          { name: 'Granite',          color: '#ffffff', roughness: 0.85, metalness: 0.1, friction: 0.65, elasticity: 0.12, density: 2.7,  physicalType: 'hardsoft', textureSet: 'granite' },
  Marble:           { name: 'Marble',           color: '#ffffff', roughness: 0.3,  metalness: 0.1, friction: 0.4,  elasticity: 0.15, density: 2.7,  physicalType: 'hard', textureSet: 'marble' },
  Cobblestone:      { name: 'Cobblestone',      color: '#ffffff', roughness: 0.9,  metalness: 0.0, friction: 0.75, elasticity: 0.1,  density: 2.5,  physicalType: 'hardsoft', textureSet: 'cobblestone' },
  SmallCobblestone: { name: 'SmallCobblestone', color: '#ffffff', roughness: 0.9,  metalness: 0.0, friction: 0.75, elasticity: 0.1,  density: 2.5,  physicalType: 'hardsoft', textureSet: 'small_cobblestone' },
  Pebble:           { name: 'Pebble',           color: '#ffffff', roughness: 0.85, metalness: 0.0, friction: 0.7,  elasticity: 0.12, density: 2.3,  physicalType: 'hardsoft', textureSet: 'pebble' },
  Stone:            { name: 'Stone',            color: '#ffffff', roughness: 0.85, metalness: 0.1, friction: 0.65, elasticity: 0.12, density: 2.7,  physicalType: 'hard', textureSet: 'stone' },
  RoughStone:       { name: 'RoughStone',       color: '#ffffff', roughness: 0.95, metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 2.7,  physicalType: 'hard', textureSet: 'rough_stone' },
  RockyGround:      { name: 'RockyGround',      color: '#ffffff', roughness: 0.9,  metalness: 0.0, friction: 0.75, elasticity: 0.1,  density: 2.5,  physicalType: 'hardsoft', textureSet: 'rocky_ground' },
  Dirt:             { name: 'Dirt',             color: '#ffffff', roughness: 0.95, metalness: 0.0, friction: 0.8,  elasticity: 0.05, density: 1.4,  physicalType: 'soft', textureSet: 'dirt' },
  Snow:             { name: 'Snow',             color: '#ffffff', roughness: 0.6,  metalness: 0.0, friction: 0.3,  elasticity: 0.05, density: 0.9,  physicalType: 'soft', textureSet: 'snow' },
  Tiles:            { name: 'Tiles',            color: '#ffffff', roughness: 0.3,  metalness: 0.1, friction: 0.4,  elasticity: 0.15, density: 2.3,  physicalType: 'hard', textureSet: 'tiles' },
  GeometricTiles:   { name: 'GeometricTiles',   color: '#ffffff', roughness: 0.4,  metalness: 0.1, friction: 0.5,  elasticity: 0.15, density: 2.3,  physicalType: 'hard', textureSet: 'geometric_tiles' },
  Cardboard:        { name: 'Cardboard',        color: '#ffffff', roughness: 0.9,  metalness: 0.0, friction: 0.6,  elasticity: 0.1,  density: 0.3,  physicalType: 'soft', textureSet: 'cardboard' },
  Leather:          { name: 'Leather',          color: '#ffffff', roughness: 0.7,  metalness: 0.0, friction: 0.5,  elasticity: 0.1,  density: 0.9,  physicalType: 'soft', textureSet: 'leather' },
  Lava:             { name: 'Lava',             color: '#ffffff', roughness: 0.5,  metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 2.7,  physicalType: 'hard', textureSet: 'lava' },
  Magma:            { name: 'Magma',            color: '#ffffff', roughness: 0.6,  metalness: 0.0, friction: 0.7,  elasticity: 0.1,  density: 2.7,  physicalType: 'hard', textureSet: 'magma' },
  // Neon: not textured. The glow follows the part's own colour
  // (emissiveMatchesColor), so a blue Neon part glows blue — not the fixed
  // #FF4444 red it used to. emissiveIntensity 2.0 keeps the bright glow.
  Neon:             { name: 'Neon',             color: '#FF4444', roughness: 0.0,  metalness: 0.0, emissive: '#FF4444', emissiveIntensity: 2.0, emissiveMatchesColor: true, friction: 0.3, elasticity: 0.2, density: 1.0, physicalType: 'hard' },
  // Wireframe: the classic baseplate grid. Baked into a static 1024² texture
  // (white surface + light-gray 1-stud minor + 10-stud major grid) tiled at
  // a fixed 10-stud size. Material colour is pure white so the wireframe
  // renders white; the grid albedo IS bound (the lines are the point).
  Wireframe:        { name: 'Wireframe',        color: '#ffffff', roughness: 0.6,  metalness: 0.0, friction: 0.5,  elasticity: 0.2,  density: 1.0,  physicalType: 'hard', textureSet: 'wireframe_grid', textureTileStuds: 10 },
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
