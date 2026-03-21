import * as THREE from 'three';

// Character skeleton dimensions (shared across all characters):
// boots bottom at y≈0, head top at y≈1.6, body width ≈0.5, depth ≈0.3.
// The box is slightly generous so clicking near a character is forgiving.
const HIT_WIDTH = 0.9;
const HIT_HEIGHT = 1.7;
const HIT_DEPTH = 0.6;

/**
 * Creates an invisible box mesh that covers the full character from
 * feet to head. Expands the clickable targeting area without changing
 * the visible model or hitbox.
 */
export function createTargetingHitArea(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(HIT_WIDTH, HIT_HEIGHT, HIT_DEPTH);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = HIT_HEIGHT / 2;
  return mesh;
}
