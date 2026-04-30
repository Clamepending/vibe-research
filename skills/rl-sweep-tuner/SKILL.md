---
name: "rl-sweep-tuner"
description: "Use when the user asks you to take over hyperparameter / architecture / data-mixture tuning of an RL or ML training repo for them — autonomous sweep planning, execution, leaderboard maintenance, and deciding what to try next. Invokes the Vibe Research project shape (projects/<name>/{README, paper, runs.tsv}) plus the vr-rl-sweep + vr-research-* CLIs."
---

# RL Sweep Tuner skill

You're being asked to take over hyperparameter / architecture / data-mixture tuning of a training repo. **You own the loop.** The user will skim `paper.md` and the leaderboard once a day or so. They are not in the inner loop. Do not stop and ask them what to try next when the move queue has obvious follow-ups.

## When to load this skill

The user says something like:

- "tune the LR/batch combo on this RL repo"
- "take over the hyperparameter search for me"
- "run a sweep over these knobs and tell me which won"
- "find the best config for this training script"

Or any variation of "be the autonomous tuner for this project."

## Bootstrap (only if the project isn't set up yet)

If `projects/<name>/kickoff.json` already exists, skip to **Loop**. Otherwise:

```bash
vr-rl-tuner --repo <abs-path-to-the-repo> \
            --goal "<one-paragraph what we're optimizing>" \
            --budget "<free-form, e.g. '20 GPU-hours, $50'>" \
            --library <abs-path-to-the-Library-root> \
            --name <project-slug>
```

This writes `projects/<name>/{README.md, paper.md, kickoff.json, results/, figures/}`. The kickoff.json carries the user's goal + budget + repo path so subsequent reloads of this skill have the context.

## Contract

- **The Vibe Research researcher contract in `AGENTS.md` is binding.** Read it before your first move. Move/cycle/result/leaderboard semantics are non-negotiable.
- **Pre-flight before GPU spend** is mandatory. No silent substitution of datasets/models/training methods/sequence lengths/eval targets. If something is unavailable or low quality, write that as the result and ask for a scoped decision.
- **Variance over single-seed luck.** Every quantitative claim wants n ≥ 3 seeds and a `2 × std` noise rule. A one-seed result is a debugging signal, not an insight.

## Loop

Read `projects/<name>/README.md` (the project index) and `projects/<name>/kickoff.json` (the user's goal + repo path + budget) on entry. Then:

1. **If ACTIVE has a row, resume that move.** Otherwise pick QUEUE row 1.
2. **If the queue is empty, do not idle.** Generate the next 3-5 moves yourself based on what the leaderboard already shows:
   - If you have one configuration that beat baseline, do an **ablation move** per knob to see which knob did the work.
   - If you have a parametric sweep curve (LR vs return), do a **narrow-around-the-peak** move at higher resolution.
   - If you have categorical alternatives (e.g. 3 reward shapings) and only ranked them on n=1, do a **seed expansion** move at n=5 on the top 2.
   - Add the moves to the QUEUE in the README, then take row 1.
3. **For each move, plan with `vr-rl-sweep init`**.
   - **First move** (no top-level `runs.tsv` yet): `vr-rl-sweep init <project-name>` writes `projects/<project>/runs.tsv` and bootstraps the project. The kickoff helper has already done this for you; the first move's runs.tsv goes at the top level.
   - **Follow-up moves**: `vr-rl-sweep init <project-name> --sweep-name <move-slug>` writes `projects/<project>/runs/<move-slug>.tsv` INSIDE the existing project. **Always use `--sweep-name` for follow-up moves** so all sweeps live under one project's leaderboard + paper, not as sibling projects. The `<move-slug>` should match the move's result-doc slug.
   Pin the code repo's current SHA via `--commit` so every row in the TSV cites the same commit.
4. **Execute the planned rows** with `vr-rl-sweep run <project-name>` (add `--sweep-name <move-slug>` for follow-up moves). For each row in the matching runs.tsv whose status is `planned`:
   - Resolve `config` JSON into command-line overrides for the project's training entry point (look at the existing repo's launch invocation; do not invent flags).
   - Set `wandb.init(group=<row.group>, name=<row.name>, tags=[<row.commit>, *override_keys])` — match the row's group/name exactly so the doc-row format ties back to the wandb dashboard 1:1.
   - Spawn the run. Local first if GPUs are available; otherwise use the Modal or RunPod buildings (`vr-mcp install mcp-modal` / `mcp-runpod` if not already installed; their CLIs are `modal` and `runpodctl`). Get human approval before spending real money — see the budget cap in `kickoff.json`.
   - When the run finishes (or fails), update the row in-place: `started_at`, `mean_return`, `std_return`, `wandb_url`, `status` ∈ `done|failed|skipped`. **Append-only edits to `runs.tsv`** — never delete a planned row, even if you decide to skip it. Mark it `skipped` with a one-line reason in the `hypothesis` column.
