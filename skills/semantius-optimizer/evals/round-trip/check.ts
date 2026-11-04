#!/usr/bin/env bun
/**
 * Round-trip conformance check for semantius-optimizer.
 *
 * Four assertions, all offline (no Semantius instance needed):
 *
 *  1. GOLDEN   Every `fixture-*.json` in this folder renders (via
 *              `spec-extract-lib.ts --from-fixture`) byte-identical to its
 *              `expected-*.md`. Run with `--update` to regenerate the goldens after an
 *              intentional change to the extractor; review the diff before committing.
 *  2. CHECKER  Every rendered spec passes the architect's `consistency-check.ts`
 *              (the same gate the analyst runs pre-save and the modeler runs pre-deploy).
 *  3. TEMPLATE The analyst's `semantic-spec-template.md` skeleton and the extractor
 *              agree on the emitted surface: zero em-dashes (U+2014) inside the
 *              skeleton; every skeleton heading (`#`/`##`/`###`, placeholder prefix
 *              stripped) and every table header row the optimizer is expected to emit
 *              appears as a literal in `spec-extract-lib.ts`. Table headers the optimizer
 *              deliberately never emits are listed in NOT_EMITTED_BY_OPTIMIZER so the
 *              contract is explicit rather than silent.
 *  4. SHAPE    Independent of the goldens, so `--update` cannot bless a regression. Every
 *              owned entity carries full codes on `**View permission:**` and
 *              `**Edit permission:**`, each one a §8.1 row, and §8.1 has no `reconciliation`
 *              column. EXPECT lists the §8.1 tiers, the hierarchy rows, and what must stay
 *              out, for the fixtures that exercise them.
 *
 * Usage:  bun evals/round-trip/check.ts [--update]
 * Exit 0 = all green; 1 = at least one assertion failed (details on stdout).
 */

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = import.meta.dir;
const lib = resolve(here, "../../references/spec-extract-lib.ts");
const checker = resolve(here, "../../../semantius-architect/references/consistency-check.ts");
const template = resolve(here, "../../../semantius-analyst/references/semantic-spec-template.md");
const update = Bun.argv.includes("--update");

const SKELETON_START = /^## Skeleton starts below this line/;
const SKELETON_END = /^## Skeleton ends above this line/;

/** Table header rows of the skeleton that the optimizer never emits (it writes the
 *  section's `_(none: …)_` placeholder instead, or omits the surface entirely). */
const NOT_EMITTED_BY_OPTIMIZER = new Set<string>([
  "| FK table | References | Label | Cardinality | Required | Delete | Reconciliation |",  // §6 relationship table
  "| source module | target domain | target module | trigger_event | transition | payload | integration | friction | description |", // §6 Outbound
  "| target module | source domain | source module | trigger_event | transition | payload | integration | friction | description |", // §6 Inbound
  "| rule_name | data_object | source flag | intent |",                       // §8.2
  "| actor | kind | raci | process_key | consult_mode | realization |",      // §9.1 RACI realization
  "| process_key | role (slug) | raci | consult_mode |",                      // §9.1 RACI plan
  "| process_key | entity | gate_kind | to_state | state_column | emits_events |",
  "| entity | rule | jsonlogic |",
  "| responsibility | business function | default role | default tier |",    // §9.2
]);

