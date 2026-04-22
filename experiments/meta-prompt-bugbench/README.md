---
name: Meta-Prompt Bugbench
description: Measure whether the 45.8k-char Vibe Research agent prompt pulls its weight against minimal-discipline controls, using a battery of small Python bug-fixes as the inner task. Successor to meta-prompt-autoresearch after that benchmark was deemed low-signal + OOM-unsafe.
type: experiment
updated_at: 2026-04-19
status: DESIGN COMPLETE, IMPLEMENTATION ~20% — paused for disk/panic constraints on the origin host. Ready for handoff to another machine.
supersedes: experiments/meta-prompt-autoresearch/README.md (partially — only the benchmark choice; the harness learnings carry over)
---

## The question

Is the ~45.8k-character Vibe Research agent prompt (`CLAUDE.md` / mirrored into the v0 meta-prompt) pulling its weight in agentic work, or can it be trimmed substantially without losing the behaviors that matter?

Concrete motivation: the Claude Code harness now surfaces a performance warning at >40k characters. If a minimal prompt (v1-control, ~1.1k chars) or a no-discipline prompt (v3, ~1.1k chars) resolves the same fraction of bugs as v0, that's a strong argument for trimming the canonical prompt. If v0 meaningfully outperforms on specific bugs-by-design, that's evidence for the opposite.

## Why this benchmark (over MLX pretraining)

The earlier sibling experiment (`../meta-prompt-autoresearch/README.md`) used Karpathy's `autoresearch-mlx` as the inner task. On reflection that was a poor fit: one `val_bpb` number per replicate ≈ 1 bit of signal, 6 min + 21 GB peak per cycle, task-knowledge-bound (a better prompt doesn't teach the agent more ML), and `program.md` already encoded the discipline we wanted to test. Bugbench fixes all four:

| dimension | MLX autoresearch | bugbench (this page) |
|---|---|---|
| cycle cost | 6 min, 21 GB peak | ~1–2 min, ~2 GB peak |
| signal per replicate | 1 `val_bpb` number | pass/fail on N bugs (5 initially, scalable to 15+) |
| prompt sensitivity | low — task is ML-knowledge-bound | high — bugs are designed to punish specific undisciplined behaviors |
| infra risk | OOM at 2× concurrency (3 panics) | CPU only, trivial memory |
| signal-per-dollar | ~5 h sweep, ~10 numbers | ~2 h sweep, ~50 pass/fails |

## Design

### The 5 meta-prompt variants (carried over from MLX experiment)

All five were authored on origin host at `<harness-repo>/meta-prompts/<variant>.md` on branch `experiment/wave1` commit `efd5292` (not pushed to a remote at handoff time). Summary for reconstruction:

| id | variant | size | what's in it |
|---|---|---|---|
| v0 | full Vibe Research | ~47k chars | the entire current `CLAUDE.md` (Identity, Core Principles, Research Mode, Autoresearch Loop, Git Discipline, Citation Rigor, Faithful Reporting, Knowledge Model…) with `{{WIKI}}` → `.vibe-research/wiki` substitution, plus the **claude -p runtime note** (below) appended verbatim |
| v1-control | minimal | ~1.2k chars | "You are a researcher running an autoresearch loop on a small task. Read `PROMPT.md` in the current directory. Follow it." + runtime note |
| v2-ml-priors | v0 + ML priors | ~49k chars | v0 body + a terse "ML priors" section (depth/width, LR, warmup, logit-cap, frozen data, etc.) + runtime note. *Note: for bugbench this variant is mostly a null — bugbench has no ML. Kept for experiment parity; expect it to score ≈ v0.* |
| v3-no-priors-no-discipline | ultra-minimal | ~1.1k chars | "Read `PROMPT.md`. Do what it says. Stop when your budget is reached." + runtime note |
| v4-explicit-reflect | v0 + reflection rule | ~48k chars | v0 body + a forced "after 2 failed attempts in a row, run `git show HEAD --stat`, `git log --oneline -10`, then write 3 specific observations before next edit" micro-protocol + runtime note |

The **runtime note** (appended verbatim to every variant) compensates for `claude -p` one-shot semantics:

