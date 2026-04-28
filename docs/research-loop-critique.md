# Research-loop critique — suggestions for improving CLAUDE.md

Walked the Vibe Research researcher prompt (currently in `CLAUDE.md`, 225 lines) end-to-end against `projects/horror-prompt-tuning` (which clearly used the loop and produced a leaderboard, paper, and result docs). What follows is concrete: each item names the line/concept the prompt currently has, the friction that hits in practice, and a specific change.

## Top suggestions, ranked by leverage

### 1. Make the noise rule machine-checkable

**Where:** `RANKING CRITERION` + admission rule + result-doc Cycles section.

**Current:** quantitative criterion requires `n >= 3` and `2 x std`. Result doc reports numbers in prose. `Decision:` is an in-prompt judgment call.

**Friction:** the agent can write `accuracy=0.78` once and forget the std. There's no mechanical guard. The horror-tuning project sidestepped this by being qualitative, but every quantitative project is one human-error away from an unsupported admission.

**Change:** require a small YAML frontmatter at the top of every quantitative result doc:

```yaml
---
metric: accuracy
metric_higher_is_better: true
seeds: [0, 1, 2]
mean: 0.781
std: 0.014
---
```

Then add a `vr-research admit <slug>` command that reads the leaderboard's existing rank-1..K frontmatter, applies `2*std`, and writes the verdict. Decision lines become assertions, not narrative.

### 2. Allow "rerun for noise" as a cycle kind without breaking the chain

**Where:** "Cycles chain linearly" rule, `## Cycles` block.

**Current:** "If you find yourself wanting to branch cycles ... close this move and open sibling moves instead." Rerun-for-noise is implicitly a branch.

**Friction:** real example from `v4-composite.md`: cycle 2 is "V4 rerun n=8 for reliability, head-to-head with V1 rerun n=8." That's not chained — it's a noise check. The rule was bent to keep the result doc readable.

**Change:** explicitly bless three cycle kinds: `change` (the default chained one), `rerun` (same config, more seeds, no chain break), `analysis` (no PTY change, just notebook). Keep the linear-chain rule for `change`-cycles only. Stops over-fragmentation into sibling moves.

### 3. Periodic review trigger, not only "QUEUE empty"

**Where:** `## Review Mode` opener.

**Current:** review fires when QUEUE is empty or a human asks.

**Friction:** for a long-running project the QUEUE stays non-empty for weeks while moves resolve. Insights worth crystallizing pile up but never get reviewed.

**Change:** also enter review on whichever fires first — (a) QUEUE empty, (b) 5 moves resolved since the last review, (c) 3 consecutive resolved-but-not-admitted moves. The autonomous-loop stop condition catches "stuck"; this catches "drifting without distillation."

### 4. Project-level budget envelope, not just per-move

**Where:** Research grounding bullet "name hardware flavor, timeout, expected cost class."

**Current:** budget shows up only inside individual result docs.

**Friction:** no aggregate. A project with 12 GPU-hour moves can silently sum to 80h before anyone notices.

**Change:** README gains a `BUDGET` field with three axes — compute-hours, dollars, calendar days. Each `resolved` LOG row debits it. `vr-research budget` prints remaining. Hitting the cap forces review-with-human before any new move starts.

### 5. Linter for "no bare numbers" + "every Results subsection leads with a figure"

**Where:** paper.md conventions ("Footnote every numeric or qualitative claim", "Every Results subsection leads with a figure", "Footnote IDs are global and slug-prefixed").

**Current:** soft rules. Enforcement is social pressure.

**Friction:** the conventions are strong but at scale they will erode. Footnote-ID collisions across 40 moves are not catchable by eye.

**Change:** ship `vr-research lint paper` that:
- flags any number ≥ 2 chars not followed (same paragraph) by a footnote
- walks each `^### ` Results subsection, checks the first non-blank line is `![...](figures/...)`, checks the file exists
- collects all `[^...]` footnote IDs, flags duplicates, flags missing definitions
- flags figures that are committed but not referenced

Bake into pre-commit.

### 6. Doctor command for the loop machinery itself

**Where:** Step 1 of the loop ("read the project README ... if ACTIVE has a row, resume it").

**Current:** no precondition validation. If `ACTIVE` references a result doc that doesn't exist or a branch that was deleted, the loop continues anyway.

**Friction:** silent corruption. The agent reads the README's claim, doesn't find the file, and either fabricates state or stalls.

**Change:** `vr-research doctor` validates the README ↔ result-doc ↔ branch ↔ commit graph. Runs at the top of every loop iteration. Specifically:
- every leaderboard row's `branch` URL resolves to a real branch
- every leaderboard row's `commit` URL resolves to a SHA on that branch
- every ACTIVE row has a `STATUS: active` result doc
- every QUEUE row's starting-point URL resolves
- every INSIGHTS row links to an `insights/<slug>.md` that exists

### 7. Pre-flight rule against false-falsification

**Where:** `## Self-Unblocking` last bullet ("If you retry the same failure 3+ times, ...").

