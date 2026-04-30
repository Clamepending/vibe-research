#!/usr/bin/env python3
"""Train SAC on HalfCheetah-v4 with configurable hyperparameters.

Designed to work with the vr-rl-sweep autonomous tuner:
  - Accepts the hyperparameters as `--<key>=<value>` flags so the
    sweep-runner's launcher template (`python train.py --lr=${lr}
    --batch-size=${batch_size} --seed=${seed}`) substitutes cleanly.
  - Prints `mean_return: <num>` to stdout at end so the runner's regex
    capture grabs the metric without needing wandb.
  - Optionally calls wandb.init(group=..., name=..., tags=...) if
    --wandb is passed; the standard "View run at <url>" line falls out
    of wandb itself, so the runner's wandb URL extractor catches it.

Usage (the autonomous tuner does this automatically):

    python train.py \\
        --lr=3e-4 --batch-size=256 --gamma=0.99 --total-steps=100000 \\
        --seed=0 --wandb --wandb-group=ablate-lr --wandb-name=ablate-lr-3e-4-seed0

Standalone smoke check (1k steps to confirm the env works):

    python train.py --total-steps=1000 --eval-episodes=2

Stable-Baselines3 is intentional: SB3's SAC is the simplest "just-run-it"
SAC implementation that handles the gymnasium/MuJoCo interface plumbing
without 500 lines of CleanRL reproducing it. If you need a more readable
single-file impl, swap this for cleanrl/sac_continuous_action.py — the
flag set here is a strict subset.
"""

import argparse
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--lr", type=float, default=3e-4, help="Learning rate (actor + critic + entropy)")
    parser.add_argument("--gamma", type=float, default=0.99, help="Discount factor")
    parser.add_argument("--tau", type=float, default=0.005, help="Polyak target-network smoothing")
    parser.add_argument("--alpha", type=str, default="auto", help='Entropy coefficient. "auto" lets SB3 tune it.')
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--buffer-size", type=int, default=1_000_000)
    parser.add_argument("--total-steps", type=int, default=100_000)
    parser.add_argument("--learning-starts", type=int, default=10_000, help="No learning until this many env steps collected")
    parser.add_argument("--eval-episodes", type=int, default=10)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--env-id", type=str, default="HalfCheetah-v4")
    parser.add_argument("--wandb", action="store_true", help="Log to wandb (needs WANDB_API_KEY)")
    parser.add_argument("--wandb-project", type=str, default="vr-halfcheetah-sac")
    parser.add_argument("--wandb-group", type=str, default="")
    parser.add_argument("--wandb-name", type=str, default="")
    args = parser.parse_args()

    # Defer imports so `python train.py --help` works without all deps.
    try:
        import gymnasium as gym
        import numpy as np
        import torch
        from stable_baselines3 import SAC
        from stable_baselines3.common.evaluation import evaluate_policy
    except ImportError as e:
        sys.stderr.write(f"missing dependency: {e}\n")
        sys.stderr.write("run: pip install -r requirements.txt\n")
        sys.exit(2)

    # Setup wandb first so the "View run at <url>" line lands early.
    if args.wandb:
        try:
            import wandb
            wandb.init(
                project=args.wandb_project,
                group=args.wandb_group or None,
                name=args.wandb_name or None,
                tags=["halfcheetah", "sac"],
                config=vars(args),
                reinit=True,
            )
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"warning: wandb init failed: {e}\n")

    # Reproducibility.
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    print(f"[train] {args.env_id} · lr={args.lr} · batch={args.batch_size} · "
          f"gamma={args.gamma} · tau={args.tau} · alpha={args.alpha} · "
          f"steps={args.total_steps} · seed={args.seed}", flush=True)

    env = gym.make(args.env_id)
    # SB3 accepts "auto" or a float for ent_coef.
    try:
        ent_coef_value = float(args.alpha)
    except ValueError:
        ent_coef_value = args.alpha  # "auto"

    model = SAC(
        "MlpPolicy",
        env,
        learning_rate=args.lr,
        buffer_size=args.buffer_size,
        batch_size=args.batch_size,
        gamma=args.gamma,
        tau=args.tau,
        ent_coef=ent_coef_value,
        learning_starts=args.learning_starts,
        seed=args.seed,
        verbose=0,
        device="auto",
    )

    t0 = time.time()
    model.learn(total_timesteps=args.total_steps, progress_bar=False, log_interval=10)
    train_time = time.time() - t0
    print(f"[train] done in {train_time:.1f}s; evaluating on {args.eval_episodes} episodes…", flush=True)

    eval_env = gym.make(args.env_id)
    mean_return, std_return = evaluate_policy(
        model, eval_env, n_eval_episodes=args.eval_episodes,
        deterministic=True, return_episode_rewards=False,
    )

    # The two lines the autonomous tuner's metric extractor + std aggregator
    # care about. Single-seed std isn't meaningful here (it's the std *across
    # eval episodes*, not across seeds) — vr-rl-sweep recomputes the std
    # ACROSS the seed cell anyway when it aggregates.
    print(f"mean_return: {mean_return:.4f}", flush=True)
    print(f"eval_episode_std: {std_return:.4f}", flush=True)
    print(f"train_seconds: {train_time:.1f}", flush=True)

    if args.wandb:
        try:
            import wandb
            wandb.log({
                "mean_return": float(mean_return),
                "eval_episode_std": float(std_return),
                "train_seconds": train_time,
            })
            wandb.finish()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"warning: wandb finish failed: {e}\n")


if __name__ == "__main__":
    main()
