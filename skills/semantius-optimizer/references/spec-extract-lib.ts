/**
 * spec-extract-lib.ts — deterministic reverse-engineer of a live Semantius module
 * into a `*-semantic-spec.md` (file format version "3.1").
 *
 * READ-ONLY against Semantius. Every read shells out via `Bun.spawn` with an
 * ARG ARRAY (bypasses the shell — inline JSON is safe on Windows and POSIX).
 *
 * Usage:  bun run spec-extract-lib.ts <module_slug> [outfile] [--force]
 *         bun run spec-extract-lib.ts --from-fixture <fixture.json> [outfile] [--force]
 *         bun run spec-extract-lib.ts <module_slug> --diagram
 *
 * `--diagram` prints only the §2 Mermaid block to stdout and writes no file. It is
 * cut from the same render as a full run, so it equals that run's §2 diagram.
 *
 * `--from-fixture` renders the same markdown from a JSON snapshot of the live
 * reads (shape documented at `loadLive()` / the round-trip eval under
 * `../evals/round-trip/`) without touching Semantius; it exists so the emitted
 * markdown can be diffed against the spec template byte-for-byte in CI.
 *
 * The mapping rules (and the Category-A / Category-B divergence taxonomy the
 * companion compare loop keys on) are documented in SKILL.md. This file is the
 * single deterministic source of the generated markdown so refinement cycles are
 * attributable.
 */

/** The file format version (the same in blueprint and spec files; changes only with the user's approval). */
const FORMAT_VERSION = "3.1";

/** Semantius platform built-ins — reused by the deployer, not owned by any module. */
const BUILTINS = new Set([
  "users", "roles", "permissions", "permission_hierarchy", "role_permissions",
  "user_roles", "webhook_receivers", "webhook_receiver_logs", "modules",
  "entities", "fields", "departments",
]);

// ---------------------------------------------------------------------------
// Entity ordering (canonical — shared with authored specs)
// ---------------------------------------------------------------------------

/** Tier by `entity_type`, then alphabetical by `table_name`. This is the ONE
 *  ordering key that exists identically on the spec and in live state, so the
 *  authored specs and this reverse pass produce the same
 *  order. NOT `created_at`, which is a deploy-time artifact with no modeling
 *  meaning. Reuse-from / built-in entities are appended last (see `main`). */
const ENTITY_TYPE_RANK: Record<string, number> = {
  catalog: 0,            // masters / lookups, referenced by everything -> first
  operational_record: 1,
  operational_workflow: 1,
  computed: 1,
  unclassified: 1,
  junction: 2,           // depends on its parents -> last among owned
};

const entityRank = (e: any): number =>
  e.entity_type in ENTITY_TYPE_RANK ? ENTITY_TYPE_RANK[e.entity_type] : 1;

