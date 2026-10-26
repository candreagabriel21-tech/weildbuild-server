/**
 * Mesh ref registry - shared between the editor viewport and the character
 * parts renderer so TransformControls can attach gizmos to ANY selectable
 * object, including character body parts.
 *
 * v13.7: this used to live inside Viewport3D.tsx. Character body parts are
 * rendered by CharacterPartsRenderer (not PartMesh), and their meshes were
 * never registered - so selecting a body part (Head, Torso, ...) showed NO
 * Move/Rotate gizmo at all ("the arrows don't appear!"). The registry moved
 * to its own module so both renderers can share it without a circular import.
 *
 * v13.8: character parts now register a WORLD-SPACE PROXY (an Object3D at
 * the scene root) instead of their nested group inside the character rig.
 * The old approach attached TransformControls to a group whose parent (the
 * rig group) carries a position/rotation offset - every world-space gizmo
 * computation (snapping, write-backs, selection sync) then had to reason
 * about that offset, and several paths didn't, which made selected body
 * parts visibly jump (~3 studs up + a few units off). With a proxy at the
 * scene root, gizmo math is IDENTICAL to regular world-space parts. The
 * proxy is glued to the part's world transform every frame by
 * CharacterPartsRenderer, and gizmo write-backs convert world -> rig-local
 * using `charRigTransform` (below) before touching the store.
 */

import * as THREE from 'three';

const meshRefRegistry = new Map<string, THREE.Object3D>();

export function registerMeshRef(id: string, mesh: THREE.Object3D | null) {
  if (mesh) {
    meshRefRegistry.set(id, mesh);
  } else {
    meshRefRegistry.delete(id);
  }
}

export function getRegisteredMesh(id: string): THREE.Object3D | undefined {
  return meshRefRegistry.get(id);
}

export function forEachRegisteredMesh(fn: (mesh: THREE.Object3D, id: string) => void) {
  meshRefRegistry.forEach((m, id) => fn(m, id));
}

export function registeredMeshCount(): number {
  return meshRefRegistry.size;
}

// ─── v13.8: editor character-rig world transform ───
// The CharacterPartsRenderer publishes the rig group's world position + Y
// rotation here every frame (editor preview only). SelectedTransformControls
// uses it to convert gizmo world-space writes back into the rig-local
// coordinates that character body parts store.
export const charRigTransform = { x: 0, y: 0, z: 0, rotY: 0 };

export function setCharRigTransform(x: number, y: number, z: number, rotY: number) {
  charRigTransform.x = x;
  charRigTransform.y = y;
  charRigTransform.z = z;
  charRigTransform.rotY = rotY;
}

/** Rotate a local rig offset into world space (rig Y rotation). */
export function rigLocalToWorld(dx: number, dy: number, dz: number): { x: number; y: number; z: number } {
  const c = Math.cos(charRigTransform.rotY);
  const s = Math.sin(charRigTransform.rotY);
  return { x: dx * c + dz * s, y: dy, z: -dx * s + dz * c };
}

/** Rotate a world offset into the rig's local space (inverse Y rotation). */
export function rigWorldToLocal(dx: number, dy: number, dz: number): { x: number; y: number; z: number } {
  const c = Math.cos(charRigTransform.rotY);
  const s = Math.sin(charRigTransform.rotY);
  return { x: dx * c - dz * s, y: dy, z: dx * s + dz * c };
}

// ─── v13.8: which part the gizmo is currently dragging ───
// While a gizmo drag is active, CharacterPartsRenderer must NOT re-glue that
// part's proxy (TransformControls owns it until the drag ends).
let _gizmoDragTargetId: string | null = null;

export function setGizmoDragTarget(id: string | null) {
  _gizmoDragTargetId = id;
}

export function getGizmoDragTarget(): string | null {
  return _gizmoDragTargetId;
}

// ─── v1.0.2: "gizmo press" guard ───
// A pointer-down on a gizmo (the TransformControls arrows/rings/box or the
// Scale face handles) used to raycast STRAIGHT THROUGH the gizmo onto
// whatever part was behind it, stealing the selection mid-grab (and a gizmo
// press over open terrain fired onPointerMissed on release, deselecting
// everything). The guard lets mesh pointer-down handlers and the
// pointer-missed handler check "is this press actually on the editor
// overlay?" and leave the selection alone.
let _activeTransformControls: any = null;
let _overlayPickMeshes: THREE.Object3D[] = [];
let _overlayDragActive = false;
const _guardRaycaster = new THREE.Raycaster();

/** SelectedTransformControls publishes its controls instance here while a
 *  gizmo is live (and clears it when the gizmo unmounts). */
export function setActiveTransformControls(controls: any) {
  _activeTransformControls = controls;
}

/** FaceScaleHighlights publishes its six handle planes here while the Scale
 *  tool is live (and clears them on tool change / deselect). */
export function setOverlayPickMeshes(list: THREE.Object3D[] | null) {
  _overlayPickMeshes = list || [];
}

/** True while a face-handle resize drag is in progress. */
export function setEditorOverlayDragActive(v: boolean) {
  _overlayDragActive = v;
}

/** Is this pointer press on a gizmo / resize handle instead of the scene?
 *  `ray` is the R3F event ray (world space); the fast path uses the
 *  TransformControls `axis` (set by its hover raycast on the last move). */
export function pointerPressTargetsGizmo(ray: THREE.Ray | null): boolean {
  try {
    const c = _activeTransformControls;
    if (c) {
      if (c.axis) return true;
      if (ray) {
        const helper = typeof c.getHelper === 'function' ? c.getHelper() : c;
        if (helper) {
          _guardRaycaster.ray.copy(ray);
          if (helper.gizmo && _guardRaycaster.intersectObject(helper.gizmo, true).length > 0) return true;
          if (helper.picker && _guardRaycaster.intersectObject(helper.picker, true).length > 0) return true;
        }
      }
    }
    if (ray && _overlayPickMeshes.length > 0) {
      _guardRaycaster.ray.copy(ray);
      if (_guardRaycaster.intersectObjects(_overlayPickMeshes, false).length > 0) return true;
    }
  } catch {
    // Never block selection because the guard itself errored.
  }
  return false;
}

/** Is a gizmo / face-handle interaction currently in progress? Used by the
 *  pointer-missed (click empty space) handler so releasing a gizmo grab
 *  over open terrain doesn't drop the selection. */
export function editorGizmoInteractionActive(): boolean {
  if (_overlayDragActive) return true;
  const c = _activeTransformControls;
  return !!(c && (c.dragging || c.axis));
}
