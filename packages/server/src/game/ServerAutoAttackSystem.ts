import { AutoAttackSystem } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';

export type { AutoAttackCallbacks, AutoAttackState, PendingProjectile } from '@gtr/shared';

export class ServerAutoAttackSystem extends AutoAttackSystem<ServerEntity> {}
