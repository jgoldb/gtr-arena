import { GLOBAL_COOLDOWN } from '@gtr/shared';

export class NpcCooldownTracker {
  private cooldowns = new Map<string, { remaining: number; total: number }>();
  private gcdRemaining = 0;
  private gcdTotal = 0;

  isReady(abilityId: string): boolean {
    return this.getCooldownRemaining(abilityId) <= 0 && this.gcdRemaining <= 0;
  }

  isOnGcd(): boolean {
    return this.gcdRemaining > 0;
  }

  getCooldownRemaining(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.remaining ?? 0;
  }

  getCooldownTotal(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.total ?? 0;
  }

  getGcdRemaining(): number {
    return this.gcdRemaining;
  }

  setCooldown(abilityId: string, duration: number): void {
    if (duration > 0) {
      this.cooldowns.set(abilityId, { remaining: duration, total: duration });
    }
  }

  clearCooldown(abilityId: string): void {
    this.cooldowns.delete(abilityId);
  }

  triggerGcd(): void {
    this.gcdRemaining = GLOBAL_COOLDOWN;
    this.gcdTotal = GLOBAL_COOLDOWN;
  }

  update(dt: number): void {
    if (this.gcdRemaining > 0) {
      this.gcdRemaining = Math.max(0, this.gcdRemaining - dt);
    }

    for (const [id, cd] of this.cooldowns) {
      cd.remaining -= dt;
      if (cd.remaining <= 0) {
        this.cooldowns.delete(id);
      }
    }
  }
}
