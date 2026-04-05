// Server collision — re-exports the shared CollisionSystem.
// Previously this file contained a duplicated implementation.
export {
  CollisionSystem,
  type BoxCollider,
  type CircleCollider,
  type Collider,
  type ResolveResult,
  type WaterZone,
} from '@gtr/shared';
