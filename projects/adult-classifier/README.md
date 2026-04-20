# adult-classifier

## GOAL

Find the best pipeline for the UCI Adult income binary-classification task on val ROC-AUC with `claude-sonnet-4-6`-equivalent sklearn tooling. Secondary goal: pressure-test the v2 research-agent protocol on a *quantitative* project — does the "beats beyond noise" admission clause fire cleanly, does the QUEUE cap at 5 bind on a hillclimb that naturally wants 8–12 moves, does the cycle-per-commit cadence feel right at 10-second train times?

## CODE REPO

https://github.com/Clamepending/adult-classifier

## SUCCESS CRITERIA

- A pipeline that beats the logistic-regression baseline by ≥ 2× the baseline's seed-noise std on val ROC-AUC.
- At least one orthogonality / ablation move so we know which components are load-bearing (analog of V5 ban-ablation in horror).
- At least one leaderboard admission decision that hinges on the "beats beyond noise" clause (either admits at the boundary or is explicitly rejected as within-noise).
- No data leakage — `fnlwgt` and the train/val split must be handled identically across variants.

## RANKING CRITERION

`quantitative: val_auc (higher is better)`

Noise estimate comes from n=5 seeds per variant; "beats beyond noise" = `variant_mean - rank_k_mean > 2 * rank_k_std` (conservative, roughly 95% one-sided at n=5).

## LEADERBOARD

| rank | result | branch | commit | score / verdict |
|------|--------|--------|--------|-----------------|
| — | — | — | — | *(empty at seed time)* |

## INSIGHTS

*(none yet — quantitative project, no cross-move insights crystallized.)*

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| baseline | [main@1f69f2a](https://github.com/Clamepending/adult-classifier/tree/main) | Logistic regression with one-hot + scaled numerics at n=5 seeds. Establish baseline AUC and the seed-noise std that downstream "beats beyond noise" checks will use. |
| gradient-boosted-trees | [main@1f69f2a](https://github.com/Clamepending/adult-classifier/tree/main) | Swap model family to HistGradientBoosting with the same raw features. Biggest expected gain; sets the real ceiling to beat. |
| feature-engineering | *(rank 1 at time of move)* | Add interaction features + target encoding on top of the rank-1 pipeline. Likely noise-boundary result — good admission-rule stress test. |
| gbt-hparam-tune | *(rank 1 at time of move)* | Small random search over GBT hyperparameters. Incremental; may be within noise. |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
| 2026-04-20 | review | seed | project seeded as quantitative protocol pressure-test (Adult binary classification, val_auc ranking, 4 moves queued) | [README](./README.md) |
