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
 * 1 = at least one inconsistency (or a parse/usage error). Warnings (`⚠`) are
 * printed but never fail a file.
 *
 * Usage:  bun consistency-check.ts <file.md> [<file2.md> ...]
 *         bun consistency-check.ts --emit-mermaid <file.md>
 */

import { readFileSync } from "node:fs";

type Issue = { check: string; detail: string; warn?: boolean };

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

// Entity key types (`entities.id_type` / `entities.id_prefix`). `auto_increment` is the
// default and is written by omission; `computed` is system-only and never authored.
// `is_a` (a subtype) and `has_a` (an optional extension) are based on another entity
// (`entities.id_refentity`) and share its key; see use-semantius references/entity-families.md.
const KEY_TYPES = new Set(["bigint", "text", "uuid", "typeid", "is_a", "has_a"]);
const PREFIXED_KEY_TYPES = new Set(["typeid", "is_a"]);
const BASED_KEY_TYPES = new Set(["is_a", "has_a"]);
const KEY_PREFIX = /^[a-z](?:[a-z_]{0,61}[a-z])?$/;
// The fixed verbs of a dotted mermaid edge, drawn from a based entity to its base.
const FAMILY_VERB: Record<string, string> = { is_a: "is a kind of", has_a: "extends" };
// §3 `role` values: the four the architect authors, plus `derived`, which catalog clones carry
// (the domain-map catalog's role enum: a module that republishes signals computed from others' masters).
const ROLES = new Set(["master", "embedded_master", "contributor", "consumer", "derived"]);

/** Validate one entity's key type / prefix pair; `seen` maps prefix -> first entity (uniqueness). */
function checkKey(where: string, id: string, type: string, prefix: string, seen: Map<string, string>): Issue[] {
  const out: Issue[] = [];
  if (!KEY_TYPES.has(type)) {
    out.push({ check: "key type", detail: `${where} \`${id}\`: key type "${type}" must be one of bigint | text | uuid | typeid | is_a | has_a (auto_increment is written by omitting it)` });
  }
  if (PREFIXED_KEY_TYPES.has(type)) {
    if (!KEY_PREFIX.test(prefix)) {
      out.push({ check: "key type", detail: `${where} \`${id}\`: ${type} needs a prefix of lower-case letters / underscores, starting and ending with a letter, max 63 (got "${prefix || "(none)"}")` });
    } else if (seen.has(prefix)) {
      out.push({ check: "key type", detail: `${where} \`${id}\`: key prefix "${prefix}" is already used by \`${seen.get(prefix)}\` (prefixes are unique among entities)` });
    } else {
      seen.set(prefix, id);
    }
  } else if (prefix) {
    out.push({ check: "key type", detail: `${where} \`${id}\`: a key prefix ("${prefix}") is only allowed with key type typeid or is_a` });
  }
  return out;
}

/** One entity's key type ("" = the default auto_increment) and the base it is based on ("" = none). */
type KeyInfo = { type: string; basedOn: string };

/**
 * Validate the family links of one file: `based on` only with is_a / has_a (and required there),
 * the base resolves and is never a built-in, no cycles, and, when the base's key type is decided
 * in this file (`keyDecidedHere`), has_a needs a typeid base and is_a a typeid or is_a base.
 */
