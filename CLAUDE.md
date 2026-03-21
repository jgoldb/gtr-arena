# GTR Arena — Development Guide

## Project Overview

A multiplayer arena combat game inspired by WoW arena (3D, Third-person, real-time combat). Built with Three.js + TypeScript + WebSocket.

### Monorepo Structure

```
packages/
  shared/     # Types, protocol, game data (abilities, characters, maps)
  client/     # Three.js client (Playground + Multiplayer modes)
  server/     # Node.js WebSocket server (authoritative game state)
```

### Running

- **Dev (playground only):** `npm run dev` — Vite dev server, no network
- **Dev (multiplayer):** `npm run dev:mp` — Starts both Vite + game server
- **Server only:** `npm run dev:server`

## Two Game Modes

### Playground (Single-Player)
- Entry: `packages/client/src/engine/Engine.ts`
- Full game loop in one class — physics, combat, AI, rendering
- Client-authoritative (player controls everything)
- Used for rapid development and testing

### Multiplayer (Client-Server)
- Server: `packages/server/src/game/ServerEngine.ts` — 20 Hz authoritative tick loop
- Client: `packages/client/src/network/ClientEngine.ts` — renders + interpolates
- Split authority: server owns combat/HP/buffs, client owns local movement
- Message wiring: `packages/client/src/main.ts`

## Development Workflow: Playground First

**IMPORTANT: Always implement new features in the Playground first, then adapt for multiplayer.**

The Playground is the fastest feedback loop — no network, no server, instant iteration. Once a feature works in single-player, convert it for the client-server architecture.

### Step 1: Implement in Playground (`Engine.ts`)

Build the feature end-to-end in `Engine.ts`. This includes:
- Game logic (damage, effects, timing, cooldowns)
- Visual effects (Three.js meshes, particles, animations)
- UI updates (action bar, unit frames, combat text)
- Input handling (targeting, ability activation)

Everything runs locally, so you can iterate quickly without network concerns.

### Step 2: Convert for Multiplayer

The conversion follows a consistent pattern. Here's what needs to happen for each aspect of a feature:

#### 2a. Define the Protocol (`packages/shared/src/protocol.ts`)

Identify what data the server needs to send to clients. Ask:
- Does the client need to know when this happens? → Add an event message (like `S2C_AbilityEffect`)
- Does this change entity state that clients render? → Include in `EntitySnapshot` or `EntityStateDelta`
- Does this create a world object clients need to see? → Add a spawn message (like `S2C_GasCloudSpawn`)

Add new message types to `protocol.ts` and include them in the `ServerMessage` union type.

#### 2b. Move Game Logic to the Server (`ServerEngine.ts`)

The server is the **authority** for all combat mechanics. Move the core logic from `Engine.ts` to `ServerEngine.ts`:

| Playground (Engine.ts) | Server (ServerEngine.ts) |
|---|---|
| `this.playerController` | `ServerEntity` |
| `this.combatSystem.useAbility(...)` | `this.combatSystem.useAbility(...)` (same pattern) |
| `this.buffSystem.apply(...)` | `this.buffSystem.apply(...)` |
| Direct HP/mana modification | Same, but on `ServerEntity` |
| `this.targetingSystem.currentTarget` | `this.targets.get(entityId)` |
| Timer-based effects (setInterval/dt) | Update in the server tick loop |

Key rules:
- **Damage, healing, cooldowns, buffs** — always server-authoritative
- **Position/movement** — client-authoritative (server trusts client position)
- **Area effects** (gas clouds, pools) — server tracks logic, client renders visuals
- Use `this.pendingEvents.push(...)` to queue messages for broadcast
- Use `this.onSendToPlayer?.(entityId, msg)` for player-specific messages
- Use `this.onBroadcast?.(msg)` for messages that go to all players

#### 2c. Handle Server Messages on the Client (`ClientEngine.ts`)

Add handler methods on `ClientEngine` for each new message type:

```typescript
// Pattern: handleXxx(msg: S2C_Xxx): void
handleMyNewEffect(msg: S2C_MyNewEffect): void {
  if (msg.entityId === this.localEntityId) {
    // Drive local player visuals (animations, effects)
    this.playerController.triggerSomeAnimation(...);
  } else {
    // Drive remote entity visuals
    const entity = this.remoteEntities.get(msg.entityId);
    if (entity) entity.model.triggerSomeAnimation(...);
  }
}
```

For state that changes over time (casting progress, buff timers):
- The server sends updates via `EntityStateDelta` (only changed fields, every tick)
- Or via `EntitySnapshot` in keyframe messages (full state, every 5 seconds)
- The client applies these to its local entity state

#### 2d. Wire the Handler in `main.ts`

