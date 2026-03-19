import * as THREE from 'three';
import { CHARACTER_LIST, createCharacter } from '../engine/player/characters';

/**
 * Pre-renders a face portrait for every character model.
 * Returns a Map keyed by display name (e.g. "The Janitor") → data-URL.
 * The renderer is created and disposed immediately — call once at startup.
 */
export function renderPortraits(): Map<string, string> {
  const size = 128;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(size, size);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));

  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(0.5, 1, 1.5);
  scene.add(dir);

  // Frame the head: headGroup is at y=1.42, head sphere at +0.16,
  // hair can extend to ~+0.30.  Camera looks at roughly face-center.
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 10);
  camera.position.set(0, 1.56, 0.65);
  camera.lookAt(0, 1.54, 0);

  const portraits = new Map<string, string>();

  for (const char of CHARACTER_LIST) {
    const model = createCharacter(char.id);
    scene.add(model.group);
    renderer.render(scene, camera);
    portraits.set(char.name, renderer.domElement.toDataURL());
    scene.remove(model.group);
    model.dispose();
  }

  renderer.dispose();
  return portraits;
}