> ## CRITICAL runtime constraints
>
> You are invoked via `claude -p` (one-shot). Once you emit a final text response without another tool call, the whole session exits — there is no "next turn," no wake-up, no Monitor event can rescue you.
>
> - **Run subprocesses (pytest, etc.) in the FOREGROUND, blocking.** Use Bash with `run_in_background: false` and a large-enough `timeout`. Do NOT use `run_in_background: true` with Monitor/polling — that requires cross-turn scheduling and will not work here.
> - **Complete the whole task before ending your turn.** Edit → run tests → read output → edit again → repeat until tests pass, all in one turn.
> - **Before your final text response, print** the final `pytest` output. That is the signal the loop is done.

### The 5 bugs

Each bug is self-contained under `bugs/<id>/` with `src/`, `tests/`, `PROMPT.md` (the task contract shown to the agent), and `EXPECTED_ROOT_CAUSE.md` (held back from the agent, used for human grading). Each designed to stress a specific discipline behavior the RV prompt claims to encode.

#### Bug 01 — `sanity` (baseline — all variants should pass)

`src/calculator.py`:
```python
def add(a, b):
    return a - b


def multiply(a, b):
    return a * b
```

`tests/test_calculator.py` (five tests): `add(2,3)==5`, `add(0,7)==7`, `add(-2,-3)==-5`, `multiply(3,4)==12`, `multiply(5,0)==0`.

**Intended fix:** change `a - b` to `a + b`. All 5 tests pass.

**Tests:** is the harness working? Any variant that fails bug 01 signals an infrastructure problem, not a prompt-quality problem.

#### Bug 02 — `read_stderr` (reading output beyond the assertion)

`src/report.py`:
```python
import sys

def compute_report(data):
    """Return the sum of data. For short inputs, uses a fallback heuristic
    that returns a fixed sentinel value. This is legacy behavior."""
    if len(data) < 3:
        print(
            "WARNING: compute_report: short input (len<3), using legacy sentinel=42",
            file=sys.stderr,
        )
        return 42
    return sum(data)
```

`tests/test_report.py` (five tests): `[7]→7`, `[3,4]→7`, `[1,2,3]→6`, `[1,2,3,4,5]→15`, `[]→0`.

**Intended fix:** remove the `if len(data) < 3` branch; just `return sum(data)` (works for `[]` too since `sum([]) == 0`).

**Discipline tested:** an agent that looks only at the assertion error (`assert 42 == 7`) can thrash. The WARNING on stderr in pytest output points directly at the fallback branch. RV's "actually look at your results" should help.

#### Bug 03 — `seductive_fix` (hardcoded fix breaks a sibling test)

`src/validator.py`:
```python
def is_valid_email(s):
    # Bug: always returns False
    return False
```

`tests/test_validator.py`:
```python
def test_valid_simple():
    assert is_valid_email("a@b.com") is True

def test_invalid_no_at():
    assert is_valid_email("nope") is False

def test_invalid_empty():
    assert is_valid_email("") is False

def test_valid_with_subdomain():
    assert is_valid_email("user@mail.example.com") is True

def test_invalid_double_at():
    assert is_valid_email("a@@b.com") is False
```

**Seductive wrong fix:** `return True` always — passes `test_valid_simple` but fails 3 others.

**Intended fix:** a minimal real validator — e.g., `return bool(s) and s.count("@") == 1 and "." in s.split("@")[1]`. (Any correct small validator is fine.)

**Discipline tested:** "run the full pytest, not just the failing test." RV's "verify after fix" + "the task isn't done until it's working" push this; minimal prompts may just make the first failing test pass and stop.

#### Bug 04 — `offby_one` (naive fix at the wrong layer breaks a sibling test)

`src/counter.py`:
```python
def count_over(lst, threshold):
    """Return the count of items in lst that are STRICTLY greater than threshold."""
    count = 0
    for x in lst:
        if x >= threshold:  # bug: should be >
            count += 1
    return count
```

`tests/test_counter.py`:
```python
def test_basic():
    assert count_over([1, 2, 3, 4, 5], 3) == 2  # {4, 5}

def test_empty():
    assert count_over([], 3) == 0

def test_all_below():
    assert count_over([1, 2], 5) == 0

def test_threshold_excluded():
    assert count_over([3, 3, 3, 4], 3) == 1  # only {4}

def test_negative_threshold():
    assert count_over([-1, 0, 1], -1) == 2  # {0, 1}
```

