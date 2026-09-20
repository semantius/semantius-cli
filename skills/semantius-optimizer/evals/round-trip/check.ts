#!/usr/bin/env bun
/**
 * Round-trip conformance check for semantius-optimizer.
 *
 * Three assertions, all offline (no Semantius instance needed):
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
  "| From | To | Verb | Cardinality | Delete | Reconciliation |",             // §6 link table
  "| source module | target domain | target module | trigger_event | transition | payload | integration | friction | description |", // §6 Outbound
  "| target module | source domain | source module | trigger_event | transition | payload | integration | friction | description |", // §6 Inbound
  "| rule_name | data_object | source flag | intent |",                       // §8.2
  "| actor | kind | raci | process_key | consult_mode | realization | grant_module |", // §9.1 RACI realization
  "| process_key | role (slug) | raci | consult_mode |",                      // §9.1 RACI plan
  "| process_key | entity | gate_kind | to_state | state_column | emits_events |",
  "| entity | rule | jsonlogic |",
  "| responsibility | business function | default role | default tier |",    // §9.2
]);

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

  // Normalise the extractor source: drop backslashes (escaped backticks inside
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