/** What a fixture's render must say, whatever its golden says. */
const EXPECT: Record<string, { tiers: Record<string, string>; hierarchy?: [string, string][]; absent?: string[] }> = {
  full: {
    tiers: {
      "demo-ops-pro:read_assets": "entity-read",
      "demo-ops-pro:write_assets": "entity-write",
      "demo-ops-pro:write_asset_vendors": "entity-write",
      "demo-ops-pro:relate": "narrow",
    },
  },
  // Hand-made codes: a code an entity's edit permission names is narrow, and `custom` has no per-entity tiers.
  custom: { tiers: { "demo-handmade:lend": "narrow", "demo-handmade:write_repairs": "narrow" } },
  "later-embedder": {
    tiers: {
      // Reached through hierarchy rows; the first embedder holds them.
      "ats-candidate-crm:read_candidates": "entity-read",
      "ats-candidate-crm:write_candidates": "entity-write",
      "ats-candidate-crm:hire_candidate": "workflow-gate (lifecycle)",
      "ats-candidate-crm:view_all_candidates": "override",
      "lms-skills:read_skill_profiles": "entity-read",
      // Held by the installed owner; a variant below shows the entity's columns alone reach them.
      "ats-offers:read_campus_offers": "entity-read",
      "ats-offers:write_campus_offers": "entity-write",
      // Reached only through a rule.
      "ats-offers:cancel_campus_event": "workflow-gate (rule)",
      // Owner-named submit codes. The second lock has no rule in this spec: its entity is reused.
      "ats-offers:submit_campus_offer": "workflow-gate (rule)",
      "ats-offers:bypass_submit_lock": "workflow-gate (rule)",
      "ats-candidate-crm:bypass_submit_lock": "workflow-gate (rule)",
      // Computed: read row only, no write row.
      "campus-hiring:read_campus_scorecards": "entity-read",
      // Held here. A bundle that includes a write permission is narrow; a gate whose verb reads like one is not.
      "campus-hiring:interview": "narrow",
      "campus-hiring:write_campus_interviews": "entity-write",
      "campus-hiring:write_off_event": "workflow-gate (lifecycle)",
    },
    hierarchy: [
      ["campus-hiring:read", "ats-candidate-crm:read_candidates"],
      ["campus-hiring:manage", "ats-candidate-crm:write_candidates"],
      ["ats-candidate-crm:write_candidates", "ats-candidate-crm:read_candidates"],
      ["campus-hiring:admin", "ats-candidate-crm:hire_candidate"],
      ["campus-hiring:read", "lms-skills:read_skill_profiles"],
      ["campus-hiring:interview", "campus-hiring:write_campus_interviews"],
    ],
    // Another module's bundles, whatever sits behind them.
    absent: [
      "ats-offers:read", "ats-offers:read_job_offers", "hiring-starter:read", "hiring-starter:manage",
      "hiring-starter:admin", "hiring-starter:interview", "hiring-starter:read_panels", "hiring-starter:write_panels",
    ],
  },
};

/** The backticked rows of the table under a line, as `[first cell, second cell]`. */
function tableUnder(md: string[], start: RegExp): string[][] {
  const at = md.findIndex((l) => start.test(l));
  const rows: string[][] = [];
  if (at < 0) return rows;
  for (let i = at + 1; i < md.length; i++) {
    if (/^(#{1,3} |\*\*)/.test(md[i])) break;
    if (!/^\| `/.test(md[i])) continue;
    rows.push(md[i].split("|").slice(1, 3).map((c) => c.trim().replace(/`/g, "")));
  }
  return rows;
}

