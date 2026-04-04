import { CastingSystem as BaseCastingSystem } from '@gtr/shared';
import type { Targetable } from '../types';

export type { CastingState, CastingCallbacks } from '@gtr/shared';

export class CastingSystem extends BaseCastingSystem<Targetable> {}