5. **After every cell finishes (all seeds done), aggregate.** Write the result-doc cycle line to `projects/<name>/results/<move-slug>.md`:
   - `cycle N @<sha>: <change> -> mean_return=<mean> ± <std> (n=<seeds>). qual: <one line>.`
6. **At move completion, write the move's full result doc + leaderboard verdict.** Use `vr-research-admit` to test admission; if the result beats anything on the leaderboard, admit it; if not, log it as `falsified` or `resolved` per the contract. Either way, push to the Library.
7. **At the end of every move, prepend a one-liner to `paper.md`'s "Since last update" section** so the user sees what changed when they open the paper next. Update the Discussion section to weave in the new finding.
8. **Loop back to step 1.**

## Decision discipline (what to try next)

When the queue is empty and you're generating new moves, prioritize in this order:

1. **Ablate.** If the leaderboard rank-1 result has multiple changes from baseline (e.g. "lower LR + higher entropy bonus + longer rollout"), the next move is removing one knob at a time to see which one carried the win.
2. **Replicate.** A single n=3 result that beats baseline by 2σ is a hypothesis, not a fact. Re-run with new seeds before stacking more knobs on top.
3. **Sensitivity.** Sweep narrowly around the current best on the most-impactful knob you've identified. Stop sweeping a knob once 3 adjacent points produce within-noise results — you've hit the plateau.
4. **Architecture only after data + reward + LR are settled.** Architecture changes are expensive and the gains often dissolve once you re-tune the optimizer.
5. **Stop hammering when the leaderboard's gap from rank-1 to rank-5 is < 1σ** — you've converged and further sweeps are noise mining. Refresh the abstract, write a Limitations bullet about what you didn't try, and tell the user you're at a plateau via a `terminate` LOG row.

## Cloud execution

The runner shells out per row, so anything that runs as a shell command works. For local GPUs, the launcher is just `python train.py ...` or `bash train.sh ...`. For cloud:

- **Modal**: `--launcher 'modal run ${repo}/sweep_app.py --lr=${lr} --seed=${seed}'`. The user's repo needs a small Modal entrypoint (one `@app.function(gpu="A10G")` decorator over their existing training function); install it via `vr-mcp install mcp-modal` if missing. Get human approval via Agent Inbox before any cloud spend over the budget.
- **RunPod**: `--launcher 'runpodctl exec --pod-id ${RUNPOD_POD_ID} -- bash /workspace/repo/train.sh --lr=${lr} --seed=${seed}'`. Requires a running pod the user has provisioned; do not auto-provision.
- **Wandb capture**: the runner already extracts the wandb run URL from each launcher's stdout into the `wandb_url` column — no extra work needed if the launcher's training script calls `wandb.init(...)` and prints the standard `View run at https://wandb.ai/...` line.

Default per-row timeout is 30 minutes. For long cloud runs, pass `--timeout-sec 14400` (4 hours) on `vr-rl-sweep run` and write a one-line note in `paper.md`'s "Since last update" so the human sees what's expected.

## Tools you have

