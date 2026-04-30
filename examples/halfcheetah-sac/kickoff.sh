#!/usr/bin/env bash
# Bootstrap a Vibe Research project that the rl-sweep-tuner skill can take
# over for HalfCheetah SAC tuning. Run AFTER bootstrap.sh.
#
# Usage:
#   ./kickoff.sh <abs-path-to-vibe-research-library> [--name <slug>]
#
# Example:
#   ./kickoff.sh /Users/me/lab-library --name halfcheetah-sac-2026

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <abs-path-to-library> [--name <slug>]" >&2
  exit 2
fi

LIBRARY="$1"
shift

NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find vr-rl-tuner. Prefer the one on PATH; fall back to the worktree's bin/.
VR_RL_TUNER="$(command -v vr-rl-tuner || true)"
if [[ -z "$VR_RL_TUNER" ]]; then
  VR_RL_TUNER="$(cd "$HERE/../../bin" && pwd)/vr-rl-tuner"
fi

if [[ ! -x "$VR_RL_TUNER" ]]; then
  echo "could not locate vr-rl-tuner; expected on PATH or at $VR_RL_TUNER" >&2
  exit 1
fi

NAME_FLAG=""
[[ -n "$NAME" ]] && NAME_FLAG="--name $NAME"

GOAL="Find the best SAC hyperparameters on HalfCheetah-v4 within 100k env steps. Metric: mean episode return over 10 eval rollouts (deterministic policy). Higher is better. Knobs to consider: learning rate, gamma, tau, alpha, batch size, learning_starts. Stop when rank-1 to rank-5 leaderboard gap < 1σ across 3-seed cells."

BUDGET="1 GPU-hour local · \$0 cloud (no Modal/RunPod for v1)"

# shellcheck disable=SC2086
"$VR_RL_TUNER" \
  --repo "$HERE" \
  --goal "$GOAL" \
  --budget "$BUDGET" \
  --library "$LIBRARY" \
  --base "lr=3e-4,gamma=0.99,tau=0.005,alpha=auto,batch_size=256,total_steps=100000,learning_starts=10000" \
  $NAME_FLAG

echo
echo "Next steps:"
echo "  1. cd into your library: cd \"$LIBRARY\""
echo "  2. Open Claude Code in that directory."
echo "  3. Tell the agent: \"Use the rl-sweep-tuner skill to take over"
echo "     projects/<the-slug-printed-above>.\""
echo "  4. The agent will read kickoff.json + the README + start running"
echo "     moves. Don't forget to set WANDB_API_KEY if you want wandb logs."
