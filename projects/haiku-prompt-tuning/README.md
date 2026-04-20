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
| 1 | [composite](results/composite.md) | [r/composite](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/composite) | [e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/commit/e3e270c) | 5-6/6 craft hits, 0/6 conspicuous attractor collapse, 0/6 meta-leak, 6/6 domain variety; subtle summer-season residual (5/6) on unbanned axis |
| 2 | [ban-only](results/ban-only.md) | [r/ban-only](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/ban-only) | [187e4b2](https://github.com/Clamepending/haiku-prompt-tuning/commit/187e4b2) | 5/6 "Rust..." opener (new attractor); 5/6 concrete image, 0/6 abstract closer, 0/6 meta-leak — craft better than baseline but strong rust/decay mode collapse |
| 3 | [positive-only](results/positive-only.md) | [r/positive-only](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/positive-only) | [7a4c0f5](https://github.com/Clamepending/haiku-prompt-tuning/commit/7a4c0f5) | 4/6 mountain/hill opener, 6/6 small-creature+petal formula, 1/6 asterisk meta-leak; classical-pastoral attractor, incomparable to rust |
| 4 | [baseline](results/baseline.md) | [r/baseline](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/baseline) | [12fd65e](https://github.com/Clamepending/haiku-prompt-tuning/commit/12fd65e) | 5/6 "Silent..." opener + 4/6 abstract closer + 1/6 meta-leak; Zen-pastiche attractor, hit rate ~1/6 |

## INSIGHTS

*(none yet — this project is testing whether [attractor-naming](../../insights/attractor-naming.md) extends here)*

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| season-unlocked-composite | [r/composite@e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/composite) | Extend composite ban list with "require season variety" to kill the summer-lock residual. |
| composite-rerun-n8 | [r/composite@e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/composite) | Larger-n replication of composite (n=8) to verify the 5-6/6 hit rate holds. |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
| 2026-04-19 | resolved | composite | composite produces 5-6/6 craft variety, 0/6 conspicuous attractor collapse; subtle summer-season residual on unbanned axis — confirms attractor-naming with new sub-finding | [composite.md](results/composite.md) |
| 2026-04-19 | resolved | positive-only | positive-only routes to classical-pastoral attractor (mountain+insect+petal); third distinct attractor confirmed | [positive-only.md](results/positive-only.md) |
| 2026-04-19 | resolved | ban-only | ban-only routes to rust/industrial-decay attractor (5/6 "Rust..." opener); banned forms absent; craft > baseline, variety < baseline | [ban-only.md](results/ban-only.md) |
| 2026-04-19 | resolved | baseline | baseline collapses to Zen-pastiche attractor: 5/6 "Silent..." opener, 4/6 abstract closer, 1/6 meta-leak, hit rate ~1/6 | [baseline.md](results/baseline.md) |
| 2026-04-19 | review | seed | project seeded to test attractor-naming generalization on haiku; 4 moves queued (baseline / ban-only / positive-only / composite) | [README](./README.md) |
