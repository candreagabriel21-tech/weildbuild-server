// ═══════════════════════════════════════════════════════════════════
// Blocky Trees - stylized, Minecraft-inspired, deterministic from seed
// ═══════════════════════════════════════════════════════════════════

export type TreeVariant = 'oak' | 'birch' | 'pine' | 'cactus';

export interface TreeInstance {
  id: string;
  position: { x: number; y: number; z: number };
  variant: TreeVariant;
  /** World units per block */
  scale: number;
  /** Seed for deterministic shape variation */
  seed: number;
}

/** A single cube to render as part of a tree. */
export interface TreeBlock {
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  color: string;
}

export function createTree(opts: Partial<TreeInstance> = {}): TreeInstance {
  return {
    id: opts.id ?? `tree_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    position: opts.position ?? { x: 0, y: 0, z: 0 },
    variant: opts.variant ?? 'oak',
    scale: opts.scale ?? 1,
    seed: opts.seed ?? Math.floor(Math.random() * 1_000_000),
  };
}

/** Simple deterministic PRNG from a seed (for per-tree variation). */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Generate the list of blocks that make up a tree. The result is
 * deterministic - same tree instance → same block list. The shape is
 * fully blocky: cubes for trunk, cubes for leaves. No smooth cones or
 * cylinders.
 */
export function generateTreeBlocks(tree: TreeInstance): TreeBlock[] {
  const blocks: TreeBlock[] = [];
  const s = tree.scale;
  const rng = makeRng(tree.seed);

  const variant = tree.variant;
  const baseY = tree.position.y;

  const push = (dx: number, dy: number, dz: number, color: string) => {
    blocks.push({
      position: {
        x: tree.position.x + dx * s,
        y: baseY + dy * s,
        z: tree.position.z + dz * s,
      },
      size: { x: s, y: s, z: s },
      color,
    });
  };

  if (variant === 'cactus') {
    // Cactus: 3-4 tall green column, occasional arm
    const trunkColor = '#3a7d3a';
    const trunkHeight = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < trunkHeight; i++) {
      push(0, i, 0, trunkColor);
    }
    // Optional arm
    if (rng() > 0.5) {
      const armH = 1 + Math.floor(rng() * (trunkHeight - 1));
      push(1, armH, 0, trunkColor);
      push(1, armH + 1, 0, trunkColor);
    }
    return blocks;
  }

  // Tree trunk colors
  const trunkColor = variant === 'birch' ? '#e8e0d0' : '#6b4226';
  const trunkHeight = variant === 'pine' ? 5 : 4;

  // Trunk: vertical column of blocks
  for (let i = 0; i < trunkHeight; i++) {
    push(0, i, 0, trunkColor);
  }

  // Leaf color varies by variant
  const leafColor =
    variant === 'birch' ? '#7ab86a' :
    variant === 'pine' ? '#2d5a2d' :
    '#3a7d3a'; // oak

  const canopyBaseY = trunkHeight;

  if (variant === 'pine') {
    // Pine: layered triangular shape (Christmas-tree style)
    const layers = 3;
    for (let layer = 0; layer < layers; layer++) {
      const radius = layers - layer;
      const y = canopyBaseY + layer;
      // Diamond/square layer
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > radius + 1) continue;
          // Skip the trunk position on lower layers
          if (dx === 0 && dz === 0 && layer < layers - 1) continue;
          push(dx, y, dz, leafColor);
        }
      }
    }
    // Top cap
    push(0, canopyBaseY + layers, 0, leafColor);
  } else {
    // Oak / Birch: rounded cube blob of leaves
    const radius = 2;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = 0; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const distSq = dx * dx + dy * dy * 1.5 + dz * dz;
          // Outside the ellipsoid → skip
          if (distSq > radius * radius + 1.5) continue;
          // Skip the trunk position at the base of the canopy
          if (dx === 0 && dz === 0 && dy === 0) continue;
          // Random thinning for natural variation
          if (distSq > radius * radius - 1 && rng() < 0.4) continue;
          push(dx, canopyBaseY + dy, dz, leafColor);
        }
      }
    }
    // Birch top: lighter leaves
    if (variant === 'birch') {
      push(0, canopyBaseY + radius + 1, 0, '#a8d098');
    }
  }

  return blocks;
}

/** Default tree placement on terrain - random scatter, deterministic from seed. */
export function scatterTrees(
  count: number,
  seed: number,
  areaWidth: number,
  areaLength: number,
  getHeight: (x: number, z: number) => number,
  variants: TreeVariant[] = ['oak', 'birch', 'pine']
): TreeInstance[] {
  const rng = makeRng(seed);
  const trees: TreeInstance[] = [];
  const halfW = areaWidth / 2;
  const halfL = areaLength / 2;
  let attempts = 0;
  while (trees.length < count && attempts < count * 4) {
    attempts++;
    const x = (rng() - 0.5) * areaWidth;
    const z = (rng() - 0.5) * areaLength;
    const y = getHeight(x, z);
    if (y < 0) continue; // skip underwater
    const variant = variants[Math.floor(rng() * variants.length)];
    trees.push(
      createTree({
        position: { x, y, z },
        variant,
        scale: 1,
        seed: Math.floor(rng() * 1_000_000),
      })
    );
  }
  return trees;
}
