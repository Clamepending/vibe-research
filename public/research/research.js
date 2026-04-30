// Standalone dashboard renderer. Calls /api/research/projects[/<name>] and
// renders into the static page templates. No framework — DOM via small
// helpers, escapes everything by default.

(function () {
  "use strict";

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v === null || v === undefined) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        if (typeof child === "string") node.appendChild(document.createTextNode(child));
        else node.appendChild(child);
      }
    }
    return node;
  }

  function setStatus(message, isError) {
    const status = document.getElementById("status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", Boolean(isError));
    status.hidden = !message;
  }

  function fmtCriterion(kind) {
    if (!kind || kind === "unknown") return "criterion: ?";
    return `criterion: ${kind}`;
  }

  function chip(label, variant) {
    return el("span", { class: `vr-chip${variant ? " vr-chip-" + variant : ""}` }, label);
  }

  function renderDoctorChip(bucket, counts) {
    if (!counts) return chip("doctor: —");
    if (bucket === "ok") return chip(`doctor: ok`, "good");
    if (bucket === "warning") return chip(`doctor: ${counts.warning}w`, "warn");
    return chip(`doctor: ${counts.error}e`, "bad");
  }

  function renderBenchChip(project) {
    if (!project.hasBenchmark) return chip("no bench");
    const status = project.benchmarkStatus || "active";
    const v = project.benchmarkVersion || "?";
    const variant = status === "frozen" ? "bad" : status === "draft" ? "warn" : "accent";
    return chip(`bench ${v} (${status})`, variant);
  }

  // ----- Project list page -----

  async function renderProjectList() {
    setStatus("Loading projects…");
    let payload;
    try {
      const res = await fetch("/api/research/projects", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (err) {
      setStatus(`Could not load projects: ${err.message}`, true);
      return;
    }

    const list = document.getElementById("project-list");
    list.innerHTML = "";

    if (!payload.projects.length) {
      setStatus(
        `No research projects found. Library root: ${payload.libraryRoot || "(unset)"}.\nCreate one at ${payload.libraryRoot || "<library>"}/projects/<name>/README.md.`,
        false,
      );
      return;
    }

    setStatus("");
    const section = document.getElementById("projects-section");
    if (section) section.setAttribute("aria-busy", "false");
    list.hidden = false;

    for (const p of payload.projects) {
      const meta = el("div", { class: "vr-project-card-meta" }, [
        chip(fmtCriterion(p.criterionKind)),
        chip(`leaderboard ${p.leaderboardSize}`),
        chip(`active ${p.activeCount}`, p.activeCount > 0 ? "accent" : null),
        chip(`queue ${p.queueSize}`),
        renderBenchChip(p),
      ]);
      const card = el(
        "a",
        { class: "vr-project-card", href: `/research/${encodeURIComponent(p.name)}` },
        [
          el("h2", { class: "vr-project-card-name" }, p.name),
          p.goal ? el("p", { class: "vr-project-card-goal" }, p.goal) : null,
          meta,
        ],
      );
      list.appendChild(el("li", null, card));
    }
  }

  // ----- Per-project dashboard -----

  async function renderProjectDashboard(name) {
    if (!name) {
      setStatus("Project name missing in URL.", true);
      return;
    }
    document.getElementById("project-crumb").textContent = `/ ${name}`;
    document.title = `${name} — Vibe Research`;

    setStatus(`Loading ${name}…`);
    let detail;
    try {
      const res = await fetch(`/api/research/projects/${encodeURIComponent(name)}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 404) {
        setStatus(`Project "${name}" not found in the library.`, true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      detail = await res.json();
    } catch (err) {
      setStatus(`Could not load ${name}: ${err.message}`, true);
      return;
    }

    setStatus("");
    document.getElementById("dashboard").hidden = false;

    renderDoctorCard(detail);
    await renderNextActionCard(detail);
    renderTakeawayCard(detail);
    renderHypothesisCard(detail);
    renderOverviewCard(detail);
    renderSuccessCriteriaCard(detail);
    renderLeaderboardCard(detail);
    renderActiveCard(detail);
    renderQueueCard(detail);
    renderBenchCard(detail);
    renderLogCard(detail);
  }

  function evaluatorVariant(strength) {
    if (strength === "strong") return "good";
    if (strength === "blocked" || strength === "weak") return "bad";
    if (strength === "medium") return "accent";
    return null;
  }

  function actionVariant(action) {
    if (/fix|blocked/.test(action || "")) return "bad";
    if (/review|judge|brief/.test(action || "")) return "accent";
    if (/run|continue/.test(action || "")) return "good";
    return null;
  }

  async function fetchProjectDetail(name) {
    const res = await fetch(`/api/research/projects/${encodeURIComponent(name)}`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 404) throw new Error(`Project "${name}" not found in the library.`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function postOrchestratorTick(detail, options) {
    const res = await fetch(`/api/research/projects/${encodeURIComponent(detail.name)}/orchestrator/tick`, {
      method: "POST",
      headers: { accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(options || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function setActionStatus(body, message, isError) {
    let status = body.querySelector(".vr-next-status");
    if (!status) {
      status = el("p", { class: "vr-next-status", role: "status" });
      body.appendChild(status);
    }
    status.textContent = message || "";
    status.classList.toggle("is-error", Boolean(isError));
    status.hidden = !message;
  }

  function button(label, onClick, variant) {
    return el("button", { class: `vr-action-button${variant ? " is-" + variant : ""}`, type: "button", onclick: onClick }, label);
  }

  function renderActionButtons({ detail, body, report, rec }) {
    const buttons = [];
    const commandText = report.nextCommand || "";

    if (commandText) {
      buttons.push(button("Copy command", async () => {
        try {
          await navigator.clipboard.writeText(commandText);
          setActionStatus(body, "Command copied.");
        } catch (err) {
          setActionStatus(body, `Could not copy: ${err.message}`, true);
        }
      }));
    }

    if (rec.action === "enter-review") {
      buttons.push(button("Enter review", async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        setActionStatus(body, "Switching phase…");
        try {
          const applied = await postOrchestratorTick(detail, { apply: true });
          const payload = applied.report && applied.report.phaseUpdate
            ? await postOrchestratorTick(detail, {})
            : applied;
          renderNextActionPayload(detail, body, payload);
        } catch (err) {
          setActionStatus(body, `Could not enter review: ${err.message}`, true);
        } finally {
          if (target.isConnected) target.disabled = false;
        }
      }, "primary"));
    }

    if (rec.action === "review-brief" && rec.briefSlug) {
      buttons.push(button("Compile brief", async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        setActionStatus(body, "Compiling brief into QUEUE…");
        try {
          const res = await fetch(
            `/api/research/projects/${encodeURIComponent(detail.name)}/briefs/${encodeURIComponent(rec.briefSlug)}/compile`,
            {
              method: "POST",
              headers: { accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify({}),
            },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const nextDetail = await fetchProjectDetail(detail.name);
          renderDoctorCard(nextDetail);
          await renderNextActionCard(nextDetail);
          renderQueueCard(nextDetail);
          renderActiveCard(nextDetail);
          renderLogCard(nextDetail);
        } catch (err) {
          setActionStatus(body, `Could not compile brief: ${err.message}`, true);
        } finally {
          if (target.isConnected) target.disabled = false;
        }
      }, "primary"));
    }

    if (/^judge-/.test(rec.action || "")) {
      buttons.push(button("Ask human", async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        setActionStatus(body, "Creating Agent Inbox card…");
        try {
          const payload = await postOrchestratorTick(detail, { askHuman: true });
          renderNextActionPayload(detail, body, payload);
        } catch (err) {
          setActionStatus(body, `Could not create review card: ${err.message}`, true);
        } finally {
          if (target.isConnected) target.disabled = false;
        }
      }, "primary"));
    }

    buttons.push(button("Refresh", async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      setActionStatus(body, "Refreshing…");
      try {
        const payload = await postOrchestratorTick(detail, {});
        renderNextActionPayload(detail, body, payload);
      } catch (err) {
        setActionStatus(body, `Could not refresh: ${err.message}`, true);
      } finally {
        if (target.isConnected) target.disabled = false;
      }
    }));

    body.appendChild(el("div", { class: "vr-next-actions" }, buttons));
  }

  function renderNextActionPayload(detail, body, payload) {
    const report = payload.report || {};
    const rec = report.recommendation || {};
    const queueUpdates = report.judge && Array.isArray(report.judge.queueUpdates)
      ? report.judge.queueUpdates
      : [];
    body.innerHTML = "";
    body.appendChild(el("div", { class: "vr-next-header" }, [
      chip(rec.action || "unknown", actionVariant(rec.action || "")),
      rec.slug ? chip(rec.slug) : null,
      rec.briefSlug ? chip(rec.briefSlug) : null,
      rec.evaluatorStrength ? chip(`evaluator ${rec.evaluatorStrength}`, evaluatorVariant(rec.evaluatorStrength)) : null,
      rec.nextCandidates ? chip(`${rec.nextCandidates} next`) : null,
      report.judge && report.judge.review && report.judge.review.actionItem
        ? chip(`inbox ${report.judge.review.actionItem.id}`, "accent")
        : null,
    ]));
    body.appendChild(el("p", { class: "vr-next-reason" }, rec.reason || "No recommendation returned."));
    if (report.nextCommand) {
      body.appendChild(el("pre", { class: "vr-next-command" }, report.nextCommand));
    }
    if (queueUpdates.length) {
      body.appendChild(el(
        "ul",
        { class: "vr-next-candidates" },
        queueUpdates.slice(0, 5).map((item) =>
          el("li", null, [
            el("span", { class: "vr-mono" }, `${item.verb}: ${item.slug}`),
            item.why ? el("span", null, ` — ${item.why}`) : null,
          ]),
        ),
      ));
    }
    renderActionButtons({ detail, body, report, rec });
  }

  async function renderNextActionCard(detail) {
    const card = document.getElementById("next-card");
    if (!card) return;
    card.innerHTML = "";
    card.appendChild(el("h2", null, "Next action"));
    const body = el("div", { class: "vr-next-action" }, [
      el("p", { class: "vr-card-empty" }, "Checking phase state…"),
    ]);
    card.appendChild(body);

    let payload;
    try {
      payload = await postOrchestratorTick(detail, {});
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(el("p", { class: "vr-card-empty" }, `Could not load next action: ${err.message}`));
      return;
    }

    renderNextActionPayload(detail, body, payload);
  }

  function renderHypothesisCard(detail) {
    const card = document.getElementById("hypothesis-card");
    if (!card) return;
    card.innerHTML = "";
    card.appendChild(el("h2", null, "Hypothesis in flight"));
    if (!detail.active.length) {
      card.appendChild(
        el(
          "p",
          { class: "vr-card-empty" },
          "No active move — the dashboard celebrates ruled-out hypotheses too: see the LOG below for falsifications.",
        ),
      );
      return;
    }
    const top = detail.active[0];
    const doc = detail.resultDocs.find((d) => d.slug === top.slug);
    if (!doc) {
      card.appendChild(
        el("p", { class: "vr-card-empty" }, `Active move "${top.slug}" — result doc not found.`),
      );
      return;
    }
    if (doc.question) {
      card.appendChild(
        el("p", { style: "margin: 0 0 6px;" }, [
          el("strong", null, "Q: "),
          doc.question,
        ]),
      );
    }
    if (doc.hypothesis) {
      card.appendChild(
        el("p", { style: "margin: 0 0 6px; color: var(--vr-text-muted); font-size: 13px;" }, doc.hypothesis),
      );
    }
    card.appendChild(
      el("div", { style: "font-size: 12px; color: var(--vr-text-dim); font-family: var(--vr-mono);" }, [
        top.slug,
        " · cycle ",
        String((doc.cycles && doc.cycles.length) || 0),
        " · agent ",
        top.agent || "?",
      ]),
    );
  }

  function renderSuccessCriteriaCard(detail) {
    const card = document.getElementById("success-card");
    if (!card) return;
    card.innerHTML = "";
    card.appendChild(el("h2", null, [
      "Success criteria",
      el("span", { class: "vr-card-count" }, `(${detail.successCriteria.length})`),
    ]));
    if (!detail.successCriteria.length) {
      card.appendChild(el("p", { class: "vr-card-empty" }, "No success criteria written yet."));
      return;
    }
    const list = el("ul", { style: "margin: 0; padding-left: 18px; font-size: 13px;" });
    for (const crit of detail.successCriteria) {
      list.appendChild(el("li", { style: "padding: 3px 0;" }, crit));
    }
    card.appendChild(list);
  }

  function renderDoctorCard(detail) {
    const card = document.getElementById("doctor-card");
    card.innerHTML = "";
    const d = detail.doctor || { bucket: "ok", counts: { error: 0, warning: 0, info: 0 }, issues: [] };
    const isOk = d.bucket === "ok";
    const summary = isOk
      ? "Doctor: clean. No errors or warnings."
      : `Doctor: ${d.counts.error} error${d.counts.error === 1 ? "" : "s"}, ${d.counts.warning} warning${d.counts.warning === 1 ? "" : "s"}.`;
    const banner = el(
      "div",
      { class: `vr-doctor-banner is-${d.bucket}` },
      [
        el("span", { class: "vr-doctor-icon" }, isOk ? "✓" : d.bucket === "warning" ? "!" : "✕"),
        el("div", null, [
          el("div", { class: "vr-doctor-summary" }, summary),
          d.issues && d.issues.length
            ? el(
                "ul",
                { class: "vr-doctor-issues" },
                d.issues.slice(0, 8).map((issue) =>
                  el("li", null, [
                    el("span", { class: `vr-issue-severity ${issue.severity}` }, issue.severity),
                    el("span", { class: "vr-issue-where" }, issue.where || ""),
                    el("span", null, "— " + (issue.message || "")),
                    el("span", { class: "vr-issue-code" }, issue.code || ""),
                  ]),
                ),
              )
            : null,
        ]),
      ],
    );
    card.appendChild(banner);
  }

  function renderTakeawayCard(detail) {
    const card = document.getElementById("takeaway-card");
    card.innerHTML = "";
    card.appendChild(el("h2", null, "Latest takeaway"));

    // Pick the most-recent resolved result we can identify: prefer rank-1
    // leaderboard, else the most recent result doc with status=resolved.
    let chosen = null;
    if (detail.leaderboard && detail.leaderboard[0]) {
      const rank1 = detail.resultDocs.find((d) => d.slug === detail.leaderboard[0].slug);
      if (rank1) chosen = rank1;
    }
    if (!chosen) {
      chosen = detail.resultDocs.find((d) => d.status === "resolved");
    }
    if (!chosen) {
      card.appendChild(el("p", { class: "vr-card-empty" }, "No resolved moves yet."));
      return;
    }
    card.appendChild(el("p", { class: "vr-takeaway" }, chosen.takeaway || "(takeaway not written)"));
    card.appendChild(
      el("div", { class: "vr-takeaway-source" }, [
        chosen.slug,
        " · ",
        chosen.cycles && chosen.cycles.length ? `${chosen.cycles.length} cycle${chosen.cycles.length === 1 ? "" : "s"}` : "no cycles",
      ]),
    );
  }

  function renderOverviewCard(detail) {
    const card = document.getElementById("overview-card");
    card.innerHTML = "";
    card.appendChild(el("h2", null, "Goal"));
    card.appendChild(el("p", { class: "vr-overview-goal" }, detail.goal || "(no goal stated)"));
    const row = el("div", { class: "vr-overview-row" });
    if (detail.rankingCriterion) {
      row.appendChild(chip(`criterion: ${detail.rankingCriterion.kind || "?"}`));
      if (detail.rankingCriterion.description) {
        row.appendChild(chip(detail.rankingCriterion.description));
      }
    }
    if (detail.codeRepo && detail.codeRepo.url) {
      row.appendChild(
        el("a", { class: "vr-chip vr-chip-accent", href: detail.codeRepo.url, target: "_blank", rel: "noopener" }, "code repo"),
      );
    }
    card.appendChild(row);
  }

  function fmtMeanStd(row) {
    if (typeof row.mean !== "number" || typeof row.std !== "number") return null;
    // 2σ noise radius is the default admission rule; render that explicitly so
    // within-noise neighbors don't read identically to clean wins.
    return `${row.mean.toFixed(3)} ± ${(2 * row.std).toFixed(3)}`;
  }

  function renderBenchStaleness(row, hasBench) {
    if (!hasBench) return null;
    if (row.benchStaleness === "current") return chip(`bench ${row.benchmarkVersionCited}`, "good");
    if (row.benchStaleness === "stale") return chip(`bench ${row.benchmarkVersionCited} stale`, "bad");
    if (row.benchStaleness === "missing") return chip("no bench cited", "bad");
    return null;
  }

  function renderLeaderboardCard(detail) {
    const card = document.getElementById("leaderboard-card");
    card.innerHTML = "";
    const header = el("h2", null, [
      "Leaderboard",
      el("span", { class: "vr-card-count" }, `(${detail.leaderboard.length})`),
    ]);
    card.appendChild(header);
    if (!detail.leaderboard.length) {
      card.appendChild(el("p", { class: "vr-card-empty" }, "Empty — no admitted results yet."));
      return;
    }
    const hasBench = Boolean(detail.benchmark);
    const table = el("table", { class: "vr-table" }, [
      el("thead", null, el("tr", null, [
        el("th", null, "#"),
        el("th", null, "result"),
        el("th", null, "score (mean ± 2σ)"),
        hasBench ? el("th", null, "bench") : null,
      ])),
      el(
        "tbody",
        null,
        detail.leaderboard.map((row) => {
          const meanStd = fmtMeanStd(row);
          const scoreCell = el("td", null, [
            meanStd ? el("span", { class: "vr-mono" }, meanStd) : null,
            meanStd && row.score ? el("span", { style: "color: var(--vr-text-dim); margin-left: 6px;" }, `(${row.score})`) : null,
            !meanStd ? (row.score || "—") : null,
          ]);
          return el("tr", null, [
            el("td", { class: "vr-rank" }, String(row.rank)),
            el(
              "td",
              { class: "vr-slug" },
              row.branchUrl
                ? el("a", { href: row.branchUrl, target: "_blank", rel: "noopener" }, row.slug)
                : row.slug,
            ),
            scoreCell,
            hasBench ? el("td", null, renderBenchStaleness(row, hasBench)) : null,
          ]);
        }),
      ),
    ]);
    card.appendChild(table);
  }

  function renderActiveCard(detail) {
    const card = document.getElementById("active-card");
    card.innerHTML = "";
    card.appendChild(el("h2", null, [
      "Active",
      el("span", { class: "vr-card-count" }, `(${detail.active.length})`),
    ]));
    if (!detail.active.length) {
      card.appendChild(el("p", { class: "vr-card-empty" }, "No moves in flight."));
      return;
    }
    const list = el("ul", { class: "vr-log-list", style: "list-style: none; padding: 0;" });
    for (const row of detail.active) {
      list.appendChild(
        el("li", null, [
          el("span", { class: "vr-log-event vr-log-event-review" }, row.agent ? `agent ${row.agent}` : "agent ?"),
          el("span", { class: "vr-log-date" }, row.started || ""),
          el(
            "span",
            { class: "vr-log-summary" },
            row.branchUrl
              ? el("a", { href: row.branchUrl, target: "_blank", rel: "noopener" }, row.slug)
              : row.slug,
          ),
        ]),
      );
    }
    card.appendChild(list);
  }

  function renderQueueCard(detail) {
    const card = document.getElementById("queue-card");
    card.innerHTML = "";
    card.appendChild(el("h2", null, [
      "Queue",
      el("span", { class: "vr-card-count" }, `(${detail.queue.length})`),
    ]));
    if (!detail.queue.length) {
      card.appendChild(el("p", { class: "vr-card-empty" }, "Queue empty — review mode next."));
      return;
    }
    const list = el("ol", { style: "padding-left: 22px; margin: 0; font-size: 13px;" });
    for (const row of detail.queue.slice(0, 5)) {
      list.appendChild(
        el("li", { style: "padding: 4px 0;" }, [
          el("span", { class: "vr-mono", style: "font-weight: 600;" }, row.slug),
          row.why ? el("span", { class: "vr-card-empty", style: "margin-left: 8px;" }, "— " + row.why) : null,
        ]),
      );
    }
    card.appendChild(list);
  }

  function renderBenchCard(detail) {
    const card = document.getElementById("bench-card");
    card.innerHTML = "";
    const benchVersion = detail.benchmark && detail.benchmark.version
      ? String(detail.benchmark.version)
      : "";
    const benchVersionLabel = benchVersion
      ? (benchVersion.toLowerCase().startsWith("v") ? benchVersion : `v${benchVersion}`)
      : "?";
    card.appendChild(el("h2", null, [
      "Benchmark",
      detail.benchmark
        ? el("span", { class: "vr-card-count" }, `${benchVersionLabel} (${detail.benchmark.status})`)
        : null,
      detail.paths.benchmark
        ? el("span", { class: "vr-card-action" }, detail.paths.benchmark)
        : null,
    ]));
    if (!detail.benchmark) {
      const expected = detail.rankingCriterion && (detail.rankingCriterion.kind === "qualitative" || detail.rankingCriterion.kind === "mix");
      card.appendChild(
        el(
          "p",
          { class: "vr-card-empty" },
          expected
            ? "Missing — qualitative/mix projects must declare a benchmark.md (the doctor errors above)."
            : "No benchmark.md (optional for quantitative projects).",
        ),
      );
      return;
    }
    if (detail.benchmark.purpose) {
      card.appendChild(el("p", { class: "vr-bench-purpose" }, detail.benchmark.purpose));
    }
    const meta = el("div", { class: "vr-bench-meta" }, [
      detail.benchmark.lastUpdated ? chip(`updated ${detail.benchmark.lastUpdated}`) : null,
      detail.benchmark.metrics.length ? chip(`${detail.benchmark.metrics.length} metric${detail.benchmark.metrics.length === 1 ? "" : "s"}`) : null,
      detail.benchmark.calibration.length ? chip(`${detail.benchmark.calibration.length} calibration row${detail.benchmark.calibration.length === 1 ? "" : "s"}`) : null,
      detail.benchmark.history.length ? chip(`${detail.benchmark.history.length} version${detail.benchmark.history.length === 1 ? "" : "s"}`) : null,
    ]);
    card.appendChild(meta);

    if (detail.benchmark.metrics.length) {
      const sec = el("div", { class: "vr-bench-section" });
      sec.appendChild(el("h3", null, "Metrics"));
      const t = el("table", { class: "vr-table" }, [
        el("thead", null, el("tr", null, [
          el("th", null, "name"), el("th", null, "kind"), el("th", null, "direction"),
        ])),
        el("tbody", null, detail.benchmark.metrics.map((m) =>
          el("tr", null, [
            el("td", { class: "vr-slug" }, m.name),
            el("td", null, m.kind || "?"),
            el("td", null, m.direction || "?"),
          ]),
        )),
      ]);
      sec.appendChild(t);
      card.appendChild(sec);
    }
  }

  function renderLogCard(detail) {
    const card = document.getElementById("log-card");
    card.innerHTML = "";
    card.appendChild(el("h2", null, [
      "Recent log",
      el("span", { class: "vr-card-count" }, `(showing ${Math.min(detail.log.length, 8)} of ${detail.log.length})`),
    ]));
    if (!detail.log.length) {
      card.appendChild(el("p", { class: "vr-card-empty" }, "No log entries yet."));
      return;
    }
    const list = el("ul", { class: "vr-log-list" });
    for (const row of detail.log.slice(0, 8)) {
      const evClass = (row.event || "").split("+")[0];
      list.appendChild(
        el("li", null, [
          el("span", { class: "vr-log-date" }, row.date || ""),
          el("span", { class: `vr-log-event vr-log-event-${evClass}` }, row.event || ""),
          el("span", { class: "vr-log-summary" }, [
            row.slug ? el("strong", { class: "vr-mono" }, row.slug + " ") : null,
            row.summary || "",
          ]),
        ]),
      );
    }
    card.appendChild(list);
  }

  window.VibeResearchPage = { renderProjectList, renderProjectDashboard };
})();
