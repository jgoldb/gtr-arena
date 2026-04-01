import type { Ability } from '../../../combat/Ability';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';
import type { CharacterId } from '@gtr/shared';

export interface ScoredAction {
  type: 'ability' | 'movement' | 'target-switch';
  score: number;
  abilityId?: string;
  ability?: Ability;
  target?: EntityInfo;
  /** If true, this is a cast-time or channel ability — brain will call startCasting() instead of npcUseAbility() */
  isCastTime?: boolean;
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
  getMovementIntent(world: WorldState, currentTarget: EntityInfo | null): MovementIntent;
}

/**
 * Fallback behavior for characters without unique abilities.
 * Just auto-attacks and chases the current target.
 */
export class BaseBehavior implements CharacterBehavior {
  readonly characterId: CharacterId;
  private readonly attackRange: number;

  constructor(characterId: CharacterId, attackRange: number) {
    this.characterId = characterId;
    this.attackRange = attackRange;
  }

  scoreActions(): ScoredAction[] {
    // No ability actions — just auto-attack via NpcController's existing logic
    return [];
  }

  getDesiredRange(): number {
    return this.attackRange;
  }

  getMovementIntent(_world: WorldState, currentTarget: EntityInfo | null): MovementIntent {
    if (!currentTarget) return { type: 'idle' };
    return {
      type: 'moveToward',
      target: currentTarget.position,
      stopDistance: this.attackRange * 0.85, // get slightly closer than max range
    };
  }
}
