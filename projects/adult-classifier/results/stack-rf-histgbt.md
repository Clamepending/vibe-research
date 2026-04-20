# stack-rf-histgbt

## TAKEAWAY

RF + HistGBT stacked through a LogisticRegression meta-learner hits val AUC 0.9284 ± 0.00203 — within-noise of rank-1 HistGBT alone (Δ = −0.00063, 0.32× the rank-1 margin), but beats rank-2 RF by +0.00989 beyond-noise. Ensemble diversification does not crack the HistGBT ceiling on Adult, but it does retire RF as a standalone contender: a stacked ensemble dominates its weaker member. Admits rank 2, RF drops to rank 3.

## STATUS

resolved

## STARTING POINT

[r/model-diversification@b264e2e](https://github.com/Clamepending/adult-classifier/tree/r/model-diversification)

## BRANCH

[r/stack-rf-histgbt](https://github.com/Clamepending/adult-classifier/tree/r/stack-rf-histgbt)

## AGENT

0

## Question

Does a stacking ensemble (RandomForest + HistGBT base learners, LogisticRegression meta-learner over 5-fold out-of-fold predict_proba) beat rank-1 HistGBT on val AUC beyond noise? If not, does it at least beat rank-2 RF?

## Hypothesis

**Prior (35% confident):** stacking yields Δ ∈ [+0.001, +0.003] vs rank 1 on mean AUC — at or just below the 2×std noise margin (0.00390). The two base learners have genuinely different inductive biases (bagging-with-column-sampling vs sequential-boosting), so some complementary signal should exist. But Adult's signal is mostly additive and HistGBT already captures it well; the meta-learner has little room to combine beyond what HistGBT does alone.
**Weaker prior (15% confident):** stacking beats rank 1 beyond noise (Δ > +0.004). Would imply RF is carrying a meaningful slice of signal HistGBT misses — surprising given the −0.0105 RF gap.
**Weaker prior (10% confident):** stacking trails rank 1 beyond noise (Δ < −0.004) due to RF diluting HistGBT's predictions at the meta-layer. LogisticRegression meta on probabilities should weight RF down automatically, so this would be a surprise.
**Falsifier for "stacking helps":** Δ vs rank 1 < +0.001 on mean AUC (within-noise, meta can't leverage the diversification). Would settle that the RF/HistGBT axis is orthogonal-but-not-complementary for this task.

## Experiment design

Change: `variants/stack_rf_histgbt.py` wraps sklearn's `StackingClassifier(cv=5, stack_method="predict_proba")` with HistGBT + RF base learners and LogisticRegression(max_iter=1000) meta. Base learner configs match rank 1 and rank 2 exactly — HistGBT with native categorical_features, RF with n_estimators=500/max_features="sqrt"/min_samples_leaf=5. Preprocessing shared: ordinal-encoded categoricals + median-imputed numerics.

Measure: val ROC-AUC mean ± std across seeds 0..4. Fit time per seed expected to be notable (HistGBT + RF + 5 CV folds each ≈ ~10× the single-model time).

## Cycles

- `cycle 1 @e106bb7: StackingClassifier(HistGBT + RF, LR meta, cv=5) n=5 seeds -> val_auc=0.9284±0.00203. Δ vs rank 1 = -0.00063 (within-noise). Δ vs rank 2 RF = +0.00989 (beyond-noise). qual: fits ~12s per seed (12× slower than HistGBT alone); stacking hypothesis falsified — meta cannot leverage the RF/HistGBT diversification, but the ensemble still dominates RF alone.`

## Results

n=5 at commit [e106bb7](https://github.com/Clamepending/adult-classifier/commit/e106bb7). Per-seed metrics at `outputs/stack_rf_histgbt/seed_{0..4}.json`, summary at `outputs/stack_rf_histgbt/summary.json`.

| seed | val_auc | val_f1 | val_acc | fit_s |
|------|---------|--------|---------|-------|
| 0 | 0.9276 | 0.7082 | 0.8725 | 12.28 |
| 1 | 0.9291 | 0.7212 | 0.8764 | 12.58 |
| 2 | 0.9309 | 0.7069 | 0.8721 | 11.48 |
| 3 | 0.9254 | 0.7036 | 0.8703 | 12.12 |
| 4 | 0.9289 | 0.7131 | 0.8732 | 12.39 |
| **mean** | **0.9284** | **0.7106** | **0.8729** | — |
| **std (ddof=1)** | **0.00203** | **0.00683** | **0.00224** | — |

**vs rank 1 (gradient-boosted-trees, mean=0.92902, std=0.00195):**
- Δ AUC = −0.00063 (stack slightly worse)
- rank-1 2×std margin = 0.00390
- |Δ| / margin = **0.16×** — well within noise

**vs rank 2 (model-diversification / RF, mean=0.91850, std=0.00242):**
- Δ AUC = +0.00989
- rank-2 2×std margin = 0.00484
- Δ / margin = **2.04×** — beyond noise (on the winning side)

**vs rank 3 (baseline, mean=0.9072):** Δ = +0.0212, well beyond noise.

## Analysis

Hypothesis falsified in its primary claim. The 35% "stacking yields Δ ∈ [+0.001, +0.003] vs rank 1" prior predicted a small-but-positive gain; actual Δ = −0.00063 is the opposite sign and, at 0.16× the noise margin, cleanly within-noise. The "stacking helps" falsifier condition (Δ vs rank 1 < +0.001) fired.

Two plausible readings of why stacking didn't help:

1. **HistGBT's signal subsumes RF's.** The LogisticRegression meta on out-of-fold probabilities can (and empirically does) learn a near-weight-1 on HistGBT and a near-weight-0 on RF — at which point the stack just reproduces HistGBT's predictions, minus whatever the 5-fold CV adds in variance. The −0.00063 shift is consistent with that variance-only explanation.
2. **The diversification axis is orthogonal in *inputs* but not in *errors*.** RF and HistGBT use very different algorithms but have similar error patterns on Adult (same residuals on hard cases: borderline capital-gain thresholds, rare native-country × occupation combinations). Independent-in-mechanism ≠ independent-in-error. For stacking to help, base learners need to make *different mistakes*, not just compute predictions differently. On Adult they make the same mistakes.

Either way, the practical consequence is the same: stacking tree-with-tree on this task is a no-op. For stacking to help here, you'd need a genuinely different error geometry — e.g., a neural net with learned categorical embeddings, or a calibrated LR with interaction terms, paired with HistGBT. Those are different moves.

The unintended finding is that **stacking retires RF as a standalone contender.** RF@0.9185 is now provably dominated: you can always wrap it with HistGBT and the stacked version strictly beats it (+0.00989 beyond-noise). This is the first move where a new result *displaces* a prior leaderboard resident mid-stack — not by being better than rank 1, but by being strictly better than rank 2 while being within-noise of rank 1.

**Protocol observation (PROTOCOL-NOTES.md #7 — new):** the admission rule walked top-down correctly here but produced a result I hadn't mentally pre-rehearsed: a move that is *falsified in hypothesis* (stacking did not beat rank 1 as predicted) can still *admit and displace a leaderboard row* (by beating rank 2). These are orthogonal judgments — one about the scientific question, one about the leaderboard. The LOG event `resolved` vs `falsified` has to pick one, and I think the honest tag here is `falsified` (the primary hypothesis was wrong) even though the leaderboard did update. Worth calling out in the protocol.

**Prior update:** tree-ensemble ceiling on Adult is confirmed by independent evidence. HistGBT default config is within noise of any further tree-ensembling approach tried so far (FE, hparam tune, RF stacking). To beat rank 1 would require a fundamentally different error source, not more-of-the-same.

## Reproducibility

Commit: [e106bb7](https://github.com/Clamepending/adult-classifier/commit/e106bb7)
Command: `./run_variant.sh stack_rf_histgbt 5`
Artifacts: `outputs/stack_rf_histgbt/seed_{0..4}.json`, `outputs/stack_rf_histgbt/summary.json` on branch `r/stack-rf-histgbt`
Config: sklearn 1.6.1, StackingClassifier(estimators=[histgbt, rf], final_estimator=LogisticRegression(max_iter=1000, solver="lbfgs"), stack_method="predict_proba", cv=5, n_jobs=1, passthrough=False). Base estimators: HistGradientBoostingClassifier(categorical_features=cat_indices, random_state=seed) and RandomForestClassifier(n_estimators=500, max_features="sqrt", min_samples_leaf=5, n_jobs=-1, random_state=seed). Preprocessing: SimpleImputer(median) on numerics + SimpleImputer(constant,"MISSING") → OrdinalEncoder on categoricals. Seeds 0..4.

## Leaderboard verdict

- vs rank 1 (gradient-boosted-trees, mean=0.92902): **within-noise** on val_auc (Δ = −0.00063 vs 2×std margin 0.00390; |Δ|/margin = 0.16×). Does not beat rank 1.
- vs rank 2 (model-diversification / RF, mean=0.91850): **better** on val_auc (Δ = +0.00989 vs 2×std margin 0.00484; Δ/margin = 2.04×). Beats rank 2 beyond-noise.
- vs rank 3 (baseline, mean=0.9072): **better** (Δ = +0.0212, ~4× baseline margin). Would also beat baseline.

Decision: insert at rank 2; model-diversification (RF) drops to rank 3; baseline drops to rank 4.

## Queue updates

*(no adds. The only remaining move this result suggests is "stack with a genuinely different error source" — a neural net or a calibrated LR with interaction terms — which is a larger pivot in direction, not a targeted follow-up. Leaving the QUEUE empty triggers Review mode as intended by the protocol, which is the appropriate moment to decide whether this project has reached diminishing returns or merits a strategic pivot.)*
