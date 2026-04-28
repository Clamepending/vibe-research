---
metric: readability
benchmark_version: v1
---
# v2-scaffold

## TAKEAWAY

Tightened scaffold pushed readability from 3.4 to 4.1 mean.

## STATUS

resolved

## STARTING POINT

[r/v1-baseline@aaaaaaa](https://github.com/example/prose-style/tree/r/v1-baseline)

## BRANCH

[r/v2-scaffold](https://github.com/example/prose-style/tree/r/v2-scaffold)

## AGENT

0

## Question

Does adding "answer in two sentences" plus an explicit conciseness instruction lift readability?

## Hypothesis

Prior 50% confident this lifts mean ≥0.5 over baseline.

## Cycles

- `cycle 1 @bbbbbbb: scaffold + length cap -> readability mean=4.1. qual: conciseness 4+, clarity unchanged, accuracy unchanged.`

## Results

Mean 4.1 across the 20-prompt golden set under bench v1.

## Leaderboard verdict

vs rank 1 (v1-baseline): better on readability (this: 4.1, rank 1: 3.4) — same bench v1.
Decision: insert at rank 1.
