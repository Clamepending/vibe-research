---
metric: readability
benchmark_version: v1
---
# v1-baseline

## TAKEAWAY

Default scaffold scored 3.4 mean readability on the v1 golden set.

## STATUS

resolved

## STARTING POINT

[main](https://github.com/example/prose-style/tree/main)

## BRANCH

[r/v1-baseline](https://github.com/example/prose-style/tree/r/v1-baseline)

## AGENT

0

## Question

What does the default scaffold score on readability?

## Hypothesis

Prior 80% confident the default scores between 3.0 and 3.6.

## Cycles

- `cycle 1 @aaaaaaa: default scaffold over 20-prompt golden set -> mean=3.4. qual: clarity hits 4+ but conciseness drags to 2.8.`

## Results

Mean 3.4 across the 20-prompt golden set under bench v1, two-judge passes.

## Leaderboard verdict

vs rank 1 (none): incomparable.
Decision: insert at rank 1 (empty leaderboard).