**Current:** the prompt is good at saying "don't retry the same failure" but doesn't say "don't accept a falsifier on the first noisy run."

**Friction:** classic agent failure mode — see one bad seed of the variant, declare the prior falsified, log `falsified+evicted`, move on. Real signal lost.

**Change:** before logging `falsified`, the agent must rerun the *baseline* cycle 1 with a fresh seed. Only declare falsified if (a) the variant under-performs by ≥ pre-registered margin, AND (b) the baseline still hits its expected mean. This is one extra cycle and a real anti-noise guard.

### 8. Clearer move-vs-cycle decision rule

**Where:** Definitions, "Move" bullet, the search-vs-characterization paragraph.

**Current:** "search → N moves; characterization → 1 move with N cycles." Correct in spirit but in practice agents bend the rule.

**Friction:** the boundary case "what hyperparameter is best?" is in fact a search (categorical sweep over candidate values), but if the candidates form a smooth curve over a 1D axis, the result is a *characterization* (find the curve shape). Same factual answer; current rule says it's two different shapes.

**Change:** rephrase: "If you would compare candidates head-to-head against the leaderboard, it's N moves. If the answer is the *shape* of a continuous curve and only the curve goes on the leaderboard, it's one move with N cycles." Add an example for each.

### 9. Pivot rows need an approval gate in autonomous mode

**Where:** Locked sections, paper.md conventions, LOG `pivot` event.

**Current:** "To change a locked section, append a `pivot` row to the LOG with one-line justification, then update the paper. Locks are a brake against HARKing."

**Friction:** the brake is the pivot row itself. An autonomous agent can write a pivot row to itself.

**Change:** in autonomous mode, a `pivot` row requires an Agent Inbox approval card with capability tag `pivot-locked-section`, containing the original Question/Method, the proposed new one, and the justification. Approves on a 24-hour timer if the human doesn't reject. Same shape as other sensitive actions.

### 10. Cross-project dependencies as first-class

**Where:** Insights live at the Library root and span projects, but project READMEs don't list cross-project inputs.

**Current:** if `horror-prompt-tuning` results depend on a scoring rubric authored in `prompt-evaluation`, the dependency is implicit.

**Friction:** when the dependency project changes, downstream projects don't know. Cascade invalidation isn't possible.

**Change:** `## DEPENDS ON` block in project README, listing `<other-project>:<slug>:<commit>` triples. `vr-research doctor` flags when the upstream commit changes. This is what an insight subsumed by a newer one effectively is, but explicit at the project level.

## Smaller fixes

- **Compile the prompt into per-step views.** 225 lines is a lot to re-read on every loop iteration. The actual decision tree at step 1 ("ACTIVE? QUEUE? Review?") only needs the Loop section. Insights verbs only matter inside Review Mode. A small loader that injects only the relevant slice would cut tokens.
- **Insight confidence levels need a bump rule.** Today `INSIGHT-UPDATE` "bumps confidence if stated." When *should* it bump? Add: "promote `low → medium` when 2 independent moves cite the insight as decisive in their decision; `medium → high` when 5 do."
- **The `agent canvas` is for results but not for live monitors.** Long training runs benefit from a TensorBoard / Modal app URL pinned next to the project. Add `vr-agent-canvas --url <live-monitor-url>` mode.
- **Footnote provenance triple should include data range.** "<commit-url> · <command> · <artifact path>" is good. For derived statistics, also include `<rows-considered>` so a future reader knows the metric was over which subset.
- **`Long Runs` says "every cycle is a commit, push after every cycle"** — that's heavyweight for a project with 30-second cycles. Allow a project-level setting `cycle_commit_strategy: per-cycle | squash-on-resolve` and default to squash for short cycles.

## What I'd keep exactly as-is

- **The two-repo split (Library prose + per-project code).** Right call. Keeps prose history clean and code history meaningful independently.
- **The append-only LOG with verbed events.** The `falsified+admitted` etc. compounding is a small piece of design that does a lot of work.
- **Locked Question/Method via pre-registration.** Even if the brake on autonomous pivots is weak (#9), the discipline is right.
- **The result-doc shape (TAKEAWAY at top, Decision line at the bottom).** Reads naturally for a human checking in mid-stream.
- **Insights as review-only artifacts.** Not letting a single move "claim" an insight prevents premature crystallization.
- **The `r/<slug>` branch convention.** Cosmetic, but the `git log --all --oneline --graph` view is excellent for retrospectives.
- **Bias against in-head decisions.** "Pre-experiment QUEUE edits get a `review` LOG row" — small but powerful, makes priority churn visible.

## Concrete next step

If we want to actually improve the loop rather than just suggest improvements, item #1 (machine-checkable noise rule) and item #6 (`vr-research doctor`) are the highest leverage. Both are tooling, not prompt-rewriting. Both make every other rule more durable. Recommend shipping those first, then revisiting #5 (linter) once we have a quantitative-criterion project to test against.
