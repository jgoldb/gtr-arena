import * as THREE from 'three';
import type { S2C_Knockback } from '@gtr/shared';
import { Sweep, TweakerSprint, yardsToUnits } from '@gtr/shared';
import type { PlayerController } from '../engine/player/PlayerController';

// ── Host interface ────────────────────────────────────────────────────

export interface ChargeSystemHost {
  readonly localEntityId: string;
  readonly playerController: PlayerController;
  getSelectedTargetId(): string | null;
  getEntityMesh(entityId: string): THREE.Group | undefined;
  sendStopAutoAttack(): void;
  sendAutoAttack(targetEntityId: string): void;
}

// ── ClientChargeSystem ────────────────────────────────────────────────

export class ClientChargeSystem {
  private readonly host: ChargeSystemHost;

  // Sweep charge (local player only — client-side movement during charge)
  private sweepCharge: {
    elapsed: number; duration: number; direction: THREE.Vector3;
    speed: number; savedAutoAttackTargetId: string | null;
  } | null = null;

  // Tweaker Sprint charge (local player only — dash to target)
  private tweakerSprintCharge: {
    elapsed: number; duration: number; direction: THREE.Vector3;
    speed: number; savedAutoAttackTargetId: string | null;
  } | null = null;

  // Active knockbacks (visual displacement on client)
  private activeKnockbacks: {
    entityId: string; dirX: number; dirZ: number;
    distance: number; duration: number; elapsed: number; startY: number;
  }[] = [];

  constructor(host: ChargeSystemHost) {
    this.host = host;
  }

  // ── Sweep charge ────────────────────────────────────────────────────

  startSweepCharge(): void {
    const pc = this.host.playerController;
    const rotY = pc.mesh.rotation.y;
    pc.charging = true;
    const savedAutoAttackTargetId = this.host.getSelectedTargetId();
    this.host.sendStopAutoAttack();
    this.sweepCharge = {
      elapsed: 0,
      duration: Sweep.chargeDuration!,
      direction: new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)),
      speed: Sweep.chargeSpeed!,
      savedAutoAttackTargetId,
    };
  }

  private updateSweepCharge(dt: number): void {
    if (!this.sweepCharge) return;
    const pc = this.host.playerController;
    this.sweepCharge.elapsed += dt;
    // Move player forward (client-authoritative movement)
    pc.mesh.position.addScaledVector(this.sweepCharge.direction, this.sweepCharge.speed * dt);
    if (this.sweepCharge.elapsed >= this.sweepCharge.duration) {
      // Trigger sweep finish spin animation + wind burst
      pc.triggerAbilityAnimation('sweep-finish');

      // Re-engage auto-attack if we were auto-attacking before sweep
      const targetId = this.sweepCharge.savedAutoAttackTargetId;
      if (targetId) {
        this.host.sendAutoAttack(targetId);
      }

      pc.charging = false;
      this.sweepCharge = null;
    }
  }

  // ── Tweaker Sprint charge ───────────────────────────────────────────

  startTweakerSprintCharge(): void {
    const pc = this.host.playerController;
    // Dash toward the selected target
    const targetId = this.host.getSelectedTargetId();
    const targetMesh = targetId ? this.host.getEntityMesh(targetId) : null;
    if (!targetMesh) return;

    const dx = targetMesh.position.x - pc.mesh.position.x;
    const dz = targetMesh.position.z - pc.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const direction = new THREE.Vector3(dx / dist, 0, dz / dist);
    // Face the target
    pc.mesh.rotation.y = Math.atan2(direction.x, direction.z);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1)); // stop 1 yard short
    const duration = chargeDist / speed;

    const savedAutoAttackTargetId = this.host.getSelectedTargetId();
    this.host.sendStopAutoAttack();
    pc.charging = true;
    pc.chargeAnimSpeed = 3; // fast frantic run
    this.tweakerSprintCharge = {
      elapsed: 0,
      duration,
      direction,
      speed,
      savedAutoAttackTargetId,
    };
  }

  private updateTweakerSprintCharge(dt: number): void {
    if (!this.tweakerSprintCharge) return;
    const pc = this.host.playerController;
    this.tweakerSprintCharge.elapsed += dt;
    pc.mesh.position.addScaledVector(this.tweakerSprintCharge.direction, this.tweakerSprintCharge.speed * dt);
    if (this.tweakerSprintCharge.elapsed >= this.tweakerSprintCharge.duration) {
      const targetId = this.tweakerSprintCharge.savedAutoAttackTargetId;
      if (targetId) {
        this.host.sendAutoAttack(targetId);
      }

      pc.charging = false;
      pc.chargeAnimSpeed = 1;
      this.tweakerSprintCharge = null;
    }
  }

  // ── Knockbacks ──────────────────────────────────────────────────────

  handleKnockback(msg: S2C_Knockback): void {
    // Capture the entity's current Y so the arc is relative to their actual height
    const mesh = this.host.getEntityMesh(msg.entityId);
    const startY = mesh?.position.y ?? 0;
    this.activeKnockbacks.push({
      entityId: msg.entityId,
      dirX: msg.dirX,
      dirZ: msg.dirZ,
      distance: msg.distance,
      duration: msg.duration,
      elapsed: 0,
      startY,
    });
  }

  private updateKnockbacks(dt: number): void {
    const pc = this.host.playerController;
    for (let i = this.activeKnockbacks.length - 1; i >= 0; i--) {
      const kb = this.activeKnockbacks[i];
      kb.elapsed += dt;
      const t = Math.min(1, kb.elapsed / kb.duration);

      const speed = kb.distance / kb.duration;
      const height = 3.0 * 4 * t * (1 - t); // parabolic arc (relative offset)

      const mesh = this.host.getEntityMesh(kb.entityId);
      if (mesh) {
        mesh.position.x += kb.dirX * speed * dt;
        mesh.position.z += kb.dirZ * speed * dt;
        mesh.position.y = kb.startY + height;
      }

      if (t >= 1) {
        if (kb.entityId === this.host.localEntityId) {
          // Return to starting height — PlayerController physics will handle
          // the fall if knocked off a ledge (gravity, grounded detection, etc.)
          pc.mesh.position.y = kb.startY;
          pc.grounded = false;
          pc.velocityY = 0;
          (pc as any).fallPeakY = kb.startY;
        } else if (mesh) {
          mesh.position.y = kb.startY;
        }
        this.activeKnockbacks.splice(i, 1);
      }
    }
  }

  // ── Per-frame update ────────────────────────────────────────────────

  update(dt: number): void {
    this.updateSweepCharge(dt);
    this.updateTweakerSprintCharge(dt);
    this.updateKnockbacks(dt);
  }

  // ── Fast-forward (tab restore) ──────────────────────────────────────

  /** Clear any active charges — if we were mid-charge when backgrounded, it's certainly finished. */
  fastForward(): void {
    const pc = this.host.playerController;
    if (this.sweepCharge) {
      this.sweepCharge = null;
      pc.charging = false;
    }
    if (this.tweakerSprintCharge) {
      this.tweakerSprintCharge = null;
      pc.charging = false;
      pc.chargeAnimSpeed = 1;
    }
  }
}
