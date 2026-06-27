#!/usr/bin/env bun
/**
 * consistency-check.ts — deterministic cross-section consistency checker for
 * Semantius semantic blueprints (`artifact: semantic-blueprint`) and specs
 * (`artifact: semantic-spec`).
 *
 * It does NOT judge content (language, casing, spelling, word choice). It only
 * verifies that every place an entity's identifier / display name / edge
 * appears, it appears IDENTICALLY. Reverse or uppercase a label in every
 * location and it passes; do it in one location and it fails. That is the
 * exact failure mode that shipped three broken blueprints: §2 relabeled while
 * §3 / mermaid / §5 were not (or were processed differently).
 *
 * Read-only. Never writes to the files it checks. Exit code 0 = all consistent,
 * 1 = at least one inconsistency (or a parse/usage error).
 *
 * Usage:  bun consistency-check.ts <file.md> [<file2.md> ...]
 */

import { readFileSync } from "node:fs";

type Issue = { check: string; detail: string };

const BUILTINS = new Set(["users", "roles", "permissions"]);
// A valid Semantius data_object / table_name: lower snake_case, starts with a letter, only [a-z0-9_].
const IDENT = /^[a-z][a-z0-9_]*$/;

// ---------- generic markdown helpers ----------

/** Split a markdown table row into trimmed cells, preserving internal empties. */
function cells(line: string): string[] {
  let parts = line.split("|");
  if (parts.length && parts[0].trim() === "") parts = parts.slice(1);
  if (parts.length && parts[parts.length - 1].trim() === "") parts = parts.slice(0, -1);
  return parts.map((s) => s.trim());
}

function isTableRow(line: string): boolean {
  return /^\s*\|/.test(line);
}

function isSeparatorRow(line: string): boolean {
  const cs = cells(line);
  return cs.length > 0 && cs.every((c) => /^:?-{2,}:?$/.test(c));
}

/** Lines of a top-level section "## N." up to (not incl.) the next "## ". */
function topSection(lines: string[], n: number): string[] {
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${n}\\.`).test(l));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\d+\./.test(lines[i]) || /^##\s+\d+\.\d+/.test(lines[i])) {
      if (/^##\s/.test(lines[i]) && !/^###/.test(lines[i])) { end = i; break; }
    }
    if (/^##\s/.test(lines[i]) && !/^###/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** Lines of a "### N.M ..." subsection up to the next "### " or "## ". */
function subSection(lines: string[], re: RegExp): string[] {
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###?\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** Table rows of a block, bounded to before the first nested heading / mermaid fence. */
function tableRows(block: string[]): string[][] {
  const out: string[][] = [];
  for (const line of block) {
    if (/^```/.test(line) || /^###/.test(line)) break; // stop at mermaid / subheading
    if (!isTableRow(line) || isSeparatorRow(line)) continue;
    out.push(cells(line));
  }
  return out;
}

function firstBacktick(s: string): string | null {
  const m = s.match(/`([^`]+)`/);
  return m ? m[1].trim() : null;
}

function parenLabel(s: string): string | null {
  const m = s.match(/\(([^)]*)\)/);
  return m ? m[1].trim() : null;
}

function frontmatter(text: string): { raw: string; entities: string[]; get(k: string): string | null } {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const raw = m ? m[1] : "";
  const fmLines = raw.split("\n");
  const entities: string[] = [];
  let inEntities = false;
  for (const l of fmLines) {
    if (/^entities:\s*$/.test(l)) { inEntities = true; continue; }
    if (inEntities) {
      const e = l.match(/^\s*-\s+(.+?)\s*$/);
      if (e) { entities.push(e[1].replace(/`/g, "").trim()); continue; }
      if (/^\S/.test(l)) inEntities = false; // dedent ends the list
    }
  }
  return {
    raw,
    entities,
    get(k: string) {
      const mm = raw.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, "m"));
      return mm ? mm[1].replace(/^["']|["']$/g, "").trim() : null;
    },
  };
}

// ---------- mermaid parsing ----------