function checkFamilies(where: string, keys: Map<string, KeyInfo>, known: (id: string) => boolean, keyDecidedHere: (id: string) => boolean): Issue[] {
  const out: Issue[] = [];
  const typeOf = (id: string) => keys.get(id)?.type || "auto_increment";
  for (const [id, k] of keys) {
    if (!BASED_KEY_TYPES.has(k.type)) {
      if (k.basedOn) out.push({ check: "family", detail: `${where} \`${id}\`: "based on" \`${k.basedOn}\` is only allowed with key type is_a or has_a (this entity is ${typeOf(id)})` });
      continue;
    }
    if (!k.basedOn) {
      out.push({ check: "family", detail: `${where} \`${id}\`: key type ${k.type} needs the entity it is based on` });
      continue;
    }
    const base = k.basedOn;
    if (BUILTINS.has(base)) {
      out.push({ check: "family", detail: `${where} \`${id}\`: platform built-in \`${base}\` can never be a base; reference it instead` });
      continue;
    }
    if (!known(base)) {
      out.push({ check: "family", detail: `${where} \`${id}\`: based on \`${base}\`, which is not an entity of this file` });
      continue;
    }
    if (!keyDecidedHere(base)) continue; // the owner decides the base's key; checked against the live catalog
    const bt = typeOf(base);
    if (k.type === "has_a" && bt !== "typeid") {
      out.push({ check: "family", detail: `${where} \`${id}\`: has_a needs a typeid base, but \`${base}\` is ${bt}` });
    } else if (k.type === "is_a" && bt !== "typeid" && bt !== "is_a") {
      out.push({ check: "family", detail: `${where} \`${id}\`: is_a needs a typeid or is_a base, but \`${base}\` is ${bt}` });
    }
  }
  const reported = new Set<string>();
  for (const [id] of keys) {
    const chain = [id];
    let cur = keys.get(id)?.basedOn || "";
    while (cur && BASED_KEY_TYPES.has(keys.get(chain[chain.length - 1])?.type ?? "")) {
      if (chain.includes(cur)) {
        const loop = chain.slice(chain.indexOf(cur));
        const key = [...loop].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          out.push({ check: "family", detail: `${where}: cycle in "based on": ${[...loop, cur].map((x) => `\`${x}\``).join(" → ")}` });
        }
        break;
      }
      chain.push(cur);
      cur = keys.get(cur)?.basedOn || "";
    }
  }
  return out;
}

/** The dotted mermaid edges a file's family links imply: based entity -.->|verb| base. */
function familyEdges(keys: Map<string, KeyInfo>): MEdge[] {
  const out: MEdge[] = [];
  for (const [id, k] of keys) {
    if (BASED_KEY_TYPES.has(k.type) && k.basedOn) out.push({ from: id, verb: FAMILY_VERB[k.type], to: k.basedOn });
  }
  return out;
}

/** Dotted diagram edges ⟺ the family links, in both directions. */
function checkDottedEdges(want: MEdge[], got: MEdge[], source: string): Issue[] {
  const out: Issue[] = [];
  const key = (e: MEdge) => `${e.from} |${(e.verb ?? "").trim()}| ${e.to}`;
  const wantSet = new Set(want.map(key));
  const gotSet = new Set(got.map(key));
  for (const e of got) {
    if (!wantSet.has(key(e))) out.push({ check: "mermaid ⟺ family", detail: `dotted edge \`${e.from} -.->|${e.verb ?? ""}| ${e.to}\` has no matching ${source} (is_a draws "${FAMILY_VERB.is_a}", has_a draws "${FAMILY_VERB.has_a}")` });
  }
  for (const e of want) {
    if (!gotSet.has(key(e))) out.push({ check: "mermaid ⟺ family", detail: `${source} implies the dotted edge \`${e.from} -.->|${e.verb}| ${e.to}\`, but the diagram is missing it or draws it differently` });
  }
  return out;
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

/** `edges` are the relationship edges; `dotted` are the family edges (`-.->`), kept apart. */
function parseMermaid(block: string[]): { nodes: MNode[]; edges: MEdge[]; dotted: MEdge[] } {
  const nodes: MNode[] = [];
  const edges: MEdge[] = [];
  const dotted: MEdge[] = [];
  for (const raw of block) {
    const line = raw.trim();
    if (!line || /^classDef\b/.test(line) || /^class\b/.test(line) || /^style\b/.test(line) || /^flowchart\b/.test(line) || /^%%/.test(line)) {
      // node-with-label can also be `class`? no. skip styling lines.
    }
    // node:  id["Label"]
    const node = line.match(/^(\w+)\["([^"]*)"\]\s*;?\s*$/);
    if (node) { nodes.push({ id: node[1], label: node[2] }); continue; }
    // family edge:  A -.->|"is a kind of"| B   /  A -.->|extends| B
    const fam = line.match(/^(\w+)\s*-\.+->\s*(?:\|"?([^|"]*)"?\|)?\s*(\w+)\s*;?\s*$/);
    if (fam) {
      dotted.push({ from: fam[1], verb: fam[2] !== undefined ? fam[2].trim() : null, to: fam[3] });
      continue;
    }
    // edge:  A -->|"verb"| B   /  A -->|verb| B  /  A --> B  /  A ---|verb| B  /  A --- B
    const edge = line.match(/^(\w+)\s*(?:--+>|--+)\s*(?:\|"?([^|"]*)"?\|)?\s*(\w+)\s*;?\s*$/);
    if (edge) {
      edges.push({ from: edge[1], verb: edge[2] !== undefined ? edge[2].trim() : null, to: edge[3] });
      continue;
    }
  }
  return { nodes, edges, dotted };
}

// ---------- BLUEPRINT checks ----------

/**
 * The §3 optional `**Key types:**` sub-block, parsed BY HEADER NAME:
 * | data_object | key type | key prefix | based on |  (blueprint_version 3.1; the legacy
 * 3-column form without `based on` parses too). `-` cells read as empty.
 */
function parseBlueprintKeyTypes(s3: string[]): { id: string; type: string; prefix: string; basedOn: string }[] | null {
  const start = s3.findIndex((l) => /^\*\*Key types:\*\*/.test(l.trim()));
  if (start < 0) return null;
  const ktLines: string[] = [];
  for (const l of s3.slice(start + 1)) {
    if (isTableRow(l)) ktLines.push(l);
    else if (ktLines.length) break; // the table ended
  }
  const rows = tableRows(ktLines);
  const names = (rows[0] || []).map((c) => c.toLowerCase().replace(/\*/g, "").trim());
  const hasHeader = names.includes("data_object");
  const at = (name: string, fallback: number) => (hasHeader && names.includes(name) ? names.indexOf(name) : hasHeader ? -1 : fallback);
  const iId = at("data_object", 0), iType = at("key type", 1), iPrefix = at("key prefix", 2), iBased = at("based on", -1);
  const val = (row: string[], i: number) => {
    const v = i >= 0 ? (row[i] || "").replace(/`/g, "").trim() : "";
    return v === "-" ? "" : v;
  };
  return rows.slice(hasHeader ? 1 : 0).map((row) => ({
    id: firstBacktick(row[iId] || "") || (row[iId] || "").trim(),
    type: val(row, iType),
    prefix: val(row, iPrefix),
    basedOn: val(row, iBased),
  }));
}

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
  // §3 `role` is a closed set (checked only when the header names the column).
  if ("role" in col) {
    for (const [id, rec] of registry) {
      if (!ROLES.has(rec.role)) issues.push({ check: "§3 role", detail: `§3 \`${id}\`: role "${rec.role}" must be one of master | embedded_master | contributor | consumer | derived` });
    }
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
  const { nodes, edges, dotted } = parseMermaid(mermaidBlock(text));
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    nodeIds.add(n.id);
    if (!registry.has(n.id)) {
      // A platform built-in (`users`) may be drawn without a §3 row, as §5.2 edges may name it.
      if (!BUILTINS.has(n.id)) issues.push({ check: "mermaid ⟺ §3", detail: `mermaid node \`${n.id}\` is not an entity in §3` });
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
      if (from && to && /^`.*`$/.test(verb)) {
        issues.push({ check: "§5 verb", detail: `§5 edge \`${from}\` → \`${to}\`: the verb cell ${verb} must be plain text, not backticked (the diagram label carries no backticks)` });
      }
      if (from && to) fiveEdges.push({ from, to, verb: verb.replace(/^`(.*)`$/, "$1") });
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

  // §3 optional `**Key types:**` sub-block. Each row names a §3 entity this module provisions
  // (master / embedded_master); typeid and is_a rows carry a well-formed, unique prefix; other
  // types carry `-`; is_a / has_a rows name the §3 entity they are based on.
  const keys = new Map<string, KeyInfo>();
  const seen = new Map<string, string>();
  for (const r of parseBlueprintKeyTypes(s3) ?? []) {
    if (!registry.has(r.id)) {
      issues.push({ check: "§3 Key types ⟺ §3", detail: `**Key types:** row \`${r.id}\` is not a §3 entity` });
    } else if (!/^(master|embedded_master)$/.test(registry.get(r.id)!.role)) {
      issues.push({ check: "§3 Key types ⟺ §3", detail: `**Key types:** row \`${r.id}\` is ${registry.get(r.id)!.role}; only entities this module provisions (master / embedded_master) are listed, the others keep their owner's key` });
    }
    issues.push(...checkKey("§3 Key types", r.id, r.type, r.prefix, seen));
    keys.set(r.id, { type: r.type, basedOn: r.basedOn });
  }
  // A base's key type is decided here only when this module provisions it (no row = auto_increment).
  const provisioned = (id: string) => /^(master|embedded_master)$/.test(registry.get(id)?.role ?? "");
  issues.push(...checkFamilies("§3 Key types", keys, (id) => registry.has(id), provisioned));
  // Dotted mermaid edges ⟺ the family links (they are not §5 rows).
  issues.push(...checkDottedEdges(familyEdges(keys), dotted, "§3 Key types row"));
  // A §7 lifecycle sits on the base or on its kinds, never on both: the state field would repeat (90243).
  const lifecycles = new Set(lines.map((l) => l.match(/^###\s+`([a-z][a-z0-9_]*)`\s*\(/)?.[1]).filter(Boolean) as string[]);
  for (const [id, k] of keys) {
    if (!BASED_KEY_TYPES.has(k.type) || !lifecycles.has(id)) continue;
    const seenUp = new Set<string>([id]);
    for (let up = k.basedOn; up && !seenUp.has(up); up = BASED_KEY_TYPES.has(keys.get(up)?.type ?? "") ? keys.get(up)!.basedOn : "") {
      seenUp.add(up);
      if (lifecycles.has(up)) issues.push({ check: "family", detail: `§7 has a lifecycle for both \`${id}\` and its base \`${up}\`; put it on one of them (the state field cannot repeat across a family)` });
    }
  }

  return issues;
}

// ---------- SPEC checks ----------

type SpecField = { name: string; format: string; description: string; notes: string };
type SpecEntity = {
  keyType: string | null;      // `**Key type:**` (null = line absent = auto_increment)
  keyPrefix: string | null;    // `**Key prefix:**`
  basedOn: string;             // `**Based on:**` (backticks stripped; "" = absent)
  lines: Set<string>;          // which `**Key:**` lines the block carries (e.g. "Label column")
  reconciliation: string;      // `**Reconciliation:**` ("" = absent = create-new)
  fields: SpecField[];
};

/** Every `### 3.N \`table\`` block of a spec: its key lines and its Fields table. */
function parseSpecEntities(lines: string[]): Map<string, SpecEntity> {
  const out = new Map<string, SpecEntity>();
  let cur: SpecEntity | null = null;
  let inFence = false;
  for (const l of topSection(lines, 3)) {
    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = l.match(/^###\s+3\.\d+\s+`([^`]+)`/);
    if (h) {
      cur = { keyType: null, keyPrefix: null, basedOn: "", lines: new Set(), reconciliation: "", fields: [] };
      out.set(h[1].trim(), cur);
      continue;
    }
    if (!cur) continue;
    const kv = l.match(/^\*\*([^*:]+):\*\*\s*(.*?)\s*$/);
    if (kv) {
      const [, key, value] = kv;
      cur.lines.add(key.trim());
      if (key === "Key type") cur.keyType = value;
      else if (key === "Key prefix") cur.keyPrefix = value;
      else if (key === "Based on") cur.basedOn = value.replace(/`/g, "").trim();
      else if (key === "Reconciliation") cur.reconciliation = value;
      continue;
    }
    if (!isTableRow(l) || isSeparatorRow(l)) continue;
    const row = cells(l);
    const name = firstBacktick(row[0] || "");
    const format = firstBacktick(row[1] || "");
    if (!name || !format) continue; // header row
    cur.fields.push({ name, format, description: row[4] || "", notes: row[5] || "" });
  }
  return out;
}

/** `enum_values:` tokens and the `default:` value of a Notes cell. */
function parseEnumNotes(notes: string): { values: string[] | null; def: string | null } {
  const ev = notes.match(/enum_values:\s*([^;]*)/);
  const values = ev ? [...ev[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : null;
  const dm = notes.match(/\bdefault:\s*"([^"]*)"/);
  return { values, def: dm ? dm[1] : null };
}

/**
 * §5 blocks: ``### `table.field` `` then one bullet per entry, `` - `value` `` or
 * `` - `value` - Label `` (a label only when the value is a code). Returns value lists and
 * any line that breaks the bullet grammar.
 */
function parseSpecEnums(lines: string[]): { blocks: Map<string, string[]>; bad: string[] } {
  const blocks = new Map<string, string[]>();
  const bad: string[] = [];
  let cur: string[] | null = null;
  let key = "";
  for (const l of topSection(lines, 5)) {
    const h = l.match(/^###\s+(?:5\.\d+\s+)?`([^`]+)`/);
    if (h) { key = h[1].trim(); cur = []; blocks.set(key, cur); continue; }
    if (/^#/.test(l)) { cur = null; continue; }
    if (!cur || !l.trim()) continue;
    const b = l.match(/^- `([^`]+)`(?: - (\S.*))?$/);
    if (b) cur.push(b[1]);
    else bad.push(`\`${key}\`: "${l.trim()}"`);
  }
  return { blocks, bad };
}

/** The `_process_gates_` table under §9 (living-mode RACI plan): the entity of each gate. */
function parseProcessGateEntities(lines: string[]): string[] {
  const start = lines.findIndex((l) => /^_process_gates_\s*$/.test(l.trim()));
  if (start < 0) return [];
  const block: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (isTableRow(l)) block.push(l);
    else if (block.length) break;
  }
  return tableRows(block)
    .filter((row) => (row[0] || "").toLowerCase() !== "process_key")
    .map((row) => (row[1] || "").replace(/`/g, "").trim())
    .filter(Boolean);
}

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

  // §3 sub-section headings: ### 3.N `table` - Singular (canonical separator is the
  // plain hyphen; the en/em-dash alternatives are accepted for pre-5.4 files only).
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

  // §5 enum headings: unnumbered ``### `table.field` `` (template v5.4+) or the legacy
  // numbered ``### 5.N `table.field` ``. Scoped to the §5 body so a backticked
  // `x.y` heading elsewhere is never mistaken for an enum block.
  for (const l of topSection(lines, 5)) {
    const m = l.match(/^###\s+(?:5\.\d+\s+)?`([^.`]+)\.[^`]+`/);
    if (m && !known(m[1])) issues.push({ check: "§5 ⟺ entities", detail: `§5 enumeration is declared on \`${m[1]}\` which is not a declared entity` });
  }

  // §6 Outbound handoffs: the `payload` cell names an entity this spec owns
  // (Inbound rows name the SOURCE module's entity, so they are not checked).
  // Columns: source module | target domain | target module | trigger_event | transition | payload | ...
  for (const row of tableRows(subSection(topSection(lines, 6), /^###\s+Outbound handoffs\b/))) {
    const id = firstBacktick(row[5] || "");
    if (id && !known(id)) issues.push({ check: "§6 handoffs ⟺ entities", detail: `§6 Outbound handoff payload \`${id}\` is not a declared entity` });
  }

  // §8.2 business rules data_object resolves. The spec numbers `## 8.1` / `## 8.2` as
  // sibling H2s (no `## 8.` parent), so address `## 8.2` directly: topSection(8) would
  // stop at `## 8.2` and return §8.1's body.
  for (const row of tableRows(subSection(lines, /^##\s+8\.2\b/))) {
    const id = firstBacktick(row[1] || "");
    if (id && !known(id)) issues.push({ check: "§8.2 ⟺ entities", detail: `§8.2 references \`${id}\` which is not a declared entity` });
  }

  // mermaid edge endpoints resolve
  const { edges, dotted } = parseMermaid(mermaidBlock(text));
  for (const e of [...edges, ...dotted]) {
    for (const ep of [e.from, e.to]) {
      if (!known(ep)) issues.push({ check: "mermaid ⟺ entities", detail: `mermaid references \`${ep}\` which is not a declared entity` });
    }
  }

  // mermaid edges ⟺ §3 relationship_label + §4 cardinality (direction/verb must be DERIVED, never hand-authored),
  // and dotted edges ⟺ §3 `**Based on:**`
  issues.push(...checkSpecMermaidAgainstSource(lines, text, fm));

  const ents = parseSpecEntities(lines);

  // §3 `**Key type:**` / `**Key prefix:**` lines (optional; absent = auto_increment): valid type,
  // prefix exactly with typeid / is_a, well-formed and unique across the spec's entities.
  {
    const seen = new Map<string, string>();
    for (const [id, e] of ents) {
      if (e.keyType === null && e.keyPrefix === null) continue;
      issues.push(...checkKey("§3", id, e.keyType || "(prefix without a key type)", e.keyPrefix ?? "", seen));
    }
  }

  // Families: `**Based on:**` rules. A base's key type is decided here unless it is reused from
  // its owner (or a built-in); then the analyst verified it against the live catalog.
  const keys = specKeys(ents);
  const decidedHere = (id: string) => ents.has(id) && !BUILTINS.has(id) && !/^(reuse-from|dropped)\b/.test(ents.get(id)!.reconciliation);
  issues.push(...checkFamilies("§3", keys, known, decidedHere));
  const basedIds = [...keys].filter(([, k]) => BASED_KEY_TYPES.has(k.type)).map(([id]) => id);
  for (const id of basedIds) {
    const e = ents.get(id)!;
    for (const line of ["Label column", "Label parent", "Order column"]) {
      if (e.lines.has(line)) issues.push({ check: "family", detail: `§3 \`${id}\` is based on \`${keys.get(id)!.basedOn}\` and takes its label from it; drop the \`**${line}:**\` line` });
    }
    // A field name may not repeat one of an ancestor's (siblings may share names).
    const own = new Set(e.fields.map((f) => f.name));
    const chain = new Set<string>([id]);
    for (let base = keys.get(id)!.basedOn; base && ents.has(base) && !chain.has(base); base = BASED_KEY_TYPES.has(keys.get(base)?.type ?? "") ? keys.get(base)!.basedOn : "") {
      chain.add(base);
      for (const f of ents.get(base)!.fields) {
        if (own.has(f.name)) issues.push({ check: "family", detail: `§3 \`${id}\` repeats field \`${f.name}\` of its base \`${base}\`; a based entity lists only its own fields` });
      }
    }
  }
  // An is_a entity's references cannot cascade on delete (platform 90249); use restrict or clear.
  for (const r of parseSpecRelationshipRows(lines)) {
    if (keys.get(r.from)?.type === "is_a" && /^cascade$/i.test(r.del)) {
      issues.push({ check: "family", detail: `§4 \`${r.from}\`.\`${r.field}\` → \`${r.to}\`: \`${r.from}\` is an is_a entity, so its delete behavior cannot be cascade (use restrict or clear)` });
    }
  }
  // RACI process gates are not available on based entities (platform 90249).
  for (const ent of parseProcessGateEntities(lines)) {
    if (basedIds.includes(ent)) issues.push({ check: "family", detail: `§9 _process_gates_ names \`${ent}\`, an ${keys.get(ent)!.type} entity; process gates are not available on based entities` });
  }
  // `<table>_ext` is the platform's storage table of a based entity, so no entity may end in `_ext`.
  for (const id of allIds) {
    if (/_ext$/.test(id)) issues.push({ check: "data_object name", detail: `entity \`${id}\` ends in \`_ext\`, which the platform reserves for the storage table of an is_a / has_a entity` });
  }

  // Enumerations: §5 bullet grammar; the Notes `enum_values:` equal the §5 values; `default:` is a value.
  {
    const { blocks, bad } = parseSpecEnums(lines);
    for (const b of bad) issues.push({ check: "§5 enum entries", detail: `${b} must be "- \`value\`" or "- \`value\` - Label"` });
    for (const [id, e] of ents) {
      for (const f of e.fields) {
        if (f.format !== "enum") continue;
        const { values, def } = parseEnumNotes(f.notes);
        const five = blocks.get(`${id}.${f.name}`);
        if (values && five) {
          const a = [...values].sort().join("\u0000"), b = [...five].sort().join("\u0000");
          if (a !== b) issues.push({ check: "§3 enum_values ⟺ §5", detail: `\`${id}.${f.name}\`: Notes enum_values [${values.join(", ")}] differ from §5 [${five.join(", ")}] (both hold values, never labels)` });
        }
        const allowed = values ?? five;
        if (def !== null && allowed && !allowed.includes(def)) {
          issues.push({ check: "enum default", detail: `\`${id}.${f.name}\`: default "${def}" is not one of its values [${allowed.join(", ")}] (a default is always a value, never a label)` });
        }
      }
    }
  }

  // Keep each fact once (warnings only; the analyst's Stage 4 N-checks decide).
  for (const [id, e] of ents) {
    const names = new Set(e.fields.map((f) => f.name));
    const refs = new Set(e.fields.filter((f) => f.format === "reference" || f.format === "parent").map((f) => f.name));
    for (const f of e.fields) {
      const n1 = f.name.match(/^(.+)_name$/);
      if (n1 && refs.has(`${n1[1]}_id`) && !/\bas of\b/i.test(f.description)) {
        issues.push({ check: "keep each fact once", warn: true, detail: `N1 \`${id}.${f.name}\` copies data of the entity \`${n1[1]}_id\` references; drop it, or describe it "as of <event>" if it is a snapshot` });
      }
      const n2 = f.name.match(/^(.+)_(\d+)$/);
      if (n2 && [...names].some((o) => o !== f.name && o.startsWith(`${n2[1]}_`) && /^\d+$/.test(o.slice(n2[1].length + 1)))) {
        issues.push({ check: "keep each fact once", warn: true, detail: `N2 \`${id}.${f.name}\` is a numbered repeat; a list inside a record belongs in a child entity` });
      }
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

// ---------- SPEC mermaid generation (derive §2 from §3 + §4, never hand-author) ----------

/**
 * Parse every §3.N field-level relationship annotation into a
 * "<table>\u0000<field>" -> relationship_label map. This is the ONLY place
 * verb text is allowed to come from; §4 carries structure (From/To/Cardinality/
 * Kind), never the verb.
 */
function parseSpecRelationshipLabels(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let currentTable: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+3\.\d+\s+`([^`]+)`/);
    if (h) { currentTable = h[1].trim(); continue; }
    if (/^##\s/.test(lines[i]) && !/^###/.test(lines[i])) currentTable = null; // left §3 entirely
    if (!currentTable || !isTableRow(lines[i]) || isSeparatorRow(lines[i])) continue;
    const row = cells(lines[i]);
    const field = firstBacktick(row[0] || "");
    const format = firstBacktick(row[1] || "");
    if (!field || (format !== "reference" && format !== "parent")) continue;
    const note = row[5] || "";
    const vm = note.match(/relationship_label:\s*"([^"]*)"/);
    if (vm) out.set(`${currentTable}\u0000${field}`, vm[1]);
  }
  return out;
}

/** §4 relationship summary rows as structured records (From/Field/To/Cardinality/Kind/fk_format/Delete behavior). */
function parseSpecRelationshipRows(lines: string[]): { from: string; field: string; to: string; cardinality: string; kind: string; del: string }[] {
  const out: { from: string; field: string; to: string; cardinality: string; kind: string; del: string }[] = [];
  for (const row of tableRows(topSection(lines, 4))) {
    const from = firstBacktick(row[0] || "");
    const field = firstBacktick(row[1] || "") || (row[1] || "").trim();
    const to = firstBacktick(row[2] || "");
    const cardinality = (row[3] || "").trim();
    const kind = (row[4] || "").trim();
    const del = (row[6] || "").replace(/`/g, "").trim();
    if (from && to) out.push({ from, field, to, cardinality, kind, del });
  }
  return out;
}

/** Each §3 entity's key type ("" = auto_increment) and `**Based on:**` base. */
function specKeys(ents: Map<string, SpecEntity>): Map<string, KeyInfo> {
  const keys = new Map<string, KeyInfo>();
  for (const [id, e] of ents) keys.set(id, { type: e.keyType ?? "", basedOn: e.basedOn });
  return keys;
}

/** Per-entity `**Reconciliation:**` line under each §3.N heading, for the `master` classDef. */
function parseSpecReconciliation(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let currentTable: string | null = null;
  for (const l of lines) {
    const h = l.match(/^###\s+3\.\d+\s+`([^`]+)`/);
    if (h) { currentTable = h[1].trim(); continue; }
    if (/^##\s/.test(l) && !/^###/.test(l)) currentTable = null;
    const rm = l.match(/^\*\*Reconciliation:\*\*\s*(.+?)\s*$/);
    if (rm && currentTable) out.set(currentTable, rm[1].trim());
  }
  return out;
}

/**
 * Deterministically derive the §2 mermaid block from §3 (relationship_label,
 * Reconciliation) + §4 (From/Field/To/Cardinality/Kind) + frontmatter entities.
 * This exists so §2 is never hand-authored / freely re-generated: the model
 * fills §3 and §4 first (already fully resolved by that point in reconciliation),
 * then this function's output is pasted into §2 verbatim.
 *
 * Direction rule (matches semantic-spec-template.md's cardinality convention:
 * arrows run parent[one-side] -> child[many-side]):
 *   Cardinality "N:1"  -> From is the many-side, To is the one-side/parent: emit `To --> From`.
 *   Cardinality "1:N"  -> From is the one-side/parent: emit `From --> To`.
 *   Cardinality "1:1"  -> flat connector: emit `From --- To`.
 * Verb rule: an FK leg carries its §3 `relationship_label` as the edge verb
 * whenever one is declared, and is drawn as a bare arrow when none is. This is
 * uniform across Kind: a `reference` leg carries its verb; a junction leg
 * carries the verb of the M:N relationship it decomposes (Stage 4 stamps that
 * verb onto the leg pointing back to the M:N source entity, so `A covers B`
 * survives as `A -->|covers| junction` and is not lost on decomposition). Legs
 * with no declared `relationship_label` — the non-subject junction leg and plain
 * master-detail ownership `parent` links — stay bare. This keeps the diagram
 * byte-for-byte consistent with the §3 `relationship_label` annotations (stage-4
 * "Set relationship_label for every FK field"), instead of silently dropping a
 * verb the field actually declares.
 */
function emitSpecMermaid(lines: string[], fm: ReturnType<typeof frontmatter>): string {
  const relLabels = parseSpecRelationshipLabels(lines);
  const rows = parseSpecRelationshipRows(lines);
  const reconciliation = parseSpecReconciliation(lines);
  // Family edges (`**Based on:**`), drawn dotted from the based entity to its base after the
  // relationship edges: `emails -.->|is a kind of| activities`, `customers -.->|extends| business_partners`.
  const family = familyEdges(specKeys(parseSpecEntities(lines)));

  const s2 = topSection(lines, 2);
  const s2ids: string[] = [];
  for (const row of tableRows(s2)) {
    if (!/^\d+$/.test(row[0] || "")) continue;
    const id = firstBacktick(row[1] || "");
    if (id) s2ids.push(id);
  }
  const orderedEntities = fm.entities.length ? fm.entities : s2ids;

  const edgeLines: string[] = [];
  const referenced = new Set<string>();
  for (const row of rows) {
    referenced.add(row.from);
    referenced.add(row.to);
    const verb = relLabels.get(`${row.from}\u0000${row.field}`) ?? null;
    if (/^1:1$/i.test(row.cardinality)) {
      edgeLines.push(verb ? `    ${row.from} ---|${verb}| ${row.to}` : `    ${row.from} --- ${row.to}`);
    } else if (/^1:n$/i.test(row.cardinality)) {
      edgeLines.push(verb ? `    ${row.from} -->|${verb}| ${row.to}` : `    ${row.from} --> ${row.to}`);
    } else {
      // default / "N:1": To is the parent (one-side), From is the child (many-side).
      edgeLines.push(verb ? `    ${row.to} -->|${verb}| ${row.from}` : `    ${row.to} --> ${row.from}`);
    }
  }
  for (const e of family) {
    referenced.add(e.from);
    referenced.add(e.to);
    edgeLines.push(`    ${e.from} -.->|${e.verb}| ${e.to}`);
  }

  const standaloneLines = orderedEntities
    .filter((id) => !referenced.has(id))
    .map((id) => `    ${id};`);

  const builtinIds = orderedEntities.filter((id) => BUILTINS.has(id) && referenced.has(id));
  const masterIds = orderedEntities.filter((id) => {
    if (BUILTINS.has(id) || !referenced.has(id)) return false;
    const r = reconciliation.get(id) || "";
    return /^reuse-from\b/.test(r) || /^promote-to-master\b/.test(r);
  });

  const out: string[] = ["```mermaid", "flowchart LR"];
  if (builtinIds.length) out.push("    classDef builtin fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#1a4d2e;");
  if (masterIds.length) out.push("    classDef master fill:#d4f4dd,stroke:#27ae60,color:#1a4d2e;");
  out.push(...edgeLines, ...standaloneLines);
  for (const id of builtinIds) out.push(`    class ${id} builtin;`);
  for (const id of masterIds) out.push(`    class ${id} master;`);
  out.push("```");
  return out.join("\n");
}

// ---------- SPEC checks: mermaid ⟺ §3/§4 (the check checkBlueprint has always had) ----------

/**
 * The gap this closes: checkSpec previously only verified mermaid edge
 * ENDPOINTS resolve to declared entities — never that an edge's direction or
 * verb agrees with §3's relationship_label / §4's cardinality. That blind spot
 * let a spec ship with §3 declaring relationship_label: "owns" while §2 drew
 * the edge reversed with the verb "owned by" — self-contradictory within one
 * file, undetected. This regenerates the canonical diagram from §3/§4 and
 * diffs it edge-for-edge against what's actually in §2.
 */
function checkSpecMermaidAgainstSource(lines: string[], text: string, fm: ReturnType<typeof frontmatter>): Issue[] {
  const issues: Issue[] = [];
  const canonical = emitSpecMermaid(lines, fm);
  const { edges: wantEdges, dotted: wantDotted } = parseMermaid(mermaidBlock(canonical));
  const { edges: gotEdges, dotted: gotDotted } = parseMermaid(mermaidBlock(text));
  issues.push(...checkDottedEdges(wantDotted, gotDotted, "§3 `**Based on:**` line"));

  const rows = parseSpecRelationshipRows(lines);
  if (rows.length === 0) return issues; // no §4 rows to derive from; nothing to check

  const edgeKey = (e: MEdge) => `${e.from} |${(e.verb ?? "").trim()}| ${e.to}`;
  const wantSet = new Set(wantEdges.map(edgeKey));
  const gotSet = new Set(gotEdges.map(edgeKey));

  for (const e of gotEdges) {
    if (!wantSet.has(edgeKey(e))) {
      issues.push({
        check: "mermaid ⟺ §3/§4 (derived)",
        detail: `§2 diagram edge \`${e.from}\` -|${e.verb ?? ""}|-> \`${e.to}\` does not match what §3 (relationship_label) + §4 (cardinality) derive. Direction and/or verb has drifted from source — regenerate §2 from §3/§4, do not hand-edit it.`,
      });
    }
  }
  for (const e of wantEdges) {
    if (!gotSet.has(edgeKey(e))) {
      issues.push({
        check: "mermaid ⟺ §3/§4 (derived)",
        detail: `§3/§4 imply the edge \`${e.from}\` -|${e.verb ?? ""}|-> \`${e.to}\` but §2 is missing it or has it drawn differently. Regenerate §2 from §3/§4.`,
      });
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

/**
 * `--emit-mermaid <file.md>`:
 * - On a spec, derives the §2 mermaid block from that file's §3 (relationship_label,
 *   `**Based on:**`) + §4 (From/Field/To/Cardinality/Kind) and prints it to stdout.
 *   Analyst usage: write frontmatter + §3 + §4 first (already fully resolved by
 *   that point in reconciliation), run this, paste the output as §2 verbatim.
 *   Never hand-author §2 — that's exactly the drift this whole file exists to
 *   prevent.
 * - On a blueprint, prints only the dotted family edges its §3 `**Key types:**`
 *   rows imply (the rest of a blueprint diagram is authored from §5). Paste them
 *   into the §2 diagram after the relationship edges.
 */
function emitMermaidMode(path: string) {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const fm = frontmatter(text);
  const artifact = fm.get("artifact");
  if (artifact === "semantic-blueprint") {
    const keys = new Map<string, KeyInfo>();
    for (const r of parseBlueprintKeyTypes(topSection(lines, 3)) ?? []) keys.set(r.id, { type: r.type, basedOn: r.basedOn });
    for (const e of familyEdges(keys)) console.log(`  ${e.from} -.->|"${e.verb}"| ${e.to}`);
    return;
  }
  if (artifact !== "semantic-spec") {
    console.error(`--emit-mermaid supports semantic-spec and semantic-blueprint files (got "${artifact ?? "(unknown)"}")`);
    process.exit(2);
  }
  console.log(emitSpecMermaid(lines, fm));
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--emit-mermaid") {
    if (!args[1]) {
      console.error("usage: bun consistency-check.ts --emit-mermaid <file.md>");
      process.exit(2);
    }
    emitMermaidMode(args[1]);
    return;
  }
  const files = args;
  if (files.length === 0) {
    console.error("usage: bun consistency-check.ts <file.md> [<file2.md> ...]\n       bun consistency-check.ts --emit-mermaid <file.md>");
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
    const errors = res.issues.filter((i) => !i.warn);
    const warnings = res.issues.filter((i) => i.warn);
    const print = (list: Issue[], mark: string) => {
      const byCheck = new Map<string, string[]>();
      for (const i of list) {
        if (!byCheck.has(i.check)) byCheck.set(i.check, []);
        byCheck.get(i.check)!.push(i.detail);
      }
      for (const [check, details] of byCheck) {
        console.log(`  ${mark} ${check}`);
        for (const d of details) console.log(`      - ${d}`);
      }
    };
    if (errors.length === 0) {
      console.log("  ✓ consistent — every entity name, identifier, label, and edge agrees across all sections");
    } else {
      failed++;
      print(errors, "✗");
    }
    print(warnings, "⚠");
  }
  console.log(`\n${failed === 0 ? "RESULT: all files consistent" : `RESULT: ${failed} file(s) with inconsistencies`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
