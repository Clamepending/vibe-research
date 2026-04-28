---
version: v1
last_updated: 2026-04-27
status: active
---

# prose-style benchmark

## PURPOSE

Score short-form answers on readability using a fixed 1-5 rubric over a held-out set of 20 prompts. Out of scope: factual accuracy, code correctness, length-normalised information density. Optimising readability without an accuracy guard rail will trade truthfulness for prose smoothness — that is the failure mode the contamination check below was designed to catch.

## METRICS

| name | kind | direction | computed by |
|------|------|-----------|-------------|
| readability | rubric | higher | `python eval/judge.py --rubric benchmark/judge-rubric.md --prompts benchmark/golden-set.jsonl` |

## DATASETS

| split | path | size | provenance |
|-------|------|------|------------|
| golden | benchmark/golden-set.jsonl | 20 | held-out, hand-curated 2026-04-27, never inspected during hillclimb |
| dev | benchmark/dev-set.jsonl | 50 | dev split, OK to look at; rotates monthly |

## RUBRICS

- [judge-rubric.md](benchmark/judge-rubric.md) — readability dimensions: clarity, conciseness, accuracy. 1-5 scale, anchored examples.

## CALIBRATION

| metric | target | measured | when | by |
|--------|--------|----------|------|-----|
| readability | Cohen's κ ≥ 0.6 | 0.71 | 2026-04-27 | two independent passes (claude-opus-4-7, gpt-5) |

## CONTAMINATION CHECKS

- 2026-04-27: golden-set.jsonl prompts grepped against the project's training corpus and dev-set — 0 hits.

## HISTORY

| version | date | change | reason | superseded |
|---------|------|--------|--------|------------|
| v1 | 2026-04-27 | initial | first cut | - |
