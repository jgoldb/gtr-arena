/**
 * NeuralBehavior — CharacterBehavior driven by an ONNX neural network model.
 *
 * Builds an observation vector matching HeadlessArena.buildObservation() exactly,
 * runs inference via onnxruntime-web, and maps the output to ScoredActions and
 * MovementIntents consumed by NpcAiBrain.
 *
 * The model was trained via PPO in the headless arena (Phase 3).
 * Action space: MultiDiscrete([numAbilities+1, 9, 2, 2])
 *   - ability: 0=none, 1..N = ability slot index
 *   - moveDir: 0=stop, 1-8 = N/NE/E/SE/S/SW/W/NW
 *   - cancelCast: 0/1 (unused in client — brain manages casting)
 *   - rest: 0/1 (sit down for accelerated mana regen)
 */

import * as ort from 'onnxruntime-web';

// Point onnxruntime-web to WASM files in public/ so Vite can serve them
ort.env.wasm.wasmPaths = '/';
import type { CharacterBehavior, ScoredAction } from './BaseBehavior';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';
import type { AiEngineInterface } from '../NpcAiBrain';
import type { NpcController } from '../../NpcController';
import { getCharacterStats, yardsToUnits, type CharacterId, type Ability } from '@gtr/shared';

// Movement direction angles matching bridge.ts MOVE_ANGLES
const MOVE_ANGLES: (number | null)[] = [
  null,                //  0: stand still
  0,                   //  1: N  (+Z)
  Math.PI * 0.25,      //  2: NE
  Math.PI * 0.5,       //  3: E  (+X)
  Math.PI * 0.75,      //  4: SE
  Math.PI,             //  5: S  (-Z)
  -Math.PI * 0.75,     //  6: SW
  -Math.PI * 0.5,      //  7: W  (-X)
  -Math.PI * 0.25,     //  8: NW
];

// 8 raycast directions for wall distance: N, NE, E, SE, S, SW, W, NW
const WALL_RAY_DIRS: [number, number][] = [
  [0, 1], [0.707, 0.707], [1, 0], [0.707, -0.707],
  [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707],
];
const WALL_RAY_MAX = yardsToUnits(30);

export class NeuralBehavior implements CharacterBehavior {
  readonly characterId: CharacterId;
  private session: ort.InferenceSession | null = null;
  private readonly npc: NpcController;
  private readonly engine: AiEngineInterface;
  private readonly abilities: readonly (Ability | null)[];
  private readonly numAbilities: number;
  private readonly actionSplits: number[]; // [numAbilities+1, 9, 2, 2]

  // Normalization scale (computed from arena bounds)
  private normScale = 30;

  // Inference state: we run inference async and use the result on the next think cycle.
  // This gives a 1-tick delay (~100ms) which is imperceptible.
  private inferring = false;
  private cachedAbilityIdx = 0;   // 0 = no ability
  private cachedMoveDir = 0;      // 0 = stand still
  private cachedRest = false;     // true = wants to rest

  constructor(characterId: CharacterId, npc: NpcController, engine: AiEngineInterface) {
    this.characterId = characterId;
    this.npc = npc;
    this.engine = engine;
    const stats = getCharacterStats(characterId);
    this.abilities = stats.abilities;
    this.numAbilities = stats.abilities.length;
    this.actionSplits = [this.numAbilities + 1, 9, 2, 2];
  }