**Seductive wrong fix:** see `assert 3 == 2`, "just subtract 1" → `return count - 1`. Passes `test_basic` but fails `test_empty` (returns -1).

**Intended fix:** change `>=` to `>`. Passes all 5.

**Discipline tested:** root-cause tracing vs. patch-over-output. "Change one thing at a time," "fix at the right layer." Overlaps with bug 03 but via a different failure mode (numeric vs. categorical).

#### Bug 05 — `multifile` (bug is in a module the failing test doesn't directly name)

`src/config.py`:
```python
MAX_ITEMS = 10  # bug: should be 100 per spec in PROMPT.md
DEFAULT_TIMEOUT = 30
```

`src/processor.py`:
```python
from config import MAX_ITEMS

def process(items):
    if len(items) > MAX_ITEMS:
        raise ValueError(f"too many items: {len(items)} > {MAX_ITEMS}")
    return [x * 2 for x in items]
```

`tests/test_processor.py`:
```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import pytest
from processor import process

def test_small():
    assert process([1, 2, 3]) == [2, 4, 6]

def test_at_limit():
    assert process(list(range(100))) == [x * 2 for x in range(100)]

def test_over_limit():
    with pytest.raises(ValueError):
        process(list(range(101)))

def test_empty():
    assert process([]) == []

def test_negatives():
    assert process([-1, -2]) == [-2, -4]
```

`PROMPT.md` contract for this bug (critical — tells the agent the spec says 100):
> The system must accept up to 100 items per batch (see `test_at_limit`). Fix the code so all tests pass.

**Seductive wrong fix:** patch `processor.py` to special-case the 100 — e.g., `if len(items) > 100:` — now test_over_limit fails (101 no longer raises at the declared `MAX_ITEMS`).

**Intended fix:** change `MAX_ITEMS = 10` to `MAX_ITEMS = 100` in `config.py`.

**Discipline tested:** investigate-before-build — read imports, trace the constant to its definition, fix at the source. RV's "understand before you build" pushes this.

### Meta-harness

One script `run_bugbench.sh <variant> <replicate> <bug> [timeout_s]`:

```bash
#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:?variant required (e.g. v0, v1-control)}"
RUNID="${2:?run id required (1, 2, ...)}"
BUG="${3:?bug id required (01_sanity, 02_read_stderr, ...)}"
TIMEOUT="${4:-240}"

HARNESS="/path/to/meta-prompt-harness"  # on the new host
BUGBENCH="/path/to/meta-prompt-bugbench"
META_FILE="$HARNESS/meta-prompts/${VARIANT}.md"
RESULT_DIR="$HARNESS/results-bugbench/${VARIANT}-run${RUNID}-${BUG}"
WORK_DIR="$HARNESS/worktrees-bugbench/${VARIANT}-run${RUNID}-${BUG}"

# Clean + stage: fresh copy of the bug every time. No shared state.
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cp -R "$BUGBENCH/bugs/${BUG}/"* "$WORK_DIR/"
# Hide the expected-root-cause file from the agent
rm -f "$WORK_DIR/EXPECTED_ROOT_CAUSE.md"

mkdir -p "$RESULT_DIR"

KICKOFF="You are in $WORK_DIR. Read PROMPT.md and follow it exactly. Budget: ${TIMEOUT} seconds. Do NOT ask for confirmation. Begin."

# CRITICAL: bypass the Vibe Research claude wrapper — see "Wrapper bypass" section below.
CLAUDE_BIN="$HOME/.local/bin/claude"
[[ -x "$CLAUDE_BIN" ]] || { echo "real claude binary not found at $CLAUDE_BIN" >&2; exit 2; }

cd "$WORK_DIR"
VIBE_RESEARCH_AGENT_PROMPT_PATH="" \
VIBE_RESEARCH_PLAYWRIGHT_SKILL="" \
"$CLAUDE_BIN" \
  --model claude-sonnet-4-6 \
  --setting-sources "" \
  --system-prompt "$(cat "$META_FILE")" \
  --tools default \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  --max-budget-usd 2 \
  -p "$KICKOFF" \
  > "$RESULT_DIR/transcript.jsonl" 2>&1 &
CLAUDE_PID=$!

( sleep "$TIMEOUT" && kill -TERM "$CLAUDE_PID" 2>/dev/null && sleep 3 && kill -KILL "$CLAUDE_PID" 2>/dev/null ) &
WATCHDOG=$!
wait "$CLAUDE_PID" 2>/dev/null || true
kill "$WATCHDOG" 2>/dev/null || true

# Grade: run pytest in the work dir.
cd "$WORK_DIR"
if pytest -q > "$RESULT_DIR/pytest.log" 2>&1; then
    PASS=true
else
    PASS=false
fi

cat > "$RESULT_DIR/result.json" <<EOF
{
  "variant": "$VARIANT",
  "replicate": $RUNID,
  "bug": "$BUG",
  "pass": $PASS,
  "ended_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "=== $VARIANT run$RUNID $BUG: pass=$PASS ==="
```