Add a case to the message handler switch in `main.ts`:

```typescript
case 'my_new_effect':
  clientEngine?.handleMyNewEffect(msg);
  break;
```

#### 2e. Visual Effects — Client Only

Visual effects (particles, beams, auras) live only on the client. The server tells the client WHAT happened; the client decides HOW it looks.

- Reuse the same visual effect code from `Engine.ts` in `ClientEngine.ts`
- Import shared helpers from `packages/client/src/engine/effects/VisualEffects.ts`
- The `CharacterModel` class is used in both modes — animation methods work the same way

### Step 3: Update Shared Types

If the feature adds new entity state:
1. Add fields to `EntitySnapshot` in `packages/shared/src/types.ts`
2. Add fields to `EntityStateDelta` in `packages/shared/src/protocol.ts`
3. Update `ServerEntity.toSnapshot()` to include the new fields
4. Update `ClientEngine.applyEntityStateDeltas()` to handle the new fields
5. Update `ClientEngine.applyRemoteEntityState()` for keyframe handling

If the feature adds new abilities/buffs:
1. Define in `packages/shared/src/abilities.ts`
2. Add to character ability lists in `packages/shared/src/characters.ts`

## Architecture Reference

### Network Protocol (WoW-style Delta Compression)

The server uses a split update strategy to minimize bandwidth:

- **`game_state_update`** (every tick, 20 Hz): Always includes entity positions. Only includes combat state (`EntityStateDelta`) and buff data for entities that changed since the last broadcast.
- **`game_state_snapshot`** (every 100 ticks / 5 sec): Full keyframe with all entity state, buffs, and world effects. Clients use this to resync.
- **Event messages** (`ability_effect`, `combat_event`, `auto_attack_swing`, etc.): Discrete one-shot events broadcast when they happen.

### Client Interpolation (Snapshot Buffer)

Remote entity positions are rendered using **snapshot interpolation**, not direct lerp:
- `SnapshotBuffer` stores timestamped position snapshots from the server
- The client renders ~100ms behind real-time
- Positions are linearly interpolated between two known server states
- This gives perfectly smooth movement between 20 Hz server updates

The local player uses client-authoritative movement (same `PlayerController` as Playground) — no interpolation delay for your own character.

### Entity Lookup

- Server: `ServerEntity` found via `this.getEntity(entityId)` or iterate `this.entities`
- Client local player: `this.playerController` (same class as Playground)
- Client remote: `this.remoteEntities.get(entityId)` → `RemoteEntity`
- Both: `this.getEntityMesh(entityId)` for Three.js mesh access

### Server Delta Tracking

The server tracks the last-broadcast state per entity (`lastBroadcastState` map). On each tick:
1. Positions are always sent (they change every frame for moving players)
2. State fields (HP, mana, casting, etc.) are compared to last broadcast — only changed fields are included in `EntityStateDelta`
3. Buffs are JSON-compared — only entities with changed buff lists are included
4. Full keyframe every 100 ticks resets tracking

### Distance Units

1 yard = 0.6 world units. Use `yardsToUnits()` from shared package. Melee range ~5 yards, most abilities 10-20 yards.

## Common Patterns

### Adding a New Ability

1. Define ability data in `shared/src/abilities.ts`
2. Add to character's ability list in `shared/src/characters.ts`
3. **Playground:** Add activation logic in `Engine.ts` (damage, effects, cooldown)
4. **Playground:** Add animation in `CharacterModel.ts` / character subclass
5. **Server:** Move activation logic to `ServerEngine.requestAbility()` or `ServerCombatSystem`
6. **Server:** Queue `ability_effect` event in `onAbilitySuccess()`
7. **Client:** Handle animation trigger in `ClientEngine.handleAbilityEffect()`

### Adding a New Buff/Debuff

1. Define `BuffDefinition` in `shared/src/abilities.ts`
2. **Playground:** Apply via `this.buffSystem.apply(target, buffDef)`
3. **Server:** Apply via `this.buffSystem.apply(entity, buffDef)` — server tracks duration/effects
4. **Client:** Buff state arrives via `EntityBuffSnapshot` in delta/keyframe updates
5. **Client:** Drive visuals with `entity.model.setAbilityBuffActive(buffId, active)`

### Adding a New Area Effect

1. Define spawn message in `shared/src/protocol.ts`
2. **Playground:** Full logic in `Engine.ts` (spawn, tick damage, cleanup)
3. **Server:** Logic in `ServerEngine` (spawn, tick, damage calc, broadcast spawn message)
4. **Client:** Visual-only in `ClientEngine` (create mesh on spawn, animate, cleanup)
5. Share visual helpers via `engine/effects/VisualEffects.ts`
