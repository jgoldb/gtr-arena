import { AutoAttackSystem as BaseAutoAttackSystem } from '@gtr/shared';
import type { Targetable } from '../types';

export type { AutoAttackCallbacks, AutoAttackState, PendingProjectile } from '@gtr/shared';

export class AutoAttackSystem extends BaseAutoAttackSystem<Targetable> {}