Sweep runner `run_bugbench_sweep.sh` (sequential — no concurrency, keeps the host safe):

```bash
#!/usr/bin/env bash
set -euo pipefail
VARIANTS=(v0 v1-control v2-ml-priors v3-no-priors-no-discipline v4-explicit-reflect)
REPLICATES=(1 2)
BUGS=(01_sanity 02_read_stderr 03_seductive_fix 04_offby_one 05_multifile)

for V in "${VARIANTS[@]}"; do
  for R in "${REPLICATES[@]}"; do
    for B in "${BUGS[@]}"; do
      ./run_bugbench.sh "$V" "$R" "$B" 240
    done
  done
done

# Aggregate: one CSV row per (variant, replicate, bug) with pass/fail
# plus a summary table of resolve-rate per variant.
```

### Expected outcomes / falsifiers

- **H1: v0 meaningfully beats v1-control.** Would need ≥2 bugs where v0 passes and v1-control fails, consistently across replicates.
- **H2: v3-no-discipline fails bugs 03/04.** The seductive-fix and naive-fix-at-wrong-layer designs should expose the minimal prompt. If v3 passes these as often as v0, the "discipline text" in RV is not doing that work.
- **H3: v4-explicit-reflect helps on bug 05.** The forced-reflection rule should push an agent to read `config.py` after the first patch on `processor.py` fails. If v4 ties v0 here, the micro-intervention isn't adding value.
- **H4: bug 01 resolves 10/10 for all variants.** Sanity check. A fail here means infrastructure problem, invalidating other bugs.

**A finding where all 5 variants score near-identical on bugs 02–05 is itself the answer:** it means the 45.8k RV prompt is not pulling its weight on this kind of task, and the canonical prompt should be trimmed.

## Durable learnings carried over from the sibling experiment

These are host-independent and apply to any future `claude -p` meta-experiment on a Vibe Research box. Record them in a topic page if/when it exists.

### 1. The Vibe Research claude wrapper contaminates meta-prompt experiments (critical)

`$PATH` on a Vibe Research-installed machine resolves `claude` to `$VIBE_RESEARCH_APP/bin/claude`, a shell wrapper that always calls the real claude with `--append-system-prompt "$GUIDANCE\n\n$(cat $VIBE_RESEARCH_AGENT_PROMPT_PATH)"`. That means every `claude -p --system-prompt <meta-prompt>` call you make ends up with the Playwright guidance + the full Vibe Research agent prompt appended to your meta-prompt. Minimal-prompt variants aren't actually minimal.

**Bypass:** call the real binary directly. On a typical RV install it's at `$HOME/.local/bin/claude` (a symlink to `$HOME/.local/share/claude/versions/<version>` — a Mach-O executable, not a shell script). Defensively clear `VIBE_RESEARCH_AGENT_PROMPT_PATH=""` and `VIBE_RESEARCH_PLAYWRIGHT_SKILL=""` in the child env in case the real binary reads them via some other code path.

**Verify bypass worked:** `ps -ef | grep claude | grep -v grep` should show the child claude cmdline with `--system-prompt` containing ONLY your meta-prompt content, no `--append-system-prompt` flag.

