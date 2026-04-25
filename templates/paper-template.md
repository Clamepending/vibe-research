# <Project title>

> Living research paper. The human reads this; agents update it section-by-section as moves resolve. The full lab notebook (every move, including failures) lives in `results/*.md`. The project index lives in `README.md`.

## Since last update

<!-- Newest first. One line per cycle: `- @<short-sha> <one line>`. After a `review` LOG row, start a fresh dated sub-block: `### YYYY-MM-DD review`. -->

- _no entries yet_

## Abstract

<!-- 5-7 sentences. Written LAST. Stub until the first review with admitted insights. Order: what we asked → what we did → what we found → what we ruled out → what's next. -->

_Stub: not enough evidence yet._

## 1. Question

<!-- locked: pre-registration -->

What are we trying to learn? Why does it matter? One paragraph. Inherits the project README's GOAL but states it from the paper's reader's perspective: a curious peer skimming the abstract.

## 2. Background & related work

What does the existing literature, code, or docs already say about this question? Cite primary sources (papers, official docs, source pages, datasets, benchmarks). If "no support found", say so explicitly — that lowers our prior on novelty.

## 3. Method

<!-- locked: pre-registration -->

- **Setup.** Hardware, software, dataset/benchmark, model, key hyperparameters that are fixed across moves.
- **Variable.** What we change between moves.
- **Measurement.** Inherits the project README's `RANKING CRITERION`. State it explicitly here, including the noise rule for quantitative criteria (default: `2 x std` across `n >= 3` seeds).
- **Success.** Concrete observation that would convince a skeptical reader.
- **Falsifier.** Concrete observation that would force us to abandon the frame.

## 4. Results

<!-- One subsection per resolved move (or family of moves). Each subsection cross-links to `results/<slug>.md` for full provenance and footnotes every numeric or qualitative claim. -->

_No resolved moves yet._

<!--
### 4.1 <move-slug> — <one-line headline finding>

See [`results/<move-slug>.md`](./results/<move-slug>.md). Headline finding: accuracy 0.78 ± 0.02 across 3 seeds[^<move-slug>-agg], a 6-point lift over the baseline[^baseline-c1] and within noise of rank 1[^rank1-link].

Footnote slugs use the pattern `[^<move-slug>-c<N>]` for cycle N of a move, and `[^<move-slug>-agg]` for the aggregate across seeds. Pick one pattern and stick with it across the paper.

[^baseline-c1]: <github-url>/commit/<sha> · `python train.py --config baseline.yaml --seed 0` · `runs/baseline/seed-0/metrics.json`
[^<move-slug>-agg]: <github-url>/commit/<sha> · `python train.py --config dropout-aug.yaml --seeds 0,1,2` · `runs/dropout-aug/metrics.csv`
-->

## 5. Discussion

What the results show together. What they rule out. How the prior shifted. Where the leaderboard now stands. Open questions that the next move could close.

## 6. Limitations

<!-- One bullet per resolved move: what this move did NOT test. Empty after the second resolved move is a bug. -->

- _no entries yet_

## 7. Reproducibility appendix

- Code repo: _<github-url>_
- Library snapshot: _<github-url> at commit `<sha>`_
- Per-result reproduction lives in each `results/<slug>.md` "Reproducibility" section (commit SHA, exact command, artifact paths, config + seed).
- Hardware flavor and expected cost class for the typical move: _fill in_.

## 8. References

<!-- Primary sources cited above. Numbered or by author-year — pick one and stick with it. -->

- _no entries yet_
