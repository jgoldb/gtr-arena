import { Engine } from './engine/Engine';
import { DebugPanel } from './ui/DebugPanel';
import { MapSelector } from './ui/MapSelector';
import { CharacterSelector } from './ui/CharacterSelector';
import { NpcSpawner } from './ui/NpcSpawner';
import { UnitFrame } from './ui/UnitFrame';
import { renderPortraits } from './ui/PortraitRenderer';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element not found');

const engine = new Engine(canvas);

// Pre-render character face portraits (one-shot, renderer is disposed after)
const portraits = renderPortraits();
const getPortrait = (modelName: string) => portraits.get(modelName);

// UI — right panel
const mapContainer = document.getElementById('map-selector-container')!;
const debugContainer = document.getElementById('debug-panel-container')!;

const charContainer = document.getElementById('character-selector-container')!;
new CharacterSelector(engine, charContainer);
new MapSelector(engine, mapContainer);

const npcContainer = document.getElementById('npc-spawner-container')!;
new NpcSpawner(engine, npcContainer);

new DebugPanel(engine, debugContainer);

// UI — unit frames (top-left)
const playerFrame = new UnitFrame({ getPortrait });
document.getElementById('player-frame-container')!.appendChild(playerFrame.element);

const targetFrame = new UnitFrame({ hostileAware: true, getPortrait });
document.getElementById('target-frame-container')!.appendChild(targetFrame.element);

function updateFrames() {
  requestAnimationFrame(updateFrames);
  playerFrame.update(engine.playerController);
  targetFrame.update(engine.targetingSystem.currentTarget);
}
updateFrames();

// Handle resize
window.addEventListener('resize', () => {
  engine.resize(window.innerWidth, window.innerHeight);
});

// Start
engine.start();