function mermaidBlock(text: string): string[] {
  const m = text.match(/```mermaid\n([\s\S]*?)```/);
  return m ? m[1].split("\n") : [];
}

type MNode = { id: string; label: string | null };
type MEdge = { from: string; verb: string | null; to: string };

function parseMermaid(block: string[]): { nodes: MNode[]; edges: MEdge[] } {
  const nodes: MNode[] = [];
  const edges: MEdge[] = [];
  for (const raw of block) {
    const line = raw.trim();
    if (!line || /^classDef\b/.test(line) || /^class\b/.test(line) || /^style\b/.test(line) || /^flowchart\b/.test(line) || /^%%/.test(line)) {
      // node-with-label can also be `class`? no. skip styling lines.
    }
    // node:  id["Label"]
    const node = line.match(/^(\w+)\["([^"]*)"\]\s*;?\s*$/);
    if (node) { nodes.push({ id: node[1], label: node[2] }); continue; }
    // edge:  A -->|"verb"| B   /  A -->|verb| B  /  A --> B  /  A ---|verb| B  /  A --- B
    const edge = line.match(/^(\w+)\s*(?:--+>|--+)\s*(?:\|"?([^|"]*)"?\|)?\s*(\w+)\s*;?\s*$/);
    if (edge) {
      edges.push({ from: edge[1], verb: edge[2] !== undefined ? edge[2].trim() : null, to: edge[3] });
      continue;
    }
  }
  return { nodes, edges };
}

// ---------- BLUEPRINT checks ----------

