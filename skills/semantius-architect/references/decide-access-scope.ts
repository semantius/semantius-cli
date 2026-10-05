#!/usr/bin/env bun
/**
 * decide-access-scope.ts — decides a module's access level (`access_scope`) for
 * `semantius-architect`. Deterministic: the same facts always give the same
 * result. The architect runs it, asks only when the output carries `ask`, and
 * stamps the result into the blueprint frontmatter.
 *
 * It reads the live state itself (read-only, two `read_module` calls); the model
 * never passes live state in.
 *
 * Usage:
 *   bun decide-access-scope.ts --slug <system_slug> --flow plan|expert|fast
 *       ( --has-reference-data-entities yes|no --has-process-gate yes|no  |  --blueprint <path> )
 *       [--requested-level basic|advanced|gated|raci] [--keep-custom yes|no]
 *       [--answer basic|advanced|gated|raci]
 *
 * Output (stdout): one JSON object
 *   { access_scope, ask, reason, facts }
 *   ask = null | { kind: "keep_or_replace" | "level", options: [...], recommended: <value> | null }
 *   While `ask` is set, `access_scope` is null.
 *
 * Exit codes:
 *   0  decided, or a question is pending
 *   1  a live read failed
 *   2  usage error (an unknown flag or value, `--answer` not in `options`,
 *      `--keep-custom` while the module is not `custom`, `--blueprint` plus the two flags)
 *
 * `--from-fixture <file.json>` is for tests only: it replaces both live reads with
 * `{ "live_raci": boolean, "current_access_scope": "none" | "custom" | "basic" | "advanced" | "gated" | "raci" }`.
 */

import { readFileSync } from "node:fs";

const LEVELS = ["basic", "advanced", "gated", "raci"] as const;
type Level = (typeof LEVELS)[number];
type Scope = "custom" | Level;
type Flow = "plan" | "expert" | "fast";
type Current = Scope | "none";

type Facts = {
  has_reference_data_entities: boolean;
  has_process_gate: boolean;
  live_raci: boolean;
  flow: Flow;
  current_access_scope: Current;
  requested_level: Level | null;
};

type Ask = { kind: "keep_or_replace" | "level"; options: string[]; recommended: string | null };
type Decision = { access_scope: Scope | null; ask: Ask | null; reason: string };

class UsageError extends Error {}
class LiveReadError extends Error {}

const rank = (l: Level): number => LEVELS.indexOf(l);
const higher = (a: Level, b: Level): Level => (rank(a) >= rank(b) ? a : b);
const isLevel = (v: string): v is Level => (LEVELS as readonly string[]).includes(v);

// ---------- arguments ----------

const FLAGS = new Set([
  "--slug", "--flow", "--has-reference-data-entities", "--has-process-gate", "--blueprint",
  "--requested-level", "--keep-custom", "--answer", "--from-fixture",
]);

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) throw new UsageError(`unknown argument "${flag}"`);
    const value = argv[i + 1];
    if (value === undefined || FLAGS.has(value)) throw new UsageError(`${flag} needs a value`);
    if (out.has(flag)) throw new UsageError(`${flag} given twice`);
    out.set(flag, value);
    i++;
  }
  return out;
}

function yesNo(flag: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "yes") return true;
  if (value === "no") return false;
  throw new UsageError(`${flag} must be yes or no (got "${value}")`);
}

// ---------- blueprint parsing (by header name) ----------

const BUILTINS = new Set(["users", "roles", "permissions"]);