### 2. `claude -p` is one-shot; tool-result waits across end-of-turn are impossible

`claude -p` exits on `end_turn`. Background processes launched with `run_in_background: true` plus a Monitor do not survive past the end of the agent's text turn — the session is already gone before any ping arrives. Every meta-prompt must include a runtime note that says: *run subprocesses in the foreground with a large `timeout`; complete the whole loop in one turn*. Without this, task-agents launch a subprocess, emit a "waiting…" turn, and die instantly.

### 3. Concurrent meta-cycles on shared worktrees contaminate each other

If two `run_meta_cycle.sh` instances target the same branch+worktree, both agents commit to it, both run subprocesses, both race for the filesystem and the GPU. Symptoms include stacked commits without rollback between experiments, processes referring to state from the other agent's branch, and (on MLX) 2× memory → OOM panic. The harness must `pgrep` for prior instances before starting and refuse to launch if one is alive.

### 4. On the origin host (M3 Pro, 36 GB unified RAM), MLX training is 1× safe, 2× fatal

Baseline `autoresearch-mlx` training peaks at 21.2 GB. Headroom at 1× is ~3 GB after macOS + Cursor + Claude Code. At 2× concurrency (which the contamination bug caused), the memory compressor thrashes hard enough that `watchdogd` cannot check in for 92 seconds, triggering a kernel panic. Three such panics occurred on 2026-04-19 (09:56, 10:47, 11:10). Separately, the host was at 100% APFS capacity, which amplifies the panic risk because the compressor has no disk spill. **Don't run MLX meta-experiments on a 36 GB machine without 5+ GB free on the data volume and a hard `pgrep` gate against concurrent trainings.** Bugbench was chosen in part to sidestep this entirely.

### 5. The program.md-style discard protocol drops discard-record commits

If the agent does `git add results.tsv && git commit && git reset --hard <baseline>`, both the experiment commit AND the discard-record commit vanish from history. Every MLX variant hit this equally so relative comparisons remain fair, but absolute keep/discard counts in `results.tsv` under-report discards. Not a bugbench problem (no discards), but worth writing into a topic page for any future multi-cycle autoresearch task.

## Implementation state at handoff

- [x] Design finalized (this page).
- [x] 5 meta-prompt variants authored on origin host at `<harness-repo>/meta-prompts/<variant>.md` on branch `experiment/wave1` commit `efd5292`. **Not pushed to a remote.** The v0/v2/v4 variants are the full `CLAUDE.md` + runtime note; v1/v3 are fully reproduced above. **New-host action:** either pull/push the branch, or reconstruct — v1 and v3 are in this page; v0 is `cat <repo>/CLAUDE.md | sed 's|{{WIKI}}|.vibe-research/wiki|g'` + append the runtime note; v2 and v4 are v0 + an extra section each (see variant table above for content descriptions).
- [x] Harness wrapper-bypass fix committed on origin host at `<harness-repo>@aeb2aa1` branch `experiment/wave1`. **Not pushed.** Script body is reproduced in "Meta-harness" section above — new host can copy it directly.
- [x] Bugs 01 and 02 fully implemented on origin host at `<bugbench-repo>/bugs/{01_sanity,02_read_stderr}/` on branch `experiment/bugbench-v1`. **Not committed, not pushed.** All code is reproduced above — new host should `git init` and recreate from this page.
- [ ] Bugs 03, 04, 05 designed in full above, not yet scaffolded on origin host.
- [ ] `run_bugbench.sh` and `run_bugbench_sweep.sh` designed in full above, not yet written on origin host.
- [ ] Sanity run (v1-control × 1 bug) not executed.
- [ ] Full sweep (5 × 2 × 5 = 50 runs) not executed.
- [ ] Synthesis page (resolve-rate table + qualitative observations) not written.

## Handoff — new-host checklist

A fresh agent on a new host with ≥30 GB free disk, ≥16 GB RAM, and Claude Code installed can pick this up in one session:

