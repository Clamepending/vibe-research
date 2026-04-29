// Hyperparameter sweep planner for the Vibe Research researcher contract.
//
// What this is: the small kernel of an HP / architecture / data-mixture
// sweep tool that maps the friend-of-the-house's Google-Doc-row workflow
// (one row per experiment with: started_at, group, name, commit, hypothesis,
// mean_return, std_return, wandb_url, status) onto Vibe Research moves.
//
// What this is NOT (yet): an executor. v1 plans the sweep — parses the
// spec, expands Cartesian-product cells, multiplies by seeds, and writes
// runs.tsv with status="planned". Execution + wandb integration land in a
// follow-up so each PR stays reviewable.
//
// API:
//
//   const cells = expandCells({ lr: ["1e-4", "1e-3"], batch: ["256"] });
//   // → [{ lr: "1e-4", batch: "256" }, { lr: "1e-3", batch: "256" }]
//
//   const plan = planSweep({
//     name: "lr-bs-grid",
//     base: { lr: "1e-3", batch: "256", frames: "4" },
//     sweep: { lr: ["1e-4", "1e-3"], batch: ["256", "512"] },
//     seeds: 3,
//     hypothesis: "lr/batch interaction",
//   });
//   // → { rows: [...], hypothesis, name } with rows sized cells × seeds
//
//   const tsv = renderRunsTsv(plan.rows);
//   // → tab-separated, one header line + one row per (cell, seed)
//
// We deliberately keep this format dumb on purpose: TSV opens in Sheets,
// Excel, vim, less, awk, and a 5-minute Python script. The grad student
// can paste it into his existing Google Doc on Day One. Replace later.

const RUN_COLUMNS = [
  "started_at",       // ISO; empty until launch
  "group",            // wandb group = sweep name
  "name",             // wandb run name = <cell-key>-seed<N>
  "commit",           // git rev-parse HEAD at plan time
  "hypothesis",       // free-form pre-launch
  "mean_return",      // empty until N seeds finish
  "std_return",       // empty until N seeds finish
  "wandb_url",        // empty until launch
  "status",           // planned | running | done | failed | skipped
  "config",           // JSON of the resolved overrides for this row
];

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Parse a "key=value" spec into { key, values: [v1, v2, ...] }.
// Supported value forms:
//   key=v                 → { key, values: [v] }
//   key=[v1,v2,v3]        → { key, values: [v1, v2, v3] }
//   key=v1,v2,v3          → same (brackets optional)
//   key=range(a,b,step)   → numeric range, step inclusive of a
//   key=logspace(a,b,n)   → log-spaced numeric values from a..b, n points
// Whitespace inside values is preserved; outside is trimmed.
export function parseSweepEntry(spec) {
  const text = trimString(spec);
  const eqIndex = text.indexOf("=");
  if (eqIndex < 0) {
    throw new TypeError(`sweep spec must be "key=value(s)"; got "${spec}"`);
  }
  const key = trimString(text.slice(0, eqIndex));
  const rest = trimString(text.slice(eqIndex + 1));
  if (!key) throw new TypeError(`sweep spec missing key in "${spec}"`);
  if (!rest) throw new TypeError(`sweep spec missing value(s) in "${spec}"`);

  // Numeric helpers.
  const parseNumberArgs = (inner) => inner.split(",").map((p) => Number(p.trim()));

  if (rest.startsWith("range(") && rest.endsWith(")")) {
    const [a, b, step] = parseNumberArgs(rest.slice("range(".length, -1));
    if (![a, b, step].every(Number.isFinite) || step === 0) {
      throw new TypeError(`range(a,b,step) needs three finite numbers, step!=0 in "${spec}"`);
    }
    const values = [];
    if (step > 0) {
      for (let v = a; v <= b + 1e-12; v += step) values.push(`${roundForDisplay(v)}`);
    } else {
      for (let v = a; v >= b - 1e-12; v += step) values.push(`${roundForDisplay(v)}`);
    }
    return { key, values };
  }

  if (rest.startsWith("logspace(") && rest.endsWith(")")) {
    const [a, b, n] = parseNumberArgs(rest.slice("logspace(".length, -1));
    if (![a, b, n].every(Number.isFinite) || n < 1 || a <= 0 || b <= 0) {
      throw new TypeError(`logspace(a,b,n) needs positive a/b and n>=1 in "${spec}"`);
    }
    const values = [];
    if (n === 1) {
      values.push(`${roundForDisplay(a)}`);
    } else {
      const logA = Math.log10(a);
      const logB = Math.log10(b);
      for (let i = 0; i < n; i += 1) {
        const v = 10 ** (logA + ((logB - logA) * i) / (n - 1));
        values.push(`${roundForDisplay(v)}`);
      }
    }
    return { key, values };
  }

  // Bracketed list.
  let body = rest;
  if (body.startsWith("[") && body.endsWith("]")) {
    body = body.slice(1, -1);
  }
  const values = body.includes(",")
    ? body.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
    : [body.trim()];
  if (values.length === 0) {
    throw new TypeError(`sweep spec resolved to zero values in "${spec}"`);
  }
  return { key, values };
}

