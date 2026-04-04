import type { ServerEntity } from './ServerEntity.js';

export class ServerLagCompensation {
  private positionHistory: Array<{
    serverTimestamp: number;
    positions: Map<string, { x: number; z: number; rotationY: number }>;
  }> = [];

  private static readonly MAX_REWIND_MS = 400;
  private readonly maxHistoryTicks: number;

  constructor(tickMs: number) {
    // ~14 ticks at 30Hz (400ms / 33ms = 12, +2 margin)
    this.maxHistoryTicks = Math.ceil(400 / tickMs) + 2;
  }

  /** Record all entity positions for this tick (called once per broadcast). */
  recordPositionHistory(serverTimestamp: number, entities: readonly ServerEntity[]): void {
    const positions = new Map<string, { x: number; z: number; rotationY: number }>();
    for (const e of entities) {
      positions.set(e.id, { x: e.x, z: e.z, rotationY: e.rotationY });
    }
    this.positionHistory.push({ serverTimestamp, positions });
    while (this.positionHistory.length > this.maxHistoryTicks) {
      this.positionHistory.shift();
    }
  }

  /**
   * Get the rewound position for an entity at a past server timestamp.
   * Returns null if the timestamp is too old, in the future, or the entity
   * has no history — caller should fall back to current positions.
   */
  getRewindPosition(entityId: string, clientServerTimestamp: number): { x: number; z: number; rotationY: number } | null {
    if (this.positionHistory.length === 0) return null;

    const now = Date.now();
    const rewindAmount = now - clientServerTimestamp;

    // Reject timestamps in the future or too far in the past
    if (rewindAmount < 0 || rewindAmount > ServerLagCompensation.MAX_REWIND_MS) return null;

    // Find the two history entries bracketing the requested timestamp
    for (let i = 0; i < this.positionHistory.length - 1; i++) {
      const before = this.positionHistory[i];
      const after = this.positionHistory[i + 1];
      if (before.serverTimestamp <= clientServerTimestamp && after.serverTimestamp > clientServerTimestamp) {
        const beforePos = before.positions.get(entityId);
        const afterPos = after.positions.get(entityId);
        if (!beforePos && !afterPos) return null;
        if (!beforePos) return afterPos ? { ...afterPos } : null;
        if (!afterPos) return { ...beforePos };

        const totalTime = after.serverTimestamp - before.serverTimestamp;
        const elapsed = clientServerTimestamp - before.serverTimestamp;
        const t = totalTime > 0 ? Math.max(0, Math.min(1, elapsed / totalTime)) : 1;
        return {
          x: beforePos.x + (afterPos.x - beforePos.x) * t,
          z: beforePos.z + (afterPos.z - beforePos.z) * t,
          rotationY: beforePos.rotationY + (afterPos.rotationY - beforePos.rotationY) * t,
        };
      }
    }

    // Timestamp is at or after our latest entry — use latest
    const last = this.positionHistory[this.positionHistory.length - 1];
    if (last.serverTimestamp <= clientServerTimestamp) {
      const pos = last.positions.get(entityId);
      return pos ? { ...pos } : null;
    }

    // Timestamp is before all history entries — too old
    return null;
  }

  clear(): void {
    this.positionHistory.length = 0;
  }
}
