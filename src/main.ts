import { Engine } from './engine/Engine';
import { DebugPanel } from './ui/DebugPanel';
import { MapSelector } from './ui/MapSelector';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element not found');

const engine = new Engine(canvas);

// UI
const mapContainer = document.getElementById('map-selector-container')!;
const debugContainer = document.getElementById('debug-panel-container')!;

new MapSelector(engine, mapContainer);
new DebugPanel(engine, debugContainer);

// Handle resize
window.addEventListener('resize', () => {
  engine.resize(window.innerWidth, window.innerHeight);
});

// Start
engine.start();