function roundForDisplay(value) {
  // Strip trailing zeros from a JS number rendering, but keep enough
  // significant digits to be reproducible.
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const text = value.toExponential(8);
  const num = Number(text);
  if (Math.abs(num) >= 1e-3 && Math.abs(num) < 1e6) {
    // Plain decimal for readability.
    return parseFloat(num.toPrecision(8)).toString();
  }
  // Scientific notation for very small / very large.
  return parseFloat(num.toPrecision(8)).toExponential();
}

// Cartesian product over { key1: [...], key2: [...], ... } → list of objects.
export function expandCells(sweepMap) {
  const keys = Object.keys(sweepMap || {});
  if (keys.length === 0) return [{}];
  const lists = keys.map((k) => sweepMap[k]);
  for (let i = 0; i < lists.length; i += 1) {
    if (!Array.isArray(lists[i]) || lists[i].length === 0) {
      throw new TypeError(`sweep dimension "${keys[i]}" has no values`);
    }
  }
  const out = [];
  const indices = new Array(keys.length).fill(0);
  while (true) {
    const cell = {};
    for (let i = 0; i < keys.length; i += 1) cell[keys[i]] = lists[i][indices[i]];
    out.push(cell);
    let i = keys.length - 1;
    while (i >= 0) {
      indices[i] += 1;
      if (indices[i] < lists[i].length) break;
      indices[i] = 0;
      i -= 1;
    }
    if (i < 0) break;
  }
  return out;
}

// Build a stable, filename-safe slug from cell keys + values.
export function cellSlug(cell) {
  const parts = [];
  for (const [k, v] of Object.entries(cell || {})) {
    parts.push(`${k}${slugify(String(v))}`);
  }
  return parts.join("-") || "default";
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function planSweep({
  name,
  base = {},
  sweep = {},
  seeds = 1,
  hypothesis = "",
  commit = "",
  now = () => "",
} = {}) {
  const trimmedName = trimString(name);
  if (!trimmedName) throw new TypeError("planSweep: name is required");
  const seedCount = Math.max(1, Math.floor(Number(seeds)));
  const cells = expandCells(sweep);
  const startedAt = now();
  const rows = [];
  for (const cell of cells) {
    const slug = cellSlug(cell);
    const resolvedConfig = { ...base, ...cell };
    for (let s = 0; s < seedCount; s += 1) {
      rows.push({
        started_at: startedAt,
        group: trimmedName,
        name: `${slug}-seed${s}`,
        commit: trimString(commit),
        hypothesis: trimString(hypothesis),
        mean_return: "",
        std_return: "",
        wandb_url: "",
        status: "planned",
        config: JSON.stringify(resolvedConfig),
      });
    }
  }
  return { name: trimmedName, hypothesis: trimString(hypothesis), rows };
}

export function renderRunsTsv(rows) {
  const lines = [RUN_COLUMNS.join("\t")];
  for (const row of rows) {
    lines.push(RUN_COLUMNS.map((col) => sanitizeTsvCell(row[col])).join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function sanitizeTsvCell(value) {
  // TSV doesn't formally escape \t and \n inside cells. Replace both
  // with literal escapes so the output stays grep-able.
  return String(value ?? "").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

export const RUNS_TSV_COLUMNS = RUN_COLUMNS;
