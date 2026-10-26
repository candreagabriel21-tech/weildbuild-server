import { StudioPart, StudioModel, isPart } from '../studio-store';

export interface SelectionBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export function computeSelectionBounds(objects: (StudioPart | StudioModel)[]): SelectionBox | null {
  const parts = objects.filter(isPart);
  if (parts.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const part of parts) {
    const halfSize = {
      x: part.size.x / 2,
      y: part.size.y / 2,
      z: part.size.z / 2,
    };
    minX = Math.min(minX, part.position.x - halfSize.x);
    minY = Math.min(minY, part.position.y - halfSize.y);
    minZ = Math.min(minZ, part.position.z - halfSize.z);
    maxX = Math.max(maxX, part.position.x + halfSize.x);
    maxY = Math.max(maxY, part.position.y + halfSize.y);
    maxZ = Math.max(maxZ, part.position.z + halfSize.z);
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

export function snapToGridValue(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

export function snapVectorToGrid(vec: { x: number; y: number; z: number }, gridSize: number): { x: number; y: number; z: number } {
  return {
    x: snapToGridValue(vec.x, gridSize),
    y: snapToGridValue(vec.y, gridSize),
    z: snapToGridValue(vec.z, gridSize),
  };
}

export function raycastObjects(
  rayOrigin: { x: number; y: number; z: number },
  rayDirection: { x: number; y: number; z: number },
  objects: StudioPart[]
): { id: string; distance: number } | null {
  let closest: { id: string; distance: number } | null = null;

  for (const part of objects) {
    const distance = rayAABBIntersect(rayOrigin, rayDirection, part.position, part.size);
    if (distance !== null && (closest === null || distance < closest.distance)) {
      closest = { id: part.id, distance };
    }
  }

  return closest;
}

function rayAABBIntersect(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  center: { x: number; y: number; z: number },
  size: { x: number; y: number; z: number }
): number | null {
  const halfSize = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
  const min = { x: center.x - halfSize.x, y: center.y - halfSize.y, z: center.z - halfSize.z };
  const max = { x: center.x + halfSize.x, y: center.y + halfSize.y, z: center.z + halfSize.z };

  let tMin = -Infinity;
  let tMax = Infinity;

  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
    } else {
      const t1 = (min[axis] - origin[axis]) / direction[axis];
      const t2 = (max[axis] - origin[axis]) / direction[axis];
      if (t1 > t2) {
        const tmp = t1;
        const t1_ = t2;
        const t2_ = tmp;
        if (t1_ > tMin) tMin = t1_;
        if (t2_ < tMax) tMax = t2_;
      } else {
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
      }
      if (tMin > tMax) return null;
      if (tMax < 0) return null;
    }
  }

  return tMin >= 0 ? tMin : tMax >= 0 ? tMax : null;
}
