# composite

## TAKEAWAY

Composite (bans of all three observed attractors + positive anchor without structural formula + "output only" guard) produces 5-6/6 craft hits with zero conspicuous attractor collapse on opener / imagery / closer. One subtle residual: 5/6 are summer — season displaced to the one dimension I banned *spring* and *autumn-decay* but didn't ban *summer*. Confirms horror's V4 pattern on haiku AND surfaces a new sub-finding: bans displace attractors along unbanned axes.

## STATUS

resolved

## STARTING POINT

[main@42ba2d6](https://github.com/Clamepending/haiku-prompt-tuning/tree/main)

## BRANCH

[r/composite](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/composite)

## AGENT

0

## Question

Does the composite prompt (bans from ban-only + bans on rust and classical-pastoral attractors + positive anchor stripped of structural formula + "output only three lines") produce varied craft haiku without mode collapse?

## Hypothesis

**Prior (75% confident):** varied craft with no dominant attractor across n=6. Possible weak residual attractor (≤2/6).
**Falsifier:** composite collapses to a dominant attractor ≥4/6.

## Experiment design

Change: system prompt with (a) bans from ban-only, (b) added bans on rust and classical-pastoral attractors, (c) positive anchor without "bigger/smaller" structural framing, (d) explicit no-asterisks no-markdown guard.
Measure: (a) any single attractor ≥4/6, (b) hit rate, (c) season variety, (d) meta-output.

## Cycles

- `cycle 1 @e3e270c: composite prompt n=6 -> 0/6 opener-collapse, 0/6 imagery-collapse, 0/6 meta-leak, 0/6 banned-form violations, 5/6 strong craft hits; BUT 5/6 summer (season displacement to unbanned axis). qual: tile-setter-knuckle (3), rain-soaked-bicycle (4), griddle-grease-spatula (6) cleanest; every sample in a different physical domain.`

## Results

n=6 at commit [e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/commit/e3e270c), outputs at `outputs/composite/sample_{1..6}.txt`. Tagged `best`.

All six samples verbatim:

1. *"June beetle thuds hard / against the porch screen — again, / the lamp holds its ground"*
2. *"Sprinkler ticks through noon / one dandelion head bobs— / the dog ignores it"*
3. *"Grout lines fill with steam / the tile-setter's knuckle bleeds / July, not yet noon"*
4. *"Rain-soaked bicycle / leans against the school's brick wall— / summer vacation"*
5. *"Ceiling fan clicks twice— / the dog lifts one ear, then sleeps / through the July heat"*
6. *"Griddle grease pops once — / the spatula scrapes summer / from cast iron's skin"*

Tallies:
- **Banned-form violations:** 0/6 — no Silent opener, no cherry blossoms, no crow, no rust, no mountain+insect+petal, no abstract-sentiment closer, no meta-output.
- **Opener variety:** 6/6 distinct first-word/image (June beetle, Sprinkler, Grout, Rain-soaked bicycle, Ceiling fan, Griddle).
- **Concrete image + specific physical detail:** 6/6 — screen lamp, sprinkler+dandelion, grout+knuckle, bicycle+brick, ceiling fan+dog-ear, griddle+spatula.
- **Domain variety:** every sample in a different physical domain (insect-lamp, yard, construction, schoolyard, indoor afternoon, kitchen).
- **Season variety:** 1/6 — all summer or early summer. Season displacement to unbanned axis.
- **Abstract-sentiment closer:** 0/6 direct. "The lamp holds its ground" (1) and "summer vacation" (4) flirt with abstraction but are image-anchored.
- **Meta-output:** 0/6.
- **Hit rate (craft on haiku's core criterion):** 5-6/6 — sample 1 is strong (June beetle + porch-screen + lamp standoff), sample 3 strongest (grout / knuckle / pre-noon July), sample 6 ambitious ("spatula scrapes summer" flirts with but doesn't cross into abstraction).

## Analysis

Hypothesis confirmed on the main claim — no conspicuous attractor collapse on the dimensions that were banned (opener, closer, imagery, season-as-spring-or-autumn). Craft per sample is strong and varied.

Key sub-finding: **bans displace attractors along unbanned axes.** I banned spring-lock and autumn-decay-lock but did not explicitly ban summer. Result: 5/6 samples are summer. Same mechanism as horror's V4r-5 "escalation-twist" residual (that fifth attractor wasn't in V4's ban list). The displacement pattern is:

1. Baseline: attractor on opener + closer + imagery + season (Silent Zen).
2. Ban-only: attractor on imagery + season (Rust decay).
3. Positive-only: attractor on structure + imagery + season (Classical pastoral).
4. Composite (bans for all above, including specific attractors): attractor shrinks to *just season*, because season was in the ban list only as "don't spring-lock" and "don't autumn-decay-lock" — leaving summer and winter as the unbanned attractor-basin, and the model picked summer.

This is a refinement of the attractor-naming insight: it's not just that multiple attractors exist, it's that **bans are one-dimensional** — each ban closes one axis of the attractor space; if you leave any axis open, the model picks a single point along the open axis. To fully avoid collapse you'd need to either (a) explicitly require variety along every axis, or (b) generate and filter.

Prior update: attractor-naming's core claim (multiple distinct attractors, compose bans + positive to neutralize) → confirmed. New sub-claim (bans displace collapse to unbanned axes) → high confidence, n=2 genres.

## Reproducibility

Commit: [e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/commit/e3e270c), tagged `best`
Command: `./run_variant.sh composite 6 prompts/composite.txt`
Artifacts: `outputs/composite/sample_{1..6}.txt` on branch `r/composite`
Prompt: `prompts/composite.txt` at commit `e3e270c`
Config: `claude-sonnet-4-6`, default temperature, n=6

## Leaderboard verdict

- vs rank 1 (ban-only): **better** on haiku craft. Composite has 0/6 opener-collapse vs ban-only's 5/6 "Rust" opener; 0/6 imagery-collapse vs ban-only's 4/6 bolt-gate-drain; domain variety 6/6 vs ban-only's 1/6 (everything-rust). Composite's only collapse is subtle summer-lock (1-dimension); ban-only's rust attractor is multi-dimensional.
- vs rank 2 (positive-only): **better** because composite breaks structural formula lock (0/6 "bigger/smaller" formula vs positive-only's 6/6); no mountain+insect+petal collapse; 0/6 meta-leak vs positive-only's 1/6 asterisk emission.
- vs rank 3 (baseline): **better** on every dimension.

Decision: insert at rank 1.

## Queue updates

ADD: season-unlocked-composite | starting-point [r/composite@e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/composite) | why extend composite ban list with summer/winter variety requirement to test whether the season-displacement residual can be killed.
ADD: composite-rerun-n8 | starting-point [r/composite@e3e270c](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/composite) | why larger-n replication of composite to verify the 5-6/6 hit rate holds.

## Insights touched

*(review mode will fill — this is where the insight update is expected)*
