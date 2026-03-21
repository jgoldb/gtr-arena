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
import { Nameplates } from './ui/Nameplates';
import { ChemicalSpillDot, ChemicalSpillSpeedBuff, DebugStun, DiscombobulateDebuff, FartBombDebuff, yardsToUnits, type Ability } from './engine/combat/Ability';

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

// UI — Open Gates test button (in NPC panel)
const gatesBtn = document.createElement('button');
gatesBtn.textContent = 'Open Gates';
gatesBtn.style.cssText = `
  padding: 6px 10px;
  font-size: 13px;
  background: rgba(40, 100, 160, 0.85);
  color: #ddd;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  width: 100%;
  margin-top: 4px;
`;
gatesBtn.addEventListener('click', () => {
  const script = engine.mapManager.getScript();
  if (script && 'forceOpenDoors' in script) {
    (script as { forceOpenDoors: () => void }).forceOpenDoors();
  }
});
npcContainer.appendChild(gatesBtn);

// UI — Toggle Stun test button (in NPC panel)
const stunBtn = document.createElement('button');
stunBtn.textContent = 'Stun Target';
stunBtn.style.cssText = `
  padding: 6px 10px;
  font-size: 13px;
  background: rgba(160, 130, 40, 0.85);
  color: #ddd;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  width: 100%;
  margin-top: 4px;
`;
stunBtn.addEventListener('click', () => {
  const target = engine.targetingSystem.currentTarget;
  if (!target || target.dead) return;
  if (engine.buffSystem.isStunned(target)) {
    engine.buffSystem.remove(target, 'debug-stun');
    stunBtn.textContent = 'Stun Target';
    stunBtn.style.background = 'rgba(160, 130, 40, 0.85)';
  } else {
    engine.buffSystem.apply(target, DebugStun);
    stunBtn.textContent = 'Unstun Target';
    stunBtn.style.background = 'rgba(40, 130, 160, 0.85)';
  }
});
npcContainer.appendChild(stunBtn);

// UI — Discombobulate test button (in NPC panel)
const discBtn = document.createElement('button');
discBtn.textContent = 'Discombobulate';
discBtn.style.cssText = `
  padding: 6px 10px;
  font-size: 13px;
  background: rgba(100, 60, 160, 0.85);
  color: #ddd;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  width: 100%;
  margin-top: 4px;
`;
discBtn.addEventListener('click', () => {
  const target = engine.targetingSystem.currentTarget;
  if (!target || target.dead) return;
  engine.buffSystem.apply(target, DiscombobulateDebuff);
});
npcContainer.appendChild(discBtn);

// UI — unit frames (top-left)
const setTarget = (t: import('./engine/types').Targetable) => {
  engine.targetingSystem.currentTarget = t;
};
const playerFrame = new UnitFrame({ getPortrait, onClick: setTarget });
document.getElementById('player-frame-container')!.appendChild(playerFrame.element);

const targetFrame = new UnitFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
document.getElementById('target-frame-container')!.appendChild(targetFrame.element);

// UI — error text (center screen)
const errorText = new ErrorText();
document.body.appendChild(errorText.element);

// UI — floating combat text (damage/heal numbers over targets)
const combatText = new FloatingCombatText(engine.camera);
document.body.appendChild(combatText.element);
// UI — nameplates (floating above characters)
const nameplates = new Nameplates(engine.camera, engine.scene);
document.body.appendChild(nameplates.element);

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

// UI — cast bar (above action bar)
const castBarContainer = document.createElement('div');
castBarContainer.style.cssText = `
  position: fixed;
  bottom: 84px;
  left: 50%;
  transform: translateX(-50%);
  width: 240px;
  z-index: 100;
  display: none;
`;
const castBarHeader = document.createElement('div');
castBarHeader.style.cssText = `
  display: flex;
  justify-content: space-between;
  color: #ddd;
  font-size: 11px;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  margin-bottom: 2px;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.9);
`;
const castBarBg = document.createElement('div');
castBarBg.style.cssText = `
  height: 14px;
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  overflow: hidden;
`;
const castBarFill = document.createElement('div');
castBarFill.style.cssText = `
  height: 100%;
  background: linear-gradient(to right, #4488ff, #66aaff);
  width: 0%;
`;
castBarBg.appendChild(castBarFill);
castBarContainer.appendChild(castBarHeader);
castBarContainer.appendChild(castBarBg);
document.body.appendChild(castBarContainer);

