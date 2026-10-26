// ═══════════════════════════════════════════════════════════════════
// Water Body - independent, resizable, configurable water object
// ═══════════════════════════════════════════════════════════════════
//
// Unlike the legacy sea-level water plane, a WaterBody is its own object
// in the world. It can be moved, resized, given a custom color, and can
// push physics bodies with its current direction × strength.

export interface WaterBody {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  /** Width (X), Depth (Y, top-to-bottom), Length (Z) in world units */
  size: { x: number; y: number; z: number };
  color: string;
  /** 0 = invisible, 1 = opaque */
  transparency: number;
  /** Normalized flow direction (will be normalized at apply time) */
  flowDirection: { x: number; y: number; z: number };
  /** 0 = stagnant, 1 = max current */
  currentStrength: number;
  /** Wave amplitude in world units (visual only) */
  waveAmplitude: number;
  enabled: boolean;
}

export function createWaterBody(opts: Partial<WaterBody> = {}): WaterBody {
  return {
    id: opts.id ?? `water_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    name: opts.name ?? 'Water Body',
    position: opts.position ?? { x: 0, y: 0, z: 0 },
    size: opts.size ?? { x: 40, y: 6, z: 40 },
    color: opts.color ?? '#2c7be0',
    transparency: opts.transparency ?? 0.35,
    flowDirection: opts.flowDirection ?? { x: 1, y: 0, z: 0 },
    currentStrength: opts.currentStrength ?? 0.2,
    waveAmplitude: opts.waveAmplitude ?? 0.15,
    enabled: opts.enabled ?? true,
  };
}

/**
 * Returns true if the given world point is inside the water body's box
 * (including its depth). Used by physics for buoyancy/current application.
 */
export function isPointInWater(body: WaterBody, x: number, y: number, z: number): boolean {
  if (!body.enabled) return false;
  const halfW = body.size.x / 2;
  const halfD = body.size.y; // depth from top down
  const halfL = body.size.z / 2;
  return (
    x >= body.position.x - halfW &&
    x <= body.position.x + halfW &&
    z >= body.position.z - halfL &&
    z <= body.position.z + halfL &&
    y <= body.position.y &&
    y >= body.position.y - halfD
  );
}

/**
 * Returns the current force vector for an object in this water body.
 * Scaled by currentStrength and normalized against the flow direction.
 */
export function getCurrentForce(body: WaterBody): { x: number; y: number; z: number } {
  if (!body.enabled || body.currentStrength <= 0) return { x: 0, y: 0, z: 0 };
  const len = Math.sqrt(
    body.flowDirection.x ** 2 + body.flowDirection.y ** 2 + body.flowDirection.z ** 2
  );
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return {
    x: (body.flowDirection.x / len) * body.currentStrength * 10,
    y: (body.flowDirection.y / len) * body.currentStrength * 10,
    z: (body.flowDirection.z / len) * body.currentStrength * 10,
  };
}
