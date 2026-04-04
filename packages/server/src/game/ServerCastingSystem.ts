import { CastingSystem } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';

export type { CastingState, CastingCallbacks } from '@gtr/shared';

export class ServerCastingSystem extends CastingSystem<ServerEntity> {}
