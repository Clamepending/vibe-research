# Agent Organization Benchmark

Date: 2026-05-01

This is the first cheap benchmark harness for testing whether the Vibe
Research organization loop is actually better than a plain single-pass agent.
It is inspired by PostTrainBench, but intentionally much cheaper.

## Why Not Full PostTrainBench First?

PostTrainBench gives each CLI agent small base LLMs, an H100, and a 10-hour
budget to improve benchmark performance through post-training. See the public
leaderboard at <https://posttrainbench.com/> and the methodology summary at
<https://epoch.ai/benchmarks/post-train-bench>. That is the right north-star
shape for AI R&D automation, but too expensive for every inner-loop UI and
orchestration change.

So the first Vibe harness uses `posttrain-lite`: a deterministic local proxy
where each strategy edits a tiny `recipe.json`, sees a dev profile, and is
scored by a hidden holdout profile. It does not measure real post-training
skill. It measures whether our organization loop preserves the benchmark
contract and improves a recipe through iterative evidence.

## Command

```bash
vr-research-org-bench run output/org-bench/posttrain-lite --seeds 0,1,2
```

Built-in strategies:

| strategy | meaning |
| --- | --- |
| `baseline` | No edits; scores the seed recipe. |
| `single-proxy` | One-shot dev optimizer; simulates an individual agent grabbing the visible dev optimum. |
| `org-autopilot-proxy` | Runs the same scenario through `runResearchAutopilot` for two cycles; simulates review-driven correction toward a more robust recipe. |
| `single-agent-provider` | Runs a provider command template once in the scenario repo. Use this for real Codex/Claude one-shot baselines. |
| `org-provider` | Runs the provider command template through the Vibe autopilot loop for multiple cycles, recording result-doc evidence. |
| `org-provider-reviewed` | Runs worker cycle -> reviewer command -> worker cycle, feeding the reviewer memo into the next worker prompt. |

Each run writes `report.json` with per-seed dev score, holdout score, recipe,
integrity result, wall time, and strategy metadata.

Provider-backed example:

```bash
vr-research-org-bench run output/org-bench/provider-smoke \
  --seeds 0 \
  --strategy single-agent-provider \
  --strategy org-provider-reviewed \
  --agent-provider codex \
  --provider-command 'codex exec --sandbox workspace-write --skip-git-repo-check --cd {scenarioDir} "$(cat {promptFile})" </dev/null' \
  --reviewer-provider codex-reviewer \
  --reviewer-command 'codex exec --sandbox workspace-write --skip-git-repo-check --cd {scenarioDir} "$(cat {promptFile})" </dev/null'
```

The `</dev/null` matters for `codex exec`: without it, the runner's shell can
leave stdin open and Codex may wait for additional input until the cycle times
out. The research runner now closes stdin for cycle commands too, but keeping
the redirect in provider templates is harmless and makes ad hoc shell runs
behave the same way.

The provider command runs with these environment variables:

| variable | meaning |
| --- | --- |
| `VIBE_RESEARCH_ORG_BENCH_PROMPT_FILE` | Prompt file for the current run/cycle. |
| `VIBE_RESEARCH_ORG_BENCH_SCENARIO_DIR` | Scenario working directory. |
| `VIBE_RESEARCH_ORG_BENCH_STRATEGY` | Strategy name. |
| `VIBE_RESEARCH_ORG_BENCH_CYCLE` | Cycle number. |
| `VIBE_RESEARCH_ORG_BENCH_SEED` | Seed id. |
| `VIBE_RESEARCH_ORG_BENCH_PROVIDER` | Provider label passed by `--agent-provider`. |
| `VIBE_RESEARCH_ORG_BENCH_ROLE` | `worker` or `reviewer`. |
| `VIBE_RESEARCH_ORG_BENCH_REVIEW_FILE` | Reviewer memo path, or the memo to feed into the next worker cycle. |

## What This Tests

- Can the Vibe loop run the same task through durable project state?
- Does iterative review/correction beat a one-shot dev optimizer on holdout?
- Do protected benchmark files remain unchanged?
- Can we compare strategies over multiple seeds with mean/std?

## What This Does Not Test Yet

- Real fine-tuning.
- Real GPU scheduling.
- Real model quality.
- Reward-hacking resistance against a malicious agent with filesystem access.

## Next Benchmark Steps

1. Run `single-agent-provider`, `org-provider`, and `org-provider-reviewed`
   against real Codex/Claude on several seeds, then inspect failure modes.
2. Make `org-provider-reviewed` optionally use Agent Inbox reviewer sessions
   instead of only provider command templates.
3. Add telemetry columns: human review latency, artifact opens, ask-why usage,
   rerun rate, doctor clean-rate, and paper-lint clean-rate.
4. Add a heavier optional `posttrain-mini` suite using an actual small model or
   classifier when a GPU/cloud budget is available.
5. Promote only benchmarked organization changes into default prompts/tools.
