# Autonomous Research Organizations Literature Review

Snapshot date: 2026-04-30

This is a synthesis of recent work on multi-agent LLM systems, AlphaEvolve-style evolutionary discovery, autonomous research systems, and human-in-the-loop communication. The goal is to extract design principles for Vibe Research, not to produce a full survey.

## Executive Synthesis

Vibe Research should not copy "many agents talking" as the central metaphor. The stronger pattern across the literature is an auditable research organization:

- A small number of explicit roles with written state, not a free-form chat swarm.
- Automated evaluation wherever the task admits it, with provenance and noise estimates treated as first-class.
- Evolutionary search over moves, prompts, tools, and workflows only when the evaluator is strong enough.
- Human attention routed through small, interruptible, capability-scoped cards rather than long transcripts.
- A durable scientific ledger that lets agents resume, compare, review, and learn without rewriting history.

Vibe Research already has unusually good bones for this: Library, project README, ACTIVE, QUEUE, LOG, result docs, paper, doctor, admit, lint-paper, agent canvas, Agent Inbox, buildings, scaffold recipes, and persistent terminals. The next step is to make the organization itself measurable and evolvable.

## Deep Reading Ledger

This section records what I actually retrieved and read closely in the second pass. "Deep read" here means full text or full HTML was retrieved and I read the abstract, method/system design, evaluation, results, limitations, and the parts most relevant to Vibe Research. It does not mean every appendix table was exhaustively audited.

Items that appear later in the Source Map or References but not in this ledger were used as context or citation-trail support, not as deep-reading inputs.

