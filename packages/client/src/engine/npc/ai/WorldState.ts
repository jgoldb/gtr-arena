import * as THREE from 'three';
import type { Targetable } from '../../types';
import type { BuffSystem, ActiveBuff } from '../../combat/BuffSystem';
import type { CollisionSystem } from '../../physics/CollisionSystem';

export interface EntityInfo {
  entity: Targetable;
  position: THREE.Vector3;
  distance: number;
  hpPercent: number;
  manaPercent: number;
  isStunned: boolean;
  isSleeping: boolean;
  isBlinded: boolean;
  isCasting: boolean;
  isChanneling: boolean;
  inLineOfSight: boolean;
  facingMe: boolean;
  iAmBehindThem: boolean;
  buffs: readonly ActiveBuff[];
  debuffs: readonly ActiveBuff[];
}

export interface SelfInfo {
  entity: Targetable;
  position: THREE.Vector3;
  hpPercent: number;
  manaPercent: number;
  isStunned: boolean;
  isSleeping: boolean;
  isBlinded: boolean;
  buffs: readonly ActiveBuff[];
  debuffs: readonly ActiveBuff[];
}

export interface HazardInfo {
  center: THREE.Vector3;
  radius: number;
}

export interface WorldState {
  self: SelfInfo;
  enemies: EntityInfo[];
  allies: EntityInfo[];
  hazards: HazardInfo[];
  arenaBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function buildWorldState(
  npc: Targetable,
  allEntities: Targetable[],
  buffSystem: BuffSystem,
  collisionSystem: CollisionSystem,
  arenaBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  hazards: HazardInfo[]
): WorldState {
  const selfPos = npc.mesh.position;

  const selfBuffs = buffSystem.getBuffs(npc);
  const self: SelfInfo = {
    entity: npc,
    position: selfPos.clone(),
    hpPercent: npc.maxHp > 0 ? npc.hp / npc.maxHp : 0,
    manaPercent: npc.maxMana > 0 ? npc.mana / npc.maxMana : 0,
    isStunned: buffSystem.isStunned(npc),
    isSleeping: buffSystem.isSleeping(npc),
    isBlinded: buffSystem.isBlinded(npc),
    buffs: selfBuffs.filter(b => b.definition.type === 'buff'),
    debuffs: selfBuffs.filter(b => b.definition.type === 'debuff'),
  };

  const enemies: EntityInfo[] = [];
  const allies: EntityInfo[] = [];

  for (const entity of allEntities) {
    if (entity === npc || entity.dead) continue;

    const ePos = entity.mesh.position;
    const dx = ePos.x - selfPos.x;
    const dz = ePos.z - selfPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const hasLos = collisionSystem.hasLineOfSight(
      selfPos.x, selfPos.z, ePos.x, ePos.z, selfPos.y, ePos.y
    );

    // Is the entity facing us?
    const entityForward = new THREE.Vector3(
      Math.sin(entity.mesh.rotation.y), 0, Math.cos(entity.mesh.rotation.y)
    );
    const toMe = new THREE.Vector3(-dx, 0, -dz).normalize();
    const facingMe = entityForward.dot(toMe) > 0.5;

    // Am I behind them?
    const toThem = new THREE.Vector3(dx, 0, dz).normalize();
    const iAmBehindThem = entityForward.dot(toThem) < 0;

    const entityBuffs = buffSystem.getBuffs(entity);
    const info: EntityInfo = {
      entity,
      position: ePos.clone(),
      distance: dist,
      hpPercent: entity.maxHp > 0 ? entity.hp / entity.maxHp : 0,
      manaPercent: entity.maxMana > 0 ? entity.mana / entity.maxMana : 0,
      isStunned: buffSystem.isStunned(entity),
      isSleeping: buffSystem.isSleeping(entity),
      isBlinded: buffSystem.isBlinded(entity),
      isCasting: entity.castingAbilityName !== null && !entity.castingIsChannel,
      isChanneling: entity.castingAbilityName !== null && entity.castingIsChannel,
      inLineOfSight: hasLos,
      facingMe,
      iAmBehindThem,
      buffs: entityBuffs.filter(b => b.definition.type === 'buff'),
      debuffs: entityBuffs.filter(b => b.definition.type === 'debuff'),
    };

    if (npc.isHostileTo(entity)) {
      enemies.push(info);
    } else {
      allies.push(info);
    }
  }

  // Sort enemies by distance (closest first)
  enemies.sort((a, b) => a.distance - b.distance);
  allies.sort((a, b) => a.distance - b.distance);

  return { self, enemies, allies, hazards, arenaBounds };
}
