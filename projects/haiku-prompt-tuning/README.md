# haiku-prompt-tuning

## GOAL

Find the best system prompt for `claude-sonnet-4-6` (via `claude -p --tools ""`) to write haiku that land as *craft* — concrete image, present-tense juxtaposition, implied cutting (kireji), no abstract sentiment words — instead of the formulaic cherry-blossom-and-quiet-time-passes slop the baseline is expected to produce. Secondary goal: test whether the [attractor-naming](../../insights/attractor-naming.md) insight from horror-prompt-tuning generalizes — does baseline collapse to one stereotype, ban-only to a different one, positive-only to a third, and composite produce varied craft?

## CODE REPO

https://github.com/Clamepending/haiku-prompt-tuning

## SUCCESS CRITERIA

- A prompt that produces varied, image-led, present-tense haiku at ≥80% hit rate across n≥8 samples.
- No mode collapse to a single stereotype (cherry blossoms, autumn leaves, snow on mountain, any single "eternal/forever/quiet" closing move).
- No prompt-leak or meta-output.
- Evidence on whether the three-distinct-attractors pattern from horror reproduces: if yes, [attractor-naming](../../insights/attractor-naming.md) scope extends; if no, we learn something about where the pattern breaks.

## RANKING CRITERION

`qualitative: haiku craft` — composite read of (a) hit rate per sample, (b) attractor-collapse resistance across samples, (c) concrete-image-with-cutting-juxtaposition, (d) absence of abstract sentiment words ("peace", "eternal", "forever", "quiet contemplation").

## LEADERBOARD

| rank | result | branch | commit | score / verdict |
|------|--------|--------|--------|-----------------|
| 1 | [baseline](results/baseline.md) | [r/baseline](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/baseline) | [12fd65e](https://github.com/Clamepending/haiku-prompt-tuning/commit/12fd65e) | 5/6 "Silent..." opener + 4/6 abstract closer + 1/6 meta-leak; Zen-pastiche attractor, hit rate ~1/6 |

## INSIGHTS

*(none yet — this project is testing whether [attractor-naming](../../insights/attractor-naming.md) extends here)*

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|
| ban-only | [results/ban-only.md](results/ban-only.md) | [r/ban-only](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/ban-only) | 0 | 2026-04-19 |

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| positive-only | [main@42ba2d6](https://github.com/Clamepending/haiku-prompt-tuning/tree/main) | "Concrete image, present tense, no sentiment" positive framing only, no bans. Tests positive-only-collapse. |
| composite | [main@42ba2d6](https://github.com/Clamepending/haiku-prompt-tuning/tree/main) | Bans + positive + "output only three lines." Tests whether the compose-pattern reproduces. |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
| 2026-04-19 | resolved | baseline | baseline collapses to Zen-pastiche attractor: 5/6 "Silent..." opener, 4/6 abstract closer, 1/6 meta-leak, hit rate ~1/6 | [baseline.md](results/baseline.md) |
| 2026-04-19 | review | seed | project seeded to test attractor-naming generalization on haiku; 4 moves queued (baseline / ban-only / positive-only / composite) | [README](./README.md) |
