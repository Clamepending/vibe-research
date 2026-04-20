# baseline

## TAKEAWAY

Baseline collapses into a "Silent [seasonal weather] / [concrete image] / [abstract sentiment]" Zen-pastiche template. 5/6 open with "Silent", 4/6 close on abstraction, 1/6 emits meta-text. Attractor confirmed — matches the attractor-naming hypothesis about one-dominant-stereotype baseline behavior.

## STATUS

resolved

## STARTING POINT

[main@42ba2d6](https://github.com/Clamepending/haiku-prompt-tuning/tree/main)

## BRANCH

[r/baseline](https://github.com/Clamepending/haiku-prompt-tuning/tree/r/baseline)

## AGENT

0

## Question

What does `claude-sonnet-4-6` produce for haiku with no system prompt? Under the [attractor-naming](../../../insights/attractor-naming.md) hypothesis, output should collapse into one dominant stereotype attractor. Which one?

## Hypothesis

**Prior (85% confident):** output collapses to a single stereotype. Most likely candidates: cherry-blossoms + abstract reflection, or seasonal-change + quiet contemplation, or "ancient pond" Bashō pastiche.
**Falsifier:** samples show real variety across image, season, and move — no dominant attractor visible in n=6.

## Experiment design

Change: nothing (invoke `claude -p` with no `--system-prompt` flag).
Measure: (a) opener/closer repetition, (b) subject/image repetition, (c) presence of sentiment abstractions, (d) subjective hit rate.

## Cycles

- `cycle 1 @12fd65e: no-prompt baseline, n=6 -> 5/6 "Silent..." opener, 4/6 abstract closer, 1/6 meta-leak, hit rate ~1/6. qual: "Silent [weather] / [concrete image] / [abstract sentiment]" Zen-pastiche template; only sample 5 (crow on pine branch, shaking dew) lands present-tense concrete craft.`

## Results

n=6 at commit [12fd65e](https://github.com/Clamepending/haiku-prompt-tuning/commit/12fd65e), outputs at `outputs/baseline/sample_{1..6}.txt`.

All six samples verbatim:

1. *"Silent spring morning / Cherry blossoms fall like snow / The branch holds nothing"*
2. *"Silent spring rain falls / each drop finds the waiting earth / nothing is hurried"*
3. *"Here is a haiku:\n\n```\nmorning fog lifts slow / a crow lands on wet black stone / silence, then a call\n```"* (meta-output: emitted "Here is a haiku:" prefix + markdown fences)
4. *"Silent morning fog — / a crow lands on the cold wire, / then the world is still."*
5. *"Silent morning fog — / a crow lands on the pine branch, / shaking loose the dew."*
6. *"Silent rain at dusk / Petals fall without a sound / Earth remembers all"*

Tallies:
- **"Silent" opener:** 5/6 (samples 1, 2, 4, 5, 6); sample 3 uses "silence" as second-line closer
- **Crow landing:** 3/6 (3, 4, 5)
- **Morning fog / dawn / spring:** 5/6 (1, 2, 3, 4, 5)
- **Abstract closer:** 4/6 — "holds nothing" (1), "nothing is hurried" (2), "world is still" (4), "Earth remembers all" (6)
- **Meta-output:** 1/6 (sample 3)
- **Season variety:** zero (all spring or undated morning — no autumn/winter/summer)
- **Hit rate (concrete image + present-tense + no abstract closer):** ~1/6 — only sample 5 is competent

## Analysis

Hypothesis confirmed. Sonnet 4.6's haiku prior is a Western-Zen-pastiche template: "Silent [seasonal weather] / [concrete image] / [abstract sentiment-closer]", with season locked to spring/dawn, recycled imagery (crow, cherry blossoms, fog, rain), and an abstraction in line 3 doing the emotional work.

Attractor specifics:
- **Opener attractor:** "Silent" — 5/6 direct, 6/6 if we count sample 3's "silence, then a call"
- **Closer attractor:** abstract sentiment ("nothing / still / remembers") — 4/6 direct
- **Season attractor:** spring/undated dawn — 6/6
- **Imagery attractor:** crow, fog, cherry blossoms, falling petals — all Western haiku stereotype elements

This is the haiku analog to horror's "lights-went-out / closet / dead-relative" attractor. Different genre, different specific attractor, same shape of collapse. Sets up the test for whether ban-only and positive-only produce *different* second and third attractors — if yes, attractor-naming generalizes.

Prior update: 95% that haiku has stereotype-attractor behavior. The specific attractor for ban-only and positive-only moves is the open question.

## Reproducibility

Commit: [12fd65e](https://github.com/Clamepending/haiku-prompt-tuning/commit/12fd65e)
Command: `./run_variant.sh baseline 6` (no prompt file)
Artifacts: `outputs/baseline/sample_{1..6}.txt` on branch `r/baseline`
Config: `claude-sonnet-4-6`, default temperature, n=6, parallel invocations

## Leaderboard verdict

*(empty leaderboard at time of running — first move)*

Decision: insert at rank 1 (by default, as there's nothing to compare against). Subsequent moves will push baseline down or evict it.

## Queue updates

*(no changes — QUEUE rows ban-only / positive-only / composite remain valid next steps)*