function checkShape(name: string, md: string, owned: any[]): void {
  const lines = md.split("\n");
  const before = failures;
  const wanted: Record<string, number> = {
    "View permission": owned.length,
    "Edit permission": owned.filter((e) => e.entity_type !== "computed").length,
  };
  const catalog = new Map(tableUnder(lines, /^## 8\.1 /).map(([code, tier]) => [code, tier] as const));
  const hierarchy = tableUnder(lines, /^\*\*Permission hierarchy:\*\*/);
  const header = lines.find((l) => l.startsWith("| permission | tier |")) ?? "";
  if (/reconciliation/.test(header)) fail(`${name}: §8.1 header still has a reconciliation column: ${header}`);
  if (/re-prefixed-from|grant_module/.test(md)) fail(`${name}: render names re-prefixed-from or grant_module`);
  for (const [label, count] of Object.entries(wanted)) {
    const codes = lines.filter((l) => l.startsWith(`**${label}:** `)).map((l) => l.slice(label.length + 6).trim());
    if (codes.length !== count) fail(`${name}: ${codes.length} \`**${label}:**\` lines, expected ${count}`);
    for (const code of codes) {
      if (!/^[a-z0-9_-]+:[a-z0-9_]+$/.test(code)) fail(`${name}: \`**${label}:**\` is not a full code: ${code}`);
      else if (!catalog.has(code)) fail(`${name}: \`**${label}:** ${code}\` has no §8.1 row`);
    }
  }
  const want = EXPECT[name];
  for (const [code, tier] of Object.entries(want?.tiers ?? {})) {
    if (catalog.get(code) !== tier) fail(`${name}: §8.1 \`${code}\` should be ${tier}, is ${catalog.get(code) ?? "missing"}`);
  }
  for (const [a, b] of want?.hierarchy ?? []) {
    if (!hierarchy.some(([x, y]) => x === a && y === b)) fail(`${name}: §9.1 lost \`${a}\` includes \`${b}\``);
  }
  for (const code of want?.absent ?? []) {
    if (catalog.has(code) || hierarchy.some(([x, y]) => x === code || y === code)) fail(`${name}: \`${code}\` belongs to another module and should not be in §8.1 or §9.1`);
  }
  if (failures === before) ok(`${name}: shape holds (${catalog.size} §8.1 rows, ${hierarchy.length} §9.1 rows)`);
}

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

function firstDiff(a: string, b: string): string {
  const al = a.split("\n"), bl = b.split("\n");
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) {
      return `first difference at line ${i + 1}:\n      expected: ${JSON.stringify(bl[i] ?? "<EOF>")}\n      actual:   ${JSON.stringify(al[i] ?? "<EOF>")}`;
    }
  }
  return "(identical)";
}

// ---------- 1 + 2: goldens + checker ----------
const tmp = mkdtempSync(join(tmpdir(), "semantius-rt-"));
const fixtures = readdirSync(here).filter((f) => /^fixture-.*\.json$/.test(f)).sort();
console.log(`round-trip: ${fixtures.length} fixture(s)`);
for (const fx of fixtures) {
  const name = fx.replace(/^fixture-/, "").replace(/\.json$/, "");
  const outPath = join(tmp, `${name}.md`);
  const r = await run(["bun", "run", lib, "--from-fixture", join(here, fx), outPath, "--force"]);
  if (r.code !== 0) { fail(`${fx}: extractor exited ${r.code}\n${r.err}`); continue; }
  const actual = readFileSync(outPath, "utf8");
  checkShape(name, actual, JSON.parse(readFileSync(join(here, fx), "utf8")).ownedRaw);
  const goldenPath = join(here, `expected-${name}.md`);
  if (update) {
    writeFileSync(goldenPath, actual);
    ok(`${fx}: wrote ${goldenPath}`);
  } else {
    let golden: string | null = null;
    try { golden = readFileSync(goldenPath, "utf8"); } catch { /* missing */ }
    if (golden === null) fail(`${fx}: golden ${goldenPath} missing (run with --update)`);
    else if (golden.replace(/\r\n/g, "\n") !== actual.replace(/\r\n/g, "\n")) fail(`${fx}: output differs from golden; ${firstDiff(actual, golden)}`);
    else ok(`${fx}: byte-identical to expected-${name}.md`);
  }
  const c = await run(["bun", checker, outPath]);
  if (c.code !== 0) fail(`${fx}: consistency-check.ts rejected the render\n${c.out}`);
  else ok(`${fx}: consistency-check.ts exit 0`);
  if (/—/.test(actual)) fail(`${fx}: rendered spec contains an em-dash`);
}

/** Render the later-embedder fixture after `change`, for a case the fixture itself cannot carry. */
async function renderVariant(variant: string, change: (fx: any) => void): Promise<string[]> {
  const fx = JSON.parse(readFileSync(join(here, "fixture-later-embedder.json"), "utf8"));
  change(fx);
  const input = join(tmp, `${variant}.json`), output = join(tmp, `${variant}.md`);
  writeFileSync(input, JSON.stringify(fx));
  const r = await run(["bun", "run", lib, "--from-fixture", input, output, "--force"]);
  if (r.code !== 0) { fail(`${variant}: extractor exited ${r.code}\n${r.err}`); return []; }
  return readFileSync(output, "utf8").split("\n");
}