// Helper: apply post-cast effects (animation, special abilities)
function onAbilitySuccess(ability: Ability): void {
  engine.playerController.triggerAbilityAnimation(
    ability.id,
    engine.targetingSystem.currentTarget?.mesh.position.clone()
  );
  if (ability.id === 'fart-bomb') {
    engine.spawnGasCloud(
      engine.playerController.mesh.position.clone(),
      yardsToUnits(5),
      8,
      FartBombDebuff,
      96,
      2,
      engine.playerController
    );
  }
  if (ability.id === 'sweep') {
    engine.startSweepCharge();
  }
  if (ability.id === 'chemical-spill') {
    engine.spawnChemicalPool(
      engine.playerController.mesh.position.clone(),
      yardsToUnits(3),   // small pool radius
      30,                // pool duration (seconds)
      ChemicalSpillSpeedBuff,
      ChemicalSpillDot,
      40,                // initial damage to hostiles
      60,                // total DoT damage
      2,                 // DoT tick interval
      6,                 // DoT duration
      engine.playerController,
      2                  // 2 second activation delay
    );
  }
}

// Cast completion callback
engine.onCastComplete = (ability) => {
  onAbilitySuccess(ability);
};
engine.onCastFailed = (message) => {
  errorText.show(message);
};

// UI — action bar (bottom center)
const actionBar = new ActionBar({
  onActivate: (ability) => {
    // Interrupt active channel when using another ability (only if not on cooldown)
    if (engine.isChanneling() && engine.combatSystem.getCooldownRemaining(ability.id) <= 0) {
      engine.cancelCasting();
    }
    // Auto self-cast: if ability can target friendlies and no target selected, use self
    let target: import('./engine/types').Targetable | null = engine.targetingSystem.currentTarget;
    if (!target && ability.requiresTarget && !ability.requiresHostileTarget) {
      target = engine.playerController;
    }
    if (ability.castTime) {
      // Start casting instead of instant use
      const result = engine.startCasting(
        ability,
        engine.playerController.mesh.rotation.y,
        target
      );
      if (!result.success && result.errorMessage) {
        errorText.show(result.errorMessage);
      }
    } else {
      // Instant-cast ability
      const result = engine.combatSystem.useAbility(
        ability,
        engine.playerController,
        engine.playerController.mesh.rotation.y,
        target
      );
      if (result.success) {
        onAbilitySuccess(ability);
      } else if (result.errorMessage) {
        errorText.show(result.errorMessage);
      }
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
    if (ability.requiresTarget && !ability.requiresHostileTarget) {
      // Auto self-cast: no target → will cast on self, so skip no-target check
      const target = engine.targetingSystem.currentTarget ?? player;
      if (target.dead) return 'no-target';
      if (ability.range && target !== player) {
        const dx = player.mesh.position.x - target.mesh.position.x;
        const dz = player.mesh.position.z - target.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > ability.range) return 'out-of-range';
      }
    }
    return 'usable';
  },
  getCombatSystem: () => engine.combatSystem,
  isDisabled: () => engine.playerController.dead || engine.playerController.stunned || engine.playerController.charging || (engine.isCasting() && !engine.isChanneling()),
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

  // Update cast bar
  const castState = engine.getCastingState();
  if (castState) {
    castBarContainer.style.display = 'block';
    let progress: number;
    if (castState.isChannel) {
      // Channel: bar drains from full to empty
      progress = Math.max(0, (castState.totalTime - castState.elapsed) / castState.originalCastTime);
      castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
    } else {
      // Regular cast: bar fills from empty to full
      progress = Math.min(1, castState.elapsed / castState.totalTime);
      castBarFill.style.background = 'linear-gradient(to right, #4488ff, #66aaff)';
    }
    castBarFill.style.width = `${progress * 100}%`;
    const remaining = Math.max(0, castState.totalTime - castState.elapsed);
    castBarHeader.innerHTML =
      `<span>${castState.abilityName}</span><span>${remaining.toFixed(1)}s</span>`;
  } else {
    castBarContainer.style.display = 'none';
  }

  combatText.update(dt);
  nameplates.update(engine.playerController, engine.getNpcs());

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
