---
metric: wibble
metric_higher_is_better: true
seeds: [0, 1, 2]
mean: 0.72
std: 0.015
---
# v1-baseline

## TAKEAWAY

Baseline configuration measured at wibble=0.72.

## STATUS

resolved

## STARTING POINT

[main](https://github.com/example/widget-tuning/tree/main)

## BRANCH

[r/v1-baseline](https://github.com/example/widget-tuning/tree/r/v1-baseline)

## AGENT

0

## Question

What does the default widget configuration score on wibble?

## Hypothesis

Prior 90% confident the default scores between 0.70 and 0.75.

## Cycles

- `cycle 1 @bbbbbbb: default config, n=3 seeds -> wibble_mean=0.72 std=0.015. qual: clean run, no anomalies.`

## Results

Mean across three seeds was 0.72 with std 0.015.

## Leaderboard verdict

vs rank 1 (none): incomparable.
Decision: insert at rank 1 (empty leaderboard).