function cells(line: string): string[] {
  let parts = line.split("|");
  if (parts.length && parts[0].trim() === "") parts = parts.slice(1);
  if (parts.length && parts[parts.length - 1].trim() === "") parts = parts.slice(0, -1);
  return parts.map((s) => s.trim());
}
const isTableRow = (line: string): boolean => /^\s*\|/.test(line);
const isSeparatorRow = (line: string): boolean => {
  const cs = cells(line);
  return cs.length > 0 && cs.every((c) => /^:?-{2,}:?$/.test(c));
};
const bare = (s: string): string => s.replace(/`/g, "").replace(/\*/g, "").trim();
const headerNames = (row: string[]): string[] => row.map((c) => bare(c).toLowerCase());

/** Lines of the top-level section "## N." up to the next "## " heading. */
function topSection(lines: string[], n: number): string[] {
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${n}\\.`).test(l));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** Lines of a "### N.M" subsection up to the next "### " or "## " heading. */
function subSection(lines: string[], re: RegExp): string[] {
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###?\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/**
 * Every table row of a block, each paired with the header of the table it belongs
 * to (the header is the first row after a non-table line).
 */
function rowsWithHeaders(block: string[]): { header: string[]; row: string[] }[] {
  const out: { header: string[]; row: string[] }[] = [];
  let header: string[] | null = null;
  for (const line of block) {
    if (!isTableRow(line)) { header = null; continue; }
    if (isSeparatorRow(line)) continue;
    const row = cells(line);
    if (header === null) { header = headerNames(row); continue; }
    out.push({ header, row });
  }
  return out;
}

const cell = (header: string[], row: string[], name: string): string => {
  const i = header.indexOf(name);
  return i >= 0 ? bare(row[i] ?? "") : "";
};

function blueprintFacts(path: string): { hasReferenceDataEntities: boolean; hasProcessGate: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read --blueprint ${path}: ${(err as Error).message}`);
  }
  // Normalize BOM + CRLF/CR, as consistency-check.ts does.
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");

  // §3: an entity this module provisions (master / embedded_master), entity_type catalog, not a built-in.
  let hasReferenceDataEntities = false;
  for (const { header, row } of rowsWithHeaders(topSection(lines, 3))) {
    if (!header.includes("data_object") || !header.includes("entity_type") || !header.includes("role")) continue;
    const id = cell(header, row, "data_object");
    const role = cell(header, row, "role");
    const type = cell(header, row, "entity_type");
    if (type === "catalog" && (role === "master" || role === "embedded_master") && !BUILTINS.has(id)) {
      hasReferenceDataEntities = true;
    }
  }

  // §7: any row with requires_permission? ✓.
  let hasProcessGate = false;
  for (const { header, row } of rowsWithHeaders(topSection(lines, 7))) {
    if (header.includes("requires_permission?") && cell(header, row, "requires_permission?").includes("✓")) {
      hasProcessGate = true;
    }
  }
  // §8.1: any workflow-gate (lifecycle) row.
  const s8 = topSection(lines, 8);
  for (const { header, row } of rowsWithHeaders(subSection(s8, /^###\s+8\.1\b/))) {
    if (header.includes("tier") && cell(header, row, "tier").startsWith("workflow-gate (lifecycle)")) {
      hasProcessGate = true;
    }
  }
  // §8.2: any rule with source flag `create`.
  for (const { header, row } of rowsWithHeaders(subSection(s8, /^###\s+8\.2\b/))) {
    if (header.includes("source flag") && cell(header, row, "source flag") === "create") {
      hasProcessGate = true;
    }
  }
  return { hasReferenceDataEntities, hasProcessGate };
}

// ---------- live reads ----------

async function readModules(args: Record<string, unknown>): Promise<any[]> {
  let proc;
  try {
    proc = Bun.spawn(["semantius", "call", "crud", "read_module", JSON.stringify(args)], {
      stdout: "pipe", stderr: "pipe",
    });
  } catch (err) {
    throw new LiveReadError(`cannot run the semantius CLI: ${(err as Error).message}`);
  }
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new LiveReadError(`read_module failed (exit ${code}): ${err.trim()}`);
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new LiveReadError(`read_module returned output that is not JSON: ${trimmed.slice(0, 200)}`);
  }
}

const CURRENT_VALUES = new Set(["none", "custom", ...LEVELS]);

async function liveState(slug: string, fixturePath: string | undefined): Promise<{ liveRaci: boolean; current: Current }> {
  if (fixturePath !== undefined) {
    let fx: any;
    try {
      fx = JSON.parse(readFileSync(fixturePath, "utf8"));
    } catch (err) {
      throw new UsageError(`cannot read --from-fixture ${fixturePath}: ${(err as Error).message}`);
    }
    if (typeof fx.live_raci !== "boolean" || !CURRENT_VALUES.has(fx.current_access_scope)) {
      throw new UsageError(`--from-fixture needs { "live_raci": boolean, "current_access_scope": none|custom|basic|advanced|gated|raci }`);
    }
    return { liveRaci: fx.live_raci, current: fx.current_access_scope };
  }
  const others = await readModules({ filters: `access_scope=eq.raci&module_slug=neq.${slug}`, select: "module_slug" });
  const self = await readModules({ filters: `module_slug=eq.${slug}`, select: "access_scope" });
  let current: Current = "none";
  if (self.length > 0) {
    const value = self[0]?.access_scope;
    if (typeof value !== "string" || !CURRENT_VALUES.has(value) || value === "none") {
      throw new LiveReadError(`module ${slug} has an unexpected access_scope value: ${JSON.stringify(value)}`);
    }
    current = value as Current;
  }
  return { liveRaci: others.length > 0, current };
}

// ---------- decision ----------

const minimum = (f: Facts): Level =>
  f.has_process_gate ? "gated" : f.has_reference_data_entities ? "advanced" : "basic";

/** The new-module table. */
function decideNew(f: Facts): Decision {
  if (!f.has_process_gate) {
    const level: Level = f.has_reference_data_entities ? "advanced" : "basic";
    if (f.flow === "expert") {
      return { access_scope: null, ask: { kind: "level", options: ["basic", "advanced"], recommended: level },
        reason: "The design has no process gates; in expert flow the user chooses the access level." };
    }
    return { access_scope: level, ask: null,
      reason: f.has_reference_data_entities
        ? "The design has no process gates and has reference data entities, so it needs an admin level."
        : "The design has no process gates and no reference data entities." };
  }
  if (f.flow === "plan") {
    return f.live_raci
      ? { access_scope: "raci", ask: null, reason: "The design has process gates and another module already uses raci." }
      : { access_scope: "gated", ask: null, reason: "The design has process gates and no other module uses raci." };
  }
  if (f.flow === "fast") {
    return { access_scope: "gated", ask: null, reason: "The design has process gates; a fast-flow run never picks raci." };
  }
  return { access_scope: null, ask: { kind: "level", options: ["gated", "raci"], recommended: f.live_raci ? "raci" : "gated" },
    reason: "The design has process gates; in expert flow the user chooses who takes them." };
}

/** An existing module (current is a level): never lowered. */
function decideExisting(f: Facts, current: Level): Decision {
  if (f.flow !== "expert") {
    const result = higher(current, minimum(f));
    return { access_scope: result, ask: null,
      reason: `The module already uses ${current}; it is never lowered, and the design needs at least ${minimum(f)}.` };
  }
  const fresh = decideNew(f).ask!; // in expert flow the new-module table always asks
  const options = LEVELS.filter((l) => (fresh.options.includes(l) || l === current) && rank(l) >= rank(current));
  const recommended = higher(current, fresh.recommended as Level);
  if (options.length === 1) {
    return { access_scope: options[0], ask: null,
      reason: `The module already uses ${current}; no other access level is possible without lowering it.` };
  }
  return { access_scope: null, ask: { kind: "level", options: [...options], recommended },
    reason: `The module already uses ${current}; in expert flow the user chooses among the access levels that do not lower it.` };
}

/** A requested level raises the result (or the recommended option); a lower one is ignored. */
function applyRequested(f: Facts, d: Decision): Decision {
  if (!f.requested_level) return d;
  let req: Level = f.requested_level;
  if (f.flow === "fast" && req === "raci") req = "gated";
  if ((req === "gated" || req === "raci") && !f.has_process_gate) return d;
  if (d.ask) {
    if (d.ask.kind !== "level" || !d.ask.options.includes(req)) return d;
    if (rank(req) <= rank(d.ask.recommended as Level)) return d;
    return { ...d, ask: { ...d.ask, recommended: req }, reason: `${d.reason} The request asked for ${req}.` };
  }
  const result = d.access_scope as Level;
  if (rank(req) <= rank(result)) return d;
  return { ...d, access_scope: req, reason: `${d.reason} The request asked for ${req}.` };
}

function decide(f: Facts, keepCustom: boolean | undefined): Decision {
  let current = f.current_access_scope;
  if (current === "custom") {
    if (keepCustom === undefined) {
      return { access_scope: null, ask: { kind: "keep_or_replace", options: ["keep_custom", "replace"], recommended: null },
        reason: "The module's permissions were set up by hand." };
    }
    if (keepCustom) {
      return { access_scope: "custom", ask: null, reason: "The module's permissions were set up by hand and are kept." };
    }
    current = "none";
  } else if (keepCustom !== undefined) {
    throw new UsageError("--keep-custom is only valid when the module's access level is custom");
  }
  const base = current === "none" ? decideNew(f) : decideExisting(f, current as Level);
  return applyRequested(f, base);
}

function applyAnswer(d: Decision, answer: string | undefined): Decision {
  if (answer === undefined) return d;
  if (!d.ask || d.ask.kind !== "level" || !d.ask.options.includes(answer)) {
    throw new UsageError(`--answer ${answer} is not one of the options of a pending access-level question`);
  }
  return { access_scope: answer as Scope, ask: null, reason: `${d.reason} The user chose ${answer}.` };
}

// ---------- main ----------

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));

  const slug = args.get("--slug");
  if (!slug) throw new UsageError("--slug is required");
  const flow = args.get("--flow");
  if (flow !== "plan" && flow !== "expert" && flow !== "fast") {
    throw new UsageError(`--flow must be plan, expert or fast (got "${flow ?? ""}")`);
  }

  const blueprint = args.get("--blueprint");
  const refFlag = yesNo("--has-reference-data-entities", args.get("--has-reference-data-entities"));
  const gateFlag = yesNo("--has-process-gate", args.get("--has-process-gate"));
  let hasRef: boolean;
  let hasGate: boolean;
  if (blueprint !== undefined) {
    if (refFlag !== undefined || gateFlag !== undefined) {
      throw new UsageError("give either --blueprint or the two --has-* flags, not both");
    }
    const parsed = blueprintFacts(blueprint);
    hasRef = parsed.hasReferenceDataEntities;
    hasGate = parsed.hasProcessGate;
  } else {
    if (refFlag === undefined || gateFlag === undefined) {
      throw new UsageError("give --blueprint, or both --has-reference-data-entities and --has-process-gate");
    }
    hasRef = refFlag;
    hasGate = gateFlag;
  }

  const requested = args.get("--requested-level");
  if (requested !== undefined && !isLevel(requested)) {
    throw new UsageError(`--requested-level must be basic, advanced, gated or raci (got "${requested}")`);
  }
  const keepCustom = yesNo("--keep-custom", args.get("--keep-custom"));
  const answer = args.get("--answer");
  if (answer !== undefined && !isLevel(answer)) {
    throw new UsageError(`--answer must be basic, advanced, gated or raci (got "${answer}")`);
  }

  const live = await liveState(slug, args.get("--from-fixture"));

  const facts: Facts = {
    has_reference_data_entities: hasRef,
    has_process_gate: hasGate,
    live_raci: live.liveRaci,
    flow,
    current_access_scope: live.current,
    requested_level: (requested as Level | undefined) ?? null,
  };

  const decision = applyAnswer(decide(facts, keepCustom), answer);
  console.log(JSON.stringify({ access_scope: decision.access_scope, ask: decision.ask, reason: decision.reason, facts }, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError) {
      console.error(`usage error: ${err.message}`);
      process.exit(2);
    }
    console.error(err instanceof LiveReadError ? `live read failed: ${err.message}` : `error: ${(err as Error).message}`);
    process.exit(1);
  },
);
