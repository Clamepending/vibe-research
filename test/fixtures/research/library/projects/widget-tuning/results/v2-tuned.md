---
metric: wibble
metric_higher_is_better: true
seeds: [0, 1, 2]
mean: 0.84
std: 0.012
---
# v2-tuned

## TAKEAWAY

Tuned configuration jumps wibble from 0.72 to 0.84 across three seeds.

## STATUS

resolved

## STARTING POINT

[r/v1-baseline@bbbbbbb](https://github.com/example/widget-tuning/tree/r/v1-baseline)

## BRANCH

[r/v2-tuned](https://github.com/example/widget-tuning/tree/r/v2-tuned)

## AGENT

0

## Question

Does deepening the wibble knob from 1.0 to 1.5 improve wibble score?

## Hypothesis

Prior 60% confident knob=1.5 outperforms baseline by ≥2σ.

## Cycles

- `cycle 1 @aaaaaaa: knob=1.5, n=3 seeds -> wibble_mean=0.84 std=0.012.`

## Results

Mean 0.84, std 0.012. Beats baseline by 0.12 (~8 baseline-σ).

## Leaderboard verdict

vs rank 1 (v1-baseline): better on wibble (this: 0.84, rank: 0.72 ± 0.030).
Decision: insert at rank 1.
