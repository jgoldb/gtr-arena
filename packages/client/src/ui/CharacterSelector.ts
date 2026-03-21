import { Engine } from '../engine/Engine';
import { CHARACTER_LIST, CharacterId } from '../engine/player/characters';

export class CharacterSelector {
  private select: HTMLSelectElement;

  constructor(engine: Engine, container: HTMLElement) {
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
      margin-bottom: 8px;
      width: 100%;
    `;

    for (const char of CHARACTER_LIST) {
      const option = document.createElement('option');
      option.value = char.id;
      option.textContent = char.name;
      this.select.appendChild(option);
    }

    this.select.addEventListener('change', () => {
      engine.setCharacter(this.select.value as CharacterId);
    });

    container.appendChild(this.select);
  }
}
