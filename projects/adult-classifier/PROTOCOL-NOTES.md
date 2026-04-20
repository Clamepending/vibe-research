# adult-classifier — protocol notes

Running notes on what the v2 research-agent protocol does well and where it rubs on this quantitative project. Updated as moves run. Not a result doc — this is meta-observation about the *protocol itself*, to be reviewed after the project terminates.

## Things that worked

- **Step-0 GitHub remote mandate**: caught the same SSH/HTTPS gotcha as haiku, but once switched to HTTPS, push-per-cycle is cheap and the code repo URLs in the wiki actually resolve. Material improvement over the horror retrofit.
- **One branch per move + one commit per cycle**: `git log --all --oneline --graph` on the code repo is a readable history of the project. For move 3 (FE) the commit message alone tells you the outcome ("Δ = -0.00007, within-noise, do not admit").
- **Admission rule on quantitative with noise estimate**: fired cleanly on move 3 FE. Δ = -0.00007 vs 2×std margin 0.00390 → unambiguous reject. Without the noise estimate this would've read as "ties rank 1"; with it, we can say "no evidence of improvement."
- **Hypothesis + falsifier per move**: kept me honest. Move 3 FE prior was 35% — when it came in flat, that matched the *low-confidence* hypothesis, not a surprise. If I'd written "confident FE will help," a null result would have read as an upset; because I wrote a probability, the null just updates the posterior on "default HistGBT is already near the feature-ceiling."

## Things to fix in the protocol

### 1. Noise estimate must be required for quantitative, not conditional

Current prompt says: `"beats" = strictly better on the named metric (beyond noise, if you have a noise estimate).`

The *if* is a bug. For quantitative projects, without a noise estimate the admission rule is meaningless — you can't distinguish a real gain from seed luck. Every admission rides on it.

**Fix:** schema for quantitative result docs should require `<metric>_mean` and `<metric>_std` (or an equivalent noise estimate) and the leaderboard score column should carry both. The admission rule should be stated as:

> **quantitative** — "beats" = `variant_mean − rank_k_mean > 2 × rank_k_std` (or stricter if the project defines its own threshold). Result docs MUST report mean + std across ≥3 seeds.

### 2. Seed-queue starting-point placeholders are ambiguous

I seeded three queue rows with `starting-point: *(rank 1 at time of move)*`. That's a readable shorthand but it's not a SHA — and the protocol elsewhere says "every wiki reference to code is a GitHub URL pinned to a SHA." At claim time I resolved it to the current rank 1 (GBT@7250242). A strict reader could call this ambiguous or claim it allows retroactive re-interpretation.

**Fix options** (pick one):
- (a) require all starting-points to be real SHAs at seed time; re-seed if they need to move.
- (b) explicitly legitimize `"rank N at claim"` as a placeholder with the rule "resolved to the SHA of the leaderboard row at time of claim, recorded in the result doc's STARTING POINT field."

Option (b) is lighter and matches how I actually used it. Either way, document it.

### 3. Ablation / orthogonality moves don't fit "cycles chain linearly"

Horror's V5 and haiku's ban-only were single ablations: one config, one measurement, one cycle. Fine. But when I went to run `gbt-fe-ablation` for Adult — drop each of 5 FE features in turn — the natural shape is **N parallel sub-variants**, not a linear chain.

The protocol's strict reading is: "If you find yourself wanting to branch cycles (run two variants in parallel and compare), close this move and open two new moves instead." → 5 ablations would mean 5 new moves. Queue cap 5 would choke, and the result is 5 result docs carrying the same header/context repeated 5×.

**Fix:** explicitly allow an "ablation table" shape: one move, one result doc, one cycle that runs N parallel sub-configs and reports a comparison table. Add to the protocol:

> **Ablation moves** are an exception to "cycles chain linearly." One ablation move may run N parallel sub-variants in a single cycle, reporting a table. Each sub-variant gets its own output dir (`outputs/<slug>/<sub>/`). The move's result doc treats the table as the headline result; no need for N separate moves.

### 4. "Analysis-only cycles get `git commit --allow-empty`" is a fine rule but needs an example

Came up implicitly when I wrote per-move "Analysis" sections that were narrative-only after the numbers were in. I used one full commit for "cycle + analysis" rather than separating them. Cleaner might be: cycle commit = numbers, analysis-only commit = interpretation. But the protocol doesn't say that's wrong, and at 1s per cycle the extra commit feels like noise.

Not a blocker, but the protocol would be clearer with one example run showing the intended separation (or explicitly saying "analysis can ride on the cycle commit when short").

### 5. `score / verdict` column is awkward for quantitative with noise

Current leaderboard:

```
| 1 | gradient-boosted-trees | val_auc = 0.9290 ± 0.00195 (n=5); +0.0218 over baseline (4.3× margin); admission threshold for challengers: AUC > 0.9329 |
```

That's three facts stuffed into one cell: the score, the delta-from-predecessor, and the derived admission threshold. Works but hard to scan.

**Fix:** for quantitative, split into columns:
```
| rank | result | branch | commit | mean | std (n) | vs rank-1 | admits if > |
```

Keep `score / verdict` as-is for qualitative. Per-project flavor.

### 6. The `<N>. <one-line>` verbs in Queue updates are good; the conditional "rank 1 at time of move" starting-point breaks on them

When I added `gbt-fe-ablation` during FE resolve with starting-point `r/feature-engineering@ca199d2`, I pinned a SHA. Good. But when I seeded `gbt-hparam-tune` originally with `*(rank 1 at time of move)*`, I couldn't pin — rank 1 didn't exist yet. Two different styles living in the same QUEUE table is confusing.

**Fix:** same as (2). Pick one.

## Things I'd also flag from the run

- **Commit-message format** `r/<slug> cycle N: <change> -> <metric>. qual: <one line>.` worked but is long. The convention of putting quantitative metrics in the subject line means you can read `git log` as a protocol summary, which is nice — preserve this.
- **`Insights touched` optional section** — not used in this quantitative project because no cross-move insight crystallized yet. That's fine; the section is still worth having because the horror + haiku projects demonstrated it does carry weight when insights exist.
- **Review mode** is what I'm about to enter when the queue empties. Writing this now so I can compare "how the protocol feels during work" to "how it feels in review."
