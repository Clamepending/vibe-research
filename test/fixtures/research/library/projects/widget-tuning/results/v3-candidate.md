---
metric: wibble
metric_higher_is_better: true
seeds: [0, 1, 2]
mean: 0.91
std: 0.018
---
# v3-candidate

## TAKEAWAY

Knob=2.0 candidate scores 0.91 (vs v2-tuned at 0.84).

## STATUS

active

## STARTING POINT

[r/v2-tuned@aaaaaaa](https://github.com/example/widget-tuning/tree/r/v2-tuned)

## BRANCH

[r/v3-candidate](https://github.com/example/widget-tuning/tree/r/v3-candidate)

## AGENT

0

## Question

Does knob=2.0 beat knob=1.5?

## Hypothesis

Prior 50%.

## Cycles

- `cycle 1 @ccccccc: knob=2.0, n=3 seeds -> wibble_mean=0.91 std=0.018.`
