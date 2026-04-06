"""
GtrVecEnv — SB3-compatible vectorized environment wrapping the headless bridge.

Each env runs a 1v1 match. Agent 0 (team 1) is controlled by the RL policy.
Agent 1 (team 2) is controlled by an opponent policy (random by default).

Usage:
    env = GtrVecEnv(num_envs=16, characters=('janitor', 'janitor'))
    obs = env.reset()
    obs, rewards, dones, infos = env.step(actions)
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
import os
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env.base_vec_env import VecEnv, VecEnvObs, VecEnvStepReturn


# ── Opponent policies ─────────────────────────────────────────────────────


class RandomOpponent:
    """Uniform random actions."""

    def __init__(self, num_abilities: int):
        self.num_abilities = num_abilities

    def predict(self, obs: np.ndarray) -> np.ndarray:
        n = obs.shape[0]
        abilities = np.random.randint(0, self.num_abilities + 1, size=n)
        move_dirs = np.random.randint(0, 9, size=n)
        cancel = np.zeros(n, dtype=int)
        rest = np.zeros(n, dtype=int)
        return np.stack([abilities, move_dirs, cancel, rest], axis=1)


class DoNothingOpponent:
    """Always stands still and does nothing (useful for sanity checks)."""

    def predict(self, obs: np.ndarray) -> np.ndarray:
        n = obs.shape[0]
        return np.zeros((n, 4), dtype=int)


class PolicyOpponent:
    """Runs a saved SB3 PPO policy as the opponent."""

    def __init__(self, model_path: str):
        from stable_baselines3 import PPO
        self.model = PPO.load(model_path)

    def predict(self, obs: np.ndarray) -> np.ndarray:
        actions, _ = self.model.predict(obs, deterministic=False)
        return actions


class PoolOpponent:
    """Samples from a pool of saved policies, with some probability of random fallback."""

    def __init__(self, num_abilities: int, random_prob: float = 0.2):
        self.num_abilities = num_abilities
        self.random_prob = random_prob
        self.pool: list[str] = []
        self.current: PolicyOpponent | None = None
        self._random = RandomOpponent(num_abilities)

    def add(self, model_path: str, max_pool_size: int = 20) -> None:
        self.pool.append(model_path)
        if len(self.pool) > max_pool_size:
            self.pool.pop(0)
        self._resample()

    def _resample(self) -> None:
        if self.pool:
            path = random.choice(self.pool)
            self.current = PolicyOpponent(path)

    def predict(self, obs: np.ndarray) -> np.ndarray:
        if self.current is None or random.random() < self.random_prob:
            return self._random.predict(obs)
        return self.current.predict(obs)


# ── VecEnv ────────────────────────────────────────────────────────────────


class GtrVecEnv(VecEnv):
    """
    Vectorized environment that communicates with the Node.js headless bridge
    via stdin/stdout JSON lines.
    """

    def __init__(
        self,
        num_envs: int = 16,
        characters: tuple[str, str] = ("janitor", "janitor"),
        map_id: str = "cage",
        opponent: Any | None = None,
        headless_dir: str | None = None,
        tick_rate: float | None = None,
        max_duration: float | None = None,
        opponent_mode: str | None = None,
        opponent_characters: list[str] | None = None,
        scripted_mix_rate: float | None = None,
    ):
        self.headless_dir = headless_dir or str(Path(__file__).parent.parent)
        self.opponent_mode = opponent_mode

        # Start bridge subprocess
        self.proc = subprocess.Popen(
            "npx tsx src/bridge.ts",
            shell=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.headless_dir,
        )

        # Send init command
        init_cmd: dict[str, Any] = {
            "cmd": "init",
            "numEnvs": num_envs,
            "characters": list(characters),
            "mapId": map_id,
        }
        if tick_rate is not None:
            init_cmd["tickRate"] = tick_rate
        if max_duration is not None:
            init_cmd["maxDuration"] = max_duration
        if opponent_mode == "scripted" and scripted_mix_rate is None:
            init_cmd["opponentMode"] = "scripted"
        if opponent_characters:
            init_cmd["opponentCharacters"] = opponent_characters
        if scripted_mix_rate is not None:
            init_cmd["scriptedMixRate"] = scripted_mix_rate

        self._send(init_cmd)
        init_resp = self._recv()

        if "error" in init_resp:
            stderr_out = self.proc.stderr.read().decode() if self.proc.stderr else ""
            raise RuntimeError(
                f"Bridge init failed: {init_resp['error']}\nstderr: {stderr_out}"
            )

        self.obs_size: int = init_resp["obsSize"]
        self.num_abilities: int = init_resp["numAbilities"]

        # Both agents' observations: [num_envs, 2, obs_size]
        self.all_obs = np.array(init_resp["obs"], dtype=np.float32)

        # Opponent policy: pure scripted mode sends no-ops (bridge handles AI).
        # Mix mode needs real actions for non-scripted episodes.
        if opponent_mode == "scripted" and scripted_mix_rate is None:
            self.opponent = DoNothingOpponent()
        else:
            self.opponent = opponent or RandomOpponent(self.num_abilities)

        # Define spaces
        observation_space = spaces.Box(
            low=-np.inf,
            high=np.inf,
            shape=(self.obs_size,),
            dtype=np.float32,
        )
        action_space = spaces.MultiDiscrete(
            [self.num_abilities + 1, 9, 2, 2]  # ability, moveDir, cancelCast, rest
        )

        super().__init__(num_envs, observation_space, action_space)

    # ── IPC helpers ───────────────────────────────────────────────────────

    def _send(self, data: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(data) + "\n").encode())
        self.proc.stdin.flush()

    def _recv(self) -> dict:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline().decode()
        if not line:
            stderr_out = ""
            if self.proc.stderr:
                stderr_out = self.proc.stderr.read().decode()
            raise RuntimeError(f"Bridge process died unexpectedly.\nstderr: {stderr_out}")
        return json.loads(line)

    # ── VecEnv interface ──────────────────────────────────────────────────

    def reset(self) -> VecEnvObs:
        self._send({"cmd": "reset"})
        resp = self._recv()
        self.all_obs = np.array(resp["obs"], dtype=np.float32)
        return self.all_obs[:, 0]  # Agent 0's observations

    def step_async(self, actions: np.ndarray) -> None:
        # Generate opponent actions from agent 1's observations
        opp_obs = self.all_obs[:, 1]
        opp_actions = self.opponent.predict(opp_obs)

        all_actions = []
        for i in range(self.num_envs):
            all_actions.append(
                [actions[i].tolist(), opp_actions[i].tolist()]
            )

        self._send({"cmd": "step", "actions": all_actions})

    def step_wait(self) -> VecEnvStepReturn:
        resp = self._recv()

        self.all_obs = np.array(resp["obs"], dtype=np.float32)
        obs = self.all_obs[:, 0]
        rewards = np.array([r[0] for r in resp["rewards"]], dtype=np.float32)
        dones = np.array(resp["dones"], dtype=bool)

        infos: list[dict[str, Any]] = []
        for i, info in enumerate(resp.get("infos", [{}] * self.num_envs)):
            d: dict[str, Any] = {}
            if "terminal_obs" in info:
                d["terminal_observation"] = np.array(
                    info["terminal_obs"][0], dtype=np.float32
                )
            if "winner" in info:
                d["winner"] = info["winner"]
                d["is_win"] = info["winner"] == 1  # Agent 0 is team 1
            if "time" in info:
                d["episode_time"] = info["time"]
            infos.append(d)

        return obs, rewards, dones, infos

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self._send({"cmd": "close"})
            except (BrokenPipeError, OSError):
                pass
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def set_unlocked_abilities(self, n: int) -> None:
        """Update the number of unlocked ability slots across all arenas (curriculum)."""
        self._send({"cmd": "set_config", "unlockedAbilities": n})
        self._recv()  # ack

    def seed(self, seed: int | None = None) -> Sequence[int | None]:
        return [None] * self.num_envs

    def get_attr(self, attr_name: str, indices: Sequence[int] | None = None) -> list:
        indices = indices or range(self.num_envs)
        # SB3 queries render_mode during __init__; we don't support rendering
        if attr_name == "render_mode":
            return [None for _ in indices]
        raise AttributeError(f"GtrVecEnv has no attribute {attr_name!r}")

    def set_attr(
        self, attr_name: str, value: Any, indices: Sequence[int] | None = None
    ) -> None:
        pass  # no-op; we don't expose per-env attributes

    def env_method(
        self, method_name: str, *method_args, indices=None, **method_kwargs
    ) -> list:
        indices = indices or range(self.num_envs)
        return [None for _ in indices]

    def env_is_wrapped(self, wrapper_class, indices=None) -> list[bool]:
        return [False] * self.num_envs