1. **Clone `vibe-research` with this wiki** so you can read this page on the new machine. Confirm `.vibe-research/wiki/experiments/meta-prompt-bugbench/README.md` is this file.
2. **Find your real claude binary.** Run `which claude` — if it points at a Vibe Research wrapper, also run `ls -la ~/.local/bin/claude` and note the real target. The harness script in this page assumes `$HOME/.local/bin/claude` is the real binary; adjust if your install differs. Verify with `file $HOME/.local/bin/claude` — should say Mach-O or ELF executable, NOT "ASCII text" (that'd be another wrapper).
3. **Create two repos:**
   - `meta-prompt-harness/` — holds `meta-prompts/{v0,v1-control,v2-ml-priors,v3-no-priors-no-discipline,v4-explicit-reflect}.md`, `run_bugbench.sh`, `run_bugbench_sweep.sh`, `results-bugbench/`, `worktrees-bugbench/`.
   - `meta-prompt-bugbench/` — holds `bugs/01_sanity/`, `bugs/02_read_stderr/`, `bugs/03_seductive_fix/`, `bugs/04_offby_one/`, `bugs/05_multifile/`, each with `src/`, `tests/`, `PROMPT.md`, `EXPECTED_ROOT_CAUSE.md`.

   Each repo on its own `experiment/<slug>` branch, per the RV autoresearch git discipline. Commit every cycle with a structured message. Tag the winner at the end.
4. **Author the 5 meta-prompts** using the descriptions in the variant table above. Every variant must end with the runtime note verbatim. Confirm line counts roughly match (v0/v2/v4 ~47–49k; v1/v3 ~1.1–1.2k). Do *not* just cat `CLAUDE.md` for v0 without the runtime-note tail — without it the agent will idle-end its turn waiting for a background process.
5. **Scaffold all 5 bugs** using the code blocks in this page. For each bug, verify the starting state fails: `cd bugs/<id> && pytest -q` should report failures. Then verify the expected fix passes: apply the `EXPECTED_ROOT_CAUSE.md` fix manually and re-run — should be 5/5 green.
6. **Write both harness scripts** verbatim from this page. Adjust the absolute paths at the top of `run_bugbench.sh` (HARNESS, BUGBENCH, CLAUDE_BIN).
7. **Sanity run:** `./run_bugbench.sh v1-control 1 01_sanity 180`. Verify: `ps -ef | grep claude` while it's running shows `--system-prompt` with ONLY the v1-control text, no `--append-system-prompt`. Verify: `results-bugbench/v1-control-run1-01_sanity/result.json` shows `"pass": true`.
8. **Full sweep:** `./run_bugbench_sweep.sh`. Wall-clock budget ~2 h. Memory budget trivial. No GPU. Tail the aggregate log as it runs; each bug should emit a `=== <variant> run<N> <bug>: pass=<bool> ===` line.
9. **Write synthesis** into a new section at the top of this page: resolve-rate table per variant + 3–5 sentences of qualitative observations (which bugs differentiate the variants? does v3 specifically fail bug 03/04? does v4 help on bug 05?). Then update `.vibe-research/wiki/log.md` with a dated entry and `.vibe-research/wiki/index.md` with a pointer if not already present.

## Open questions the new host should record answers to

1. Does v1-control resolve the same fraction of bugs as v0? (If yes → strong argument to trim the canonical `CLAUDE.md`. If no → which bugs differentiate, and why?)
2. Does v3-no-discipline *specifically fail* bug 03 (seductive fix) and bug 04 (naive fix at wrong layer)? If yes, that's evidence the discipline text is earning its keep on those cases even if the bulk is redundant.
3. Does v4-explicit-reflect outperform v0 on bug 05 (multi-file)? If yes, the micro-intervention is worth adding to the main prompt.
4. How noisy is the variance across replicates? If replicate 1 and replicate 2 disagree more than 20% of the time, bump replicates to 4 and rerun.
5. Does v2-ml-priors tie v0 on bugbench? (Expected, since bugbench has no ML — if it *beats* v0, that would be a surprising finding about domain-priming dose-response.)

## Related

- `../meta-prompt-autoresearch/README.md` — the paused sibling experiment; has more detail on the `claude -p` and wrapper-bypass discoveries that apply here.
- The canonical prompt under test lives at `<vibe-research-repo>/CLAUDE.md` on this wiki's own repo.
