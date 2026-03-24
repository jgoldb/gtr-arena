import { Engine } from '../engine/Engine';
import { CHARACTER_LIST, CharacterId } from '../engine/player/characters';

export class NpcSpawner {
  private select: HTMLSelectElement;
  private spawnBtn: HTMLButtonElement;
  private spawnFriendlyBtn: HTMLButtonElement;
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

    // Spawn hostile button
    this.spawnBtn = document.createElement('button');
    this.spawnBtn.textContent = 'Spawn Hostile NPC';
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
      this.startSpawnGroundTarget(engine, characterId);
    });

    // Spawn friendly button
    this.spawnFriendlyBtn = document.createElement('button');
    this.spawnFriendlyBtn.textContent = 'Spawn Friendly NPC';
    this.spawnFriendlyBtn.style.cssText = `
      padding: 6px 10px;
      font-size: 13px;
      background: rgba(60, 140, 80, 0.85);
      color: #ddd;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      cursor: pointer;
      outline: none;
      width: 100%;
      margin-top: 4px;
    `;

    this.spawnFriendlyBtn.addEventListener('click', () => {
      const characterId = this.select.value as CharacterId;
      this.startSpawnGroundTarget(engine, characterId, 0);
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
    container.appendChild(this.spawnFriendlyBtn);
    container.appendChild(this.clearBtn);
  }

  private startSpawnGroundTarget(engine: Engine, characterId: CharacterId, team?: number): void {
    // Toggle off if already in NPC spawn ground targeting
    if (engine.pendingNpcSpawn) {
      engine.pendingNpcSpawn = null;
      engine.targetingSystem.cancelGroundTarget();
      return;
    }

    // Cancel any existing ground targeting, then enter NPC spawn mode
    engine.targetingSystem.cancelGroundTarget();
    engine.pendingNpcSpawn = { characterId, team };
    // Use a small reticle (0.5 radius), large range, and skip LOS checks
    engine.targetingSystem.startGroundTarget(0.5, 999, true);
  }
}
