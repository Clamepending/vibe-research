# HalfCheetah SAC — autonomous-tuner end-to-end example

This is the **first real RL workload** for the autonomous tuner — beyond the
toy parabola the system was originally validated on. The agent picks SAC
hyperparameters, runs training jobs, aggregates per-cell mean ± std across
seeds, admits or falsifies, and updates the leaderboard.

## What's here

| File | Purpose |
| --- | --- |
| `train.py` | SB3-based SAC trainer for HalfCheetah-v4. Reads HP flags, prints `mean_return: <num>` at end. Optional wandb. |
| `requirements.txt` | gymnasium[mujoco], stable-baselines3, torch, wandb |
| `bootstrap.sh` | Creates `.venv`, installs deps, runs a 1k-step smoke train. |
| `kickoff.sh` | Calls `vr-rl-tuner` to bootstrap a Vibe Research project pointing at this repo. |

## Setup (5–15 min depending on torch wheel cache)

```bash
cd examples/halfcheetah-sac
./bootstrap.sh
```

If MuJoCo doesn't import, you may need system libs (`apt-get install libgl1
libosmesa6 libglew-dev` on Linux, or accept the macOS Gatekeeper prompt for
the MuJoCo binary on first import).

If you want wandb dashboards, set `WANDB_API_KEY` in your environment before
calling `kickoff.sh`.

## Hand off to the autonomous tuner

```bash
./kickoff.sh /abs/path/to/your/lab-library --name halfcheetah-sac-2026
```

This writes `<library>/projects/halfcheetah-sac-2026/{README.md, paper.md,
kickoff.json, results/, figures/}` and copies the `rl-sweep-tuner` skill
into the project's `.claude/skills/`.

Then:

```bash
cd /abs/path/to/your/lab-library
claude code  # or however you start your Claude Code session
```

…and tell the agent:

> Use the rl-sweep-tuner skill to take over projects/halfcheetah-sac-2026.

The agent reads `kickoff.json`, plans the first sweep with `vr-rl-sweep
init`, executes via `vr-rl-sweep run`, aggregates with `vr-rl-sweep summary`,
applies the verdict with `vr-research-resolve`, and picks the next move per
the discipline order (Ablate → Replicate → Sensitivity → Architecture →
Stop).

## Hyperparameters the agent will sweep

The kickoff bakes a baseline at SB3's defaults:

```
lr=3e-4
gamma=0.99
tau=0.005
alpha=auto
batch_size=256
total_steps=100000
learning_starts=10000
```

The agent decides what to sweep based on the discipline order. A typical
first move is a 3-seed baseline replication. Then a coarse LR sweep
(`logspace(1e-4, 1e-3, 4)` × 3 seeds = 12 runs). Then narrow around the
peak. Then ablate gamma / tau / alpha.

## Per-run cost (on a recent CPU/GPU)

| Setting | Wall clock | Notes |
| --- | --- | --- |
| `--total-steps 1000` (smoke) | 30s | bootstrap.sh runs this |
| `--total-steps 100000` | 5–15 min | the autonomous tuner default |
| `--total-steps 1000000` | 1–2 hours | proper paper-grade |

Default `--total-steps=100000` keeps a 12-run sweep under 3 hours, which is
the cap implicit in the `1 GPU-hour local` budget statement.

## Stdout contract for the runner

The vr-rl-sweep runner extracts the metric via this regex:

```
(?:final_return|mean_return)\s*[:=]\s*([+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?\d+)?)
```

`train.py` ends with `print(f"mean_return: {mean_return:.4f}")`, which the
regex matches. Wandb URL extraction also works for free if `--wandb` is on
because SB3 logs through wandb's standard "View run at <url>" line.

## Troubleshooting

- **MuJoCo render errors**: HalfCheetah doesn't actually need rendering for
  training — only for `env.render()`. We never call render. If you see
  `mujoco.FatalError: gladLoadGL` it's an OpenGL stack issue; export
  `MUJOCO_GL=osmesa` or `MUJOCO_GL=egl` before running.

- **torch CUDA mismatch**: SB3's `device="auto"` picks CUDA if available.
  `train.py` will print which device it's using on the `[train] done in
  Xs` line. To force CPU, set `CUDA_VISIBLE_DEVICES=""`.

- **wandb auth**: `WANDB_API_KEY` env var. Without it, `--wandb` will print
  a warning to stderr and continue — `mean_return` still lands in stdout.

## Why SB3, not CleanRL

CleanRL's `sac_continuous_action.py` is more readable but pulls a longer
arg list and depends on `tyro` and a specific `pyproject.toml` setup. SB3
is one `pip install` and the SAC class fits the autonomous-tuner's launcher
template more tightly. If you want the CleanRL version, swap `train.py` —
the surface area (`--lr`, `--seed`, `--total-steps`, `--wandb-group`,
`--wandb-name`) is a strict subset of CleanRL's flags.
