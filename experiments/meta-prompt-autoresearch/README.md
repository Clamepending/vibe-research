---
name: Meta-Prompt Autoresearch on autoresearch-mlx
description: Karpathy-style outer loop where the optimization target is the task-agent's system prompt and the evaluation is best val_bpb achieved on Karpathy's autoresearch-mlx within a fixed cycle budget.
type: experiment
updated_at: 2026-04-19
status: PAUSED — pivoted to bugbench (see ../meta-prompt-bugbench/README.md). Durable findings preserved below.
superseded_by: experiments/meta-prompt-bugbench/README.md (for the CLAUDE.md-trimming question)
---

## Status update 2026-04-19 (pivot)

**This experiment is paused as a benchmark choice.** Three kernel panics on the M3 Pro host today made the MLX-training inner loop unsafe to run, and on reflection the benchmark was a poor fit for the real question (is the 45.8k-char RV prompt pulling its weight?):

1. **Per-cycle cost too high for signal:** 6 min train + 21.2 GB peak per run; single `val_bpb` number per replicate ≈ 1 bit of signal.
2. **Host OOM risk:** 36 GB unified RAM leaves ~3 GB headroom at 1× concurrency; today's worktree-contamination bug gave 2× concurrency and crashed the box three times (panics at 09:56, 10:47, 11:10; signature `watchdog timeout: no checkins from watchdogd in 92 seconds`).
3. **Task-knowledge-bound, not prompt-bound:** what moves `val_bpb` is MLX/LR/depth knowledge — a "better" system prompt doesn't teach the agent more ML, so the null hypothesis "prompt doesn't matter here" is uncomfortably plausible a priori, meaning we'd be measuring noise.
4. **`program.md` already encodes the discipline we're testing:** baseline, change-one-thing, keep/discard on metric. Most of what the RV prompt adds on top is redundant *for this specific task*, pre-baking a "v1-control ties v0" outcome.
5. **Disk pressure:** the host was separately at 100% APFS capacity during the session (460 GB data volume, 133 MB free at one point), a likely contributor to the watchdogd panics. Unsafe to launch more training regardless.

The durable learnings from this setup (wrapper bypass, `claude -p` semantics, concurrent-harness contamination, OOM math) are preserved below and apply to the successor experiment.

**Successor:** `../meta-prompt-bugbench/README.md` — same meta-loop idea, swapped inner task to a battery of small Python-bug fixes (seconds per run, pass/fail per bug, ~50× more signal per replicate, zero GPU). Reuses the same 5 meta-prompt variants and the wrapper-bypass harness.

---

# Meta-Prompt Autoresearch

## The question

Can we hill-climb an agent *system prompt* the same way you hill-climb `train.py`? The validation loop (R1-R7+) already demonstrated the v3 Vibe Research prompt produces disciplined autoresearch behavior on *prompt-tuning* tasks. The next question: is that discipline the *best* prompt, or just *a* prompt that works? The only way to know is to hill-climb it against a concrete downstream metric.

**Karpathy's autoresearch-mlx** gives us exactly the right shape of task: a fresh, frozen, reproducible benchmark (`val_bpb` on 5 minutes of MLX pretraining) where the task-agent's job is agentic research (modify `train.py`, run it, read results, iterate). That means:

