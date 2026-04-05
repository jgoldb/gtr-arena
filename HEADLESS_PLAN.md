# Headless Arena — Neural Network Training Plan

## Goal

Train a neural network via self-play reinforcement learning to play GTR Arena, then integrate the trained model into the client NPC system as a new `CharacterBehavior` implementation.

## Current State (completed)

### Headless Engine (`packages/headless/`)
- `HeadlessEntity` — implements `Positionable` with plain `x/y/z/rotY` (no Three.js)
- `HeadlessCombat` — full port of client CombatSystem using plain math
- `HeadlessArena` — gym-style `reset()`/`step()` simulation environment
  - Wires all shared systems: BuffSystem, RegenSystem, AutoAttackSystem, GasCloudSystem, DotSystem, ChemicalPoolSystem, ChargeSystem, FullRetardAuraSystem
  - Handles all ability post-effects (charges, gas clouds, DOTs, tweaking stacks, buff steal, etc.)
  - Builds normalized observation vectors (29 floats per agent)
  - Computes shaped rewards (damage dealt/taken/healed + terminal win/loss)
  - Performance: ~600k steps/sec, ~800 matches/sec single-threaded

### V1 Simplifications
- Flat arena, no obstacles, always line-of-sight
- 1v1 only
- Instant abilities only (no channeled casts like bandage/chudmax)
- No ground-targeted abilities (bottle chuck)

---

## Phase 2: Simulation Improvements

### 2a. Channeled abilities
Add casting/channeling state machine to `HeadlessArena.step()`:
- Track `castingState` per entity (ability, elapsed, totalTime, isChannel, ticksDelivered)
- While casting: movement cancels cast, stun cancels cast, channel ticks deliver damage at intervals
- Abilities affected: Bandage (self-heal channel), Chudmax (damage channel)
- Need a new action type: `{ abilityIndex, ... }` should distinguish "start cast" from "cancel cast"

