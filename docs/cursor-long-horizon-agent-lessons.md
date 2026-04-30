# Cursor Long-Horizon Agent Lessons

Date: 2026-04-30

Roadmap distilled from these notes: [Agent-Native Vibe Research Roadmap](./agent-native-vibe-research-roadmap.md).

## Sources Read

- Cursor, "Scaling long-running autonomous coding" (2026-01-14): https://cursor.com/blog/scaling-agents
- Cursor, "Expanding our long-running agents research preview" (2026-02-12): https://cursor.com/blog/long-running-agents
- Cursor, "Cursor agents can now control their own computers" (2026-02-24): https://cursor.com/blog/agent-computer-use
- Cursor, "The third era of AI software development" (2026-02-26): https://cursor.com/blog/third-era
- Cursor, "Cloud Agents" (2025-10-30): https://cursor.com/blog/cloud-agents
- Cursor, "Build agents that run automatically" (2026-03-05): https://cursor.com/blog/automations
- Cursor, "Meet the new Cursor" (2026-04): https://cursor.com/blog/cursor-3
- Cursor, "Introducing Cursor 2.0 and Composer" (2025-10): https://cursor.com/blog/2-0
- Cursor, "Best practices for coding with agents" (2026): https://cursor.com/blog/agent-best-practices
- Cursor, "Composer 2 Technical Report" (2026-04): https://cursor.com/resources/Composer2.pdf
- Simon Willison, "Wilson Lin on FastRender: a browser built by thousands of parallel agents" (2026-01-23): https://simonwillison.net/2026/Jan/23/fastrender/
- GitHub, `wilsonzlin/fastrender`: https://github.com/wilsonzlin/fastrender

## What Cursor Appears To Have Learned

Cursor's FastRender browser experiment was not mainly a browser-building recipe. It was a multi-agent harness stress test with a browser as the benchmark: large scope, clear public specs, visual output, compilers, and many independent subsystems.

The important architecture pattern was not a flat swarm. Cursor reports that shared-file coordination plus locks caused stale locks, waiting, brittle writes, and risk-averse behavior. Their more successful shape split agents into planners, workers, and judges. Planners recursively explored and decomposed work; workers executed one task with minimal cross-worker coordination; judges decided whether the next cycle should continue. Fresh cycles helped reduce tunnel vision.

The run succeeded by tolerating bounded local messiness while maintaining system-level pressure toward progress. FastRender did not keep every intermediate commit perfect. Temporary compile or API errors were acceptable if the error rate stayed stable and later workers repaired them quickly. This is closer to high-throughput research than conventional trunk discipline.

Verification was the real accelerator. Rust compilation, web specs, golden screenshot comparison, browser screenshots, local demos, videos, logs, and live previews all gave agents feedback without requiring a human to read every diff. Cursor's product posts repeatedly emphasize artifacts that make review fast: logs, screenshots, recordings, and live previews.

The runtime mattered. Cursor's cloud agents run on isolated VMs; the Composer 2 report describes Firecracker VM pods with full development environments, GUI/browser support, checkpointing, and a shadow deployment of Cursor tools for faithful training/evaluation. Their public posts also emphasize moving agents between local and cloud, using cloud sandboxes, and letting agents test with their own browser/computer.

The human role moved upward. Cursor's posts describe humans defining the problem, reviewing plans, approving or redirecting, and evaluating artifacts, rather than watching each line of code. Plan approval before long execution is a recurring theme.

## Implications For Vibe Research

What we just implemented moves Vibe Research in the right direction:

- `vr-research-brief` is the planner-facing artifact.
- `vr-research-runner claim/run/cycle/finish` is now the worker loop.
- `vr-research-admit`, `vr-research-doctor`, and `vr-research-resolve` are the first judge/admin layer.
- Agent Inbox review choices give the human a fast steering surface.
- Cycle artifacts, metrics, seed aggregation, and git commits give reviewers something concrete.

The remaining high-leverage gap is a real orchestrator above the runner:

1. Planner daemon: watches `phase=brainstorm/review`, creates briefs, decomposes wide searches into sibling moves, and wakes when workers resolve.
2. Worker pool: runs disjoint queued moves in separate branches/sandboxes with budgets and bounded retries.
3. Judge loop: reads result docs/artifacts, runs doctor/admit/lint, decides continue/rerun/synthesize/brainstorm, and opens one crisp Agent Inbox card.
4. Artifact-first review: every long worker should publish a live monitor or final figure/video/log summary, not just markdown.
5. Fresh-start policy: after each cycle or failed attempt, spawn a fresh worker context with the result doc and artifact links rather than continuing an increasingly noisy chat.
6. Spec/verifier pressure: research projects should prefer benchmarks, golden outputs, browser screenshots, static checks, and executable tests over prose-only goals.
7. Runtime isolation: local PTYs are enough for small loops, but serious long-horizon work wants per-move sandboxes with resumable state, checkpointed artifacts, and safe network/secret boundaries.

## Product Translation

For Vibe Research, the Cursor lesson is: make the human review throughput, not token throughput, the scarce resource. The interface should show the latest artifact, the metric/noise state, the next recommended action, and one-click steering. The system underneath can run many cycles, but the human should only see crisp decision points.