function checkBlueprint(text: string, lines: string[]): Issue[] {
  const issues: Issue[] = [];

  // Registry from §3: identifier -> { display, role }
  const s3 = topSection(lines, 3);
  // §3 catalog columns are parsed BY HEADER NAME, not by fixed offset. blueprint_version 3.0
  // inserted `catalog code` (after data_object) and `entity_type` (before write tier), so the
  // old row[1]/row[2]/row[3]/row[4] offsets no longer locate data_object/singular/plural/role.
  // Header row shape: | # | data_object | catalog code | singular | plural | role | mastered in | mastered label | necessity | entity_type | write tier | notes |
  // The fallbacks (1/2/3/4) keep an older 2.x header (no canonical/entity_type) parsing identically.
  const s3rows = tableRows(s3);
  const col: Record<string, number> = {};
  for (const row of s3rows) {
    const names = row.map((c) => c.toLowerCase().replace(/\*/g, "").trim());
    if (names.includes("data_object") && (names.includes("singular") || names.includes("role"))) {
      names.forEach((name, i) => { if (name && !(name in col)) col[name] = i; });
      break;
    }
  }
  const diCol = col["data_object"] ?? 1;
  const siCol = col["singular"] ?? 2;
  const piCol = col["plural"] ?? 3;
  const riCol = col["role"] ?? 4;
  const registry = new Map<string, { singular: string; plural: string; role: string }>();
  for (const row of s3rows) {
    if (!/^\d+$/.test(row[0] || "")) continue; // require the leading # column
    const cell = (row[diCol] || "").trim();    // data_object column — a BARE backticked identifier, nothing else
    const idm = cell.match(/^`([a-z][a-z0-9_]*)`$/);
    const rec = { singular: (row[siCol] || "").trim(), plural: (row[piCol] || "").trim(), role: (row[riCol] || "").trim() };
    if (!idm) {
      issues.push({ check: "data_object column", detail: `§3 row ${row[0]}: data_object "${cell}" must be a single backticked lower snake_case identifier [a-z][a-z0-9_]* (no label, no parentheses)` });
      const salvage = firstBacktick(cell) || cell.split(/[\s(]/)[0]; // register anyway so the row is never silently skipped
      if (salvage) registry.set(salvage, rec);
      continue;
    }
    registry.set(idm[1], rec);
  }
  if (registry.size === 0) {
    issues.push({ check: "§3 catalog", detail: "could not parse any entity rows from §3 (catalog of record). Aborting further checks." });
    return issues;
  }
  // NOTE: an OPTIONAL, un-numbered `## Additional Requirements Specification` section may sit
  // between §2 and §3 (a free-prose architect-to-analyst channel for non-derivable field /
  // cross-module intent). It carries no cross-section identifiers to reconcile and is
  // intentionally NOT parsed here. `topSection(lines, 2)` already stops at its `## ` heading,
  // so §2 stays correctly bounded, and `topSection(lines, 3)` finds §3 by its own number. Do
  // not "fix" the parser to treat this section as unexpected — it is allowed by design.
  // §2 entity summary (v2 format): | Name (plural) | data_object | Description |
  // Verify §2.data_object ⟺ §3.data_object (identifier) AND §2.Name ⟺ §3 plural label.
  const s2 = topSection(lines, 2);
  const s2ids = new Set<string>();
  for (const row of tableRows(s2)) {
    const name = (row[0] || "").trim();
    if (!name || name.toLowerCase() === "name") continue;
    const idCell = (row[1] || "").trim();
    const idm = idCell.match(/^`([a-z][a-z0-9_]*)`$/);
    const id = idm ? idm[1] : firstBacktick(idCell);
    if (!idm) {
      issues.push({ check: "data_object column", detail: `§2 row "${name}": data_object "${idCell}" must be a single backticked lower snake_case identifier [a-z][a-z0-9_]*` });
    }
    if (!id) continue;
    s2ids.add(id);
    if (!registry.has(id)) {
      issues.push({ check: "§2 ⟺ §3", detail: `§2 lists data_object \`${id}\` which has no row in §3` });
      continue;
    }
    const wantPlural = registry.get(id)!.plural;
    if (wantPlural && name !== wantPlural) {
      issues.push({ check: "§2 ⟺ §3", detail: `§2 Name for \`${id}\` is "${name}" but §3 plural label is "${wantPlural}"` });
    }
  }
  for (const [id] of registry) {
    if (!s2ids.has(id)) issues.push({ check: "§2 ⟺ §3", detail: `§3 entity \`${id}\` is missing from the §2 entity summary` });
  }

  // Mermaid nodes vs §3
  const { nodes, edges } = parseMermaid(mermaidBlock(text));
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    nodeIds.add(n.id);
    if (!registry.has(n.id)) {
      issues.push({ check: "mermaid ⟺ §3", detail: `mermaid node \`${n.id}\` is not an entity in §3` });
    } else {
      const want = registry.get(n.id)!.plural;
      if (want && n.label !== want) {
        issues.push({ check: "mermaid ⟺ §3", detail: `mermaid label for \`${n.id}\` is "${n.label}" but §3 plural label is "${want}"` });
      }
    }
  }
  for (const [id] of registry) {
    if (!nodeIds.has(id)) issues.push({ check: "mermaid ⟺ §3", detail: `§3 entity \`${id}\` has no node in the mermaid diagram` });
  }

  // Mermaid edges vs §5.1 + §5.2
  const s5 = topSection(lines, 5);
  const fiveEdges: MEdge[] = [];
  for (const reName of [/^###\s+5\.1/, /^###\s+5\.2/]) {
    for (const row of tableRows(subSection(s5, reName))) {
      const from = firstBacktick(row[0] || "");
      const to = firstBacktick(row[2] || "");
      const verb = (row[1] || "").trim();
      if (from && to) fiveEdges.push({ from, to, verb });
    }
  }
  const edgeKey = (e: MEdge) => `${e.from} |${(e.verb ?? "").trim()}| ${e.to}`;
  const fiveSet = new Set(fiveEdges.map(edgeKey));
  const memSet = new Set(edges.map(edgeKey));
  for (const e of edges) {
    if (!fiveSet.has(edgeKey(e))) {
      issues.push({ check: "mermaid ⟺ §5", detail: `diagram edge \`${e.from}\` -|${e.verb ?? ""}|-> \`${e.to}\` has no matching §5.1/§5.2 row (verb must match byte-for-byte)` });
    }
  }
  for (const e of fiveEdges) {
    if (!memSet.has(edgeKey(e))) {
      issues.push({ check: "mermaid ⟺ §5", detail: `§5 edge \`${e.from}\` -|${e.verb}|-> \`${e.to}\` is missing from / differs in the mermaid diagram` });
    }
  }

  // §5.1 / §5.2 endpoints resolve to §3 (allow platform built-ins)
  for (const e of fiveEdges) {
    for (const ep of [e.from, e.to]) {
      if (!registry.has(ep) && !BUILTINS.has(ep)) {
        issues.push({ check: "§5 endpoints", detail: `§5 edge endpoint \`${ep}\` is not an entity in §3` });
      }
    }
  }

  // §7 lifecycle headings: id resolves to §3, and the heading's singular label == §3 singular
  for (const l of lines) {
    const m = l.match(/^###\s+`([a-z][a-z0-9_]*)`\s*\(([^)]*)\)/);
    if (!m) continue;
    const hid = m[1], hsing = m[2].trim();
    if (!registry.has(hid) && !BUILTINS.has(hid)) {
      issues.push({ check: "§7 ⟺ §3", detail: `§7 lifecycle section for \`${hid}\` has no matching §3 entity` });
    } else if (registry.has(hid)) {
      const want = registry.get(hid)!.singular;
      if (want && hsing !== want) {
        issues.push({ check: "§7 ⟺ §3", detail: `§7 heading singular for \`${hid}\` is "${hsing}" but §3 singular label is "${want}"` });
      }
    }
  }

  // §6.4 + §8.2 data_object resolve to §3
  for (const row of tableRows(subSection(topSection(lines, 6), /^###\s+6\.4/))) {
    const id = firstBacktick(row[0] || "");
    if (id && !registry.has(id) && !BUILTINS.has(id)) issues.push({ check: "§6.4 ⟺ §3", detail: `§6.4 references \`${id}\` which is not a §3 entity` });
  }
  for (const row of tableRows(subSection(topSection(lines, 8), /^###\s+8\.2/))) {
    const id = firstBacktick(row[1] || "");
    if (id && !registry.has(id) && !BUILTINS.has(id)) issues.push({ check: "§8.2 ⟺ §3", detail: `§8.2 business rule references \`${id}\` which is not a §3 entity` });
  }

  return issues;
}

// ---------- SPEC checks ----------

function checkSpec(text: string, lines: string[], fm: ReturnType<typeof frontmatter>): Issue[] {
  const issues: Issue[] = [];

  // §2 entity summary: | # | `table` | Singular | Purpose |
  const s2 = topSection(lines, 2);
  const s2entities = new Map<string, string>(); // table_name -> singular
  // The spec §2 Table-name column MUST be a single backticked lower snake_case identifier.
  const SPEC_TABLE_CELL = /^`([a-z][a-z0-9_]*)`$/;
  for (const row of tableRows(s2)) {
    if (!/^\d+$/.test(row[0] || "")) continue;
    const cell = (row[1] || "").trim();
    const sm = cell.match(SPEC_TABLE_CELL);
    if (!sm) {
      issues.push({ check: "data_object column", detail: `§2 row ${row[0]}: table-name cell "${cell}" must be a single backticked lower snake_case identifier [a-z][a-z0-9_]*` });
      const id = firstBacktick(cell);
      if (id) s2entities.set(id, (row[2] || "").trim());
      continue;
    }
    s2entities.set(sm[1], (row[2] || "").trim());
  }

  // §3 sub-section headings: ### 3.N `table` — Singular
  const s3singular = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/^###\s+3\.\d+\s+`([^`]+)`\s*[—–-]\s*(.+?)\s*$/);
    if (m) s3singular.set(m[1].trim(), m[2].trim());
  }

  if (s2entities.size === 0 && s3singular.size === 0) {
    issues.push({ check: "§2/§3", detail: "could not parse any entities from §2 or §3. Aborting further checks." });
    return issues;
  }

  // data_object name validity: every declared identifier (frontmatter, §2, §3) must be lower snake_case.
  for (const id of new Set([...fm.entities, ...s2entities.keys(), ...s3singular.keys()])) {
    if (id && !IDENT.test(id)) {
      issues.push({ check: "data_object name", detail: `entity identifier "${id}" is not a valid table_name — must be lower snake_case matching [a-z][a-z0-9_]*` });
    }
  }

  const fmEntities = new Set(fm.entities);
  const s2ids = new Set(s2entities.keys());
  const s3ids = new Set(s3singular.keys());

  // 3-way entity-set reconciliation: frontmatter entities ⟺ §2 ⟺ §3
  const allIds = new Set<string>([...fmEntities, ...s2ids, ...s3ids]);
  for (const id of allIds) {
    const where: string[] = [];
    if (fmEntities.has(id)) where.push("frontmatter");
    if (s2ids.has(id)) where.push("§2");
    if (s3ids.has(id)) where.push("§3");
    const missing = ["frontmatter", "§2", "§3"].filter((w) => !where.includes(w));
    if (missing.length && (fmEntities.size > 0 || missing.indexOf("frontmatter") === -1)) {
      // only flag frontmatter-absence when a frontmatter entities list exists at all
      const realMissing = fmEntities.size === 0 ? missing.filter((m) => m !== "frontmatter") : missing;
      if (realMissing.length) {
        issues.push({ check: "entity set", detail: `entity \`${id}\` appears in ${where.join(", ")} but is missing from ${realMissing.join(", ")}` });
      }
    }
  }

  // Singular-label consistency: §2 Singular label ⟺ §3 heading Singular label
  for (const [id, s2sing] of s2entities) {
    const s3sing = s3singular.get(id);
    if (s3sing !== undefined && s2sing !== "" && s2sing !== s3sing) {
      issues.push({ check: "singular label", detail: `\`${id}\`: §2 singular label is "${s2sing}" but §3 heading says "${s3sing}"` });
    }
  }

  const known = (id: string) => s2ids.has(id) || s3ids.has(id) || fmEntities.has(id) || BUILTINS.has(id);

  // §4 relationship summary endpoints resolve
  for (const row of tableRows(topSection(lines, 4))) {
    const from = firstBacktick(row[0] || "");
    const to = firstBacktick(row[2] || "");
    for (const ep of [from, to]) {
      if (ep && !known(ep)) issues.push({ check: "§4 ⟺ entities", detail: `§4 relationship endpoint \`${ep}\` is not a declared entity` });
    }
  }

  // §5 enum headings: ### 5.N `table.field`
  for (const l of lines) {
    const m = l.match(/^###\s+5\.\d+\s+`([^.\`]+)\.[^`]+`/);
    if (m && !known(m[1])) issues.push({ check: "§5 ⟺ entities", detail: `§5 enumeration is declared on \`${m[1]}\` which is not a declared entity` });
  }

  // §8.2 business rules data_object resolves
  for (const row of tableRows(subSection(topSection(lines, 8), /^##?#?\s*8\.2/))) {
    const id = firstBacktick(row[1] || "");
    if (id && !known(id)) issues.push({ check: "§8.2 ⟺ entities", detail: `§8.2 references \`${id}\` which is not a declared entity` });
  }

  // mermaid edge endpoints resolve
  const { edges } = parseMermaid(mermaidBlock(text));
  for (const e of edges) {
    for (const ep of [e.from, e.to]) {
      if (!known(ep)) issues.push({ check: "mermaid ⟺ entities", detail: `mermaid references \`${ep}\` which is not a declared entity` });
    }
  }

  // --- RACI-mode decision provenance (the governance-mode gate) ---
  // When the spec carries a RACI matrix (§9.1 "RACI realization:"), the governance-mode
  // decision (analyst Stage 9.5 Step 0) was REQUIRED before the spec could be written.
  // A silently-defaulted mode is exactly the skip this guards: enforce that BOTH the mode
  // and HOW it was decided are stamped. The checker cannot prove a human was asked — it can
  // prove a deliberate source value was recorded, which turns a silent default into an
  // explicit, auditable choice that a reviewer (or a future tighter gate) can challenge.
  if (/(^|\n)\s*\*\*RACI realization:\*\*/.test(text)) {
    const RACI_MODES = new Set(["living", "documentation"]);
    const RACI_SOURCES = new Set(["user-answer", "computed-default", "non-interactive"]);
    const fmMode = fm.get("raci_mode");
    const fmSource = fm.get("raci_mode_source");
    const bodyModeMatch = text.match(/\*\*RACI mode:\*\*\s*`?([a-z-]+)`?/);
    const bodyMode = bodyModeMatch ? bodyModeMatch[1].trim() : null;

    if (!fmMode || !RACI_MODES.has(fmMode)) {
      issues.push({ check: "RACI provenance", detail: `spec carries a RACI matrix but frontmatter \`raci_mode\` is missing or invalid (got "${fmMode ?? "(absent)"}", expected living | documentation). The governance-mode gate (analyst Stage 9.5 Step 0) must record its outcome before the spec is written.` });
    }
    if (!fmSource || !RACI_SOURCES.has(fmSource)) {
      issues.push({ check: "RACI provenance", detail: `spec carries a RACI matrix but frontmatter \`raci_mode_source\` is missing or invalid (got "${fmSource ?? "(absent)"}", expected user-answer | computed-default | non-interactive). A silently-defaulted mode is not allowed — stamp how the mode was decided.` });
    }
    if (!bodyMode || !RACI_MODES.has(bodyMode)) {
      issues.push({ check: "RACI provenance", detail: `spec carries a RACI matrix but the §9 \`**RACI mode:**\` line is missing or invalid (got "${bodyMode ?? "(absent)"}", expected living | documentation).` });
    }
    if (fmMode && bodyMode && RACI_MODES.has(fmMode) && RACI_MODES.has(bodyMode) && fmMode !== bodyMode) {
      issues.push({ check: "RACI provenance", detail: `frontmatter \`raci_mode\` ("${fmMode}") disagrees with the §9 \`**RACI mode:**\` line ("${bodyMode}").` });
    }
  }

  return issues;
}

// ---------- driver ----------

function checkFile(path: string): { issues: Issue[]; artifact: string } {
  // Normalize BOM + CRLF/CR so the checker is line-ending agnostic (Windows files are often CRLF).
  const text = readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const fm = frontmatter(text);
  const artifact = fm.get("artifact") ?? "(unknown)";
  if (artifact === "semantic-blueprint") return { issues: checkBlueprint(text, lines), artifact };
  if (artifact === "semantic-spec") return { issues: checkSpec(text, lines, fm), artifact };
  return { issues: [{ check: "artifact", detail: `unrecognized or missing \`artifact:\` (got "${artifact}"); expected semantic-blueprint or semantic-spec` }], artifact };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun consistency-check.ts <file.md> [<file2.md> ...]");
    process.exit(2);
  }
  let failed = 0;
  for (const path of files) {
    let res;
    try {
      res = checkFile(path);
    } catch (err) {
      console.log(`\n${path}\n  [ERROR] ${(err as Error).message}`);
      failed++;
      continue;
    }
    console.log(`\n${path}  (artifact: ${res.artifact})`);
    if (res.issues.length === 0) {
      console.log("  ✓ consistent — every entity name, identifier, label, and edge agrees across all sections");
    } else {
      failed++;
      const byCheck = new Map<string, string[]>();
      for (const i of res.issues) {
        if (!byCheck.has(i.check)) byCheck.set(i.check, []);
        byCheck.get(i.check)!.push(i.detail);
      }
      for (const [check, details] of byCheck) {
        console.log(`  ✗ ${check}`);
        for (const d of details) console.log(`      - ${d}`);
      }
    }
  }
  console.log(`\n${failed === 0 ? "RESULT: all files consistent" : `RESULT: ${failed} file(s) with inconsistencies`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
