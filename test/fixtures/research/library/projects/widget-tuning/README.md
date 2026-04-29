# widget-tuning

## GOAL

Find the configuration of the widget that maximises the wibble score.

## CODE REPO

`https://github.com/example/widget-tuning`

## SUCCESS CRITERIA

- Wibble score ≥ 0.85 across n=3 seeds with 2×std noise rule.
- Configuration described well enough that a fresh agent can reproduce it.

## RANKING CRITERION

`quantitative: wibble (higher is better)`

## LEADERBOARD

| rank | result | branch | commit | score / verdict |
|------|--------|--------|--------|-----------------|
| 1 | [v2-tuned](results/v2-tuned.md) | [r/v2-tuned](https://github.com/example/widget-tuning/tree/r/v2-tuned) | [aaaaaaa](https://github.com/example/widget-tuning/commit/aaaaaaa) | 0.84 mean across n=3 seeds |
| 2 | [v1-baseline](results/v1-baseline.md) | [r/v1-baseline](https://github.com/example/widget-tuning/tree/r/v1-baseline) | [bbbbbbb](https://github.com/example/widget-tuning/commit/bbbbbbb) | 0.72 mean across n=3 seeds |

## INSIGHTS

- [widget-knob-load-bearing](../../insights/widget-knob-load-bearing.md) — the wibble knob is load-bearing across configurations

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|
| v3-candidate | [v3-candidate](results/v3-candidate.md) | [r/v3-candidate](https://github.com/example/widget-tuning/tree/r/v3-candidate) | 0 | TODAY |

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| v3-deeper-knob | [r/v2-tuned@aaaaaaa](https://github.com/example/widget-tuning/tree/r/v2-tuned) | Push the knob further to see if wibble keeps improving. |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
| 2026-04-28 | resolved+admitted | v2-tuned | wibble jumped 0.72 → 0.84 with deeper knob | [v2-tuned.md](results/v2-tuned.md) |
| 2026-04-28 | resolved | v4-noisy | resolved but no noise frontmatter so admission blocked | [v4-noisy.md](results/v4-noisy.md) |
| 2026-04-27 | resolved+admitted | v1-baseline | baseline measured at 0.72 wibble | [v1-baseline.md](results/v1-baseline.md) |
