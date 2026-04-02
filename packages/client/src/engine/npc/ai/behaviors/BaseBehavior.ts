import type { Ability } from '../../../combat/Ability';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';
import { yardsToUnits, MELEE_RANGE_THRESHOLD } from '@gtr/shared';
import type { CharacterId } from '@gtr/shared';

export interface ScoredAction {
  type: 'ability' | 'movement' | 'target-switch';
  score: number;
  abilityId?: string;
  ability?: Ability;
  target?: EntityInfo;
  /** If true, this is a cast-time or channel ability — brain will call startCasting() instead of npcUseAbility() */
  isCastTime?: boolean;
  /** Override NPC facing rotation (radians) before executing — used for skill-shot aiming (e.g. Sweep leading) */
  aimRotation?: number;
  execute: () => void;
}

export interface CharacterBehavior {
  readonly characterId: CharacterId;

  /** Score all possible actions for this character given the current world state. */
  scoreActions(
    world: WorldState,
    cooldowns: NpcCooldownTracker,
    difficulty: DifficultyProfile,
    currentTarget: EntityInfo | null
  ): ScoredAction[];

  /** What range does this character want to fight at? (world units) */
  getDesiredRange(): number;

  /** What movement does this character want given the world state? */
  getMovementIntent(world: WorldState, currentTarget: EntityInfo | null, cooldowns: NpcCooldownTracker, difficulty: DifficultyProfile): MovementIntent;
}

/**
 * Fallback behavior for characters without unique abilities.
 * Just auto-attacks and chases the current target.
 */
export class BaseBehavior implements CharacterBehavior {
  readonly characterId: CharacterId;
  private readonly attackRange: number;
  private readonly isMelee: boolean;

  constructor(characterId: CharacterId, attackRange: number) {
    this.characterId = characterId;
    this.attackRange = attackRange;
    this.isMelee = attackRange <= MELEE_RANGE_THRESHOLD;
  }

  scoreActions(): ScoredAction[] {
    // No ability actions — just auto-attack via NpcController's existing logic
    return [];
  }

  getDesiredRange(): number {
    return this.attackRange;
  }

  getMovementIntent(_world: WorldState, currentTarget: EntityInfo | null, _cooldowns: NpcCooldownTracker, _difficulty: DifficultyProfile): MovementIntent {
    if (!currentTarget) return { type: 'idle' };
    return {
      type: 'moveToward',
      target: currentTarget.position,
      stopDistance: this.attackRange * 0.85 - (this.isMelee ? yardsToUnits(1) : 0),
    };
  }
}
