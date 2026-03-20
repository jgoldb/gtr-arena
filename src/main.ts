import { Engine } from './engine/Engine';
import { DebugPanel } from './ui/DebugPanel';
import { MapSelector } from './ui/MapSelector';
import { CharacterSelector } from './ui/CharacterSelector';
import { NpcSpawner } from './ui/NpcSpawner';
import { UnitFrame } from './ui/UnitFrame';
import { renderPortraits } from './ui/PortraitRenderer';
import { ActionBar } from './ui/ActionBar';
import { ErrorText } from './ui/ErrorText';
import { FloatingCombatText } from './ui/FloatingCombatText';
import type { Ability } from './engine/combat/Ability';

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

// UI — Kill Target test button (in NPC panel)
const killBtn = document.createElement('button');
killBtn.textContent = 'Kill Target';
killBtn.style.cssText = `
  padding: 6px 10px;
  font-size: 13px;
  background: rgba(160, 40, 40, 0.85);
  color: #ddd;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  width: 100%;
  margin-top: 4px;
`;
killBtn.addEventListener('click', () => {
  const target = engine.targetingSystem.currentTarget;
  if (target && !target.dead) {
    target.die();
  }
});
npcContainer.appendChild(killBtn);

// UI — unit frames (top-left)
const playerFrame = new UnitFrame({ getPortrait });
document.getElementById('player-frame-container')!.appendChild(playerFrame.element);

const targetFrame = new UnitFrame({ localPlayer: engine.playerController, getPortrait });
document.getElementById('target-frame-container')!.appendChild(targetFrame.element);

// UI — error text (center screen)
const errorText = new ErrorText();
document.body.appendChild(errorText.element);

// UI — floating combat text (damage/heal numbers over targets)
const combatText = new FloatingCombatText(engine.camera);
document.body.appendChild(combatText.element);
engine.combatSystem.onCombatText = (target, amount, type) => {
  combatText.spawn(target.mesh, amount, type);
  // Show combat text on the appropriate unit frame portrait
  if (target === engine.playerController) {
    playerFrame.showCombatText(amount, type);
  } else if (target === engine.targetingSystem.currentTarget) {
    targetFrame.showCombatText(amount, type);
  }
};

// UI — death screen (no backdrop — camera must remain interactive)
const deathScreen = document.createElement('div');
deathScreen.style.cssText = `
  position: fixed;
  top: 35%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: none;
  z-index: 500;
  pointer-events: none;
`;
const deathDialog = document.createElement('div');
deathDialog.style.cssText = `
  pointer-events: auto;
  background: linear-gradient(to bottom, rgba(30, 10, 10, 0.95), rgba(10, 5, 5, 0.95));
  border: 1px solid #aa3333;
  border-radius: 8px;
  padding: 30px 40px;
  text-align: center;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
`;
const deathTitle = document.createElement('div');
deathTitle.textContent = 'You Died';
deathTitle.style.cssText = 'color: #cc2222; font-size: 32px; font-weight: bold; margin-bottom: 12px;';
const deathSub = document.createElement('div');
deathSub.textContent = 'Your character has been slain.';
deathSub.style.cssText = 'color: #888; font-size: 14px; margin-bottom: 24px;';
const respawnBtn = document.createElement('button');
respawnBtn.textContent = 'Respawn';
respawnBtn.style.cssText = `
  padding: 10px 32px;
  font-size: 15px;
  font-weight: bold;
  background: rgba(180, 60, 60, 0.85);
  color: #eee;
  border: 1px solid #cc4444;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
`;
respawnBtn.addEventListener('click', () => {
  engine.playerController.respawn();
  deathScreen.style.display = 'none';
});
deathDialog.appendChild(deathTitle);
deathDialog.appendChild(deathSub);
deathDialog.appendChild(respawnBtn);
deathScreen.appendChild(deathDialog);
document.body.appendChild(deathScreen);

// UI — action bar (bottom center)
const actionBar = new ActionBar({
  onActivate: (ability) => {
    const result = engine.combatSystem.useAbility(
      ability,
      engine.playerController,
      engine.playerController.mesh.rotation.y,
      engine.targetingSystem.currentTarget
    );
    if (result.success) {
      engine.playerController.triggerAbilityAnimation(ability.id);
    } else if (result.errorMessage) {
      errorText.show(result.errorMessage);
    }
  },
  getAbilityStatus: (ability) => {
    const player = engine.playerController;
    // Resource check first (takes priority visually)
    if (player.mana < ability.manaCost) return 'not-enough-resource';
    // Target checks
    if (ability.requiresHostileTarget) {
      const target = engine.targetingSystem.currentTarget;
      if (!target || !target.isHostileTo(player) || target.dead) return 'no-target';
      // Range check
      const dx = player.mesh.position.x - target.mesh.position.x;
      const dz = player.mesh.position.z - target.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > ability.range!) return 'out-of-range';
    }
    return 'usable';
  },
  getCombatSystem: () => engine.combatSystem,
  isDisabled: () => engine.playerController.dead,
});
document.body.appendChild(actionBar.element);

// Populate action bar from character abilities
function loadAbilities(abilities: readonly Ability[]): void {
  actionBar.clearAllSlots();
  abilities.forEach((ab, i) => actionBar.setSlotAbility(i, ab));
}
loadAbilities(engine.playerController.abilities);

// Character swap: full reset + repopulate action bar
engine.onCharacterChange = (abilities) => {
  loadAbilities(abilities);
};
engine.onAutoAttackError = (message) => {
  errorText.show(message);
};

let deathScreenShown = false;

let lastFrameTime = performance.now();
function updateFrames() {
  requestAnimationFrame(updateFrames);
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  const bs = engine.buffSystem;
  playerFrame.update(
    engine.playerController,
    bs.getBuffs(engine.playerController),
    bs.getDebuffs(engine.playerController)
  );
  const ct = engine.targetingSystem.currentTarget;
  targetFrame.update(
    ct,
    ct ? bs.getBuffs(ct) : [],
    ct ? bs.getDebuffs(ct) : []
  );
  playerFrame.updateCombatText(dt);
  targetFrame.updateCombatText(dt);
  actionBar.update();
  combatText.update(dt);

  // Show death screen when player dies
  if (engine.playerController.dead && !deathScreenShown) {
    deathScreenShown = true;
    deathScreen.style.display = 'block';
  } else if (!engine.playerController.dead && deathScreenShown) {
    deathScreenShown = false;
  }
}
updateFrames();

// Handle resize
window.addEventListener('resize', () => {
  engine.resize(window.innerWidth, window.innerHeight);
});

// Start
engine.start();
