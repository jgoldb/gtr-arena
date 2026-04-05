"""
PPO training for GTR Arena 1v1.

First training run: agent (janitor) vs random opponent (janitor).
Validates the pipeline by checking that win rate climbs above random (50%).

Usage:
    python train.py                           # defaults: 1M steps, janitor vs janitor
    python train.py --timesteps 5000000       # longer run
    python train.py --opponent-model models/ppo_gtr_checkpoint_200000  # self-play vs saved policy

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

from env import GtrVecEnv, PolicyOpponent


class WinRateCallback(BaseCallback):
    """Logs win rate and episode stats to TensorBoard."""

    def __init__(self, window: int = 100, verbose: int = 0):
        super().__init__(verbose)
        self.window = window
        self.outcomes: list[bool] = []
        self.episode_times: list[float] = []

    def _on_step(self) -> bool:
        for info in self.locals.get("infos", []):
            if "is_win" in info:
                self.outcomes.append(info["is_win"])
            if "episode_time" in info:
                self.episode_times.append(info["episode_time"])

        if len(self.outcomes) >= self.window:
            recent = self.outcomes[-self.window :]
            win_rate = sum(recent) / len(recent)
            self.logger.record("gtr/win_rate", win_rate)
            self.logger.record("gtr/total_episodes", len(self.outcomes))
            if self.episode_times:
                self.logger.record(
                    "gtr/avg_episode_time",
                    np.mean(self.episode_times[-self.window :]),
                )

        return True


def main():
    parser = argparse.ArgumentParser(description="Train PPO agent for GTR Arena 1v1")
    parser.add_argument("--timesteps", type=int, default=1_000_000, help="Total training timesteps")
    parser.add_argument("--characters", nargs=2, default=["janitor", "janitor"], help="Character matchup")
    parser.add_argument("--num-envs", type=int, default=16, help="Parallel environments")
    parser.add_argument("--map", default="cage", help="Map ID")
    parser.add_argument("--lr", type=float, default=3e-4, help="Learning rate")
    parser.add_argument("--ent-coef", type=float, default=0.01, help="Entropy coefficient")
    parser.add_argument("--n-steps", type=int, default=2048, help="Steps per rollout per env")
    parser.add_argument("--batch-size", type=int, default=256, help="Minibatch size")
    parser.add_argument("--save-dir", default="./models", help="Directory for model checkpoints")
    parser.add_argument("--save-freq", type=int, default=50_000, help="Checkpoint save frequency (steps)")
    parser.add_argument("--opponent-model", default=None, help="Path to saved SB3 model for opponent")
    parser.add_argument("--resume", default=None, help="Path to saved model to resume training")
    args = parser.parse_args()

    os.makedirs(args.save_dir, exist_ok=True)

    # Set up opponent
    opponent = None
    if args.opponent_model:
        print(f"Loading opponent policy from {args.opponent_model}")
        opponent = PolicyOpponent(args.opponent_model)

    # Create vectorized environment
    print(f"Starting {args.num_envs} environments: {args.characters[0]} vs {args.characters[1]} on {args.map}")
    env = GtrVecEnv(
        num_envs=args.num_envs,
        characters=tuple(args.characters),
        map_id=args.map,
        opponent=opponent,
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
            learning_rate=args.lr,
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
        WinRateCallback(window=100, verbose=1),
        CheckpointCallback(
            save_freq=max(args.save_freq // args.num_envs, 1),
            save_path=args.save_dir,
            name_prefix="ppo_gtr",
        ),
    ]

    # Train
    print(f"\nTraining for {args.timesteps:,} timesteps...")
    t0 = time.time()

    try:
        model.learn(
            total_timesteps=args.timesteps,
            callback=callbacks,
            progress_bar=True,
        )
    except KeyboardInterrupt:
        print("\nTraining interrupted by user.")

    elapsed = time.time() - t0

    # Save final model
    final_path = os.path.join(args.save_dir, "ppo_gtr_final")
    model.save(final_path)

    # Summary
    win_cb = callbacks[0]
    print(f"\n{'='*50}")
    print(f"Training complete in {elapsed:.0f}s")
    print(f"Model saved to {final_path}")
    print(f"Total episodes: {len(win_cb.outcomes)}")
    if win_cb.outcomes:
        n = min(100, len(win_cb.outcomes))
        final_wr = sum(win_cb.outcomes[-n:]) / n
        print(f"Final win rate (last {n}): {final_wr:.1%}")
    print(f"{'='*50}")

    env.close()


if __name__ == "__main__":
    main()
