import { BuffSystem } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';

export type { ActiveBuff } from '@gtr/shared';

export class ServerBuffSystem extends BuffSystem<ServerEntity> {}
