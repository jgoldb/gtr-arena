"""
Export a trained SB3 PPO model to ONNX format for browser inference via onnxruntime-web.

Usage:
    python export_onnx.py                                    # exports models/ppo_gtr_final
    python export_onnx.py --model models/ppo_gtr_final       # explicit path
    python export_onnx.py --output ../../client/public/models/agent.onnx
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import torch
import torch.nn as nn
from stable_baselines3 import PPO


class PolicyExporter(nn.Module):
    """Wraps SB3's MLP policy for clean ONNX export.

    SB3's PPO uses MultiDiscrete action space with separate logit heads.
    This module runs the shared MLP layers then each action head, and outputs
    the argmax of each head (deterministic inference).
    """

    def __init__(self, model: PPO):
        super().__init__()
        policy = model.policy

        # Shared feature extractor (usually Flatten for MlpPolicy)
        self.features_extractor = policy.features_extractor

        # Policy MLP layers (pi branch)
        self.mlp = policy.mlp_extractor.policy_net

        # Action distribution heads — one per sub-space in MultiDiscrete
        # SB3 stores these as action_net (a single Linear) but for MultiDiscrete
        # it uses a CategoricalDistribution per sub-space
        self.action_net = policy.action_net

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        features = self.features_extractor(obs)
        latent = self.mlp(features)
        logits = self.action_net(latent)

        # MultiDiscrete: logits are concatenated [ability_logits, move_logits, cancel_logits]
        # Split and argmax each sub-space
        # For janitor: 12 ability choices + 9 move choices + 2 cancel choices = 23 logits
        # We can read the split sizes from the model's action space
        return logits


def main():
    parser = argparse.ArgumentParser(description="Export SB3 PPO to ONNX")
    parser.add_argument("--model", default="./models/ppo_gtr_final", help="Path to saved SB3 model")
    parser.add_argument("--output", default=None, help="Output ONNX path")
    args = parser.parse_args()

    print(f"Loading model from {args.model}...")
    model = PPO.load(args.model)

    # Determine output path
    if args.output:
        output_path = args.output
    else:
        output_path = args.model.rstrip(".zip") + ".onnx"

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    # Build exporter
    exporter = PolicyExporter(model)
    exporter.eval()

    # Dummy input matching observation size
    obs_size = model.observation_space.shape[0]
    dummy_input = torch.randn(1, obs_size)

    print(f"Observation size: {obs_size}")
    print(f"Action space: {model.action_space}")

    # Verify exporter output matches SB3
    with torch.no_grad():
        onnx_logits = exporter(dummy_input)
        # SB3's own prediction for comparison
        sb3_action, _ = model.predict(dummy_input.numpy(), deterministic=True)
        print(f"ONNX logits shape: {onnx_logits.shape}")
        print(f"SB3 predicted action: {sb3_action}")

        # Split logits and argmax to verify match
        splits = list(model.action_space.nvec)
        split_logits = torch.split(onnx_logits, splits, dim=1)
        onnx_actions = [t.argmax(dim=1).item() for t in split_logits]
        print(f"ONNX argmax actions: {onnx_actions}")

    # Export to ONNX
    print(f"\nExporting to {output_path}...")
    torch.onnx.export(
        exporter,
        dummy_input,
        output_path,
        opset_version=17,
        input_names=["obs"],
        output_names=["logits"],
        dynamic_axes={
            "obs": {0: "batch"},
            "logits": {0: "batch"},
        },
        dynamo=False,
    )

    file_size = os.path.getsize(output_path)
    print(f"Exported ONNX model: {file_size:,} bytes ({file_size / 1024:.0f} KB)")

    # Quick validation: load and run ONNX model
    try:
        import onnxruntime as ort

        sess = ort.InferenceSession(output_path)
        ort_result = sess.run(None, {"obs": dummy_input.numpy()})[0]
        print(f"ONNX runtime validation: logits shape {ort_result.shape}")

        split_logits_np = np.split(ort_result, np.cumsum(splits[:-1]), axis=1)
        ort_actions = [np.argmax(l, axis=1)[0] for l in split_logits_np]
        print(f"ONNX runtime actions: {ort_actions}")
        print(f"Match SB3: {ort_actions == list(sb3_action[0])}")
    except ImportError:
        print("(onnxruntime not installed — skipping validation)")

    print("\nDone!")


if __name__ == "__main__":
    main()
