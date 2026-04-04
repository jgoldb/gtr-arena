import { BuffSystem as BaseBuffSystem } from '@gtr/shared';
import type { Targetable } from '../types';

export type { ActiveBuff, BuffEffect, BuffDefinition } from '@gtr/shared';

export class BuffSystem extends BaseBuffSystem<Targetable> {}