| Source | Retrieval | Sections read closely | Evidence strength | Vibe Research implication |
| --- | --- | --- | --- | --- |
| [AlphaEvolve](https://arxiv.org/abs/2506.13131) | arXiv PDF | Introduction; task specification; prompt sampling; creative generation; evaluation; evolution database; distributed pipeline; results; ablations; discussion | Strong for evaluator-grounded code evolution; white paper, but detailed system mechanics and ablations | Treat result docs, branches, figures, and insights as the "program database"; only evolve where evaluators are hard enough. |
| [FunSearch](https://www.nature.com/articles/s41586-023-06924-6) | Nature PDF | Abstract; specification; evaluator; program database; prompt construction; distributed workers; cap-set and bin-packing results | Strong; peer-reviewed, clear evaluator/program database mechanism | Vibe Research should prefer evolving interpretable programs/protocols over opaque chat transcripts. |
| [Towards end-to-end automation of AI research](https://www.nature.com/articles/s41586-026-10265-5) | Nature PDF | Workflow; automated reviewer; human workshop submission; limitations; methods | Strong as a milestone, but the paper itself emphasizes uneven quality, manual filtering, and workshop-level bar | Full research lifecycle automation is plausible, but Vibe should log human filtering and keep paper quality checks separate from self-review. |
| [AI Scientist-v2](https://arxiv.org/abs/2504.08066) | arXiv PDF | Workflow; agentic tree search; experiment manager; VLM feedback; peer-review discussion | Useful for system design; preprint companion to later Nature article | Stage-specific node types map cleanly to Vibe cycles: debug, rerun, ablation, aggregation, analysis. |
| [AI co-scientist](https://arxiv.org/abs/2502.18864) | arXiv PDF | System overview; specialized agents; tournament; expert-in-the-loop; evaluation; limitations; safety | Strong architecture signal; biomedical validations are promising but small and expert-mediated | Use generate, reflect, rank, evolve, meta-review roles, but keep expert oversight and independent validation explicit. |
| [Agent Laboratory](https://arxiv.org/abs/2501.04227) | arXiv PDF | Abstract; related work; workflow; literature review; experiment planning; mle-solver; human evaluation claims | Useful applied template; important warning that automated scores overestimated human quality | Human feedback at stages should be native. LLM judges are useful scouts, not final admissions. |
| [AutoGen](https://arxiv.org/abs/2308.08155) | arXiv PDF | Conversable agents; human/tool/LLM capabilities; conversation programming | Strong framework paper, less of an evaluation paper | Make coordination programmable, but do not let free-form conversation be the durable artifact. |
| [MetaGPT](https://arxiv.org/abs/2308.00352) | arXiv PDF / ICLR paper text | SOP framing; structured communication; role specialization; message pool | Strong design lesson for structured handoffs | Vibe's README/result-doc/paper protocol is an SOP; strengthen it with typed commands and validators. |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) | arXiv PDF, 2026 preprint | Abstract; introduction; architecture taxonomy; scaling claims; coordination overhead discussion | Very relevant but recent preprint; treat numbers as provisional | Add agents only when task structure supports it; record topology and compare to single-agent baselines. |
| [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435) | arXiv PDF / ICLR paper text | ADAS formulation; search space; search algorithm; evaluation function; Meta Agent Search | Strong conceptual fit; benchmark generalization still needs replication in Vibe contexts | Evolve occupation prompts, scaffold recipes, and topology policies as code-like artifacts with benchmark evaluators. |
| [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf) | Microsoft PDF | Full guideline table; method; validation process | Strong HCI guidance, not agent-specific | Agent Inbox cards should expose capability, confidence, consequence, correction, dismissal, and global controls. |
| [Human-Autonomy Teaming review](https://journals.sagepub.com/doi/10.1177/0018720820960865) | SAGE full HTML | Abstract; definitions; autonomy/team boundary; empirical review framing | Strong empirical review, pre-LLM but directly relevant to teaming | Treat agents as teammates only when they have distinct roles, interdependence, and bounded responsibilities. |
| [HULA](https://arxiv.org/abs/2411.12924) | arXiv PDF | Abstract; framework; stages; deployment metrics; UI flow | Strong real-world HITL software-agent evidence | Mid-task human review works: plan approval, code approval, and PR handoff should be first-class Vibe states. |
| [Adaptive Human-Agent Teaming review](https://arxiv.org/abs/2504.10918) | arXiv PDF | Abstract; process dynamics; team role development framing | Supporting context | Vibe roles should evolve over a project, but the current role at each step must be explicit. |
| [Elhuyar literature system](https://arxiv.org/abs/2604.01452) | arXiv PDF | Abstract; pipeline; human feedback loop; structured extraction | Supporting context | Literature agents should produce structured extraction plus reviewable charts, not just prose summaries. |

## Three-Reviewer Verdict

### Senior Engineer

The durable system should be built around artifact protocols, not agent personalities. The literature repeatedly shows that success comes from strong interfaces: evaluators in AlphaEvolve/FunSearch, SOP handoffs in MetaGPT, conversation programming in AutoGen, stage gates in HULA, and tree-search node schemas in AI Scientist-v2.

Engineering priorities:

- Build `vr-research-queue` and `vr-research-leaderboard` so queue/admission changes stop being markdown surgery.
- Add topology metadata to result docs so each move records whether it was single-agent, reviewed, parallelized, or human-steered.
- Make Agent Inbox predicates real runtime gates: `approved`, `rejected`, `steer`, `pause`, `resume`, `timeout`.
- Make every autonomous evaluator declare its type: hard test, noisy metric, LLM judge, human rubric, or qualitative.
- Build a project-level "program database" view that indexes result docs, branches, cycles, figures, insights, evaluator type, and follow-up moves.
- Keep one owner per move. Parallelism belongs in independent moves, reruns, reviewer checks, and literature sidecars.

The danger is building a beautiful swarm UI that increases coordination cost. The right engineering taste is boring: typed files, explicit state, reproducible commands, validators, and small action cards.

### Tenured ML Professor

The strong scientific claim across AlphaEvolve, FunSearch, and AI Scientist is that test-time search can turn LLMs into discovery engines when feedback is grounded. The weak claim is that LLM self-evaluation alone is enough. It is not.

Scientific requirements for Vibe Research:

- Separate generation from evaluation. The same model family may propose, but admission needs independent evidence.
- Do not let Elo, LLM judges, or reviewer agents become leaderboard truth unless calibrated against human or hard-test outcomes.
- Log human filtering. AI Scientist's workshop result is impressive, but the paper explicitly reports manual selection of promising outputs before submission. Vibe should record that as a stage, not hide it.
- Require baselines. Multi-agent runs must compare against a single-agent or simpler-topology baseline whenever the project is evaluating agent architecture.
- Preserve negative results. AI co-scientist notes limited access to negative unpublished data; Vibe can make negative results a local advantage by preserving falsified moves, limitations, and failed branches.
- Treat "autonomous science" as staged autonomy. Ideation, execution, review, and publication have different risk profiles and should have different approval gates.

The Vibe Research advantage is methodological discipline: pre-registration, falsifiers, noise estimates, paper lint, doctor, and result docs. That is closer to a lab notebook than most agent frameworks. Protect that.

### Grad Student With Two Years Experience

The practical next move is not to implement "AI co-scientist for everything." Start with a tiny, measurable self-improvement loop.

Build this first:

1. Create a Vibe project called `agent-org-design`.
2. Ranking criterion: `mix: task_success_rate (higher) + paper_integrity`.
3. Code repo: `vibe-research`.
4. Candidate moves: topology metadata, queue command, reviewer-card prototype, mid-task steering predicates, program-database index.
5. Evaluators: bugbench pass rate, doctor clean-rate, lint-paper clean-rate, number of manual markdown edits per move, human review minutes.
6. Baselines: current single-agent loop and current hand-edited markdown loop.

The grad-student trap is reading every paper and building nothing. The correct replication target is small: reproduce the AlphaEvolve/FunSearch shape on Vibe artifacts, where a proposer emits queue moves, an evaluator scores them, and a reviewer card asks the human before durable project state changes.

## Paper-By-Paper Design Notes

### AlphaEvolve

Mechanism: user supplies an initial program, marked evolution blocks, evaluation code, and optional context. AlphaEvolve samples parents/inspirations from a program database, builds prompts, asks an LLM ensemble for diffs, executes evaluators, and stores scored programs back into the database. Its important implementation details are evaluation cascades, multiple metrics, a MAP-elites/island-inspired database, and an asynchronous throughput-oriented pipeline.

Limitations: it needs machine-gradeable evaluation. The authors explicitly put manual experimentation outside scope. LLM-generated feedback can steer style or simplicity, but the core discovery loop depends on executable scoring.

Vibe requirement: do not run AlphaEvolve-like open search over research directions without an evaluator. Good targets are prompt variants, queue policies, scaffold recipes, benchmark harnesses, eval scripts, and tool workflows.

### FunSearch

Mechanism: an LLM evolves the critical function inside a human-written skeleton. Invalid programs are discarded by an evaluator; correct programs are stored in an island-based program database; prompts combine sampled high-performing programs so the model can generalize across prior solutions.

Limitations: it depends on cheap, reliable scoring and on a good abstraction boundary. The skeleton focuses the search but also constrains what can be discovered.

Vibe requirement: encode the reusable "skeleton" of research work in the occupation and tooling, then let agents evolve only the part under test: one queue proposer, one reviewer rubric, one prompt block, one topology rule.

### The AI Scientist And AI Scientist-v2

Mechanism: a staged research pipeline does idea generation, novelty search, experiment execution, figure generation, manuscript writing, and automated review. The later version uses stage-specific experiment management, agentic tree search, replication nodes, aggregation nodes, and VLM critique of plots.

Limitations: quality is uneven. The Nature paper reports only one of three workshop submissions likely passing a workshop bar, common failure modes include naive ideas, incorrect implementations, weak rigor, duplicated figures, and hallucinated citations. The workshop submission path included manual filtering of promising outputs.

Vibe requirement: Vibe should adopt stage structure and node types, but keep admission conservative. Automated review can triage; it should not silently publish, pivot, or admit.

### AI Co-Scientist

Mechanism: a scientist supplies a natural-language goal; a supervisor orchestrates generation, reflection, ranking, proximity, evolution, and meta-review agents. Hypotheses enter Elo-style tournaments, are reviewed for novelty, correctness, testability, and safety, and are improved through evolution and meta-review feedback. The system is explicitly scientist-in-the-loop.

Limitations: Elo is self-evaluation, not ground truth. Expert evaluation was small. Wet-lab validations are promising but expert-mediated, pre-screened, and domain-specific. The authors emphasize limited access to paywalled literature, negative results, multimodal data, and deeper clinical translation factors.

Vibe requirement: adopt the role topology, not the evaluation confidence. Queue ideas can be generated, debated, ranked, and evolved, but final project-state changes should require hard evidence or human review cards.

### Agent Laboratory

Mechanism: takes a human research idea, runs literature review, plans experiments, writes/executes ML code, and creates a report. Its `mle-solver` keeps top programs, edits/replaces code, scores outputs, reflects on failures, and uses batch parallelization.

Limitations: the paper reports a gap between automated evaluation and human evaluation; automated scores overestimated quality. This is one of the cleanest warnings in the set.

Vibe requirement: make human stage feedback easy and cheap. A human should be able to steer literature, plan, code, and writeup stages separately.

### AutoGen

Mechanism: defines conversable agents backed by LLMs, tools, humans, or combinations, and lets developers program conversation patterns in code or natural language.

Limitations: the abstraction is broad, but broad conversation is not itself a scientific method.

Vibe requirement: use conversation programming for runtime coordination, but persist knowledge through files, commits, tables, cards, and artifacts.

### MetaGPT

Mechanism: encodes software-engineering SOPs into role prompts and structured outputs. Agents communicate through documents, diagrams, and a shared message pool rather than unconstrained roleplay.

Limitations: strong for software production, less directly validated for open-ended research.

Vibe requirement: Vibe's research occupation is already an SOP. The next step is compiling parts of that SOP into commands and schemas so agents cannot casually skip the contract.

### Scaling Agent Systems

Mechanism: controlled comparisons across single-agent and multi-agent architectures under standardized prompts, tools, and compute. The central empirical lesson is task-architecture alignment: coordination helps decomposable work but hurts sequential planning and tool-heavy workflows when overhead dominates.

Limitations: very recent preprint; numbers should be treated as provisional until replicated.

Vibe requirement: do not assume more agents help. Measure topology. Use centralized verification for risky work. Keep sequential moves under one owner.

### ADAS

Mechanism: frames agent design as search over a space, using a meta-agent to write new agentic systems in code, evaluate them, and store them in an archive.

Limitations: agent designs can overfit benchmark structure; safety and objective choice are central.

Vibe requirement: scaffold recipes, occupations, and topology policies should be evolvable artifacts, but only inside benchmarked projects with explicit cost and safety limits.

### Human-AI Interaction, HAT, And HULA

Mechanism: the HCI and HAT literature emphasizes clear capabilities, uncertainty, timing, correction, dismissal, feedback, role clarity, interdependence, and shared goals. HULA shows this in a deployed software-agent workflow: humans review plans, refine code, and approve PR creation.

Limitations: much of classic HAT predates LLM agents, and HULA is software-development-specific.

Vibe requirement: Agent Inbox should support short, contextual, actionable cards. Cards should make clear what the agent can do, how reliable it is, why it is interrupting now, what happens next, and how the human can correct or dismiss it.

## Source Map

| Area | Representative sources | Mechanism | Lesson for Vibe Research |
| --- | --- | --- | --- |
| Multi-agent LLM frameworks | [AutoGen](https://arxiv.org/abs/2308.08155), [MetaGPT](https://arxiv.org/abs/2308.00352) | Conversable/tool-using agents, role specialization, SOPs | Make agent interaction programmable, but keep handoffs typed and auditable. SOPs beat improvised role-play. |
| Multi-agent scaling | [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296), [Towards a Science of Collective AI](https://arxiv.org/abs/2602.05289) | Controlled comparisons across architectures and task structures | Add agents only for decomposable work. Sequential research loops need a single owner plus verifiers more than a crowd. |
| Evolutionary discovery | [FunSearch](https://www.nature.com/articles/s41586-023-06924-6), [AlphaEvolve](https://arxiv.org/abs/2506.13131), [Mathematical exploration and discovery at scale](https://arxiv.org/abs/2511.02864) | LLM sampler + executable evaluator + population/archive + selection | Treat result docs and branches as a program database. Let evaluators, not vibes, select what survives. |
| Autonomous science | [The AI Scientist](https://arxiv.org/abs/2408.06292), [AI Scientist-v2](https://arxiv.org/abs/2504.08066), [Nature 2026 AI Scientist article](https://www.nature.com/articles/s41586-026-10265-5), [Agent Laboratory](https://arxiv.org/abs/2501.04227), [AI co-scientist](https://arxiv.org/abs/2502.18864) | Ideation, literature check, experiment execution, visualization, writeup, automated review | Vibe Research should own the ledger and review loop, not just task execution. Human feedback at stages is a feature, not a failure of autonomy. |
| Agentic self-design | [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435) | A meta-agent searches over agent designs represented in code | Use scaffold recipes and occupation prompts as the evolvable artifacts. Evaluate them with benchmark projects. |
| Human-agent teaming | [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/), [Human-Autonomy Teaming review](https://journals.sagepub.com/doi/10.1177/0018720820960865), [Human control of AI systems](https://link.springer.com/article/10.1007/s43681-024-00489-4), [HULA](https://arxiv.org/abs/2411.12924), [Adaptive HAT review](https://arxiv.org/abs/2504.10918), [Elhuyar literature system](https://arxiv.org/abs/2604.01452) | Shared mental models, role clarity, intervention points, staged feedback | Agent Inbox should support mid-task steering, not only final approval. Canvases and action items should create shared situational awareness. |
| Transparency and governance | [Multi-agent AI systems need transparency](https://www.nature.com/articles/s42256-026-01183-2) | Clear motivation and explanation for multi-agent scientific workflows | Every extra agent, evaluator, and reviewer should have an explicit reason in the project ledger. |

## 1. Multi-Agent Systems: Useful When Structured

AutoGen's important contribution is not "more agents." It is conversation programming: agents can combine LLMs, tools, code execution, and human inputs under configurable interaction patterns. That maps well to Vibe Research's current direction: the system should expose reusable coordination patterns, not depend on each agent improvising its own social protocol.

MetaGPT is a sharper warning. The paper frames naive chained agents as vulnerable to cascading hallucinations, then uses standard operating procedures and role-specific structured outputs to reduce inconsistency. For Vibe Research, this argues for:

- roles that map to artifacts: proposer writes QUEUE candidates, operator runs cycles, reviewer writes verdicts, librarian maintains insights;
- handoffs through files, tables, commits, and action items, not loose chat;
- validators at artifact boundaries, such as doctor, admit, lint-paper, and future queue/leaderboard commands.

The newer scaling literature is especially important. Kim et al. report that architecture-task fit dominates agent count: multi-agent coordination can help decomposable tasks, but can severely hurt sequential planning. This is directly relevant because a Vibe Research move is often sequential: claim, preflight, change one thing, run, commit, analyze, resolve. Parallelism belongs at the project level as independent moves, literature passes, eval reruns, or reviewer checks, not inside a single fragile cycle.

Design implication: Vibe Research should have a "topology policy":

- default: one owning agent per move;
- parallel: many agents only when work decomposes cleanly into separate move slugs, seeds, literature questions, or independent review passes;
- centralized verification: leaderboard admission and project integrity remain single-source-of-truth operations;
- measured: record when multi-agent execution was used and compare against a single-agent baseline when possible.

## 2. AlphaEvolve: The Evaluator Is The Organization's Heart

FunSearch and AlphaEvolve both wrap an LLM in a loop where generated code is executed, scored, retained, and sampled for future prompts. The core ingredients are:

- a problem written as executable code;
- an evaluator that can reject incorrect proposals;
- a population/archive of prior programs;
- selection pressure toward high-scoring and diverse candidates;
- asynchronous parallel sampling and evaluation.

AlphaEvolve extends the pattern from small functions toward larger algorithmic codebases and production-relevant optimizations. The key transfer to Vibe Research is not "evolve code blindly." It is:

```text
program database : result docs + branches + paper figures + insights
sampler          : queue proposer + prompt/scaffold recipe generator
evaluator        : tests + benchmarks + doctor/admit/lint + human review
selection        : leaderboard + review-mode insight promotion
diversity        : separate moves, branches, seeds, and project scopes
```

The caution is just as strong: AlphaEvolve works best when a solution can be scored automatically. Vibe Research should only run AlphaEvolve-like open search when it has a hard evaluator: tests, benchmark score, cost, latency, loss, pass rate, human rubric with repeated ratings, or a real peer-review-like process. Without that, the loop can evolve fluent nonsense.

Concrete application:

- Build an "evolutionary queue proposer" that samples from top result docs and insights, then emits candidate `ADD:` lines with novelty and evaluator rationale.
- Build an "occupation/prompt search" project where the artifacts being evolved are AGENTS/CLAUDE prompt variants, scaffold recipes, and agent topologies.
- Use bugbench, real Vibe Research move completion, doctor clean-rate, admission correctness, and human review time as evaluators.
- Keep the human as PI: auto-proposed queue changes become review cards unless they are inside an explicitly autonomous sandbox project.

## 3. Autonomous Research Systems: Full Loop, Weak Links

The AI Scientist line of work shows that LLM agents can cover a full computational research lifecycle: idea generation, novelty checks, code, experiments, plots, manuscript writing, and automated reviewing. The 2026 Nature version reports a peer-review workshop test, while also naming major limitations: inconsistent quality, weak ideas, incorrect implementations, hallucinated citations, and risks to review systems.

AI Scientist-v2 improves the search story with agentic tree search and an experiment manager agent. Google AI co-scientist uses a generate, debate, and evolve approach for biomedical hypotheses, with asynchronous execution and tournament-style evolution. Agent Laboratory is especially relevant to product design because it reports that human feedback at each stage improves research quality.

For Vibe Research, the lesson is that "autonomous research organization" should mean a staged, inspectable factory:

1. Ideation: generate candidate moves and priors.
2. Grounding: literature/current-docs pass and dataset/API inspection.
3. Planning: one move, one falsifier, one expected artifact.
4. Execution: cycle commits, run artifacts, durable outputs.
5. Analysis: result doc, figure, reproducibility block.
6. Review: admission, paper update, limitations, insight candidates.
7. Governance: budget, safety, publishing, and pivot gates.

Vibe Research already encodes most of this in the researcher occupation. The missing pieces are stronger automation around role transitions and stage-specific human touchpoints.

## 4. Human-In-The-Loop: Treat The Human As A Teammate, Not A Button

The human-agent teaming literature emphasizes shared mental models, transparency, role clarity, and the ability for humans to intervene during ongoing work. This matches the Visual OS direction: Agent Town, Agent Inbox, action items, approvals, and canvases.

The design target should be "short, grounded, interruptible communication":

- One action item at a time.
- The card says what decision is needed, why now, what evidence supports it, what happens if ignored, and what capability is being requested.
- The card links to the exact artifact: result doc, figure, diff, job URL, benchmark output, or local app.
- The user can approve, reject, steer, pause, or ask for a smaller option.
- The system records the decision in the Library when it affects research direction.

This is stronger than a final "approve" button. For long research moves, useful interrupts include:

- approve spend or cloud launch;
- choose between 2-3 grounded experiment branches;
- inspect a live monitor;
- stop a failing run;
- approve a pivot to locked Question/Method;
- decide whether to turn a result into an insight;
- approve publication or PR creation.

Vibe Research's current action items and canvas contract are pointed in the right direction. The upgrade is to make mid-task steering a normal state in the run loop, with predicates the agent can wait on.

## 5. The Vibe Research Organizational Model

The most promising architecture is a small research org, not an agent swarm.

| Role | Main artifact | Autonomy | Human touchpoint |
| --- | --- | --- | --- |
| PI / human | Goal, budget, sensitive approvals | Decides direction and constraints | Reviews pivots, spend, publication, insight promotions |
| Experiment manager | README ACTIVE/QUEUE/LOG, run state | Assigns one move at a time, enforces topology policy | Escalates conflicts, stale rows, budget caps |
| Operator agent | Code branch, cycle commits, result doc | Runs cycles and records artifacts | Requests setup, spend, or ambiguous choices |
| Reviewer agent | Leaderboard verdict, paper lint, critique | Audits claims and failure modes | Presents compact review cards |
| Librarian agent | Insights, paper, references | Distills cross-move findings | Asks before broad-scope insight changes |
| Evaluator service | Tests, metrics, artifact checks | Scores automatically where possible | Reports uncertainty and missing evaluator coverage |
| Safety/budget officer | Capability tags, budget ledger | Blocks risky actions by policy | Converts risk to approval cards |

This model preserves Vibe Research's current rule that one agent owns one move, while allowing parallel work at the organization layer.

## 6. Product Roadmap From The Literature

### A. Add Topology Metadata

Record how a move was run:

```yaml
topology:
  owner: single-agent
  parallel_agents: 0
  reviewer_agents: 1
  human_touchpoints: ["budget-approval", "figure-review"]
  evaluator_strength: "hard-tests" # hard-tests | noisy-metric | rubric | qualitative
```

Why: this lets Vibe Research measure when multi-agent coordination actually helps.

### B. Build `vr-research-queue`

Complete the admin family after `vr-research-log` and `vr-research-active`.

Functions:

- add/remove/reprioritize QUEUE rows safely;
- validate row count and starting-point URLs;
- attach a reason;
- optionally open an Agent Inbox review card before applying a pre-experiment priority change.

Why: AlphaEvolve-style search needs queue mutation to be a typed operation.

### C. Build A Review Agent That Writes Cards, Not Edits

The reviewer should produce:

- claim audit;
- missing provenance;
- evaluator weakness;
- likely false-falsification;
- leaderboard-admission risk;
- suggested next move.

It should not silently rewrite result docs or the paper. It should create a review card linked to the exact lines/artifacts.

Why: this preserves human agency and prevents reviewer agents from laundering hallucinations into durable records.

### D. Add Mid-Task Steering Predicates

Action items should support:

- `approved`;
- `rejected`;
- `steer:<short text>`;
- `pause`;
- `resume`;
- `timeout`.

Agents can wait on these predicates before continuing a long run or sensitive branch.

Why: human-in-the-loop needs timely intervention, not only final review.

### E. Create An Evolutionary Prompt/Scaffold Project

Use Vibe Research on itself:

- CODE REPO: vibe-research.
- Artifacts: occupation prompt variants, scaffold recipes, topology policies.
- Evaluators: bugbench, real move success, doctor clean-rate, paper-lint clean-rate, review time, human satisfaction.
- Result docs: one prompt/topology change per move.
- Admission: quantitative or mix with noise estimates.

Why: this is the safe, local version of ADAS and AlphaEvolve for agent organizations.

### F. Create A "Program Database" View

Expose a project-level archive of:

- result docs by score and status;
- cycle commits;
- figures;
- insights touched;
- evaluator type;
- tags/failure modes;
- queued follow-ups.

Why: AlphaEvolve's power comes from sampling prior successful programs. Vibe Research should let agents sample prior successful research moves.

### G. Add Transparency Reports For Multi-Agent Runs

For every multi-agent or autonomous review run, generate a short report:

- why multiple agents were used;
- topology;
- task decomposition;
- artifacts each agent owned;
- evaluator;
- human interventions;
- budget;
- failure modes.

Why: the 2026 transparency warning is correct. Multi-agent science can waste compute and human trust if the motivation is not explicit.

## 7. Research Claims To Test Inside Vibe Research

These should become Vibe Research projects or moves:

1. Multi-agent benefit is task-structure dependent.
   - Hypothesis: parallel literature/review agents reduce wall time without hurting correctness, but parallel agents inside one sequential move increase bookkeeping errors.
   - Evaluator: doctor clean-rate, result-doc completeness, wall time, human review defects.

2. Mid-task steering reduces wasted compute.
   - Hypothesis: action-item interrupts at budget/failure thresholds reduce abandoned or over-budget moves.
   - Evaluator: compute spent per resolved result, number of avoidable failed cycles, human decision latency.

3. Evolutionary queue proposal improves follow-up quality.
   - Hypothesis: queue candidates generated from top results plus insights produce more admitted moves than hand-written follow-ups.
   - Evaluator: admission rate with noise, reviewer quality rubric, novelty check pass rate.

4. Reviewer-agent cards improve paper integrity.
   - Hypothesis: a reviewer that creates cards before finalization reduces paper-lint and provenance errors.
   - Evaluator: lint failures, missing citations, corrected claims, human review time.

5. Scaffold recipes are transferable agent org designs.
   - Hypothesis: a recipe encoding buildings, communication policy, and prompt hash transfers better across machines than raw prompt instructions.
   - Evaluator: setup time, first-move completion, number of human interventions.

## 8. Strong Product Principle

Vibe Research should become an operating system for accountable autonomous research, not just a launcher for autonomous agents.

The durable unit is not the agent message. It is the research artifact:

- a move claim;
- a branch;
- a cycle commit;
- a result doc;
- a figure;
- a paper update;
- an insight;
- a human decision;
- an evaluator verdict.

Agents are replaceable workers in that system. The Library is the institution.

## References

- Wu et al., [AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation](https://arxiv.org/abs/2308.08155), arXiv 2023.
- Hong et al., [MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework](https://arxiv.org/abs/2308.00352), arXiv 2023.
- Kim et al., [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296), arXiv 2025.
- Xi et al., [Towards a Science of Collective AI](https://arxiv.org/abs/2602.05289), arXiv 2026.
- Romera-Paredes et al., [Mathematical discoveries from program search with large language models](https://www.nature.com/articles/s41586-023-06924-6), Nature 2023.
- Fawzi and Romera-Paredes, [FunSearch DeepMind blog](https://deepmind.google/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/), Google DeepMind 2023.
- Novikov et al., [AlphaEvolve: A coding agent for scientific and algorithmic discovery](https://arxiv.org/abs/2506.13131), arXiv 2025.
- Google DeepMind, [AlphaEvolve blog](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/), 2025.
- Georgiev et al., [Mathematical exploration and discovery at scale](https://arxiv.org/abs/2511.02864), arXiv 2025.
- Lu et al., [The AI Scientist: Towards Fully Automated Open-Ended Scientific Discovery](https://arxiv.org/abs/2408.06292), arXiv 2024.
- Yamada et al., [The AI Scientist-v2: Workshop-Level Automated Scientific Discovery via Agentic Tree Search](https://arxiv.org/abs/2504.08066), arXiv 2025.
- Lu et al., [Towards end-to-end automation of AI research](https://www.nature.com/articles/s41586-026-10265-5), Nature 2026.
- Schmidgall et al., [Agent Laboratory: Using LLM Agents as Research Assistants](https://arxiv.org/abs/2501.04227), arXiv 2025.
- Gottweis and Natarajan et al., [Towards an AI co-scientist](https://arxiv.org/abs/2502.18864), arXiv 2025.
- Google Research, [Accelerating scientific breakthroughs with an AI co-scientist](https://research.google/blog/accelerating-scientific-breakthroughs-with-an-ai-co-scientist/), 2025.
- Hu et al., [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435), arXiv 2024.
- Amershi et al., [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/), CHI 2019.
- O'Neill et al., [Human-Autonomy Teaming: A Review and Analysis of the Empirical Literature](https://journals.sagepub.com/doi/10.1177/0018720820960865), Human Factors 2022.
- Kiseleva, [Human control of AI systems: from supervision to teaming](https://link.springer.com/article/10.1007/s43681-024-00489-4), AI and Ethics 2024.
- Takerngsaksiri et al., [Human-In-the-Loop Software Development Agents](https://arxiv.org/abs/2411.12924), arXiv 2024.
- Wang et al., [Adaptive Human-Agent Teaming](https://arxiv.org/abs/2504.10918), arXiv 2025.
- Jacobson et al., [A Multi-Agent Human-LLM Collaborative Framework for Closed-Loop Scientific Literature Summarization](https://arxiv.org/abs/2604.01452), arXiv 2026.
- Nature Machine Intelligence editorial, [Multi-agent AI systems need transparency](https://www.nature.com/articles/s42256-026-01183-2), 2026.