- **Outer loop (what we optimize):** the meta-prompt = the system prompt given to a fresh Claude Code task-agent.
- **Inner loop (what's frozen):** the autoresearch-mlx repo — `prepare.py`, `program.md`, the `evaluate_bpb` function, the 5-minute training budget.
- **Metric:** the best `val_bpb` the task-agent achieves in a fixed cycle budget (default: 3 keep-commits, or 6 total attempts, whichever first).

## Design

### Roles

| Role | Who | Budget |
|---|---|---|
| Task-agent | `claude -p --system-prompt <meta-prompt-vN>` in a fresh worktree | Fixed: 3 keep-commits OR 45 wall-clock minutes |
| Meta-agent | Me (the Claude running this experiment) | Open — but 1 meta-cycle ≈ 1 hour |
| Stimulus | The static `program.md` + a short kickoff user message | Frozen |

### Harness protocol

For each meta-prompt variant `vN`, run M=2 independent replicates:

1. **Worktree** — `cd $AUTORESEARCH_MLX && git worktree add ../autoresearch-mlx-meta-${vN}-run${M} -b meta/${vN}-run${M} autoresearch/apr19` (branches off this host's baseline).
2. **Clear results.tsv** to the baseline entry only.
3. **Spawn task-agent** with:
   ```bash
   claude --model claude-sonnet-4-6 \
     --system-prompt "$(cat meta-prompts/${vN}.md)" \
     --dangerously-skip-permissions \
     -p "You are in $worktree. Read program.md and follow it. Your budget is 3 keep-commits. Stop when you hit budget, or when you judge you've converged. Report the final results.tsv."
   ```
4. **Capture**:
   - Final `results.tsv` contents
   - `git log --oneline meta/${vN}-run${M}` of the task-agent's commits
   - Wall-clock (start-stop of the subprocess)
   - Optional: whole transcript for later qualitative review
5. **Extract metric**: `min(val_bpb)` across `keep` rows in results.tsv.
6. **Log** to this wiki + to a meta-results table in the autoresearch-mlx repo on a `meta/results` branch.
7. **Cleanup** after all M replicates: `git worktree remove` the per-run dirs.

### The meta-prompt variants to try

- **v0** — the current Vibe Research v3 prompt (prompt-tuning-validated baseline). Hypothesis: the discipline transfers to pretraining-research with val_bpb as metric.
- **v1-control** — a stripped-down "just do what program.md says" prompt. Hypothesis: most of v3 is dead weight for this task; simpler does equally well.
- **v2-ml-priors** — v0 + a terse ML-priors section ("gradient accumulation trades memory for step size; depth/width tradeoff; learning-rate warmup matters"). Hypothesis: priming task-specific knowledge beats generic discipline.
- **v3-no-priors-no-discipline** — minimal. "Read program.md. Do it. Exit when done." Negative control.
- **v4-explicit-reflect** — v0 + forced "after 2 discards in a row, re-read the kept commit's diff before proposing next" micro-protocol. Hypothesis: named-rationalization-style pattern-matching works here too.

Primary metric: mean(min_val_bpb) across 2 replicates.  
Secondary metrics: keep-count (how often did the agent's changes improve), cycles-to-first-improvement, variance.

### Why these variants

- v0 vs v1-control answers: **does the general-research discipline help beyond the task-specific program.md?**
- v0 vs v3-no-priors-no-discipline answers: **does *any* discipline help over minimal instructions?**
- v0 vs v2-ml-priors answers: **task-specific knowledge vs. general meta-skill — which matters more?**
- v0 vs v4-explicit-reflect answers: **can we get an ablation-sized improvement from one micro-intervention?**

If v1-control ties v0, that's a valuable negative: most of the Vibe Research scaffolding is not doing the work on this task. If v2-ml-priors wins, the next direction is task-specific priming rather than general discipline. If v4-explicit-reflect wins, that's the next addition to v3 of the main prompt.

### Falsifiers

- **H1 (v3 prompt transfers to pretraining-research):** would be weakened by v1-control matching v0 on both metric and keep-count within 2 replicates.
- **H2 (pattern-matching interventions scale):** would be weakened by v4-explicit-reflect not beating v0 on keep-count, despite naming the specific "thrashing after discards" failure mode.
- **H3 (task-specific priming dominates):** would be weakened by v2-ml-priors tying or losing to v0.

## This host's baseline

- **Machine:** M3 Pro (Apple Silicon), MLX 0.31.0, mlx-metal 0.31.0
- **Measured at:** branch `autoresearch/apr19`, commit TBD
- **Baseline val_bpb:** **2.125778** (commit `dd23ac8` on `autoresearch/apr19`).
- **Baseline run stats:** 302s train, 334s total, 21.2 GB peak, 126 steps, 11.5M params, depth=4.
- **Important:** the starting `train.py` is NOT Karpathy's pristine AdamW default — it already carries three kept wins from the M1 Studio run (`halve batch to 2^16`, `matrix LR to 0.04`, `depth 8→4`). Per `program.md` we don't roll back; this is the M3 Pro host's baseline as-is.
- **Wall-clock/cycle measured:** ~6 min actual (302s train + 32s eval/compile). Call it 7 min/cycle with git + planning overhead.
- **Per-meta-cycle estimate:** 3 keep-commits × ~7 min + ~5-10 min task-agent deliberation ≈ **~30-40 min per replicate**, **~60-80 min per variant** with M=2.

## Extra motivation (2026-04-19)

User noted the CLAUDE.md (= mirrored v3 Vibe Research prompt) is 45.8k chars and the Claude Code harness now flags it as large enough to hurt performance. This is a direct, task-adjacent reason the v1-control ("strip to minimum") and v3-no-discipline variants matter: if either ties v0 on `val_bpb` / keep-count, we have a concrete basis for trimming the canonical prompt. In other words, this experiment is no longer just "can the discipline transfer" — it's also "is the current length pulling its weight."

## Open questions

- Can `claude -p` run an agentic multi-turn loop with tools reliably for 45 minutes without hitting a message cap? Unknown — needs a single sanity-check run.
- Does `--dangerously-skip-permissions` unblock the `git add` / `git reset --hard` / `uv run train.py` calls the agent needs to make, without opening up risk outside the worktree? The worktree is the sandbox; no data outside it matters.
- Does the task-agent have access to `~/.cache/autoresearch/` when running inside a worktree? It should — it's a user-wide cache, not repo-scoped.

## Status

- [x] Clone autoresearch-mlx, install deps, regenerate `token_bytes.npy`.
- [x] Create `autoresearch/apr19` branch; reset results.tsv for this host.
- [x] Measure this host's baseline val_bpb = **2.125778** at `dd23ac8`.
- [x] Build harness script (`meta-prompt-harness/run_meta_cycle.sh`, branch `experiment/wave1`).
- [x] Author all 5 meta-prompt variants (v0, v1-control, v2-ml-priors, v3-no-priors-no-discipline, v4-explicit-reflect). Committed at `efd5292` on `experiment/wave1`.
- [~] Sanity-check v1-control × run1, budget=1 keep — **in flight** (agent picked "remove logit cap" at commit `1b5fc3a` on `meta/v1-control-run1`, training running, ~170s to eval).
- [ ] Scale to full 5 variants × 2 replicates sweep.
- [ ] Synthesize.

## Cycle-2 finding: two concurrent harnesses → worktree contamination

On the re-launched sanity attempt I believed I was running one harness. I was actually running two — one orphaned bash task from an earlier attempt (never fully cleaned up after its internal claude subprocess hit the "Not logged in" error and exited) was still sitting on the watchdog-sleep, and I launched a second on top. Both spawned their own task-agents into the same worktree on the same branch. Symptoms:

- Two `uv run train.py` processes alive simultaneously, each at ~5s/step instead of the normal ~2s/step (GPU contention)
- Commits stacking without rollback between experiments (`3fd5f08` halve-batch + `9536981` WARMDOWN without a reset in between)
- `results.tsv` un-updated — both agents "owned" it, neither wrote final rows
- Agent text streams referencing state neither agent's own transcript contained ("my DEPTH=6 commit", commit hashes from the other agent's branch)

**Protocol lesson for the harness:** `run_meta_cycle.sh` should refuse to start if the target worktree or branch already exists AND the previous PID is still alive. Currently it re-uses an existing worktree ("reusing" message) but doesn't check for live contenders. Fix is cheap: before `git worktree add`, check that no process's cwd is under that worktree path.

**Clean-up procedure for this class of bug:**
1. `pkill -f "run_meta_cycle.sh"` and `pkill -f "uv run train.py"` to kill all contenders
2. `git worktree remove --force <path>` to delete the worktree
3. `git branch -D meta/<variant>-run<N>` to delete the contaminated branch
4. `rm -rf results/<variant>-run<N>` to reset result artifacts
5. Relaunch as a single bash background task, verify `ps` shows only one harness before arming monitors

**Ambient finding that IS real across variants:** the program.md discard protocol (step 9: "record the discard commit hash, then `git reset --hard <previous kept commit>`") has a subtle trap. The agent in this run did the natural thing — `git add results.tsv && git commit && git reset --hard dd23ac8` — and the `reset --hard` nuked both the experiment commit AND the discard-row commit, leaving `results.tsv` pristine. Every variant will hit this equally, so the relative comparison is fair, but absolute keep/discard counts in results.tsv will underreport discards.

## Cycle-1 finding: `claude -p` one-shot semantics break interactive tool patterns

The first v1-control attempt (before `5e0dd01`) failed with a zero-commit exit at ~$0.29 cost. Root cause: the agent launched `uv run train.py` with `run_in_background: true`, attached its own Monitor, and emitted a text turn-ending message expecting a wake-up when training finished. **`claude -p` exits on end_turn** — no Monitor event can cross that boundary, no "next turn" exists. Training ran on as an orphan process until killed manually.

This is a harness-level constraint, not a meta-prompt preference. Every variant needs a "run training FOREGROUND with `timeout: 600000`" directive at the top, or it hits the same failure regardless of how much discipline the rest of the prompt asks for. The one-shot runtime note is now appended verbatim to all 5 variants. Sanity-check attempt 4 (with the note) shows the agent correctly used `run_in_background: false, timeout: 600000`.

Generalization: if the v3 Vibe Research prompt is ever run via `claude -p` for agentic loops, it also needs this kind of runtime note. It's not in the main prompt today because the canonical invocation is interactive Claude Code where Monitor-based backgrounding is correct. This is a two-world problem: the same prompt works differently under interactive vs. one-shot harnesses.

## Handoff

If picking this up fresh: read this file, then check `autoresearch/apr19` branch for baseline state. Baseline run lives in `<autoresearch-mlx-repo>/run.log` on that branch. Harness code is at `/Users/mark/Desktop/projects/meta-prompt-harness/` on branch `experiment/wave1` (commit `efd5292`). Task-agent branches will be `meta/<variant>-run<N>` in the autoresearch-mlx repo — worktrees under `<harness>/worktrees/<variant>-run<N>/`, results under `<harness>/results/<variant>-run<N>/`. Next step: confirm v1-control-run1 completes cleanly end-to-end, then kick off full sweep.