// With no hierarchy row to them, an owned entity's codes still reach §8.1 through its columns.
{
  const code = "ats-offers:read_campus_offers";
  const md = await renderVariant("columns-only", (fx) => {
    fx.allHierarchy = fx.allHierarchy.filter((h: any) => !h.included_permission_name.startsWith("ats-offers:"));
  });
  const catalog = new Map(tableUnder(md, /^## 8\.1 /).map(([c, t]) => [c, t] as const));
  if (catalog.get(code) === "entity-read") ok(`later-embedder: \`${code}\` survives on its entity's columns alone`);
  else fail(`later-embedder: with no hierarchy row, \`${code}\` should be entity-read, is ${catalog.get(code) ?? "missing"}`);
}

// The platform default `edit_permission` is not a module's code, on any entity.
{
  const md = await renderVariant("default-admin", (fx) => {
    fx.ownedRaw.find((e: any) => e.table_name === "campus_events").edit_permission = "admin";
  });
  if (md.some((l) => l === "**Edit permission:** admin")) fail("later-embedder: the platform default `admin` was emitted as `**Edit permission:**`");
  else if (md.length) ok("later-embedder: the platform default `admin` emits no `**Edit permission:**` line");
}

// ---------- 3: template ⟺ extractor ----------
console.log("template lint:");
const tpl = readFileSync(template, "utf8").replace(/\r\n/g, "\n").split("\n");
const s = tpl.findIndex((l) => SKELETON_START.test(l));
const e = tpl.findIndex((l) => SKELETON_END.test(l));
if (s < 0 || e < 0 || e <= s) {
  fail(`template: skeleton anchors not found (need "## Skeleton starts below this line" … "## Skeleton ends above this line")`);
} else {
  // Strip the outer ```markdown fence lines; keep everything else verbatim.
  const skel = tpl.slice(s + 1, e).filter((l) => !/^```markdown\s*$/.test(l));
  const outerClose = skel.lastIndexOf("```");
  const body = outerClose >= 0 ? skel.slice(0, outerClose).concat(skel.slice(outerClose + 1)) : skel;

  const emd = body.map((l, i) => [l, i] as const).filter(([l]) => /—/.test(l));
  if (emd.length) fail(`template skeleton contains ${emd.length} em-dash line(s): ${emd.slice(0, 3).map(([, i]) => `skeleton line ${i + 1}`).join(", ")}`);
  else ok("template skeleton has zero em-dashes");

  // Normalize the extractor source: drop backslashes (escaped backticks inside
  // template literals) so `### \`` matches the skeleton's `### \``.
  const libSrc = readFileSync(lib, "utf8").replace(/\\/g, "");
  let missing = 0;
  for (const line of body) {
    let probe: string | null = null;
    if (/^#{1,3}\s/.test(line)) {
      probe = /^#\s/.test(line) ? ": Semantic Model" : line.split("{{")[0].trimEnd();
      if (probe.replace(/^#+\s*/, "") === "") probe = null; // heading that is only a placeholder
    } else if (/^\|/.test(line) && !/\{\{/.test(line) && !/^\|\s*-{2,}/.test(line) && !/^\|\s*:?-+/.test(line)) {
      probe = line.trim();
      if (NOT_EMITTED_BY_OPTIMIZER.has(probe)) probe = null;
    }
    if (probe && !libSrc.includes(probe)) { missing++; fail(`template literal not found in spec-extract-lib.ts: ${JSON.stringify(probe)}`); }
  }
  if (!missing) ok("every skeleton heading / emitted table header appears in spec-extract-lib.ts");
}

console.log(failures ? `\nRESULT: ${failures} failure(s)` : "\nRESULT: all green");
process.exit(failures ? 1 : 0);
