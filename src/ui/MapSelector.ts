import { Engine } from '../engine/Engine';

export class MapSelector {
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

    const maps = engine.mapManager.getAvailableMaps();
    for (const map of maps) {
      const option = document.createElement('option');
      option.value = map.id;
      option.textContent = map.name;
      this.select.appendChild(option);
    }

    this.select.addEventListener('change', () => {
      engine.loadMap(this.select.value);
    });

    container.appendChild(this.select);
  }
}