  async loadModel(url: string): Promise<void> {
    this.session = await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
    });
    console.log(`[NeuralBehavior] Model loaded: ${url}`);
  }

  get isLoaded(): boolean {
    return this.session !== null;
  }

  getDesiredRange(): number {
    return getCharacterStats(this.characterId).autoAttackRange;
  }

  /**
   * Trigger inference if not already running. Must be called every think cycle
   * so the model always gets fresh observations — even when resting.
   * In the headless arena (training), the agent receives a new observation every
   * step regardless of its action outputs.
   */
  updateInference(cooldowns: NpcCooldownTracker, currentTarget: EntityInfo | null): void {
    if (!this.session || !currentTarget) return;
    this.scheduleInference(cooldowns, currentTarget);
  }

  scoreActions(
    _world: WorldState,
    cooldowns: NpcCooldownTracker,
    _difficulty: DifficultyProfile,
    currentTarget: EntityInfo | null,
  ): ScoredAction[] {
    if (!this.session || !currentTarget) return [];

    // Fire off async inference for the NEXT think cycle
    this.scheduleInference(cooldowns, currentTarget);

    // Use cached ability decision from the previous inference
    const actions: ScoredAction[] = [];
    if (this.cachedAbilityIdx > 0) {
      const slotIndex = this.cachedAbilityIdx - 1;
      const ability = this.abilities[slotIndex];
      if (ability && !ability.isAutoAttack && cooldowns.isReady(ability.id)) {
        // For charge abilities (Sweep), aim toward the target — matches headless arena
        // where entities always faceToward(opponent) before ability usage.
        let aimRotation: number | undefined;
        if (ability.chargeDuration) {
          const dx = currentTarget.position.x - this.npc.mesh.position.x;
          const dz = currentTarget.position.z - this.npc.mesh.position.z;
          aimRotation = Math.atan2(dx, dz);
        }

        actions.push({
          type: 'ability',
          score: 100,
          abilityId: ability.id,
          ability,
          target: ability.requiresHostileTarget ? currentTarget : undefined,
          isCastTime: ability.castTime != null && ability.castTime > 0,
          aimRotation,
          execute: () => {},
        });
      }
    }
    return actions;
  }

  wantsRest(): boolean {
    return this.cachedRest;
  }

  getMovementIntent(
    _world: WorldState,
    currentTarget: EntityInfo | null,
    _cooldowns: NpcCooldownTracker,
    _difficulty: DifficultyProfile,
  ): MovementIntent {
    const moveAngle = MOVE_ANGLES[this.cachedMoveDir];
    if (moveAngle === null || moveAngle === undefined) {
      if (currentTarget) {
        return { type: 'moveToward', target: currentTarget.position, stopDistance: Infinity };
      }
      return { type: 'idle' };
    }

    // Convert absolute angle to a world-space target point
    const pos = this.npc.mesh.position;
    const dist = yardsToUnits(5);
    const target = pos.clone();
    target.x = pos.x + Math.sin(moveAngle) * dist;
    target.z = pos.z + Math.cos(moveAngle) * dist;

    return { type: 'moveToward', target, stopDistance: 0 };
  }

  // ── Inference ─────────────────────────────────────────────────────────

  private scheduleInference(cooldowns: NpcCooldownTracker, currentTarget: EntityInfo): void {
    if (this.inferring || !this.session) return;
    this.inferring = true;

    const obs = this.buildObservation(cooldowns, currentTarget);
    const input = new ort.Tensor('float32', Float32Array.from(obs), [1, obs.length]);

    this.session.run({ obs: input }).then(results => {
      const logits = results.logits.data as Float32Array;

      // Split logits and argmax each sub-space
      let offset = 0;
      const actions: number[] = [];
      for (const size of this.actionSplits) {
        let bestIdx = 0;
        let bestVal = logits[offset];
        for (let i = 1; i < size; i++) {
          if (logits[offset + i] > bestVal) {
            bestVal = logits[offset + i];
            bestIdx = i;
          }
        }
        actions.push(bestIdx);
        offset += size;
      }

      this.cachedAbilityIdx = actions[0];
      this.cachedMoveDir = actions[1];
      this.cachedRest = actions[3] === 1;
    }).catch(err => {
      console.warn('[NeuralBehavior] Inference failed:', err);
    }).finally(() => {
      this.inferring = false;
    });
  }

  // ── Observation Encoding ──────────────────────────────────────────────
  // Must match HeadlessArena.buildObservation() + flattenObservation() exactly.

  private buildObservation(cooldowns: NpcCooldownTracker, currentTarget: EntityInfo): number[] {
    const npc = this.npc;
    const buffSystem = this.engine.buffSystem;
    const collision = this.engine.getCollisionSystem();
    const bounds = this.engine.getNpcSpawnBounds();

    this.normScale = Math.max(
      Math.abs(bounds.maxX), Math.abs(bounds.minX),
      Math.abs(bounds.maxZ), Math.abs(bounds.minZ),
    ) || 30;

    const selfPos = npc.mesh.position;
    const selfRotY = npc.mesh.rotation.y;
    const oppPos = currentTarget.position;
    const oppEntity = currentTarget.entity;
    const oppRotY = oppEntity.mesh.rotation.y;

    const dx = oppPos.x - selfPos.x;
    const dz = oppPos.z - selfPos.z;
    const oppDist = Math.sqrt(dx * dx + dz * dz);

    // Cooldown vector: normalized 0-1 per ability slot
    const cooldownVec = this.abilities.map(a => {
      if (!a) return 0;
      const remaining = cooldowns.getCooldownRemaining(a.id);
      if (remaining <= 0) return 0;
      const total = cooldowns.getCooldownTotal(a.id);
      return total > 0 ? remaining / total : 0;
    });

    // Wall distances: 8-direction raycasts
    const wallDist = WALL_RAY_DIRS.map(
      ([dirX, dirZ]) => collision.raycastDistance(selfPos.x, selfPos.z, dirX, dirZ, WALL_RAY_MAX, selfPos.y) / WALL_RAY_MAX,
    );

    const oppLoS = collision.hasLineOfSight(
      selfPos.x, selfPos.z, oppPos.x, oppPos.z, selfPos.y, oppPos.y,
    ) ? 1 : 0;

    // Dynamic map features
    const pillarState = this.engine.getPillarState();

    // Flatten in exact same order as HeadlessArena.flattenObservation()
    return [
      // Self — vitals & position
      npc.maxHp > 0 ? npc.hp / npc.maxHp : 0,
      npc.maxMana > 0 ? npc.mana / npc.maxMana : 0,
      selfPos.x / this.normScale,
      selfPos.z / this.normScale,
      selfPos.y / 10,
      selfRotY / Math.PI,
      // Self — CC & status
      buffSystem.isStunned(npc) ? 1 : 0,
      buffSystem.isSleeping(npc) ? 1 : 0,
      buffSystem.isDisoriented(npc) ? 1 : 0,
      buffSystem.isBlinded(npc) ? 1 : 0,
      buffSystem.isDiscombobulated(npc) ? 1 : 0,
      buffSystem.isUntargetable(npc) ? 1 : 0,
      npc.inCombat ? 1 : 0,
      buffSystem.hasBuff(npc, 'resting') ? 1 : 0,
      // Self — buff multipliers
      buffSystem.getMovementSpeedMultiplier(npc),
      buffSystem.getDamageDealtMultiplier(npc),
      buffSystem.getDamageTakenMultiplier(npc),
      // Self — ability state
      ...cooldownVec,
      cooldowns.getGcdRemaining() / 0.75,
      npc.castingAbilityName !== null ? 1 : 0,
      npc.castingTotalTime > 0 ? npc.castingElapsed / npc.castingTotalTime : 0,
      npc.castingIsChannel ? 1 : 0,
      // Opponent — vitals & position
      oppEntity.maxHp > 0 ? oppEntity.hp / oppEntity.maxHp : 0,
      oppEntity.maxMana > 0 ? oppEntity.mana / oppEntity.maxMana : 0,
      dx / this.normScale,
      dz / this.normScale,
      oppDist / (this.normScale * 2),
      oppRotY / Math.PI,
      // Opponent — CC & status
      currentTarget.isStunned ? 1 : 0,
      currentTarget.isSleeping ? 1 : 0,
      buffSystem.isDisoriented(oppEntity) ? 1 : 0,
      currentTarget.isBlinded ? 1 : 0,
      buffSystem.isDiscombobulated(oppEntity) ? 1 : 0,
      buffSystem.isUntargetable(oppEntity) ? 1 : 0,
      buffSystem.hasBuff(oppEntity, 'resting') ? 1 : 0,
      // Opponent — buff multipliers
      buffSystem.getMovementSpeedMultiplier(oppEntity),
      buffSystem.getDamageDealtMultiplier(oppEntity),
      buffSystem.getDamageTakenMultiplier(oppEntity),
      // Opponent — ability & movement state
      oppEntity.castingAbilityName !== null ? 1 : 0,
      oppEntity.castingTotalTime > 0 ? oppEntity.castingElapsed / oppEntity.castingTotalTime : 0,
      oppEntity.castingIsChannel ? 1 : 0,
      (oppEntity as unknown as { isMoving?: boolean }).isMoving ? 1 : 0,
      // Spatial
      oppLoS,
      ...wallDist,
      // Dynamic map features
      pillarState.ewPillarUp, pillarState.nsPillarUp, pillarState.pillarPhasePct,
      // Temporal context
      this.engine.getMatchTimePct(),
    ];
  }
}
