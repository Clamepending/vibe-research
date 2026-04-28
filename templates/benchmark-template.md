---
version: v1
last_updated: 2026-04-28
status: draft
---

# <project-name> benchmark

> Versioned eval contract for this project. Every result doc cites a `benchmark_version` in its YAML frontmatter; admission across versions is blocked by default. Bump the version in this file's frontmatter (and add a HISTORY row) whenever you change rubrics, prompts, golden-set composition, or judge models.
>
> Required for `qualitative` and `mix` projects. Recommended for `quantitative` projects whose metric script lives outside the code repo or whose evaluation data is shared across moves.

## PURPOSE

One paragraph. What does this benchmark measure? Why does it exist? What does it deliberately *not* measure? Naming the out-of-scope failure modes here is half the point — Goodhart shows up the moment a benchmark stops mentioning what it ignores.

## METRICS

One row per metric the leaderboard can use. The `metric` field in each result doc's frontmatter must match one of these `name`s exactly.

| name | kind | direction | computed by |
|------|------|-----------|-------------|
| <name> | <numeric\|rubric\|judge\|preference> | <higher\|lower\|n/a> | `<exact command, including artifact paths>` |

`kind`:
- `numeric` — deterministic script (loss, accuracy, BLEU, eval-set hit rate).
- `rubric` — humans (or LLM judges) score against the rubric file linked below.
- `judge` — LLM-as-judge with a fixed, versioned prompt. The prompt file is part of the benchmark; bumping it bumps the bench version.
- `preference` — A/B side-by-side preference over a fixed prompt set. Direction is `n/a`; report win-rate.

## DATASETS

| split | path | size | provenance |
|-------|------|------|------------|
| golden | benchmark/golden-set.jsonl | <N> | held-out, never inspected during hillclimb |
| dev | benchmark/dev-set.jsonl | <N> | OK to look at; hillclimb on this; rotate if it drifts |

Leave empty if the project has no held-out evaluation data (e.g. method-research moves where the metric *is* the evaluation script).

## RUBRICS

For `rubric` and `judge` metrics. Each entry links to the file that *is* the rubric or judge prompt — that file is what gets versioned.

- [<file>](benchmark/<file>.md) — <one-line summary of what it scores>

Empty for purely numeric benchmarks.

## CALIBRATION

Required for any `rubric` or `judge` metric. If you do not yet have a measurement, write `pending` in the `measured` column — but `pending` for more than two resolved moves is a bug.

| metric | target | measured | when | by |
|--------|--------|----------|------|-----|
| <name> | <e.g. Cohen's κ ≥ 0.6> | <κ value or `pending`> | <YYYY-MM-DD> | <two-pass setup, model versions> |

## CONTAMINATION CHECKS

Bullet list. What did you check, when, against what.

- <YYYY-MM-DD>: <what was checked> → <result>

Empty if not applicable, but say so explicitly.

## HISTORY

Append-only, newest first. One row per version bump. Keep the row terse — the *why* matters more than the *what*.

| version | date | change | reason | superseded |
|---------|------|--------|--------|------------|
| v1 | <YYYY-MM-DD> | initial | first cut | - |
