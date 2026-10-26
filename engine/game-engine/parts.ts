import * as THREE from 'three';

export interface PartGeometryResult {
  geometry: THREE.BufferGeometry;
  offsets?: Vector3;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export function createPartGeometry(type: string, size: Vector3): PartGeometryResult {
  switch (type) {
    case 'Block':
      return {
        geometry: new THREE.BoxGeometry(size.x, size.y, size.z),
      };
    case 'Sphere':
      return {
        geometry: new THREE.SphereGeometry(Math.max(size.x, size.y, size.z) / 2, 24, 24),
      };
    case 'Cylinder':
      return {
        geometry: new THREE.CylinderGeometry(
          Math.max(size.x, size.z) / 2,
          Math.max(size.x, size.z) / 2,
          size.y,
          24
        ),
      };
    case 'Wedge':
      return createWedgeGeometry(size);
    default:
      return {
        geometry: new THREE.BoxGeometry(size.x, size.y, size.z),
      };
  }
}

function createWedgeGeometry(size: Vector3): PartGeometryResult {
  const w = size.x, h = size.y, d = size.z;
  const hw = w / 2, hh = h / 2, hd = d / 2;

  // WeildBuild wedge: front face full height, back face zero height
  // 6 unique vertices
  const vertices = new Float32Array([
    // Front face (2 triangles - full height rectangle)
    -hw, -hh, hd,    // 0: bottom-front-left
     hw, -hh, hd,    // 1: bottom-front-right
     hw,  hh, hd,    // 2: top-front-right
    -hw,  hh, hd,    // 3: top-front-left

    // Bottom face (2 triangles)
    -hw, -hh, -hd,   // 4: bottom-back-left
     hw, -hh, -hd,   // 5: bottom-back-right
    -hw, -hh,  hd,   // 6: bottom-front-left (dup)
     hw, -hh,  hd,   // 7: bottom-front-right (dup)

    // Left face (triangle)
    -hw, -hh, -hd,   // 8: bottom-back-left
    -hw, -hh,  hd,   // 9: bottom-front-left
    -hw,  hh,  hd,   // 10: top-front-left

    // Right face (triangle)
     hw, -hh,  hd,   // 11: bottom-front-right
     hw, -hh, -hd,   // 12: bottom-back-right
     hw,  hh,  hd,   // 13: top-front-right

    // Slope face (2 triangles)
    -hw,  hh,  hd,   // 14: top-front-left
     hw,  hh,  hd,   // 15: top-front-right
    -hw, -hh, -hd,   // 16: bottom-back-left
     hw, -hh, -hd,   // 17: bottom-back-right
  ]);

  const indices = [
    // Front face
    0, 1, 2,  0, 2, 3,
    // Bottom face
    4, 5, 7,  4, 7, 6,
    // Left face
    8, 9, 10,
    // Right face
    11, 12, 13,
    // Slope face
    14, 15, 17,  14, 17, 16,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return { geometry };
}

export function createPartMesh(
  type: string,
  size: Vector3,
  color: string,
  materialType: string,
  transparency: number,
  reflectance: number
): THREE.Mesh {
  const { geometry } = createPartGeometry(type, size);
  const matProps = getMaterialVisualProps(materialType);

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: matProps.roughness,
    metalness: matProps.metalness,
    transparent: transparency > 0 || (matProps.opacity ?? 1) < 1,
    opacity: (1 - transparency) * (matProps.opacity ?? 1),
    emissive: matProps.emissive ? new THREE.Color(matProps.emissive) : new THREE.Color(0x000000),
    emissiveIntensity: matProps.emissiveIntensity ?? 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

interface MaterialVisualProps {
  roughness: number;
  metalness: number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

function getMaterialVisualProps(materialType: string): MaterialVisualProps {
  const props: Record<string, MaterialVisualProps> = {
    Plastic: { roughness: 0.5, metalness: 0 },
    SmoothPlastic: { roughness: 0.2, metalness: 0 },
    Wood: { roughness: 0.8, metalness: 0 },
    WoodPlanks: { roughness: 0.85, metalness: 0 },
    Slate: { roughness: 0.9, metalness: 0.1 },
    Concrete: { roughness: 0.95, metalness: 0 },
    Metal: { roughness: 0.3, metalness: 0.9 },
    CorrodedMetal: { roughness: 0.7, metalness: 0.5 },
    DiamondPlate: { roughness: 0.4, metalness: 0.8 },
    Foil: { roughness: 0.1, metalness: 1.0 },
    Grass: { roughness: 0.9, metalness: 0 },
    Ice: { roughness: 0.1, metalness: 0.1, opacity: 0.7 },
    Brick: { roughness: 0.85, metalness: 0 },
    Sand: { roughness: 0.95, metalness: 0 },
    Fabric: { roughness: 0.95, metalness: 0 },
    Granite: { roughness: 0.85, metalness: 0.1 },
    Marble: { roughness: 0.3, metalness: 0.1 },
    Neon: { roughness: 0, metalness: 0, emissive: '#ff4444', emissiveIntensity: 2.0 },
    Cobblestone: { roughness: 0.9, metalness: 0 },
    Pebble: { roughness: 0.85, metalness: 0 },
  };
  return props[materialType] || props.Plastic;
}
