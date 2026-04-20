# gbt-fe-ablation

## TAKEAWAY

*(pending)*

## STATUS

active

## STARTING POINT

[r/feature-engineering@ca199d2](https://github.com/Clamepending/adult-classifier/tree/r/feature-engineering)

## BRANCH

[r/gbt-fe-ablation](https://github.com/Clamepending/adult-classifier/tree/r/gbt-fe-ablation)

## AGENT

0

## Question

Does any single one of the five FE derived features (`capital_net`, `has_capital_gains`, `hours_bucket`, `is_married`, `log_fnlwgt`) carry a meaningful positive or negative effect on val AUC — i.e. does dropping it move AUC by more than rank-1's 2×std margin (0.00390)?

## Hypothesis

**Prior (70% confident):** no single feature moves AUC beyond noise in either direction. If all five jointly added zero (FE cycle result), then dropping each individually should also not significantly change performance — HistGBT already extracts the underlying signal.
**Falsifier:** dropping one feature produces Δ > +0.004 (that feature was *hurting*) OR Δ < −0.004 (that feature was quietly load-bearing despite the joint-null FE result).

## Experiment design

Change: run the FE pipeline 6 × 5 = 30 times. The six configs are `none` (full FE, control) plus one each with `capital_net`, `has_capital_gains`, `hours_bucket`, `is_married`, `log_fnlwgt` dropped. Each config runs at seeds 0..4 and reports val AUC mean ± std.
Measure: for each drop, Δ = mean(drop) − mean(none). Flag any |Δ| > 0.004. This is an ablation table, not a linear cycle chain — one cycle, six parallel sub-configs (see PROTOCOL-NOTES.md #3 for why).

## Cycles

*(in progress — this move bends the linear-cycle rule: single cycle, six parallel sub-configs. Noted in PROTOCOL-NOTES.md.)*

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
