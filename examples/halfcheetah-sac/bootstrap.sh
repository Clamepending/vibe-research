#!/usr/bin/env bash
# Bootstrap a Python venv + deps + smoke-test the HalfCheetah SAC trainer.
#
# Run once before kicking off the autonomous tuner. After this passes,
# `python train.py --total-steps=1000` should produce a `mean_return: <num>`
# line and exit 0.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ ! -d .venv ]]; then
  echo "[bootstrap] creating .venv …"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "[bootstrap] upgrading pip …"
python -m pip install --upgrade pip >/dev/null

echo "[bootstrap] installing requirements (this can take a few minutes for torch + mujoco) …"
pip install -r requirements.txt

echo "[bootstrap] verifying mujoco import …"
python -c "import mujoco; print('mujoco OK', mujoco.__version__)"

echo "[bootstrap] verifying gymnasium HalfCheetah-v4 …"
python -c "import gymnasium as gym; env = gym.make('HalfCheetah-v4'); env.reset(); print('env OK', env.observation_space.shape)"

echo "[bootstrap] running 1k-step smoke train …"
python train.py --total-steps=1000 --learning-starts=200 --eval-episodes=2 --seed=0

echo
echo "[bootstrap] OK. Activate the venv with: source $HERE/.venv/bin/activate"
echo "Then run: $HERE/kickoff.sh <abs-path-to-vibe-research-library>"
