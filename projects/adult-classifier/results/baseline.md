# baseline

## TAKEAWAY

*(pending — written after results)*

## STATUS

active

## STARTING POINT

[main@1f69f2a](https://github.com/Clamepending/adult-classifier/tree/main)

## BRANCH

[r/baseline](https://github.com/Clamepending/adult-classifier/tree/r/baseline)

## AGENT

0

## Question

What val ROC-AUC does a vanilla logistic regression on Adult achieve with one-hot-encoded categoricals + scaled numerics, and what is the across-seed noise std at n=5 that downstream "beats beyond noise" admission checks will use?

## Hypothesis

**Prior (70% confident):** val_auc mean in [0.895, 0.910], seed std ≤ 0.003. Adult is a well-behaved dataset and logistic regression is close to optimal among linear models.
**Falsifier:** std > 0.005 (noise too high for admission rule to resolve small deltas) OR mean < 0.88 (preprocessing bug).

## Experiment design

Change: logistic regression (lbfgs, max_iter=1000) on the pipeline `[median-impute + standardize numerics] ∥ [constant-impute 'MISSING' + one-hot categoricals]`. No feature engineering, no tuning.
Measure: val ROC-AUC, F1, accuracy across seeds 0..4 (stratified 80/20 split per seed). Report mean ± std.

## Cycles

*(in progress — fill after run)*

## Results

*(in progress)*

## Analysis

*(in progress)*

## Reproducibility

*(in progress)*

## Leaderboard verdict

*(in progress)*

## Queue updates

*(in progress)*
