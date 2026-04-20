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
| 1 | [gradient-boosted-trees](results/gradient-boosted-trees.md) | [r/gradient-boosted-trees](https://github.com/Clamepending/adult-classifier/tree/r/gradient-boosted-trees) | [7250242](https://github.com/Clamepending/adult-classifier/commit/7250242) | val_auc = 0.9290 ± 0.00195 (n=5); admission threshold for challengers: AUC > 0.9329 |
| 2 | [stack-rf-histgbt](results/stack-rf-histgbt.md) | [r/stack-rf-histgbt](https://github.com/Clamepending/adult-classifier/tree/r/stack-rf-histgbt) | [e106bb7](https://github.com/Clamepending/adult-classifier/commit/e106bb7) | val_auc = 0.9284 ± 0.00203 (n=5); within-noise of rank 1 (Δ=-0.00063), beats RF +0.0099 beyond-noise |
| 3 | [model-diversification](results/model-diversification.md) | [r/model-diversification](https://github.com/Clamepending/adult-classifier/tree/r/model-diversification) | [b264e2e](https://github.com/Clamepending/adult-classifier/commit/b264e2e) | val_auc = 0.9185 ± 0.00242 (n=5); RandomForest — beats baseline +0.0113 beyond-noise, trails rank 1 by 0.0105 |
| 4 | [baseline](results/baseline.md) | [r/baseline](https://github.com/Clamepending/adult-classifier/tree/r/baseline) | [2d355fc](https://github.com/Clamepending/adult-classifier/commit/2d355fc) | val_auc = 0.9072 ± 0.00254 (n=5); noise floor |

## INSIGHTS

*(none yet — quantitative project, no cross-move insights crystallized.)*

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| *(empty — enter review mode)* | — | — |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
| 2026-04-20 | falsified | stack-rf-histgbt | StackingClassifier(RF+HistGBT, LR meta): val_auc=0.9284±0.00203, Δ vs rank 1 = -0.00063 (within-noise, stacking-helps falsified); but +0.0099 vs rank 2 RF beyond-noise — admits rank 2, RF drops to rank 3, baseline to rank 4 | [stack-rf-histgbt.md](results/stack-rf-histgbt.md) |
| 2026-04-20 | resolved | model-diversification | RandomForest n_estimators=500: val_auc=0.9185±0.00242, -0.0105 vs rank 1, +0.0113 vs baseline — admits rank 2, baseline evicted to rank 3 | [model-diversification.md](results/model-diversification.md) |
| 2026-04-20 | resolved | gbt-fe-ablation | drop-one ablation 5 feats × 5 seeds: 3/5 drops bit-identical (tree ignored them); max |Δ|=0.00012; confirms FE null | [gbt-fe-ablation.md](results/gbt-fe-ablation.md) |
| 2026-04-20 | resolved | gbt-hparam-tune | RandomizedSearchCV n_iter=12: val_auc=0.9293±0.00166, Δ vs rank 1 = +0.00023 — within-noise, does not admit | [gbt-hparam-tune.md](results/gbt-hparam-tune.md) |
| 2026-04-20 | resolved | feature-engineering | 5 hand-crafted features on HistGBT: val_auc=0.9290±0.00171, Δ vs rank 1 = -0.00007 — within-noise, first non-admission | [feature-engineering.md](results/feature-engineering.md) |
| 2026-04-20 | resolved | gradient-boosted-trees | HistGBT + native cats: val_auc=0.9290±0.00195 (+0.0218, 4.3× margin); admits rank 1 beyond noise | [gradient-boosted-trees.md](results/gradient-boosted-trees.md) |
| 2026-04-20 | resolved | baseline | logreg + onehot + scaled numerics: val_auc=0.9072±0.00254 (n=5); noise floor set, admission threshold 0.9123 | [baseline.md](results/baseline.md) |
| 2026-04-20 | review | seed | project seeded as quantitative protocol pressure-test (Adult binary classification, val_auc ranking, 4 moves queued) | [README](./README.md) |
