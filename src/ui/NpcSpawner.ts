import * as THREE from 'three';
import { Engine } from '../engine/Engine';
import { CHARACTER_LIST, CharacterId } from '../engine/player/characters';

export class NpcSpawner {
  private select: HTMLSelectElement;
  private spawnBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;

  constructor(engine: Engine, container: HTMLElement) {
    // Character dropdown for NPC model selection
    this.select = document.createElement('select');
    this.select.style.cssText = `
      padding: 6px 10px;
      font-size: 13px;
      background: rgba(30, 30, 40, 0.85);
      color: #ddd;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      cursor: pointer;
      outline: none;
      width: 100%;
    `;

    for (const char of CHARACTER_LIST) {
      const option = document.createElement('option');
      option.value = char.id;
      option.textContent = char.name;
      this.select.appendChild(option);
    }

    // Spawn button
    this.spawnBtn = document.createElement('button');
    this.spawnBtn.textContent = 'Spawn NPC';
    this.spawnBtn.style.cssText = `
      padding: 6px 10px;
      font-size: 13px;
      background: rgba(180, 60, 60, 0.85);
      color: #ddd;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      cursor: pointer;
      outline: none;
      width: 100%;
      margin-top: 4px;
    `;

    this.spawnBtn.addEventListener('click', () => {
      const characterId = this.select.value as CharacterId;
      const pos = this.pickSpawnPosition(engine);
      engine.spawnNpc(characterId, pos);
    });

    // Clear all button
    this.clearBtn = document.createElement('button');
    this.clearBtn.textContent = 'Clear NPCs';
    this.clearBtn.style.cssText = `
      padding: 6px 10px;
      font-size: 13px;
      background: rgba(80, 80, 100, 0.85);
      color: #ddd;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      cursor: pointer;
      outline: none;
      width: 100%;
      margin-top: 4px;
    `;

    this.clearBtn.addEventListener('click', () => {
      engine.clearNpcs();
    });

    const label = document.createElement('div');
    label.textContent = 'NPC';
    label.style.cssText = `
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      margin-bottom: 4px;
      margin-top: 8px;
    `;

    container.appendChild(label);
    container.appendChild(this.select);
    container.appendChild(this.spawnBtn);
    container.appendChild(this.clearBtn);
  }

  private pickSpawnPosition(engine: Engine): THREE.Vector3 {
    const bounds = engine.mapManager.getNpcSpawnBounds();
    const playerPos = engine.playerController.getPosition();

    // Pick a random position within the inner portion of the arena,
    // at least 5 units from the player so it doesn't spawn on top of them
    const margin = 3;
    for (let attempts = 0; attempts < 20; attempts++) {
      const x = margin + Math.random() * (bounds.maxX - bounds.minX - margin * 2) + bounds.minX;
      const z = margin + Math.random() * (bounds.maxZ - bounds.minZ - margin * 2) + bounds.minZ;
      const dx = x - playerPos.x;
      const dz = z - playerPos.z;
      if (dx * dx + dz * dz > 25) {
        return new THREE.Vector3(x, 0, z);
      }
    }

    // Fallback: spawn at map center-ish
    return new THREE.Vector3(0, 0, 0);
  }
}
