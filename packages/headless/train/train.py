"""
PPO training for GTR Arena 1v1.

Trains agent (janitor) with optional self-play opponent pool, scripted opponents, or a mix.

Usage:
    python train.py                           # defaults: 5M steps, janitor vs janitor, self-play
    python train.py --timesteps 10000000      # longer run
    python train.py --no-self-play            # disable self-play (random opponent only)
    python train.py --resume models/ppo_gtr_checkpoint_500000  # resume training
    python train.py --opponent scripted-master # train against Master-level scripted AI
    python train.py --opponent scripted-master --opponent-characters janitor crackhead dr-retardo
                                              # rotate opponent character each episode

    # Recommended: self-play + 30% scripted opponents across all characters
    python train.py --opponent self-play \\
        --opponent-characters janitor crackhead dr-retardo \\
        --scripted-mix-rate 0.3

Flags:
    General:
      --timesteps N             Total training timesteps (default: 5000000)
      --characters C1 C2        Character matchup, two names (default: janitor janitor)
      --num-envs N              Parallel environments (default: 16)
      --map ID                  Map ID (default: cage)
      --resume PATH             Path to saved model to resume training
      --save-dir DIR            Directory for model checkpoints (default: ./models)
      --save-freq N             Checkpoint save frequency in steps (default: 100000)

    Hyperparameters:
      --lr FLOAT                Initial learning rate, anneals to 0 (default: 3e-4)
      --ent-coef FLOAT          Initial entropy coefficient, anneals to 0.01 (default: 0.04)
      --n-steps N               Steps per rollout per env (default: 2048)
      --batch-size N            Minibatch size (default: 512)

    Opponent:
      --opponent MODE           random | scripted-master | self-play (default: self-play)
      --no-self-play            Disable self-play, use random opponent instead
      --opponent-characters C+  Pool of opponent characters to rotate per episode
                                (e.g. janitor crackhead dr-retardo)
      --scripted-mix-rate FLOAT Fraction (0-1) of episodes using scripted opponents;
                                remaining use self-play/random (e.g. 0.3 = 30% scripted)

    Self-play tuning:
      --self-play-start N       Timestep to activate self-play pool (default: 300000)
      --self-play-freq N        How often to snapshot policy into pool (default: 100000)
      --self-play-pool-size N   Max opponents in the pool (default: 20)
      --self-play-random-prob F Probability of random opponent per episode (default: 0.2)

    Curriculum:
      --curriculum-start N      Ability slots unlocked at training start (default: 3)
      --curriculum-unlock-every N  Unlock one more ability slot every N steps (default: 200000)
      --no-curriculum           Disable ability curriculum (all abilities from start)

Requirements:
    pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import os
import time

import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback

from env import GtrVecEnv, PoolOpponent, PolicyOpponent


# ── Learning rate schedule ──────────────────────────────────────────────


def linear_schedule(initial_lr: float):
    """Linear annealing from initial_lr to 0."""
    def schedule(progress_remaining: float) -> float:
        return progress_remaining * initial_lr
    return schedule


class EntropyScheduleCallback(BaseCallback):
    """Linearly anneal ent_coef from initial to final over training."""

    def __init__(self, initial: float, final: float, verbose: int = 0):
        super().__init__(verbose)
        self.initial = initial
        self.final = final

    def _on_step(self) -> bool:
        progress = self.model._current_progress_remaining  # 1 → 0
        self.model.ent_coef = self.final + progress * (self.initial - self.final)
        self.logger.record("train/ent_coef", self.model.ent_coef)
        return True


# ── Callbacks ───────────────────────────────────────────────────────────


class CurriculumCallback(BaseCallback):
    """Gradually unlocks ability slots over training.

    Starts with `start_abilities` slots unlocked, adds one more every
    `unlock_every` timesteps until all abilities are available.
    """

    def __init__(
        self,
        env: GtrVecEnv,
        num_abilities: int,
        start_abilities: int = 3,
        unlock_every: int = 200_000,
        verbose: int = 0,
    ):
        super().__init__(verbose)
        self.env = env
        self.num_abilities = num_abilities
        self.start_abilities = start_abilities
        self.unlock_every = unlock_every
        self.current_unlocked = start_abilities

    def _on_training_start(self) -> None:
        self.current_unlocked = self.start_abilities
        self.env.set_unlocked_abilities(self.current_unlocked)
        if self.verbose:
            print(f"[Curriculum] Starting with {self.current_unlocked}/{self.num_abilities} abilities")

    def _on_step(self) -> bool:
        if self.current_unlocked >= self.num_abilities:
            return True
        target = min(
            self.num_abilities,
            self.start_abilities + self.num_timesteps // self.unlock_every,
        )
        if target > self.current_unlocked:
            self.current_unlocked = target
            self.env.set_unlocked_abilities(self.current_unlocked)
            if self.verbose:
                print(
                    f"[Curriculum] Unlocked {self.current_unlocked}/{self.num_abilities} "
                    f"abilities at {self.num_timesteps:,} steps"
                )
            self.logger.record("gtr/unlocked_abilities", self.current_unlocked)
        return True


class WinRateCallback(BaseCallback):
    """Logs win rate and episode stats to TensorBoard, split by opponent type."""

    def __init__(self, window: int = 100, verbose: int = 0):
        super().__init__(verbose)
        self.window = window
        self.outcomes: list[bool] = []
        self.scripted_outcomes: list[bool] = []
        self.external_outcomes: list[bool] = []
        self.episode_times: list[float] = []

    def _on_step(self) -> bool:
        for info in self.locals.get("infos", []):
            if "is_win" in info:
                self.outcomes.append(info["is_win"])
                if info.get("scripted", False):
                    self.scripted_outcomes.append(info["is_win"])
                else:
                    self.external_outcomes.append(info["is_win"])
            if "episode_time" in info:
                self.episode_times.append(info["episode_time"])

        if len(self.outcomes) >= self.window:
            recent = self.outcomes[-self.window :]
            self.logger.record("gtr/win_rate", sum(recent) / len(recent))
            self.logger.record("gtr/total_episodes", len(self.outcomes))
            if self.episode_times:
                self.logger.record(
                    "gtr/avg_episode_time",
                    np.mean(self.episode_times[-self.window :]),
                )
        if len(self.scripted_outcomes) >= self.window:
            recent = self.scripted_outcomes[-self.window :]
            self.logger.record("gtr/win_rate_vs_scripted", sum(recent) / len(recent))
        if len(self.external_outcomes) >= self.window:
            recent = self.external_outcomes[-self.window :]
            self.logger.record("gtr/win_rate_vs_external", sum(recent) / len(recent))

        return True


class SelfPlayCallback(BaseCallback):
    """Periodically snapshots the current policy into an opponent pool.

    Before `start_timesteps`, the env uses its initial opponent (random).
    After activation, each `update_freq` steps a new snapshot is added to the pool.
    The pool opponent randomly samples from saved checkpoints (with random_prob
    chance of falling back to random actions for diversity).
    """

    def __init__(
        self,
        env: GtrVecEnv,
        save_dir: str,
        start_timesteps: int = 200_000,
        update_freq: int = 100_000,
        pool_size: int = 20,
        random_prob: float = 0.2,
        verbose: int = 0,
    ):
        super().__init__(verbose)
        self.env = env
        self.save_dir = save_dir
        self.start_timesteps = start_timesteps
        self.update_freq = update_freq
        self.pool_size = pool_size
        self.pool_opponent = PoolOpponent(env.num_abilities, random_prob=random_prob)
        self.next_update = start_timesteps
        self.activated = False

    def _on_step(self) -> bool:
        if self.num_timesteps >= self.next_update:
            # Save current policy snapshot
            path = os.path.join(self.save_dir, f"opponent_{self.num_timesteps}")
            self.model.save(path)
            self.pool_opponent.add(path, self.pool_size)

            if not self.activated:
                self.activated = True
                self.env.opponent = self.pool_opponent
                if self.verbose:
                    print(f"\n[SelfPlay] Activated at {self.num_timesteps:,} steps")

            self.next_update += self.update_freq
            if self.verbose:
                print(
                    f"[SelfPlay] Pool size: {len(self.pool_opponent.pool)}, "
                    f"timestep: {self.num_timesteps:,}"
                )
            self.logger.record("gtr/self_play_pool_size", len(self.pool_opponent.pool))

        return True


def main():
    parser = argparse.ArgumentParser(description="Train PPO agent for GTR Arena 1v1")
    parser.add_argument("--timesteps", type=int, default=5_000_000, help="Total training timesteps")
    parser.add_argument("--characters", nargs=2, default=["janitor", "janitor"], help="Character matchup")
    parser.add_argument("--num-envs", type=int, default=16, help="Parallel environments")
    parser.add_argument("--map", default="cage", help="Map ID")
    parser.add_argument("--lr", type=float, default=3e-4, help="Initial learning rate (anneals to 0)")
    parser.add_argument("--ent-coef", type=float, default=0.04, help="Initial entropy coefficient (anneals to 0.01)")
    parser.add_argument("--n-steps", type=int, default=2048, help="Steps per rollout per env")
    parser.add_argument("--batch-size", type=int, default=512, help="Minibatch size")
    parser.add_argument("--save-dir", default="./models", help="Directory for model checkpoints")
    parser.add_argument("--save-freq", type=int, default=100_000, help="Checkpoint save frequency (steps)")
    parser.add_argument("--resume", default=None, help="Path to saved model to resume training")
    # Self-play options
    parser.add_argument("--opponent", choices=["random", "scripted-master", "self-play"],
                        default="self-play",
                        help="Opponent type: random, scripted-master (Master NPC AI), or self-play (default)")
    parser.add_argument("--no-self-play", action="store_true", help="Disable self-play (random opponent only)")
    parser.add_argument("--self-play-start", type=int, default=300_000,
                        help="Timestep to activate self-play opponent pool")
    parser.add_argument("--self-play-freq", type=int, default=100_000,
                        help="How often to snapshot policy into opponent pool")
    parser.add_argument("--self-play-pool-size", type=int, default=20,
                        help="Max opponents in the pool")
    parser.add_argument("--self-play-random-prob", type=float, default=0.2,
                        help="Probability of random opponent per episode (for diversity)")
    parser.add_argument("--opponent-characters", nargs="+", default=None,
                        help="Pool of opponent characters to rotate per episode (e.g. janitor crackhead dr-retardo)")
    parser.add_argument("--scripted-mix-rate", type=float, default=None,
                        help="Fraction (0-1) of episodes using scripted opponents. "
                             "Remaining episodes use self-play/random. E.g. 0.3 = 30%% scripted")
    # Curriculum options
    parser.add_argument("--curriculum-start", type=int, default=3,
                        help="Number of ability slots unlocked at training start (default 3)")
    parser.add_argument("--curriculum-unlock-every", type=int, default=200_000,
                        help="Unlock one more ability slot every N timesteps (default 200k)")
    parser.add_argument("--no-curriculum", action="store_true",
                        help="Disable ability curriculum (all abilities available from start)")
    args = parser.parse_args()

    os.makedirs(args.save_dir, exist_ok=True)

    # Resolve opponent mode (--no-self-play overrides --opponent for backwards compat)
    opponent_mode = args.opponent
    if args.no_self_play and opponent_mode == "self-play":
        opponent_mode = "random"

    # Create vectorized environment
    print(f"Starting {args.num_envs} environments: {args.characters[0]} vs {args.characters[1]} on {args.map}")
    env = GtrVecEnv(
        num_envs=args.num_envs,
        characters=tuple(args.characters),
        map_id=args.map,
        opponent_mode="scripted" if opponent_mode == "scripted-master" else None,
        opponent_characters=args.opponent_characters,
        scripted_mix_rate=args.scripted_mix_rate,
    )
    print(f"Observation size: {env.obs_size}, abilities: {env.num_abilities}")

    # Create or load model
    if args.resume:
        print(f"Resuming from {args.resume}")
        model = PPO.load(args.resume, env=env)
    else:
        model = PPO(
            "MlpPolicy",
            env,
            verbose=1,
            n_steps=args.n_steps,
            batch_size=args.batch_size,
            learning_rate=linear_schedule(args.lr),
            ent_coef=args.ent_coef,
            clip_range=0.2,
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            max_grad_norm=0.5,
            policy_kwargs=dict(
                net_arch=dict(pi=[256, 256], vf=[256, 256]),
            ),
            tensorboard_log=os.path.join(args.save_dir, "tb_logs"),
        )

    # Callbacks
    callbacks = [
        EntropyScheduleCallback(initial=args.ent_coef, final=0.01, verbose=1),
        WinRateCallback(window=100, verbose=1),
        CheckpointCallback(
            save_freq=max(args.save_freq // args.num_envs, 1),
            save_path=args.save_dir,
            name_prefix="ppo_gtr",
        ),
    ]

    if opponent_mode == "self-play":
        sp_cb = SelfPlayCallback(
            env=env,
            save_dir=args.save_dir,
            start_timesteps=args.self_play_start,
            update_freq=args.self_play_freq,
            pool_size=args.self_play_pool_size,
            random_prob=args.self_play_random_prob,
            verbose=1,
        )
        callbacks.append(sp_cb)
        print(f"Self-play: activates at {args.self_play_start:,} steps, "
              f"snapshots every {args.self_play_freq:,} steps, "
              f"pool size {args.self_play_pool_size}")
    elif opponent_mode == "scripted-master":
        print("Opponent: scripted Master-level NPC (bridge-side AI)")
    else:
        print("Opponent: random actions")

    if args.scripted_mix_rate is not None:
        chars = ", ".join(args.opponent_characters) if args.opponent_characters else "default"
        print(f"Scripted mix: {args.scripted_mix_rate:.0%} of episodes use scripted AI "
              f"(characters: {chars})")
    elif args.opponent_characters:
        print(f"Opponent characters: {', '.join(args.opponent_characters)}")

    # Ability curriculum
    if not args.no_curriculum:
        curriculum_cb = CurriculumCallback(
            env=env,
            num_abilities=env.num_abilities,
            start_abilities=min(args.curriculum_start, env.num_abilities),
            unlock_every=args.curriculum_unlock_every,
            verbose=1,
        )
        callbacks.append(curriculum_cb)
        print(f"Curriculum: {args.curriculum_start} abilities at start, "
              f"+1 every {args.curriculum_unlock_every:,} steps "
              f"(all {env.num_abilities} by ~{args.curriculum_start + (env.num_abilities - args.curriculum_start) * args.curriculum_unlock_every:,} steps)")

    # Train
    print(f"\nTraining for {args.timesteps:,} timesteps (LR {args.lr} -> 0, ent_coef {args.ent_coef} -> 0.01)...")
    t0 = time.time()

    try:
        model.learn(
            total_timesteps=args.timesteps,
            callback=callbacks,
            progress_bar=False,
        )
    except KeyboardInterrupt:
        print("\nTraining interrupted by user.")

    elapsed = time.time() - t0

    # Save final model
    final_path = os.path.join(args.save_dir, "ppo_gtr_final")
    model.save(final_path)

    # Summary
    win_cb = callbacks[1]
    print(f"\n{'='*50}")
    print(f"Training complete in {elapsed:.0f}s")
    print(f"Model saved to {final_path}")
    print(f"Total episodes: {len(win_cb.outcomes)}")
    if win_cb.outcomes:
        n = min(100, len(win_cb.outcomes))
        final_wr = sum(win_cb.outcomes[-n:]) / n
        print(f"Final win rate (last {n}): {final_wr:.1%}")
    if win_cb.scripted_outcomes:
        n = min(100, len(win_cb.scripted_outcomes))
        print(f"  vs scripted (last {n}): {sum(win_cb.scripted_outcomes[-n:]) / n:.1%}")
    if win_cb.external_outcomes:
        n = min(100, len(win_cb.external_outcomes))
        print(f"  vs external (last {n}): {sum(win_cb.external_outcomes[-n:]) / n:.1%}")
    print(f"{'='*50}")

    env.close()


if __name__ == "__main__":
    main()
