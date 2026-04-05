# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm install                  # Install all workspace dependencies
npm run dev                  # Start Vite client dev server (auto-opens browser)
npm run dev:server           # Start server with hot-reload (tsx watch)
npm run build                # Full build: shared → server → client
npm run preview              # Build then run dev:server
```

Individual packages can be built with `npm run build -w packages/shared` (or `-w packages/server`, `-w packages/client`, `-w packages/headless`).

The headless package has a test script: `npm run test -w packages/headless` (runs `npx tsx src/test.ts`).

There is no linter or test runner configured.

## Architecture

GTR Arena is a multiplayer 3D arena fighting game. TypeScript monorepo with 4 npm workspace packages:

```
packages/
  shared/   - Game logic, types, combat systems, ability/character/map definitions
  server/   - Node.js game server (WebSocket + WebRTC, SQLite via better-sqlite3)
  client/   - Browser client (Three.js 3D rendering, UI screens)
  headless/ - Renderless combat simulation for RL training (no Three.js)
```

**Dependency flow:** `server`, `client`, and `headless` all depend on `shared`. Path alias `@gtr/shared` maps to `packages/shared/src/`.

### Networking

- **WebSocket (TCP):** Auth, lobby, chat, game management — reliable messages
- **WebRTC DataChannels (UDP-like):** Player position updates, ability usage — tolerates packet loss
- **Serialization:** MessagePack binary encoding (`@msgpack/msgpack`), defined in `shared/src/codec.ts`
- **Protocol:** Message types prefixed `C2S_` (client→server) and `S2C_` (server→client) in `shared/src/protocol.ts`

### Server (`packages/server/src/`)

- `index.ts` — HTTP server, WebSocket/WebRTC setup
- `game/ServerEngine.ts` — Main game tick loop
- `game/GameSession.ts` — Per-match session management
- `game/ServerEntity.ts` — Server-side entity representation
- `game/ServerCombatSystem.ts` — Server-authoritative combat
- `game/ServerLagCompensation.ts` — Retroactive ability validation using client timestamps
- `game/ServerBroadcast.ts` — State snapshot broadcasting
- `auth/AuthManager.ts` — Login/register with bcrypt
- `db/Database.ts` — SQLite persistence (accounts, XP, leaderboards)
- `lobby/LobbyManager.ts` / `lobby/GameLobby.ts` — Lobby and pre-game state

### Client (`packages/client/src/`)

- `main.ts` — Entry point, state machine (auth → lobby → game)
- `MessageRouter.ts` — Incoming server message dispatcher
- `screens/` — Top-level UI states (AuthScreen, LobbyScreen, GameLobbyScreen, SinglePlayerScreen)
- `engine/Engine.ts` — Main render loop
- `engine/map/` — Map loading, per-map scripts (TheCageMap, CelestialBallroomMap, UISetupMap)
- `engine/player/PlayerController.ts` — Local player input/animation
- `engine/combat/` — Client-side combat prediction and rendering
- `engine/npc/` — Single-player NPC AI with behavior trees (`ai/NpcAiBrain.ts`, `ai/behaviors/`)
- `engine/physics/CollisionSystem.ts` — Collision detection
- `network/NetworkManager.ts` — WebSocket/WebRTC connection
- `network/ClientEngine.ts` — Client-side tick (prediction, interpolation)
- `ui/` — HUD components (chat, portraits, keybinds, audio, game over overlay)

### Shared (`packages/shared/src/`)

- `characters.ts` — 6 playable characters with base stats
- `abilities.ts` — All ability definitions, damage, cooldowns, buff/debuff effects
- `maps.ts` — Map definitions (geometry, spawn points, obstacle configs)
- `types.ts` — Entity interfaces, XP/leveling, snapshot types
- `protocol.ts` — Network message type definitions
- Combat systems: `CombatLogic.ts`, `BuffSystem.ts`, `CastingSystem.ts`, `AutoAttackSystem.ts`, `RegenSystem.ts`
- Subsystems in `systems/`: ChargeSystem, DotSystem, GasCloudSystem, ChemicalPoolSystem

### Headless (`packages/headless/src/`)

Renderless combat simulation for training neural network agents via reinforcement learning. No Three.js — uses plain `{x, y, z, rotY}` positions. Reuses all shared combat systems (`BuffSystem`, `RegenSystem`, `AutoAttackSystem`, `GasCloudSystem`, `DotSystem`, `ChemicalPoolSystem`, `ChargeSystem`, `FullRetardAuraSystem`).

- `HeadlessEntity.ts` — Implements `Positionable` with plain position fields, includes `CooldownTracker`
- `HeadlessCombat.ts` — Port of client `CombatSystem` using plain math (no THREE.Vector3)
- `HeadlessArena.ts` — Main simulation environment. Gym-style `reset()` / `step(actions)` API. Wires all shared systems, handles ability post-effects, computes observations and shaped rewards
- `test.ts` — Validation script: `npx tsx src/test.ts`

**Current V1 simplifications:** Flat arena (no obstacles, always LoS), 1v1 only, instant abilities only (no channels), no ground-targeted abilities. See `HEADLESS_PLAN.md` for the roadmap.

## Key Technical Details

- **Distance units:** 1 yard = 0.6 world units (WoW-style). 10 yards is close range.
- **Combat is server-authoritative** with client-side prediction. The server validates all ability casts and damage.
- **Dead reckoning:** Clients send movement flags + velocity, not final positions. Remote clients reconstruct direction from flags + rotation.
- **Diminishing returns on CC:** 4 tiers (100% → 50% → 25% → immune) with 20s reset timer.
- **XP formula:** `xpForLevel(n) = 100 × (n-1)^2.2`
- **TypeScript strict mode** across all packages, target ES2020.

## Deployment

Deployed to Fly.io (IAD region). Dockerfile does multi-stage build (Node 20 Alpine). SQLite DB persisted at `/data/gtr.db` via Fly volume. Server listens on port from `PORT` env var (default 3001).
