# Headless Arena — Neural Network Training Plan

## Goal

Train a neural network via self-play reinforcement learning to play GTR Arena, then integrate the trained model into the client NPC system as a new `CharacterBehavior` implementation.

## Current State (completed)

### Headless Engine (`packages/headless/`)
- `HeadlessEntity` — implements `Positionable` with plain `x/y/z/rotY` (no Three.js)
- `HeadlessCombat` — full port of client CombatSystem using plain math
- `HeadlessArena` — gym-style `reset()`/`step()` simulation environment
  - Wires all shared systems: BuffSystem, RegenSystem, AutoAttackSystem, GasCloudSystem, DotSystem, ChemicalPoolSystem, ChargeSystem, FullRetardAuraSystem, **CastingSystem**
  - Handles all ability post-effects (charges, gas clouds, DOTs, tweaking stacks, buff steal, etc.)
  - Builds normalized observation vectors (**57 floats** per agent)
  - Computes shaped rewards (damage dealt/taken/healed + terminal win/loss)
  - Performance: ~175-200k steps/sec single-threaded (with collision + raycasts)

### Phase 2a — Channeled/cast-time abilities (completed)
- Integrated shared `CastingSystem<HeadlessEntity>` with full callback wiring
- Cast-time abilities (Discombobulate, Full Retard, Crotch Rot, Janitor's Helper) route through the casting system — cast completes after `castTime` seconds, then the ability effect fires
- Channeled abilities (Bandage, Chudmax) consume mana at channel start, deliver tick damage/healing at intervals
- Movement cancels casts (via `shouldCancel`); stun/sleep also cancel
- Direct damage applies cast pushback (extends cast time / shortens channel duration)
- `AgentAction` extended with `cancelCast` for explicit cast cancellation
- Observation vector extended with `isCasting`, `castPct`, `isChanneling`

### Phase 2b — Ground-targeted abilities (completed)
- Bottle Chuck uses `groundX`/`groundZ` in `AgentAction` for AoE placement
- Pending AoE impact system with 0.825s delay (matching server/client)
- On impact, applies AoE damage + debuff to all hostiles within radius

### Phase 2e — Map geometry, obstacles, and line-of-sight (completed)
- Extracted `CollisionSystem` into `packages/shared/src/CollisionSystem.ts` — single implementation used by client, server, and headless
- Client extends shared `CollisionSystem` with navigation/elevation/platform features
- Server re-exports shared `CollisionSystem` (removed duplicated ~320-line implementation)
- `ArenaConfig` accepts `mapId` (default `'cage'`), loads real map obstacles
- Collision `resolve()` replaces flat `clampX`/`clampZ` boundary — entities pushed out of walls, ground Y tracked
- Real 3D-aware `hasLineOfSight()` raycasting replaces `() => true` stub
- LoS checks added to ability validation in `HeadlessCombat.validateAbility()`
- Auto-attack system uses real LoS between entities
- Charge/knockback movement uses collision resolution
- Spawn points derived from `npcSpawnBounds` (map `spawnPoints` are pre-match pens)
- Position normalization uses map bounds (`normScale`) instead of hardcoded arena size
- Performance: ~450-560k steps/sec (minimal overhead from collision checks on cage map)

### Phase 2c — Richer observation vector (completed)
- Observation vector expanded from **32 floats** to **57 floats** per agent
- Self CC states split: `isStunned` (pure stun), `isSleeping`, `isBlinded`, `isDiscombobulated`, `isUntargetable`
- Buff multipliers exposed: `speedMult`, `dmgDealtMult`, `dmgTakenMult` (and opponent equivalents)
- Opponent casting detail: `oppCastPct` (progress), `oppIsChanneling`, `oppIsMoving`
- Spatial awareness: `oppLoS` (binary LoS check), `wallDist` (8-direction raycasts normalized to 0–1)
- Elevation: self `y` position normalized
- `raycastDistance()` method added to shared `CollisionSystem` for wall distance probes
- Performance: ~175-200k steps/sec (down from ~450k due to raycasts, still fast for training)

### Phase 3a — Training pipeline bridge (completed)
- `packages/headless/src/bridge.ts` — stdin/stdout JSON-lines bridge for Python RL training
- Manages N parallel arenas in a single Node.js process (vectorized environment)
- Protocol: `init` → `step` → `reset` → `close` commands via JSON lines
- Action encoding: `[ability (0=none, 1-11=slot), moveDir (0=stop, 1-8=compass), cancelCast (0/1)]` per agent
- Done arenas auto-reset; terminal observations stored in `infos` for value estimation
- Ground-targeted abilities default to opponent position
- Performance: ~17k env-steps/sec through IPC (2 envs), ~8.5k steps/sec per env
- Integration test: `bridge_test.ts` validates init/step/reset/close and observation shapes

### Phase 3b — Python training harness (completed)
- `packages/headless/train/env.py` — SB3-compatible `VecEnv` wrapping the bridge subprocess
  - Spawns bridge process, handles JSON-lines IPC
  - Agent 0 controlled by RL policy, Agent 1 by configurable opponent (random/saved policy)
  - `RandomOpponent`, `DoNothingOpponent`, `PolicyOpponent` implementations
  - Proper `terminal_observation` handling for value bootstrapping
- `packages/headless/train/train.py` — PPO training script
  - stable-baselines3 PPO with 2×256 MLP, `MultiDiscrete` action space
  - Win rate tracking via custom callback + TensorBoard logging
  - Checkpoint saving, resume support, configurable hyperparameters
  - CLI: `python train.py --timesteps 1000000 --num-envs 16`
- `packages/headless/train/requirements.txt` — Python dependencies

### Phase 4 — Model Export & Client Integration (completed)
- `packages/headless/train/export_onnx.py` — ONNX export script (SB3 → ONNX, 339 KB)
- `packages/client/src/engine/npc/ai/behaviors/NeuralBehavior.ts` — ONNX inference behavior
- `onnxruntime-web` for browser WASM inference (<1ms per forward pass)
- Model at `packages/client/public/models/agent.onnx`
- "Neural" difficulty option in SinglePlayerScreen UI

### First training run results (1M steps, janitor vs random, 16 envs)
- Win rate: 31% → 64% (upward trend, not plateaued — longer training will improve)
- Episode time: 75s → 48s (agent learns to finish fights faster)
- Explained variance: 0.32 → 0.74 (value function learning well)
- ~1,500 total episodes, ~7k steps/sec throughput
- **Issue:** Agent only auto-attacks, never uses abilities → reward shaping tuned in Phase 3c

### Phase 3c — Reward shaping tuning (completed)
- Added ability usage bonus (+0.004), failed attempt penalty (-0.001), CC bonus (+0.008), step penalty (-0.0003)
- Tracks `abilityUsedCount`, `abilityFailedCount`, `ccAppliedCount` per step

### Phase 3d — Self-play opponent pool (completed)
- `PoolOpponent` class samples from saved policy snapshots
- `SelfPlayCallback` activates after 300K steps, snapshots every 100K steps
- Linear LR annealing, batch size 512, default 5M timesteps

### Remaining Simplifications
- 1v1 only (multi-agent deferred to a future iteration)

---

## Phase 2: Simulation Improvements ✓

### 2a. Channeled abilities ✓
Integrated shared `CastingSystem<HeadlessEntity>` into the arena. Cast-time abilities validate then enter the casting system; channels consume resources at start and tick damage/healing at intervals. Movement/stun/sleep cancel casts. Direct damage applies pushback. `cancelCast` action added for explicit cancellation.

### 2b. Ground-targeted abilities ✓
Added `groundX`/`groundZ` to `AgentAction`. Bottle Chuck validates range + resources, then schedules a `PendingAoeImpact` with 0.825s delay. On impact, AoE damage + debuff applied to all hostiles in radius via `HeadlessCombat.applyAoeDamage()`.

### 2c. Richer observation vector ✓
Observation vector expanded from 32 to 57 floats. Added per-entity CC state breakdown (stun/sleep/blind/discombobulate/untargetable), buff multipliers (speed/damage dealt/damage taken), opponent casting progress + channel status + movement, spatial awareness (LoS binary + 8-direction wall distances via `CollisionSystem.raycastDistance()`), and elevation.

### 2d. Multi-agent (2v2, 3v3) — *deferred to future iteration*
- Extend `HeadlessArena` to support N entities per team
- Observation vector grows: need ally info + multiple enemy info
- Action space adds target selection (which enemy to attack)
- Training harness will focus on 1v1 initially

### 2e. Map geometry, obstacles, and line-of-sight ✓
Extracted `CollisionSystem` into `packages/shared/src/CollisionSystem.ts` — single implementation shared by client, server, and headless. Client extends it with navigation/elevation features. Server re-exports it (removed ~320 lines of duplicated code). Arena loads real map obstacles, uses `resolve()` for collision, real 3D `hasLineOfSight()` raycasting, and LoS checks in ability validation.

---

## Phase 3: Training Pipeline ✓

### 3a. Subprocess bridge ✓ (Option A chosen)
Built `packages/headless/src/bridge.ts` — stdin/stdout JSON-lines bridge. Game logic stays in TypeScript, Python only does RL. Manages N parallel arenas in a single process for vectorized env efficiency. Actions encoded as `MultiDiscrete([12, 9, 2])` per agent. Auto-resets done arenas with terminal observation preservation.

### 3b. RL algorithm setup ✓
- **Algorithm:** PPO (Proximal Policy Optimization) via stable-baselines3
- **Env wrapper:** `packages/headless/train/env.py` — custom `VecEnv` subclass spawning bridge subprocess
- **Network:** 2×256 MLP (separate pi/vf branches), `MultiDiscrete` action space
  - Ability: 12 choices (0=none, 1-11=ability slots)
  - Movement: 9 choices (0=stop, 1-8=compass directions)
  - Cancel cast: 2 choices (0/1)
- **Opponent:** pluggable — `RandomOpponent` (default), `DoNothingOpponent`, `PolicyOpponent` (from saved checkpoint)
- **Training script:** `packages/headless/train/train.py` with CLI args, TensorBoard logging, checkpoint saving

### 3c. Reward shaping ✓
Tuned based on first training run (agent only auto-attacked, never used abilities).

Reward signals per step:
```
+0.00005 per damage dealt
-0.00003 per damage taken
+0.00003 per healing done
+0.004   per successful ability use (non-auto-attack)
-0.001   per failed ability attempt (cooldown, range, mana, casting)
+0.008   per CC application (stun/sleep/blind debuff)
-0.0003  step penalty (encourages aggression, discourages stalling)
+1.0 win, -1.0 loss, -0.2 draw (terminal)
```

Tracking: `abilityUsedCount`, `abilityFailedCount`, `ccAppliedCount` accumulators in `HeadlessArena`, reset per step. `useGroundTargetAbility` returns boolean for success tracking. `isDebuffCC()` helper checks debuff effects for stun/sleep/blind types.

### 3d. Self-play training loop ✓
Implemented via `SelfPlayCallback` in `train.py` and `PoolOpponent` in `env.py`.

- Training starts against `RandomOpponent` (curriculum: learn basics first)
- After `--self-play-start` steps (default 300K), activates self-play
- Every `--self-play-freq` steps (default 100K), snapshots current policy to opponent pool
- `PoolOpponent` randomly samples from saved checkpoints, with `--self-play-random-prob` (default 20%) chance of random fallback for diversity
- Pool capped at `--self-play-pool-size` (default 20), oldest evicted first
- Learning rate linearly anneals from `--lr` to 0 over training

Key hyperparameters:
- n_steps: 2048 per env per rollout (32K total with 16 envs)
- batch_size: 512
- Learning rate: 3e-4 → 0 (linear anneal)
- Clip range: 0.2
- Entropy coefficient: 0.01
- Opponent pool size: 20

### 3e. Curriculum learning (built into 3d)
The self-play start delay acts as automatic curriculum:
1. Steps 0–300K: train against random (learn ability usage, damage dealing)
2. Steps 300K+: self-play with opponent pool (learn tactical play against competent opponents)
3. 20% random opponent probability maintained throughout for diversity

---

## Phase 4: Model Export & Client Integration ✓

### 4a. Export trained model ✓
- `packages/headless/train/export_onnx.py` — exports SB3 PPO policy to ONNX via `torch.onnx.export()`
- Extracts only the policy MLP (no value network), outputs raw logits for `MultiDiscrete` action space
- Validates export by comparing ONNX runtime output against SB3 predictions
- Model size: ~339 KB ONNX (vs ~2MB SB3 zip)
- Placed at `packages/client/public/models/agent.onnx`

### 4b. NeuralBehavior class ✓
- `packages/client/src/engine/npc/ai/behaviors/NeuralBehavior.ts`
- Implements `CharacterBehavior` interface (scoreActions, getMovementIntent, getDesiredRange)
- Loads ONNX model via `onnxruntime-web` (WASM backend, <1ms inference for 2×256 MLP)
- Async inference: fires off ONNX run each think cycle, uses previous result (1-tick delay, imperceptible at 100ms)
- `buildObservation()` replicates `HeadlessArena.buildObservation()` + `flattenObservation()` exactly — same 57-float vector in identical order
- Splits output logits by `MultiDiscrete` sub-space sizes and argmaxes each → [ability, moveDir, cancelCast]
- Maps ability index to `ScoredAction` with proper `isCastTime` flag
- Maps moveDir to world-space `MovementIntent` using bridge.ts compass angles

### 4c. Wire into NPC system ✓
- Added `'neural'` to `DifficultyLevel` type and `DIFFICULTY_PRESETS` (master-like profile: 100ms think, no fuzz)
- `PlaygroundNpcSystem.spawnAiNpc()` creates `NeuralBehavior` when difficulty is `'neural'`
- `NeuralBehavior` constructor takes `NpcController` + `AiEngineInterface` for direct access to BuffSystem, CollisionSystem, arena bounds
- Model loads asynchronously; NPC falls back to auto-attack until loaded
- `SinglePlayerScreen` shows "Neural" as a difficulty option with cyan color
- Dependency: `onnxruntime-web` added to client package (WASM loaded lazily, only when Neural is selected)

### 4d. Observation encoding bridge ✓
- `NeuralBehavior.buildObservation()` replicates HeadlessArena encoding directly using client-side systems:
  - BuffSystem methods: isStunned, isSleeping, isBlinded, isDiscombobulated, isUntargetable, speed/damage multipliers
  - CollisionSystem: raycastDistance (8-dir wall probes), hasLineOfSight
  - NpcCooldownTracker: getCooldownRemaining/getCooldownTotal → normalized cooldown vector
  - Arena bounds → normScale for position normalization
- Same flatten order as `HeadlessArena.flattenObservation()` — verified by matching obs vector length (57)

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Headless sim diverges from real game | Both use `@gtr/shared` systems. HeadlessCombat is a port of client CombatSystem — keep in sync. Phase 2e unifies CollisionSystem into shared. |
| Model doesn't understand LoS/terrain | Phase 2e adds real map geometry, obstacle collision, and LoS raycasting before training at scale. Without this, trained bots are trivially exploitable. |
| Reward shaping produces degenerate behavior | Start simple, add shaping incrementally, evaluate against baselines. |
| Sim too slow for training | Already ~600k steps/sec. Can parallelize with worker threads if needed. |
| Observation encoding mismatch (train vs deploy) | Extract encoding into shared module, add assertion tests. |
| Model doesn't generalize to full game (obstacles, channels) | Phases 2a–2e add these before training at scale. Train on simplified game first to validate pipeline. |
| New abilities / balance changes invalidate trained model | Retrain is cheap (~hours). Keep training pipeline automated. |

---

## Immediate Next Steps

1. ~~**Phase 2a** — Add channeled/cast-time abilities to the headless sim~~ ✓
2. ~~**Phase 2b** — Add ground-targeted abilities (Bottle Chuck)~~ ✓
3. ~~**Phase 2e** — Move CollisionSystem to shared, wire map geometry + LoS into arena~~ ✓
4. ~~**Phase 2c** — Enrich observation vector (buffs, casting state, LoS, wall distances)~~ ✓
5. ~~**Phase 3a** — Build subprocess bridge (`bridge.ts`)~~ ✓
6. ~~**Phase 3b** — Build Python training harness (env.py + train.py)~~ ✓
7. ~~**First training run** — 1M steps, janitor vs random~~ ✓
8. ~~**Phase 4a** — Export trained model to ONNX~~ ✓
9. ~~**Phase 4b** — Build `NeuralBehavior` class in client~~ ✓
10. ~~**Phase 3c** — Tune reward shaping based on initial training results~~ ✓
11. ~~**Phase 3d** — Self-play with opponent pool (save checkpoints → load as opponents)~~ ✓
12. **Longer training** — 5-10M+ steps with refined rewards and self-play
    - `python train.py --timesteps 5000000` (default settings include self-play + LR annealing)
    - Re-export ONNX after training: `python export_onnx.py --model models/ppo_gtr_final`