### 2b. Ground-targeted abilities
- Bottle Chuck (Dr. Retardo's AoE): needs ground position in action space
- Add `groundX/groundZ` to `AgentAction`
- Handle pending AoE impacts with delay timer (like client's `BOTTLE_CHUCK_IMPACT_DELAY`)

### 2c. Richer observation vector
- Per-buff/debuff presence (one-hot or embedding for active buffs)
- Casting state of opponent (which ability, progress)
- Movement velocity of opponent
- Arena boundary distances

### 2d. Multi-agent (2v2, 3v3)
- Extend `HeadlessArena` to support N entities per team
- Observation vector grows: need ally info + multiple enemy info
- Action space adds target selection (which enemy to attack)

---

## Phase 3: Training Pipeline

### 3a. Python training harness
Two approaches (pick one):

**Option A — subprocess bridge (recommended):**
- Node.js process runs the headless sim
- Python process runs the RL algorithm (PPO via stable-baselines3 or cleanrl)
- Communicate via stdin/stdout JSON-lines: Python sends actions, Node sends observations/rewards
- Advantage: game logic stays in TypeScript, no duplication
- Build: `packages/headless/src/bridge.ts` — reads actions from stdin, writes observations to stdout

**Option B — Python port:**
- Rewrite HeadlessArena in Python (numpy)
- Advantage: native integration with PyTorch, no IPC overhead
- Disadvantage: logic duplication, divergence risk

### 3b. RL algorithm setup
- **Algorithm:** PPO (Proximal Policy Optimization) — stable, sample-efficient enough
- **Framework:** stable-baselines3 or cleanrl
- **Network architecture:**
  - Input: observation vector (~30-60 floats depending on phase 2c)
  - Hidden: 2-3 layers of 256 units (MLP), or small LSTM for temporal reasoning
  - Output heads:
    - Ability selection: softmax over ability slots + "no ability"
    - Movement angle: Gaussian (continuous) or 8-direction discrete softmax
    - Movement speed: sigmoid (0-1)
  - Separate value head for advantage estimation

### 3c. Reward shaping
Starting point (already in HeadlessArena):
```
+1.0  win, -1.0 loss, -0.2 draw
+0.00005 per damage dealt
-0.00003 per damage taken
+0.00003 per healing done
```

Likely additions during tuning:
- Bonus for successful interrupt (opponent casting → stun/CC)
- Penalty for wasted ability (on cooldown, out of range, no target)
- Small penalty per step (encourages aggression, discourages stalling)

### 3d. Self-play training loop
```
1. Initialize policy P_0 randomly
2. For each generation:
   a. Run K matches: current policy vs opponent pool
   b. Collect trajectories (obs, action, reward, done)
   c. Update policy via PPO
   d. Every M generations, add current policy to opponent pool
   e. Periodically evaluate against fixed baselines (random, rule-based)
3. Export best policy
```

Key parameters:
- K = 2048-4096 steps per batch
- Learning rate: 3e-4 (anneal to 1e-5)
- Clip range: 0.2
- Entropy coefficient: 0.01 (encourages exploration)
- Opponent pool size: ~20 past policies

### 3e. Curriculum learning (optional)
- Start against random opponent (easy to beat → learns basics)
- Graduate to rule-based opponent (uses abilities semi-intelligently)
- Then introduce self-play
- This avoids the "random vs random learns nothing" bootstrap problem

---

## Phase 4: Model Export & Client Integration

### 4a. Export trained model
- Export PyTorch model to ONNX format: `torch.onnx.export(model, dummy_input, "agent.onnx")`
- Model size: ~100KB-1MB for a small MLP
- Place in `packages/client/public/models/`

### 4b. NeuralBehavior class
Create `packages/client/src/engine/npc/ai/behaviors/NeuralBehavior.ts`:

```typescript
class NeuralBehavior implements CharacterBehavior {
  private session: ort.InferenceSession; // onnxruntime-web

  async loadModel(url: string): Promise<void> { ... }

  scoreActions(world, cooldowns, difficulty, currentTarget): ScoredAction[] {
    const obs = this.encodeObservation(world, cooldowns);
    const output = this.session.run({ input: obs });
    // Convert network output → single best ScoredAction
    return [{ type: 'ability', score: 100, abilityId: ..., target: ... }];
  }

  getMovementIntent(world, currentTarget): MovementIntent {
    // Network outputs movement angle + magnitude
    return { type: 'moveToward', target: ..., stopDistance: 0 };
  }
}
```

### 4c. Wire into NPC system
In `packages/client/src/engine/npc/ai/behaviors/index.ts`:
```typescript
export function createCharacterBehavior(id: CharacterId, useNeural?: boolean): CharacterBehavior {
  if (useNeural) return new NeuralBehavior(id);
  // ... existing hand-coded behaviors
}
```

Dependencies to add: `onnxruntime-web` (WASM backend, no GPU needed, <1ms inference for small MLP).

### 4d. Observation encoding bridge
`NeuralBehavior.encodeObservation()` must produce the exact same observation vector as `HeadlessArena.buildObservation()`. Extract the encoding logic into a shared helper or carefully replicate it. This is a critical fidelity point — any mismatch means the model sees different inputs than what it trained on.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Headless sim diverges from real game | Both use `@gtr/shared` systems. HeadlessCombat is a port of client CombatSystem — keep in sync. |
| Reward shaping produces degenerate behavior | Start simple, add shaping incrementally, evaluate against baselines. |
| Sim too slow for training | Already ~600k steps/sec. Can parallelize with worker threads if needed. |
| Observation encoding mismatch (train vs deploy) | Extract encoding into shared module, add assertion tests. |
| Model doesn't generalize to full game (obstacles, channels) | Phase 2 adds these before training at scale. Train on simplified game first to validate pipeline. |
| New abilities / balance changes invalidate trained model | Retrain is cheap (~hours). Keep training pipeline automated. |

---

## Immediate Next Steps (for next session)

1. **Pick training approach:** Option A (subprocess bridge) or Option B (Python port)
2. **Build the bridge/harness** — the IPC layer between sim and trainer
3. **Implement PPO training loop** with a single character (janitor vs janitor 1v1)
4. **Add channeled abilities** to the headless sim (Phase 2a)
5. **First training run** — validate that the agent learns to beat a random opponent