/** Canonical entity sort: entity_type tier, then table_name A->Z. */
function sortEntities<T extends { entity_type?: string; table_name: string }>(entities: T[]): T[] {
  return [...entities].sort(
    (a, b) => entityRank(a) - entityRank(b) || a.table_name.localeCompare(b.table_name),
  );
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

async function read(tool: string, args: Record<string, unknown> = {}): Promise<any[]> {
  const proc = Bun.spawn(["semantius", "call", "crud", tool, JSON.stringify(args)], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`read ${tool} failed (exit ${code}): ${err}`);
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ---------------------------------------------------------------------------
// Field mapping helpers
// ---------------------------------------------------------------------------

const isStripped = (f: any): boolean =>
  f.ctype === "id" || f.ctype === "audit" || f.field_name === "label";

const isLabelCol = (f: any, e: any): boolean => f.field_name === e.label_column;
const isRef = (f: any): boolean => !!f.reference_table;

/** An `is_a` / `has_a` entity: based on `id_refentity`, sharing its key (template §3 `**Based on:**`). */
const isBased = (e: any): boolean => e.id_type === "is_a" || e.id_type === "has_a";

/** The code the spec's `**Edit permission:**` line carries. None on a computed entity, which has
 *  no entity-write row, and none at the platform's column default `admin`, which is not a module's code. */
const editCode = (e: any): string =>
  e.entity_type === "computed" || e.edit_permission === "admin" ? "" : e.edit_permission || "";

/** An `enum_values` entry is a value or a `{value, label}` object (optional description / color / icon); records store the value. */
const enumValue = (v: any): string => (v !== null && typeof v === "object" ? String(v.value) : String(v));

/** Live format → spec format vocabulary. */
function mapFormat(f: any, e: any): string {
  if (f.format === "text") return isLabelCol(f, e) ? "string" : "multiline";
  return f.format; // string, enum, color, icon, rating, date, number, integer, boolean, multiline, reference, …
}

/** Required is sourced strictly from input_type. */
const mapRequired = (f: any): "yes" | "no" => (f.input_type === "required" ? "yes" : "no");

/** §3 Label cell. Label-column title is lost in live (deployer overwrites it with
 *  singular_label), so humanize the field_name — Category B, best-effort. Non-label
 *  titles round-trip and are used verbatim. */
function mapLabel(f: any, e: any): string {
  if (isLabelCol(f, e)) return humanize(f.field_name);
  return f.title;
}

/** Markdown table row. A non-empty cell is padded with one space on each side; an
 *  EMPTY cell renders as a single space (`| |`), matching authored
 *  tables. (Padding empties too produced `|  |` — a byte-diff on every blank cell.) */
function tableRow(cells: string[]): string {
  return "|" + cells.map((c) => (c === "" ? " " : ` ${c} `)).join("|") + "|";
}

function humanize(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** §3 Notes cell composition (suppression rules applied). */
function mapNotes(f: any, e: any): string {
  // `unique` mirrors live `unique_value` (a DB-UNIQUE constraint). The spec
  // template lists it among the Notes markers and names THIS extractor as the thing
  // that round-trips it, so emit it for label and non-label columns alike, in the
  // template's order: `label_column`, unique, then value annotations. When live
  // `unique_value` is false the output is unchanged (nothing is appended).
  if (isLabelCol(f, e)) return f.unique_value ? "`label_column`, `unique`" : "`label_column`";
  const parts: string[] = [];
  if (f.unique_value) parts.push("`unique`");
  // `searchable`: backticked bare marker like `unique`, kept adjacent to it per the
  // canonical Notes order (§2: … `unique` · `searchable` …). Emit ONLY when live
  // `searchable` is true; the platform default false appends nothing.
  if (f.searchable) parts.push("`searchable`");
  if (f.format === "enum" && Array.isArray(f.enum_values) && f.enum_values.length) {
    const vals = f.enum_values.map((v: any) => `\`${enumValue(v)}\``).join(", ");
    let s = `enum_values: ${vals}`;
    if (f.default_value) s += `; default: "${f.default_value}"`;
    parts.push(s);
  }
  if (isRef(f)) {
    const arrow = f.format === "parent" ? "↳" : "→";
    let s = `${arrow} \`${f.reference_table}\` (N:1)`;
    if (f.relationship_label) s += `, relationship_label: "${f.relationship_label}"`;
    parts.push(s);
  }
  if (f.format === "number" && f.precision != null) parts.push(`precision: ${f.precision}`);
  // `cube_type`: bare value (no quotes), matching template `cube_type: dimension`.
  // `"auto"` is the platform default and carries no authored intent, so suppress it.
  if (f.cube_type && f.cube_type !== "auto") parts.push(`cube_type: ${f.cube_type}`);
  // Parent-FK label override: double-quoted "singular" / "plural", matching template
  // `parent label: "X" / "Ys"`. Present only on parent FKs that relabel their parent.
  if (f.singular_label_parent || f.plural_label_parent) {
    parts.push(`parent label: "${f.singular_label_parent || ""}" / "${f.plural_label_parent || ""}"`);
  }
  // `width`: bare value like `precision:`, in its canonical slot after `parent label`
  // (§2: … parent label · `width` …). `"default"` is the platform default (verified via
  // create_field schema + live rows), so suppress it to avoid round-trip noise.
  if (f.width && f.width !== "default") parts.push(`width: ${f.width}`);
  // `default:` completeness. Enum keeps its default inline in the enum_values annotation
  // (above); every other format with a `default_value` — scalar, number (alongside its
  // precision), and reference/FK — emits it here exactly once. Excluding only `enum`
  // prevents a double-emit while closing the previously-dropped number/ref cases.
  if (f.format !== "enum" && f.default_value) {
    parts.push(`default: "${f.default_value}"`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function reconciliation(e: any): string {
  if (BUILTINS.has(e.table_name)) return `reuse-from semantius_builtin.${e.table_name}`;
  // A related entity owned by another module (a cross-module FK target or a family base):
  // referenced, not provisioned (`render` sets `_reuse_module`).
  if (e._reuse_module) return `reuse-from ${e._reuse_module}.${e.table_name}`;
  const aliases = Array.isArray(e.catalog_entity_aliases) ? e.catalog_entity_aliases : [];
  if (!e.catalog_owner_module && aliases.length === 0) return "create-new";
  // rename-incoming-from / promote-to-master / dropped are out of scope (untested).
  return "create-new";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function frontmatter(mod: any, ownedTables: string[], relatedVersions: Record<string, number> = {}): string {
  const settings = mod.settings || {};
  const lines: string[] = ["---"];
  lines.push(`artifact: semantic-spec`);
  lines.push(`version: "${FORMAT_VERSION}"`);
  lines.push(`system_name: ${mod.module_name}`);
  lines.push(`tagline: "${mod.description}"`);
  lines.push(`icon_name: ${mod.icon_name}`);
  lines.push(`system_slug: ${mod.module_slug}`);
  lines.push(`module_type: ${mod.module_type}`);
  if (settings.module_kind) lines.push(`module_kind: ${settings.module_kind}`);
  lines.push(`access_scope: ${mod.access_scope}`);
  lines.push(`domain_code: ${mod.domain_code}`);
  lines.push(`naming_mode: ${settings.naming_mode || "agent-optimized"}`);
  // Module presentation keys (canonical spec §3), after naming_mode, before entities.
  // Top-level `modules` columns (NOT under settings); emit each only when non-empty.
  if (mod.logo_color) lines.push(`logo_color: "${mod.logo_color}"`);   // quoted: YAML reads an unquoted `#` as a comment
  if (mod.home_page) lines.push(`home_page: ${mod.home_page}`);
  // Deploy provenance: live truth, so the optimizer emits it (unlike the
  // authoring-only reconciled_* / source_blueprint keys it deliberately drops).
  // deployed_version mirrors the module's current modules.version; a spec extracted
  // from live is by definition in-sync, so a drift check reads equal
  // until prod next changes. Guarded so an older platform (no version column) omits them.
  if (mod.version !== undefined && mod.version !== null) {
    lines.push(`deployed_version: ${mod.version}`);
    if (mod.version_date) lines.push(`deployed_version_date: "${mod.version_date}"`);
    const relSlugs = Object.keys(relatedVersions).sort();
    if (relSlugs.length) {
      lines.push(`deployed_related_versions:`);
      for (const s of relSlugs) lines.push(`  ${s}: ${relatedVersions[s]}`);
    }
  }
  lines.push(`entities:`);
  for (const t of ownedTables) lines.push(`  - ${t}`);
  lines.push("---");
  // Category-B authoring-only keys deliberately omitted: description block,
  // license, created_at, reconciled_*, source_blueprint,
  // related_modules, related_domains, departments, initial_request, persona,
  // catalog_module_code, raci_mode/raci_mode_source (any access_scope other than raci).
  return lines.join("\n");
}

function overviewSection(mod: any): string {
  // §1 is Category B (authored prose). Best-effort seed from the tagline; a human
  // refines it. Compare loop does not chase this block. Only add a terminal period
  // when the tagline lacks its own sentence-ending punctuation (else "spreadsheets..").
  const desc = (mod.description || "").trim();
  const seed = !desc || /[.!?]$/.test(desc) ? desc : `${desc}.`;
  return `## 1. Overview\n\n${seed}`;
}

function entitySummary(entities: any[], fieldsByTable: Record<string, any[]>): string {
  const rows: string[] = [
    "## 2. Entity summary",
    "",
    "| # | Table name | Singular label | Purpose |",
    "|---|---|---|---|",
  ];
  entities.forEach((e, i) => {
    // Purpose is Category B (authored). Best-effort: first sentence of description.
    const purpose = (e.description || "").split(/(?<=\.)\s/)[0] || "";
    rows.push(`| ${i + 1} | \`${e.table_name}\` | ${e.singular_label} | ${purpose} |`);
  });
  rows.push("");
  rows.push("### Entity-relationship diagram");
  rows.push("");
  rows.push(mermaid(entities, fieldsByTable));
  return rows.join("\n");
}

function mermaid(entities: any[], fieldsByTable: Record<string, any[]>): string {
  const diagramEdgeLines: string[] = [];
  const builtinTargets = new Set<string>();
  const referenced = new Set<string>();
  // Deterministic emission order: child entities in canonical order (entity_type
  // tier, then table_name A->Z), then their reference fields in field_order. The
  // same entity order an authored spec uses.
  for (const e of entities) {
    const fields = fieldsByTable[e.table_name] || [];
    for (const f of fields) {
      if (!isRef(f)) continue;
      const verb = f.relationship_label ? `|${f.relationship_label}|` : "";
      diagramEdgeLines.push(`    ${f.reference_table} -->${verb} ${e.table_name}`);
      referenced.add(f.reference_table);
      referenced.add(e.table_name);
      if (BUILTINS.has(f.reference_table)) builtinTargets.add(f.reference_table);
    }
  }
  // Family diagram edges (template §2): dotted, from the based entity to its base, after the
  // relationship diagram edges. The same lines `consistency-check.ts --emit-mermaid` derives.
  for (const e of entities) {
    if (!isBased(e) || !e.id_refentity) continue;
    diagramEdgeLines.push(`    ${e.table_name} -.->|${e.id_type === "is_a" ? "is a kind of" : "extends"}| ${e.id_refentity}`);
    referenced.add(e.table_name);
    referenced.add(e.id_refentity);
  }
  // `master` tags non-builtin entities whose reconciliation is `reuse-from` /
  // `promote-to-master` and that take part in a diagram edge — the same criterion the
  // consistency-check.ts `emitSpecMermaid` uses, so the checker's
  // derived diagram and this one agree. Both classDef lines are emitted ONLY when
  // at least one entity qualifies (template §2 omit-rule).
  const masterIds = entities
    .filter((e) => !BUILTINS.has(e.table_name) && referenced.has(e.table_name))
    .filter((e) => /^(reuse-from|promote-to-master)\b/.test(reconciliation(e)))
    .map((e) => e.table_name);
  const lines: string[] = ["```mermaid", "flowchart LR"];
  if (builtinTargets.size) {
    lines.push("    classDef builtin fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#1a4d2e;");
  }
  if (masterIds.length) {
    lines.push("    classDef master fill:#d4f4dd,stroke:#27ae60,color:#1a4d2e;");
  }
  lines.push(...diagramEdgeLines);
  for (const t of builtinTargets) lines.push(`    class ${t} builtin;`);
  for (const t of masterIds) lines.push(`    class ${t} master;`);
  lines.push("```");
  return lines.join("\n");
}

function entityDetail(e: any, fields: any[]): string {
  const out: string[] = [];
  out.push(`### 3.${e._num} \`${e.table_name}\` - ${e.singular_label}`);
  out.push("");

  if (BUILTINS.has(e.table_name) || e._reuse_module) {
    // Built-in / reuse block: referenced, not provisioned, so no owned Fields table.
    // It still carries a Label column and participates in relationships — every inbound
    // FK from an owned entity is fully recoverable from live state, so emit the same
    // Relationships prose owned entities get. This matches an authored
    // built-in block (e.g. `users` listing its inbound 1:N relationships); omitting it dropped
    // recoverable structure, not authored prose. No `**Additive fields**` table is
    // emitted (the extractor does not read built-in columns), matching an authored
    // spec, which has that table ONLY when fields are added to the built-in.
    out.push(`**Plural label:** ${e.plural_label}`);
    if (e.label_column) out.push(`**Label column:** \`${e.label_column}\``);
    out.push(`**Reconciliation:** ${reconciliation(e)}`);
    out.push(`**Description:** ${e.description}`); // Category B (live built-in description)
    const rel = relationshipsProse(e, fields, e._allEntities, e._fieldsByTable);
    if (rel.length) {
      out.push("");
      out.push("**Relationships**");
      out.push("");
      for (const line of rel) out.push(line);
    }
    return out.join("\n");
  }

  // Annotation lines follow the spec template's order AND its omit-rules:
  //   View permission, Edit permission: the entity's live codes, in full, on every
  //     OWNED entity. A line is left out when the live column is empty. Edit permission
  //     is also left out as `editCode` says.
  //   Catalog entity code — emit for every OWNED entity (equals table_name under
  //     agent-optimized naming; the template emits it regardless).
  //   Catalog owner — emit for an embedded_master placeholder whose canonical owner
  //     module is absent (live `catalog_owner_module` carries the future owner slug).
  //   Reconciliation — omit when create-new.
  const recon = reconciliation(e);
  out.push(`**Plural label:** ${e.plural_label}`);
  // Label column: required on every non-junction entity; OPTIONAL on a junction (the
  // platform composes `_label` from the parent legs). Omit the line when live
  // `label_column` is null/empty instead of emitting `` `null` `` (template §3 rule).
  // A based entity (`is_a` / `has_a`) takes its label column, label parent and order column
  // from its base (the platform sets them), so none of the three lines is emitted for it.
  const based = isBased(e);
  if (e.label_column && !based) out.push(`**Label column:** \`${e.label_column}\``);
  // Identity-spine lines (canonical spec §1), pinned right after **Label column:**.
  // Both backticked as a `field_name` like **Label column:**. Order column: omit when
  // empty/null. Id column: omit when the platform default `id` (or empty) — every live
  // entity reads back id_column "id" unless explicitly overridden.
  if (e.order_column && !based) out.push(`**Order column:** \`${e.order_column}\``);
  if (e.id_column && e.id_column !== "id") out.push(`**Id column:** \`${e.id_column}\``);
  // Key type / Key prefix (template §3), pinned right after **Id column:**. Bare values, no
  // backticks. Key type: omit at the platform default `auto_increment` (a spec without the
  // line means auto_increment). Key prefix: only with `typeid` (the platform keeps it empty
  // for every other type). Locked after create, so this is what a re-deploy must match.
  if (e.id_type && e.id_type !== "auto_increment") out.push(`**Key type:** ${e.id_type}`);
  if ((e.id_type === "typeid" || e.id_type === "is_a") && e.id_prefix) out.push(`**Key prefix:** ${e.id_prefix}`);
  // Based on (template §3), right after **Key prefix:**: the base, backticked. Create-only.
  if (based && e.id_refentity) out.push(`**Based on:** \`${e.id_refentity}\``);
  out.push(`**Audit log:** ${e.audit_log ? "yes" : "no"}`);
  if (e.view_permission) out.push(`**View permission:** ${e.view_permission}`);
  if (editCode(e)) out.push(`**Edit permission:** ${editCode(e)}`);
  // UI/cube/icon lines (canonical spec §1), pinned right after **Edit permission:**.
  // Edit mode / Cube mode: bare enum value, no backticks; omit at the platform default
  // `auto` (verified via `create_*` schema + every live row reads back "auto"). Icon:
  // a Lucide icon name or an icon URL, NO backticks; omit when empty/null.
  if (e.edit_mode && e.edit_mode !== "auto") out.push(`**Edit mode:** ${e.edit_mode}`);
  if (e.cube_mode && e.cube_mode !== "auto") out.push(`**Cube mode:** ${e.cube_mode}`);
  if (e.icon_name) out.push(`**Icon:** ${e.icon_name}`);
  out.push(`**Catalog entity code:** \`${e.catalog_entity_code || e.table_name}\``);
  out.push(`**Entity type:** ${e.entity_type}`);
  if (e.catalog_owner_module) out.push(`**Catalog owner:** ${e.catalog_owner_module}`);
  if (e.label_parent && !based) out.push(`**Label parent:** \`${e.label_parent}\``);
  if (recon !== "create-new") out.push(`**Reconciliation:** ${recon}`);
  out.push(`**Description:** ${e.description}`);
  out.push("");
  out.push("**Fields**");
  out.push("");
  out.push("| Field name | Format | Required | Label | Description | Reference / Notes |");
  out.push("|---|---|---|---|---|---|");
  for (const f of fields) {
    out.push(
      tableRow([
        `\`${f.field_name}\``, `\`${mapFormat(f, e)}\``, mapRequired(f),
        mapLabel(f, e), f.description || "", mapNotes(f, e),
      ]),
    );
  }
  const rel = relationshipsProse(e, fields, e._allEntities, e._fieldsByTable);
  if (rel.length) {
    out.push("");
    out.push("**Relationships**");
    out.push("");
    for (const line of rel) out.push(line);
  }

  // §3 behavior blocks (data-integrity / RLS / dynamic-UI logic). Emitted after the
  // Fields table and Relationships prose, ONLY for non-builtin entities (the BUILTINS
  // branch returned early above). Each block is emitted WHEN its live value is non-empty,
  // in the spec template's order (§3 sub-blocks): Computed fields,
  // Validation rules, Input type rules, Select rule. All four use the same fence style:
  // `**Heading**`, blank line, ```json, JSON.stringify(v, null, 2), ```, blank line.
  emitJsonBlock(out, "Computed fields", e.computed_fields);
  emitJsonBlock(out, "Validation rules", e.validation_rules);
  emitJsonBlock(out, "Input type rules", inputTypeRules(fields));
  emitJsonBlock(out, "Select rule", e.select_rule);

  return out.join("\n");
}

/** Assemble the §3 "Input type rules" array from per-field `input_type_rule` objects
 *  (spec template array shape, §3 "Input type rules"): one entry
 *  `{ field, jsonlogic }` per field carrying a non-empty rule, in field order. Returns
 *  `[]` when no field carries a rule (so `emitJsonBlock` omits the whole block). */
function inputTypeRules(fields: any[]): Array<{ field: string; jsonlogic: any }> {
  const out: Array<{ field: string; jsonlogic: any }> = [];
  for (const f of fields) {
    if (isNonEmpty(f.input_type_rule)) {
      out.push({ field: f.field_name, jsonlogic: f.input_type_rule });
    }
  }
  return out;
}

/** True when a JSON behavior value carries content worth emitting: a non-empty array,
 *  or a plain object with at least one own key. Null / undefined / `[]` / `{}` are empty. */
function isNonEmpty(v: any): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return false;
}

/** Emit a §3 behavior block iff `value` is non-empty. Matches the spec template's
 *  fence style exactly: `**Heading**`, blank line, a ```json fence, the 2-space
 *  pretty-printed JSON (`JSON.stringify(value, null, 2)`), the closing fence, and a
 *  trailing blank line so successive blocks stay separated. */
function emitJsonBlock(out: string[], heading: string, value: any): void {
  if (!isNonEmpty(value)) return;
  out.push("");
  out.push(`**${heading}**`);
  out.push("");
  out.push("```json");
  out.push(JSON.stringify(value, null, 2));
  out.push("```");
}

/** §3 Relationships prose. A junction entity (live `entity_type === "junction"`) is
 *  described by ONE junction line, and its two parent entities get the canonical M:N line
 *  (spec template: "`X` ↔ `Y` is many-to-many through the `<junction>` junction
 *  table") rather than a raw 1:N-to-the-junction-table. Everything else: outbound FKs in
 *  field order, then inbound 1:N from owned children. All deterministic from live —
 *  `entity_type` supplies the junction signal; no authored verb is needed. */
function relationshipsProse(
  e: any, fields: any[], allEntities: any[], fieldsByTable: Record<string, any[]>,
): string[] {
  const art = /^[aeiou]/i.test(e.table_name) ? "An" : "A";
  const lines: string[] = [];
  const isJunction = (t: any): boolean => !!t && t.entity_type === "junction";
  const refsOf = (t: string): any[] => (fieldsByTable[t] || []).filter(isRef);

  // A based entity's family relationship comes first (template: one canonical sentence).
  if (isBased(e) && e.id_refentity) {
    lines.push(
      e.id_type === "is_a"
        ? `- ${art} \`${e.table_name}\` record is a kind of \`${e.id_refentity}\` and shares its key (is_a).`
        : `- ${art} \`${e.table_name}\` record extends one \`${e.id_refentity}\` record and shares its key (has_a).`,
    );
  }

  // Junction entity: a single junction line instead of its two raw N:1 legs.
  if (isJunction(e)) {
    const legs = refsOf(e.table_name);
    if (legs.length >= 2) {
      const modes = legs.map((l) => l.reference_delete_mode || "clear");
      const del = modes.every((m) => m === modes[0])
        ? `both legs ${modes[0]} on delete`
        : legs.map((l, i) => `\`${l.field_name}\` ${modes[i]}`).join(", ") + " on delete";
      lines.push(
        `- Each \`${e.table_name}\` relates one \`${legs[0].reference_table}\` to one \`${legs[1].reference_table}\` (junction, ${del}).`,
      );
      return lines;
    }
    // Atypical junction (<2 FK legs): fall through to the generic rendering below.
  }

  // Outbound reference FKs.
  for (const f of fields) {
    if (!isRef(f)) continue;
    const optional = f.input_type !== "required";
    const belong = optional ? "may belong to" : "belongs to";
    const req = optional ? "optional" : "required";
    const del = f.reference_delete_mode || "clear"; // literal token (clear|restrict|cascade)
    // Disambiguate the FK by its unique `field_name` (like the inbound line's
    // `via child.field_name`), never a display label or a name-derived noun — the same
    // uniqueness guarantee §1 uses for `table_name`. This is the exact form the spec
    // template prescribes, so authored and reverse-engineered specs carry identical prose.
    lines.push(
      `- ${art} \`${e.table_name}\` record ${belong} one \`${f.reference_table}\` via \`${f.field_name}\` (N:1, ${req}, ${del} on delete).`,
    );
  }
  // Inbound: an ordinary child yields a 1:N line; a junction child collapses to the
  // canonical M:N line to the junction's OTHER parent.
  for (const child of allEntities) {
    if (BUILTINS.has(child.table_name) || child.table_name === e.table_name) continue;
    for (const cf of fieldsByTable[child.table_name] || []) {
      if (cf.reference_table !== e.table_name) continue;
      if (isJunction(child)) {
        const other = refsOf(child.table_name).find((o) => o.reference_table !== e.table_name);
        if (other) {
          lines.push(
            `- \`${e.table_name}\` ↔ \`${other.reference_table}\` is many-to-many through the \`${child.table_name}\` junction table.`,
          );
          continue;
        }
      }
      lines.push(
        `- ${art} \`${e.table_name}\` record may have many \`${child.table_name}\` (1:N, via \`${child.table_name}.${cf.field_name}\`).`,
      );
    }
  }
  return lines;
}

function relationshipSummary(entities: any[], fieldsByTable: Record<string, any[]>): string {
  const rows: string[] = [
    "## 4. Relationship summary",
    "",
    "| FK table | FK field | References | Cardinality | Kind | fk_format | Delete behavior |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const e of entities) {
    if (BUILTINS.has(e.table_name)) continue;
    for (const f of fieldsByTable[e.table_name] || []) {
      if (!isRef(f)) continue;
      rows.push(
        // "Kind" reflects the relationship class (a junction entity's FK legs are
        // `junction`); "fk_format" stays the physical field format (`reference`/`parent`).
        `| \`${e.table_name}\` | \`${f.field_name}\` | \`${f.reference_table}\` | N:1 | ${e.entity_type === "junction" ? "junction" : f.format} | ${f.format} | ${f.reference_delete_mode || "clear"} |`,
      );
    }
  }
  return rows.join("\n");
}

function enumerations(entities: any[], fieldsByTable: Record<string, any[]>): string {
  const out: string[] = ["## 5. Enumerations", ""];
  // Collect every enum field, then sort the BLOCKS alphabetically by
  // `table.field` and emit an unnumbered `### `table.field`` heading. The member values inside each block keep their defined
  // (lifecycle / semantic) order; only the block order and headings change.
  const blocks: Array<{ key: string; values: any[] }> = [];
  for (const e of entities) {
    for (const f of fieldsByTable[e.table_name] || []) {
      if (f.format !== "enum" || !Array.isArray(f.enum_values) || !f.enum_values.length) continue;
      blocks.push({ key: `${e.table_name}.${f.field_name}`, values: f.enum_values });
    }
  }
  blocks.sort((a, b) => a.key.localeCompare(b.key));
  if (blocks.length === 0) {
    out.push("_(none: no enum fields in this module)_");
    return out.join("\n").trimEnd();
  }
  for (const b of blocks) {
    out.push(`### \`${b.key}\``);
    // Each entry is a value bullet; a `{value, label}` entry's properties are sub-bullets in the
    // fixed order label, color, icon, description (never Object.keys order: jsonb reorders keys); a
    // plain entry is the bare value. An object always carries its label (the platform requires one).
    for (const v of b.values) {
      out.push(`- \`${enumValue(v)}\``);
      if (v === null || typeof v !== "object") continue;
      if (v.label) out.push(`  - label: ${v.label}`);
      if (v.color) out.push(`  - color: \`${v.color}\``);
      if (v.icon) out.push(`  - icon: \`${v.icon}\``);
      if (v.description) out.push(`  - description: ${v.description}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** Text before the colon of `<prefix>:<suffix>`. The prefix names the entity's owner, the
 *  module that realizes a gate, or the module that declares a bundle, so it can differ from
 *  this module's slug and can name a module that is not installed. */
function permPrefix(name: string): string {
  return name.split(":")[0];
}

/** Text after the colon of `<prefix>:<suffix>`. */
function permSuffix(name: string): string {
  return name.split(":").pop() || name;
}

/** Permission name -> the names it directly includes, from hierarchy rows (permissions are
 *  keyed by `permission_name`; hierarchy rows relate the two names). */
function includesIndex(hierarchy: any[]): Record<string, string[]> {
  const includes: Record<string, string[]> = {};
  for (const h of hierarchy) (includes[h.including_permission_name] ||= []).push(h.included_permission_name);
  return includes;
}

/** Set of permission names transitively included by `rootName`. */
function includedClosure(rootName: string, includes: Record<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [rootName];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of includes[id] || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  return seen;
}

/** True for `<prefix>:write_<entity>` that includes its own `<prefix>:read_<entity>`, which every
 *  entity-write row does. That row is what tells it from a gate whose verb starts the same way
 *  (`write_off_invoice`). */
function writesEntity(name: string, includes: Record<string, string[]>): boolean {
  const suffix = permSuffix(name);
  if (!suffix.startsWith("write_")) return false;
  return (includes[name] || []).includes(`${permPrefix(name)}:read_${suffix.slice("write_".length)}`);
}

/** True for a code that includes a write permission: a bundle, not a gate. */
function includesWrite(name: string, includes: Record<string, string[]>): boolean {
  for (const n of includedClosure(name, includes)) if (writesEntity(n, includes)) return true;
  return false;
}

/**
 * Names of the permissions this module's §8.1 carries. A row can be held by another module:
 * the first embedder of an entity holds its owner-named rows, and an installed owner holds
 * them from then on, so reading by `module_id` alone would lose them. So besides the rows
 * this module holds, take every code an owned entity's columns name, every code an owned
 * entity's rules cite, and whatever those reach through the hierarchy.
 *
 * The walk stops at another module's bundle (its `read`, `manage`, `admin` or a narrow tier):
 * that is the other module's own row, and going through it would pull in that whole module.
 */
function modulePermissionNames(
  mod: any, owned: any[], fieldsByTable: Record<string, any[]>, heldNames: Set<string>, allHierarchy: any[],
): Set<string> {
  const includes = includesIndex(allHierarchy);
  const otherBundle = (name: string): boolean => {
    if (heldNames.has(name) || permPrefix(name) === mod.module_slug) return false;
    return ["read", "manage", "admin"].includes(permSuffix(name)) || includesWrite(name, includes);
  };
  const cited = new Set<string>();
  const stack = [...heldNames];
  for (const e of owned) {
    if (e.view_permission) stack.push(e.view_permission);
    if (editCode(e)) stack.push(editCode(e));
    citedPermissions(e.validation_rules, cited);
    citedPermissions(e.select_rule, cited);
    for (const f of fieldsByTable[e.table_name] || []) citedPermissions(f.input_type_rule, cited);
  }
  stack.push(...cited);
  const names = new Set<string>();
  while (stack.length) {
    const name = stack.pop()!;
    if (names.has(name) || otherBundle(name)) continue;
    names.add(name);
    stack.push(...(includes[name] || []));
  }
  return names;
}

/** Permission codes a JsonLogic value cites through `require_permission` or
 *  `has_permission` (both unary: a bare code string or a one-element array). */
function citedPermissions(v: any, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) citedPermissions(x, out);
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "require_permission" || k === "has_permission") {
        for (const a of Array.isArray(x) ? x : [x]) {
          if (typeof a === "string") out.add(a);
          else citedPermissions(a, out);
        }
      } else citedPermissions(x, out);
    }
  }
  return out;
}

/** True when a JsonLogic value carries `{"value_changed": "workflow_state"}` (a
 *  `workflow_state` transition rule). */
function hasStateTransition(v: any): boolean {
  if (Array.isArray(v)) return v.some(hasStateTransition);
  if (v === null || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) =>
    k === "value_changed" ? (Array.isArray(x) ? x[0] : x) === "workflow_state" : hasStateTransition(x),
  );
}

/** True when a JsonLogic value is the insert check `{"==": [{"var": "$old"}, null]}`
 *  (either operand order). */
function isInsertCheck(v: any): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v) || !Array.isArray(v["=="]) || v["=="].length !== 2) return false;
  const isOld = (x: any) => x !== null && typeof x === "object" && !Array.isArray(x) && x.var === "$old";
  const [a, b] = v["=="];
  return (isOld(a) && b === null) || (isOld(b) && a === null);
}

/** Codes cited in the gated branch of a create guard: an `if` whose condition is the
 *  insert check, `{"if": [{"==": [{"var": "$old"}, null]}, <gate check>, true]}`, where
 *  the gate check is `has_permission(<gate>)` or the living form
 *  `or(is_raci_actor(...), has_permission(<gate>))`. */
function createGateCodes(v: any, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) createGateCodes(x, out);
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "if" && Array.isArray(x) && x.length >= 2 && isInsertCheck(x[0])) citedPermissions(x[1], out);
      createGateCodes(x, out);
    }
  }
  return out;
}

/** Codes in a `has_permission` branch of an `or` that also holds an `is_raci_actor`
 *  branch (the living A-gate: `or(is_raci_actor(...), has_permission(<gate>))`). */
function raciGateCodes(v: any, out: Set<string> = new Set()): Set<string> {
  const isOp = (b: any, op: string) => b !== null && typeof b === "object" && !Array.isArray(b) && op in b;
  if (Array.isArray(v)) {
    for (const x of v) raciGateCodes(x, out);
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "or" && Array.isArray(x) && x.some((b) => isOp(b, "is_raci_actor"))) {
        for (const b of x) {
          if (!isOp(b, "has_permission")) continue;
          for (const a of Array.isArray(b.has_permission) ? b.has_permission : [b.has_permission]) {
            if (typeof a === "string") out.add(a);
          }
        }
      }
      raciGateCodes(x, out);
    }
  }
  return out;
}

/**
 * §8.1 Permissions catalog. The `tier` vocabulary MUST be one a deploy accepts
 * (baseline-read | baseline-manage | baseline-admin | entity-read |
 * entity-write | workflow-gate (lifecycle) | workflow-gate (rule) | override | narrow);
 * a bare `workflow-gate` is a deploy-time 🛑. Live state carries no tier column, so the
 * non-baseline tiers are a HEURISTIC over what the spec itself can prove. A rule
 * CITES a code through `require_permission` or `has_permission` in an owned entity's
 * validation_rules / select_rule JSON.
 *   entity-write             `write_*` named by an owned entity's `**Edit permission:**`, or
 *                            including its own `read_*`. Never under `access_scope: custom`,
 *                            where the module keeps its hand-made permissions
 *   entity-read              `read_*` named by an owned entity's `view_permission`, or
 *                            included by the module's `read` or by its own `write_*`.
 *                            Never under `access_scope: custom`
 *   narrow                   a code that includes a write permission, or (a hand-made code)
 *                            any other code an owned entity's `edit_permission` names
 *   workflow-gate (rule)     `bypass_submit_lock`, by name, cited or not (the rule that cites
 *                            it can sit on a reused entity this spec does not carry)
 *   override                 `view_all_*` / `manage_all_*` row-scope codes (tested before
 *                            the rule test: they are wired into select_rule via has_permission)
 *   workflow-gate (lifecycle) cited by a `workflow_state` transition rule (a validation
 *                            rule carrying `{"value_changed": "workflow_state"}`), in the
 *                            `has_permission` branch of an `or` next to `is_raci_actor`, or
 *                            in the gated branch of a create guard (an `if` on
 *                            `{"==": [{"var": "$old"}, null]}`)
 *   workflow-gate (rule)     cited by any other rule
 *   workflow-gate (lifecycle) everything else (a gated transition no rule cites)
 * `included in :admin?` is derived from the live hierarchy: ✓ iff `<slug>:admin`
 * transitively includes the permission. With no admin permission (two-permission
 * fallback) every row is ✓ except a `baseline-admin` row, which is always `-`.
 * `high risk?` is filled only on `workflow-gate (lifecycle)` rows under
 * `access_scope: raci`: ✓ when `<slug>:admin` does not include the gate (its
 * `included in :admin?` is `-`), else `-`. Under every other access level, and on
 * every other row, it is `-` (under `gated` the admin holds every gate, so live state
 * cannot show which gates are high-risk).
 * `perms` holds no bundle of another module (`modulePermissionNames`), so a `read`, `manage`
 * or `admin` suffix here is always this module's own baseline.
 */
function permissionsCatalog(mod: any, perms: any[], hierarchy: any[], owned: any[]): string {
  const out: string[] = [
    "## 8.1 Permissions catalog",
    "",
    "| permission | tier | description | included in `:admin`? | high risk? |",
    "| --- | --- | --- | --- | --- |",
  ];
  const includes = includesIndex(hierarchy);
  const editColumns = new Set<string>(owned.map(editCode).filter(Boolean));
  const entityReads = new Set<string>(owned.map((e) => e.view_permission).filter(Boolean));
  for (const h of hierarchy) {
    const includedBy: string = h.including_permission_name;
    if (permSuffix(includedBy) === "read" || writesEntity(includedBy, includes)) entityReads.add(h.included_permission_name);
  }
  const perEntity = String(mod.access_scope) !== "custom";
  const cited = new Set<string>();
  const lifecycleCited = new Set<string>();
  for (const e of owned) {
    const rules = Array.isArray(e.validation_rules) ? e.validation_rules : e.validation_rules ? [e.validation_rules] : [];
    for (const rule of rules) {
      const codes = citedPermissions(rule);
      for (const c of codes) cited.add(c);
      if (hasStateTransition(rule)) for (const c of codes) lifecycleCited.add(c);
      for (const c of raciGateCodes(rule)) lifecycleCited.add(c);
      for (const c of createGateCodes(rule)) lifecycleCited.add(c);
    }
    for (const c of citedPermissions(e.select_rule || {})) cited.add(c);
  }
  const raci = String(mod.access_scope) === "raci";
  const adminPerm = perms.find((p) => permSuffix(p.permission_name) === "admin");
  const adminClosure = adminPerm ? includedClosure(adminPerm.permission_name, includes) : null;

  // Deterministic order: read, manage, admin, then the rest by name.
  const rank = (p: any) => {
    const s = permSuffix(p.permission_name);
    return s === "read" ? 0 : s === "manage" ? 1 : s === "admin" ? 2 : 3;
  };
  const sorted = [...perms].sort(
    (a, b) => rank(a) - rank(b) || String(a.permission_name).localeCompare(String(b.permission_name)),
  );
  for (const p of sorted) {
    const name: string = p.permission_name;
    const suffix = permSuffix(name);
    let tier: string;
    if (suffix === "read") tier = "baseline-read";
    else if (suffix === "manage") tier = "baseline-manage";
    else if (suffix === "admin") tier = "baseline-admin";
    else if (perEntity && suffix.startsWith("write_") && (editColumns.has(name) || writesEntity(name, includes))) tier = "entity-write";
    else if (perEntity && suffix.startsWith("read_") && entityReads.has(name)) tier = "entity-read";
    else if (editColumns.has(name) || includesWrite(name, includes)) tier = "narrow";
    else if (suffix === "bypass_submit_lock") tier = "workflow-gate (rule)";
    // `override` before the rule test: a row-scope override is wired INTO the entity's
    // select_rule via `has_permission`, so it would otherwise read as a rule gate.
    else if (/^(view_all_|manage_all_)/.test(suffix)) tier = "override";
    else if (lifecycleCited.has(name)) tier = "workflow-gate (lifecycle)";
    else if (cited.has(name)) tier = "workflow-gate (rule)";
    else tier = "workflow-gate (lifecycle)";
    let inAdmin: string;
    if (tier === "baseline-admin") inAdmin = "-";
    else if (adminClosure) inAdmin = adminClosure.has(p.permission_name) ? "✓" : "-";
    else inAdmin = "✓";
    const highRisk = raci && tier === "workflow-gate (lifecycle)" && inAdmin === "-" ? "✓" : "-";
    out.push(`| \`${name}\` | ${tier} | ${p.description} | ${inAdmin} | ${highRisk} |`);
  }
  return out.join("\n");
}

function governance(
  mod: any, perms: any[], hierarchy: any[], permByName: Record<string, any>, roles: any[],
  processes: any[],
): string {
  // §9.1 heading key is the system_slug uppercased (template `{{SYSTEM_SLUG_UPPER}}`),
  // NOT domain_code — the two coincide only when domain_code == upper(slug).
  const upper = String(mod.module_slug).toUpperCase();
  // §8.2 / §9.2 / the RACI surfaces are Category B: live state does not carry them in
  // a recoverable shape. Where the access_scope rules a surface out (permission-gated
  // rules and functional ownership under `basic` / `custom`; the Processes catalog under
  // every scope but `raci`) the placeholder reason is definitional; otherwise it is honest
  // about the extractor's limit. The RACI realization / RACI mode / RACI plan lines are
  // NEVER emitted (not even as placeholders): consistency-check.ts keys its raci_mode
  // provenance gate on the literal `**RACI realization:**`.
  const scope = String(mod.access_scope);
  const noPermissionRules = scope === "basic" || scope === "custom";
  const out: string[] = [];
  out.push("## 8.2 Business rules");
  out.push("");
  out.push(
    noPermissionRules
      ? `_(none: access_scope is ${scope}, so no permission-gated business rules are authored)_`
      : "_(none: not extracted from live state by semantius-optimizer; author by hand)_",
  );
  out.push("");
  out.push("## 9. Governance");
  out.push("");
  out.push(`### 9.1 \`${upper}\``);
  out.push("");
  out.push("**Baseline roles:**");
  out.push("");
  // Two trailing lineage columns (`origin`, `catalog role code`) before
  // the final `reconciliation` column (canonical spec §4). These are display-only — the
  // deployer re-derives both from module_type/slug — so the round-trip is a functional
  // no-op; a deploy parses §9.1 by header name and ignores them as inputs.
  out.push("| role | baseline grant | origin | catalog role code | reconciliation |");
  out.push("| --- | --- | --- | --- | --- |");
  // Role slugs come from LIVE `roles.slug` (the correct fully-underscored canonical form),
  // paired to their grant via the module's default-role FK columns. NOT synthesized from
  // module_slug — that reproduces a bug where the spec carried a malformed
  // hyphen/underscore-mixed slug. Live is the truth-source; a diff vs an authored spec on
  // this cell is an upstream authoring defect, not an extractor limitation.
  // Emit each role's live `roles.origin` / `roles.catalog_role_code` in the two new cells.
  const roleById: Record<number, any> = {};
  for (const r of roles) roleById[r.id] = r;
  const roleGrants: Array<[number | null, string | undefined]> = [
    [mod.default_viewer_role_id, mod.view_permission],
    [mod.default_manager_role_id, mod.manage_permission ?? undefined],   // permission NAME reference
    [mod.default_admin_role_id, mod.admin_permission ?? undefined],     // permission NAME reference
  ];
  for (const [roleId, grant] of roleGrants) {
    if (!roleId || !roleById[roleId]) continue;
    const r = roleById[roleId];
    // Built via tableRow so the (commonly empty) catalog-role-code cell renders as a
    // single space, not `|  |` — same empty-cell rule as the §3 field tables.
    // Reconciliation cell: this pass reads LIVE state, so every role it lists exists
    // by construction -> `♻ exists` (template vocabulary: ✨ to create | ♻ exists |
    // 🟡 drift on module_id; the marker is U+267B without a variation selector).
    out.push(tableRow([`\`${r.slug}\``, `\`${grant}\``, r.origin || "", r.catalog_role_code || "", "♻ exists"]));
  }
  out.push("");
  out.push("**Permission hierarchy:**");
  out.push("");
  out.push("| permission | includes | reconciliation |");
  out.push("| --- | --- | --- |");
  for (const h of hierarchy) {
    const inc = permByName[h.including_permission_name]?.permission_name;
    // The included side is outside §8.1 only for a family edit grant to another module's
    // bundle (the `hierarchy` filter in `render` admits nothing else from outside §8.1).
    const included = permByName[h.included_permission_name]?.permission_name ?? h.included_permission_name;
    if (inc && included) out.push(`| \`${inc}\` | \`${included}\` | ♻ exists |`);
  }
  out.push("");
  // Read the module's Processes catalog (no typed `read_process` CRUD tool exists —
  // read via `postgrestRequest` GET `/processes?module_id=eq.<id>`, the same table a
  // deploy writes in living-RACI mode). Emit the §9 catalog in the spec template's
  // exact format (§9.1 Processes) when rows exist; keep the
  // `_(none: ...)_` placeholder when there are none.
  emitProcesses(out, processes, scope);
  out.push("");
  out.push("### 9.2 Functional ownership and default grants");
  out.push("");
  out.push(
    noPermissionRules
      ? `_(none: access_scope is ${scope}, no functional-ownership rows are authored)_`
      : "_(none: not extracted from live state by semantius-optimizer; author by hand)_",
  );
  return out.join("\n");
}

/** §9 Processes catalog. Emits the spec template's exact shape
 *  (§9.1 Processes): the bare `**Processes:**` caption line, a
 *  blank line, then a `| process_key | name | description | ordering |` table — one row
 *  per live process, sorted by `ordering` (then `process_key`) for deterministic output.
 *  When there are no processes, the inline `**Processes:** _(none: ...)_` form (single
 *  line, no table). The template's caption parenthetical is authoring commentary and is
 *  never emitted. */
function emitProcesses(out: string[], processes: any[], scope: string): void {
  if (!processes.length) {
    out.push(
      scope !== "raci"
        ? `**Processes:** _(none: access_scope is ${scope}, no Processes catalog is authored)_`
        : "**Processes:** _(none: not extracted from live state by semantius-optimizer; author by hand)_",
    );
    return;
  }
  out.push("**Processes:**");
  out.push("");
  out.push("| process_key | name | description | ordering |");
  out.push("| --- | --- | --- | --- |");
  const sorted = [...processes].sort(
    (a, b) => (a.ordering ?? 0) - (b.ordering ?? 0) || String(a.process_key).localeCompare(String(b.process_key)),
  );
  for (const p of sorted) {
    out.push(`| ${p.process_key} | ${p.name || ""} | ${p.description || ""} | ${p.ordering ?? ""} |`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Everything the renderer needs, as read from Semantius (raw rows, pre-sort). This is
 * also the JSON shape a `--from-fixture` file carries, so the round-trip eval can feed
 * the renderer without a live instance. `relatedModules` are the `modules` rows of the
 * OTHER modules that own a related (reuse-from) entity. `perms` are the rows this module
 * holds; `otherPerms` are rows other modules hold, of which `render` keeps the ones this
 * module reaches (`modulePermissionNames`).
 */
type LiveData = {
  mod: any;
  ownedRaw: any[];
  fieldsByTable: Record<string, any[]>;
  related: any[];
  perms: any[];
  otherPerms: any[];
  allHierarchy: any[];
  roles: any[];
  processes: any[];
  relatedModules: any[];
};

/** All live reads, in the original order, nothing else. */
async function loadLive(slug: string): Promise<LiveData> {
  const mod = (await read("read_module", { filters: `module_slug=eq.${slug}` }))[0];
  if (!mod) throw new Error(`module not found: ${slug}`);

  // Read all owned entities; the canonical modeling order (entity_type tier, then
  // table_name A->Z) is imposed in `prepare()`. The `created_at.asc` read only makes
  // the input deterministic; the EMITTED order is the modeling order, never creation order.
  const ownedRaw = await read("read_entity", { filters: `module_id=eq.${mod.id}`, order: "created_at.asc" });
  const ownedTables = sortEntities(ownedRaw).map((e) => e.table_name);

  const fieldsByTable: Record<string, any[]> = {};
  const loadFields = async (table: string) => {
    const raw = await read("read_field", { filters: `table_name=eq.${table}`, order: "field_order.asc" });
    fieldsByTable[table] = raw.filter((f) => !isStripped(f));
  };
  for (const t of ownedTables) await loadFields(t);

  // Discover related tables (built-ins pulled in as reuse-from §3 blocks).
  const related: any[] = [];
  const seen = new Set(ownedTables);
  const baseOf = new Map(ownedRaw.map((e: any) => [e.table_name, e.id_refentity] as const));
  for (const t of ownedTables) {
    // FK targets, plus the base of a based entity (a family base in another module).
    for (const f of [...fieldsByTable[t], { reference_table: baseOf.get(t) }]) {
      const tgt = f.reference_table;
      if (tgt && !seen.has(tgt)) {
        seen.add(tgt);
        const ent = (await read("read_entity", { filters: `table_name=eq.${tgt}` }))[0];
        if (ent) related.push(ent);
      }
    }
  }

  // §8/§9 sources.
  const perms = await read("read_permission", { filters: `module_id=eq.${mod.id}` });
  const allHierarchy = await read("read_permission_hierarchy", {});
  const roles = await read("read_role", { filters: `module_id=eq.${mod.id}` });

  // Rows other modules hold that this module reaches, in batches to keep each filter short.
  const heldNames = new Set<string>(perms.map((p) => p.permission_name));
  const otherNames = [...modulePermissionNames(mod, ownedRaw, fieldsByTable, heldNames, allHierarchy)]
    .filter((n) => !heldNames.has(n));
  const otherPerms: any[] = [];
  for (let i = 0; i < otherNames.length; i += 50) {
    const batch = otherNames.slice(i, i + 50);
    otherPerms.push(...(await read("read_permission", { filters: `permission_name=in.(${batch.join(",")})` })));
  }

  // §9 Processes catalog. No typed `read_process` CRUD tool exists, so read the
  // `processes` table via the generic `postgrestRequest` GET (the same table + filter a
  // deploy uses to materialize living-RACI processes: `/processes?module_id=eq.<id>`).
  // A read failure must NOT abort the extract — leave the §9 Processes block as its
  // placeholder and FLAG the loss on stderr (canonical spec §5 / task rule 5).
  let processes: any[] = [];
  try {
    processes = await read("postgrestRequest", {
      method: "GET",
      path: `/processes?module_id=eq.${mod.id}&order=ordering.asc`,
    });
  } catch (err) {
    console.error(
      `⚠ FLAG: could not read the Processes catalog (/processes?module_id=eq.${mod.id}); ` +
        `§9 Processes left as the empty placeholder. Cause: ${(err as Error).message}`,
    );
    processes = [];
  }

  // Deploy-provenance: live `modules` row of each OTHER module this spec reuses an
  // entity from (the reference targets pulled in above). Lets a drift check
  // detect drift in a reused entity, not just this module's own. Best-effort: skip a
  // module that can't be read.
  const relatedModules: any[] = [];
  const relModuleIds = [...new Set(related.map((e) => e.module_id).filter((id) => id && id !== mod.id))];
  for (const mid of relModuleIds) {
    const rm = (await read("read_module", { filters: `id=eq.${mid}` }))[0];
    if (rm) relatedModules.push(rm);
  }

  return { mod, ownedRaw, fieldsByTable, related, perms, otherPerms, allHierarchy, roles, processes, relatedModules };
}

/** The rows this module's §8.1 carries: the ones it holds, then the ones it reaches. */
function modulePermissions(data: LiveData): any[] {
  const heldNames = new Set<string>(data.perms.map((p) => p.permission_name));
  const names = modulePermissionNames(data.mod, data.ownedRaw, data.fieldsByTable, heldNames, data.allHierarchy);
  return [...data.perms, ...data.otherPerms.filter((p) => names.has(p.permission_name) && !heldNames.has(p.permission_name))];
}

/** Pure: derive the markdown from a LiveData snapshot. Shared by the live path and
 *  `--from-fixture`, so both produce byte-identical output for identical input. */
function render(data: LiveData): string {
  const { mod, fieldsByTable, roles, processes } = data;
  const perms = modulePermissions(data);

  // Canonical modeling order (entity_type tier, then table_name A->Z); reuse-from /
  // built-in entities appended last, sorted the same way.
  const owned = sortEntities(data.ownedRaw);
  const related = data.related;
  const moduleSlugById = new Map(data.relatedModules.map((m: any) => [m.id, m.module_slug] as const));
  for (const e of related) {
    if (!BUILTINS.has(e.table_name) && e.module_id !== mod.id && moduleSlugById.has(e.module_id)) {
      e._reuse_module = moduleSlugById.get(e.module_id);
    }
  }
  const allEntities = [...owned, ...sortEntities(related)];
  allEntities.forEach((e, i) => {
    e._num = i + 1;
    e._allEntities = allEntities;
    e._fieldsByTable = fieldsByTable;
  });

  // Permissions are keyed by permission_name (no numeric id); hierarchy rows relate two names.
  const permByName: Record<string, any> = {};
  for (const p of perms) permByName[p.permission_name] = p;
  // A row between two §8.1 permissions is kept, whichever module holds them. A row to anything
  // else is kept only when it is a family edit grant: one of this module's permissions
  // including the edit permission of the base of one of its based entities.
  const baseEditPerms = new Set(
    owned.filter(isBased).map((e: any) => related.find((r: any) => r.table_name === e.id_refentity)?.edit_permission).filter(Boolean),
  );
  const hierarchy = data.allHierarchy.filter(
    (h) => h.including_permission_name in permByName &&
      (h.included_permission_name in permByName || baseEditPerms.has(h.included_permission_name)),
  );

  const relatedVersions: Record<string, number> = {};
  for (const rm of data.relatedModules) {
    if (rm && rm.version !== undefined && rm.version !== null) relatedVersions[rm.module_slug] = rm.version;
  }

  // Assemble.
  const parts: string[] = [];
  // `entities` frontmatter lists every §3 entity (owned + reuse-from built-ins) in the
  // canonical order (entity_type tier, then table_name A->Z), matching authored
  // specs (the master includes `users`).
  parts.push(frontmatter(mod, allEntities.map((e) => e.table_name), relatedVersions));
  parts.push("");
  parts.push(`# ${mod.module_name}: Semantic Model`);
  parts.push("");
  parts.push(overviewSection(mod));
  parts.push("");
  parts.push(entitySummary(allEntities, fieldsByTable));
  parts.push("");
  parts.push("## 3. Entities");
  parts.push("");
  for (const e of allEntities) {
    parts.push(entityDetail(e, fieldsByTable[e.table_name] || []));
    parts.push("");
  }
  parts.push("---");
  parts.push("");
  parts.push(relationshipSummary(allEntities, fieldsByTable));
  parts.push("");
  parts.push(enumerations(owned, fieldsByTable));
  parts.push("");
  // §6: the relationship table (first table directly under `## 6.`), then the two handoff
  // sub-sections. Live state carries neither in a recoverable shape:
  // every cross-module FK already exists as a §3 reference, and the platform exposes
  // no handoff / trigger registry to read back — so all three are placeholders.
  parts.push("## 6. Cross-model relationship suggestions");
  parts.push("");
  parts.push("_(none: live extraction is reverse-engineering; every cross-module FK already exists as a §3 reference)_");
  parts.push("");
  parts.push("### Outbound handoffs");
  parts.push("");
  parts.push("_(none: not extracted from live state by semantius-optimizer; carried from the blueprint when one exists)_");
  parts.push("");
  parts.push("### Inbound handoffs");
  parts.push("");
  parts.push("_(none: not extracted from live state by semantius-optimizer; carried from the blueprint when one exists)_");
  parts.push("");
  parts.push("## 7. Open questions");
  parts.push("");
  parts.push("### 7.1 🔴 Decisions needed (blockers)");
  parts.push("");
  parts.push("_(none: reverse-engineered from a live module; nothing blocks redeployment)_");
  parts.push("");
  parts.push("### 7.2 🟡 Future considerations (deferred scope)");
  parts.push("");
  parts.push("_(none: reverse-engineered from a live module)_");
  parts.push("");
  parts.push(permissionsCatalog(mod, perms, hierarchy, owned));
  parts.push("");
  parts.push(governance(mod, perms, hierarchy, permByName, roles, processes));
  parts.push("");

  return parts.join("\n");
}

async function main() {
  // Arg parse: positional <module_slug> [outfile] (or --from-fixture <json> [outfile]),
  // plus optional order-independent --force and --diagram flags. --force is the ONLY
  // way to overwrite an existing outfile; --diagram writes no file at all.
  const rawArgs = Bun.argv.slice(2);
  const force = rawArgs.includes("--force");
  const diagramOnly = rawArgs.includes("--diagram");
  const fixtureIdx = rawArgs.indexOf("--from-fixture");
  const fixturePath = fixtureIdx >= 0 ? rawArgs[fixtureIdx + 1] : null;
  // Drop the fixture path only when --from-fixture is present (fixtureIdx -1 would otherwise drop argv[0], the slug).
  const positional = rawArgs.filter(
    (a, i) => a !== "--force" && a !== "--diagram" && a !== "--from-fixture" && (fixtureIdx < 0 || i !== fixtureIdx + 1),
  );
  const usage =
    "usage: bun run spec-extract-lib.ts <module_slug> [outfile] [--force]\n" +
    "       bun run spec-extract-lib.ts --from-fixture <fixture.json> [outfile] [--force]\n" +
    "       bun run spec-extract-lib.ts <module_slug> --diagram";
  if (fixtureIdx >= 0 && !fixturePath) throw new Error(usage);
  const slug = fixturePath ? null : positional[0];
  if (!fixturePath && !slug) throw new Error(usage);
  const outfile = (fixturePath ? positional[0] : positional[1]) || `${slug ?? "fixture"}-semantic-spec.md`;

  // Fail-fast overwrite guard: check the output path BEFORE any live read, so the
  // script never spends a run's worth of network work and then clobbers a file.
  // Refuse unless --force; the skill's Stage 2a asks the user first and passes --force
  // only on an explicit "replace" (or passes a different, non-colliding outfile).
  if (!diagramOnly && !force && (await Bun.file(outfile).exists())) {
    console.error(
      `refusing to overwrite existing file: ${outfile}\n` +
        `Choose a different output path, or pass --force to replace it.`,
    );
    process.exit(1);
  }

  const data: LiveData = fixturePath
    ? (JSON.parse(await Bun.file(fixturePath).text()) as LiveData)
    : await loadLive(slug!);
  if (fixturePath) {
    // Defensive defaults so a hand-written fixture may omit the rarely-used arrays.
    data.related ||= [];
    data.perms ||= [];
    data.otherPerms ||= [];
    data.allHierarchy ||= [];
    data.roles ||= [];
    data.processes ||= [];
    data.relatedModules ||= [];
    data.fieldsByTable ||= {};
  }

  const md = render(data);
  if (diagramOnly) {
    const block = md.match(/^```mermaid\n[\s\S]*?\n```$/m);
    if (!block) throw new Error("render produced no Mermaid block");
    console.log(block[0]);
    return;
  }
  await Bun.write(outfile, md);
  console.log(
    `Wrote ${outfile}: ${data.ownedRaw.length} owned entities, ${data.related.length} related, ${modulePermissions(data).length} permissions.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