- `vr-rl-sweep init <name> [--sweep-name <slug>] --base <kvs> --sweep <key=spec> --seeds N --hypothesis <text>` — plan a sweep into runs.tsv (or runs/<slug>.tsv inside an existing project). You read this back row-by-row and execute each.
- `vr-rl-sweep run <name> [--sweep-name <slug>] --launcher '<shell template>'` — walk planned rows, spawn each one's launcher, capture the metric, update the row in-place.
- `vr-rl-sweep summary <name> [--sweep-name <slug>] [--top N] [--direction-lower] [--json]` — read the runs.tsv (or runs/<slug>.tsv) and print status counts + per-cell mean ± std across seeds + the top-N ranked cells. Use this to check sweep state mid-run instead of opening the TSV by hand. `--json` returns structured data with `topCells`, `statusCounts`, `cellCount` for programmatic use.
- `vr-rl-sweep wandb-pull <name> [--sweep-name <slug>] [--metric <key>] [--overwrite]` — back-fill `mean_return` from wandb summaries for rows whose launcher logged to wandb but didn't print the metric in stdout-regex-able form. Reads each row's `wandb_url`, GraphQL-fetches the run's `summaryMetrics`, writes back into the TSV. Idempotent (skips rows already filled unless `--overwrite`). Needs `WANDB_API_KEY` env var.
- `vr-rl-tuner` — bootstrap a project from a target repo (writes README + paper + kickoff.json + dirs). Used once at project start.
- `vr-research-init <name>` — generic project bootstrap if you split off a sub-project.
- `vr-research-doctor projects/<name>` — validate the project's bookkeeping is consistent (links resolve, leaderboard isn't lying about commits, etc.). Also walks `runs.tsv` and `runs/<slug>.tsv` (stale `running` rows, config-JSON parse errors, missing required columns, `running` rows with no matching ACTIVE README claim, malformed `wandb_url`), `kickoff.json` (parseable, has `goal` + `repo`, repo path exists on disk), and the `vr-research-vacuum` manifest (every tiered file's archived copy exists and SHA matches the manifest's record — drift detection on cold-tiered binaries). Run this before pushing the Library.
- `vr-research-admit projects/<name>/results/<slug>.md` — test admission to the leaderboard.
- `vr-research-active <project> add --slug ... --result ... --branch ...` / `... remove --slug ...` — manage the README's ACTIVE table at loop step 3 (claim) and step 9 (release after resolve). Refuses duplicate slug claims; only touches the ACTIVE table.
- `vr-research-leaderboard <project> insert --rank N --slug ... --result ... --branch ... --commit ... --score ...` / `... remove --slug ...` — apply the admit verdict at loop step 9: insert at the determined rank, shift lower ranks down, and surface any rank-6 eviction so the agent can write its `evicted` LOG row via `vr-research-log`. Refuses duplicate slugs and gap-leaving ranks.
- `vr-research-queue <project> add --slug ... [--starting-point ...] [--why ...] [--position N]` / `... remove --slug ...` / `... reprioritize --slug ... --to-row N` — apply the result-doc Queue updates verbs (ADD / REMOVE / REPRIORITIZE) at loop step 9. Cap=5; an `add` past the cap surfaces the bumped row so the caller can decide what to drop. Refuses duplicate slugs and gap-leaving positions.
- `vr-research-resolve <project> --slug <slug> --event <resolved|falsified|abandoned> [--commit <url>] [--summary <text>] [--score <text>]` — **one-call orchestrator for loop step 9.** Reads `<project>/results/<slug>.md`, parses the Decision line + Queue updates section, runs `vr-research-leaderboard insert` (if admit), `vr-research-active remove`, all queue verbs, and the appropriate LOG rows (eviction + resolution) in the right order. Auto-derives summary from TAKEAWAY and score from frontmatter `mean ± std`. **Prefer this over hand-running the four admin commands** — same effect, far less ceremony, fewer chances to miss a step.
- `vr-research-vacuum <project>` — tier old binaries (PNGs / checkpoints / logs ≥90 days old) to `<project>/.archive/` with a SHA-checked manifest. Dry-run by default; pass `--apply` to act, `--restore <relpath>` to inverse, `--list` to see what's been archived. Pins markdown / TSV / `benchmark/` / figures cited by `falsified` LOG rows. Run before pushing the Library when disk pressure is high or visual clutter is biting.
- `vr-research-log <project> --event <evt> --slug <slug> --summary <text> [--link <text>]` — append a LOG row at the top of the README's LOG table (newest-first). Use this on every move resolution instead of hand-editing the markdown table. `--event` follows the contract enum (`resolved` / `falsified` / `abandoned` / etc., compounded with `+admitted` / `+evicted` per the admission outcome).
- `vr-research-lint-paper projects/<name>/paper.md` — catches contract violations (locked sections edited without a pivot row, footnote IDs colliding, etc.).
- `vr-mcp install <building-id>` — install MCP servers for tools you discover you need (e.g. `mcp-aws-kb-retrieval` if the user's repo references an AWS Bedrock KB; `mcp-postgres` if the experiment data lives in Postgres). Don't ask the user; install + use.
- The Modal + RunPod buildings — for cloud GPU runs. Respect the budget in `kickoff.json`.
- The W&B building — for visualization. Always set `wandb.init(group=<row.group>, name=<row.name>)` so each row in `runs.tsv` ties 1:1 to a wandb run.

## Hard rules

- **Don't fake numbers.** Every reported metric cites commit + command + artifact path. If you can't actually run the experiment (no GPU access, blocked dependency), write that as the result honestly.
- **Don't silently change the project's training script.** If you must edit it (because the existing entry point doesn't accept the override you need to sweep), commit the edit on a clearly-labeled branch in the project's code repo and link it from the result doc.
- **Don't blow the budget.** Track cumulative spend in `kickoff.json` after every cloud run. If you're at 80% of budget and the next sweep would push you over, ask the user via the Agent Inbox before continuing.
- **Don't pivot the goal silently.** The kickoff goal is binding. If you discover the original question is wrong (e.g. "actually the reward function is the bottleneck, not LR"), write that as a `pivot` LOG row + a paper Discussion update + ask the user before re-aiming.

The user trusted you with this work. Run the loop they would have run, with the rigor they would have wanted, at the rate they couldn't keep up with.
