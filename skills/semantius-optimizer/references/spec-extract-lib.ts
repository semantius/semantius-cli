/**
 * spec-extract-lib.ts — deterministic reverse-engineer of a live Semantius module
 * into a `*-semantic-spec.md` (analyst artifact, version "5.4").
 *
 * READ-ONLY against Semantius. Every read shells out via `Bun.spawn` with an
 * ARG ARRAY (bypasses the shell — inline JSON is safe on Windows and POSIX),
 * the same proven pattern as semantius-modeler/references/deploy-lib.ts.
 *
 * Usage:  bun run spec-extract-lib.ts <module_slug> [outfile]
 *
 * The mapping rules (and the Category-A / Category-B divergence taxonomy the
 * companion compare loop keys on) are documented in SKILL.md. This file is the
 * single deterministic source of the generated markdown so refinement cycles are
 * attributable.
 */

const SPEC_VERSION = "5.4";

/** Semantius platform built-ins — reused by the deployer, not owned by any module. */
const BUILTINS = new Set([
  "users", "roles", "permissions", "permission_hierarchy", "role_permissions",
  "user_roles", "webhook_receivers", "webhook_receiver_logs", "modules",
  "entities", "fields", "departments",
]);

// ---------------------------------------------------------------------------
// Entity ordering (canonical — shared with the analyst/architect convention)
// ---------------------------------------------------------------------------

/** Tier by `entity_type`, then alphabetical by `table_name`. This is the ONE
 *  ordering key that exists identically on the spec and in live state, so the
 *  forward pipeline (architect/analyst) and this reverse pass produce the same
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

/** Live format → spec format vocabulary. */
function mapFormat(f: any, e: any): string {
  if (f.format === "text") return isLabelCol(f, e) ? "string" : "multiline";
  return f.format; // string, enum, date, number, integer, boolean, multiline, reference
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
 *  EMPTY cell renders as a single space (`| |`), matching the analyst's authored
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
  // `unique` mirrors live `unique_value` (a DB-UNIQUE constraint). The analyst
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
    const vals = f.enum_values.map((v: string) => `\`${v}\``).join(", ");
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
  lines.push(`version: "${SPEC_VERSION}"`);
  lines.push(`system_name: ${mod.module_name}`);
  lines.push(`tagline: "${mod.description}"`);
  lines.push(`icon_name: ${mod.icon_name}`);
  lines.push(`system_slug: ${mod.module_slug}`);
  lines.push(`module_type: ${mod.module_type}`);
  if (settings.module_kind) lines.push(`module_kind: ${settings.module_kind}`);
  lines.push(`access_scope: ${mod.access_scope}`);
  lines.push(`domain_code: ${mod.domain_code}`);
  lines.push(`naming_mode: ${settings.naming_mode || "agent-optimized"}`);
  // v5.4 module presentation keys (canonical spec §3), after naming_mode, before entities.
  // Top-level `modules` columns (NOT under settings); emit each only when non-empty.
  if (mod.logo_color) lines.push(`logo_color: ${mod.logo_color}`);
  if (mod.home_page) lines.push(`home_page: ${mod.home_page}`);
  // Deploy provenance (v5.4+): live truth, so the optimizer emits it (unlike the
  // authoring-only reconciled_* / source_blueprint keys it deliberately drops).
  // deployed_version mirrors the module's current modules.version; a spec extracted
  // from live is by definition in-sync, so the analyst's 2a.1 drift gate reads equal
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
  // blueprint_version, license, created_at, reconciled_*, source_blueprint,
  // related_modules, related_domains, departments, initial_request, persona,
  // catalog_module_code, raci_mode/raci_mode_source (basic scope).
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
  const lines: string[] = ["```mermaid", "flowchart LR"];
  lines.push(
    "    classDef builtin fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#1a4d2e;",
  );
  const builtinTargets = new Set<string>();
  // Deterministic emission order: child entities in canonical order (entity_type
  // tier, then table_name A->Z), then their reference fields in field_order. The
  // same entity order the analyst emits.
  for (const e of entities) {
    const fields = fieldsByTable[e.table_name] || [];
    for (const f of fields) {
      if (!isRef(f)) continue;
      const verb = f.relationship_label ? `|${f.relationship_label}|` : "";
      lines.push(`    ${f.reference_table} -->${verb} ${e.table_name}`);
      if (BUILTINS.has(f.reference_table)) builtinTargets.add(f.reference_table);
    }
  }
  for (const t of builtinTargets) lines.push(`    class ${t} builtin;`);
  lines.push("```");
  return lines.join("\n");
}

function entityDetail(e: any, fields: any[]): string {
  const out: string[] = [];
  out.push(`### 3.${e._num} \`${e.table_name}\` - ${e.singular_label}`);
  out.push("");

  if (BUILTINS.has(e.table_name)) {
    // Built-in / reuse block: referenced, not provisioned, so no owned Fields table.
    // It still carries a Label column and participates in relationships — every inbound
    // FK from an owned entity is fully recoverable from live state, so emit the same
    // Relationships prose owned entities get. This matches the analyst's authored
    // built-in block (e.g. `users` listing its inbound 1:N links); omitting it dropped
    // recoverable structure, not authored prose. No `**Additive fields**` table is
    // emitted (the extractor does not read built-in columns), matching the analyst,
    // which emits that table ONLY when the blueprint adds fields to the built-in.
    out.push(`**Plural label:** ${e.plural_label}`);
    out.push(`**Label column:** \`${e.label_column}\``);
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

  // Annotation lines follow the analyst template's order AND its omit-rules:
  //   Edit permission — omit when the default `manage`.
  //   Catalog entity code — emit for every OWNED entity (equals table_name under
  //     agent-optimized naming; the template emits it regardless).
  //   Catalog owner — emit for an embedded_master placeholder whose canonical owner
  //     module is absent (live `catalog_owner_module` carries the future owner slug).
  //   Reconciliation — omit when create-new.
  const editSuffix = String(e.edit_permission || "").split(":").pop() || "manage";
  const recon = reconciliation(e);
  out.push(`**Plural label:** ${e.plural_label}`);
  out.push(`**Label column:** \`${e.label_column}\``);
  // v5.4 identity-spine lines (canonical spec §1), pinned right after **Label column:**.
  // Both backticked as a `field_name` like **Label column:**. Order column: omit when
  // empty/null. Id column: omit when the platform default `id` (or empty) — every live
  // entity reads back id_column "id" unless explicitly overridden.
  if (e.order_column) out.push(`**Order column:** \`${e.order_column}\``);
  if (e.id_column && e.id_column !== "id") out.push(`**Id column:** \`${e.id_column}\``);
  out.push(`**Audit log:** ${e.audit_log ? "yes" : "no"}`);
  if (editSuffix !== "manage") out.push(`**Edit permission:** ${editSuffix}`);
  // v5.4 UI/cube/icon lines (canonical spec §1), pinned right after **Edit permission:**.
  // Edit mode / Cube mode: bare enum value, no backticks; omit at the platform default
  // `auto` (verified via `create_*` schema + every live row reads back "auto"). Icon URL:
  // plain URL value, NO backticks; omit when empty/null.
  if (e.edit_mode && e.edit_mode !== "auto") out.push(`**Edit mode:** ${e.edit_mode}`);
  if (e.cube_mode && e.cube_mode !== "auto") out.push(`**Cube mode:** ${e.cube_mode}`);
  if (e.icon_url) out.push(`**Icon URL:** ${e.icon_url}`);
  out.push(`**Catalog entity code:** \`${e.catalog_entity_code || e.table_name}\``);
  out.push(`**Entity type:** ${e.entity_type}`);
  if (e.catalog_owner_module) out.push(`**Catalog owner:** ${e.catalog_owner_module}`);
  if (e.label_parent) out.push(`**Label parent:** \`${e.label_parent}\``);
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
  // in the analyst template's order (semantic-spec-template.md:141-192): Computed fields,
  // Validation rules, Input type rules, Select rule. All four use the same fence style:
  // `**Heading**`, blank line, ```json, JSON.stringify(v, null, 2), ```, blank line.
  emitJsonBlock(out, "Computed fields", e.computed_fields);
  emitJsonBlock(out, "Validation rules", e.validation_rules);
  emitJsonBlock(out, "Input type rules", inputTypeRules(fields));
  emitJsonBlock(out, "Select rule", e.select_rule);

  return out.join("\n");
}

/** Assemble the §3 "Input type rules" array from per-field `input_type_rule` objects
 *  (analyst template array shape, semantic-spec-template.md:170-184): one entry
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

/** Emit a §3 behavior block iff `value` is non-empty. Matches the analyst template's
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
 *  described by ONE link line, and its two parent entities get the canonical M:N line
 *  (analyst template: "`X` ↔ `Y` is many-to-many through the `<junction>` junction
 *  table") rather than a raw 1:N-to-the-link-table. Everything else: outbound FKs in
 *  field order, then inbound 1:N from owned children. All deterministic from live —
 *  `entity_type` supplies the junction signal; no authored verb is needed. */
function relationshipsProse(
  e: any, fields: any[], allEntities: any[], fieldsByTable: Record<string, any[]>,
): string[] {
  const art = /^[aeiou]/i.test(e.table_name) ? "An" : "A";
  const lines: string[] = [];
  const isJunction = (t: any): boolean => !!t && t.entity_type === "junction";
  const refsOf = (t: string): any[] => (fieldsByTable[t] || []).filter(isRef);

  // Junction entity: a single link line instead of its two raw N:1 legs.
  if (isJunction(e)) {
    const legs = refsOf(e.table_name);
    if (legs.length >= 2) {
      const modes = legs.map((l) => l.reference_delete_mode || "clear");
      const del = modes.every((m) => m === modes[0])
        ? `both legs ${modes[0]} on delete`
        : legs.map((l, i) => `\`${l.field_name}\` ${modes[i]}`).join(", ") + " on delete";
      lines.push(
        `- Each \`${e.table_name}\` links one \`${legs[0].reference_table}\` to one \`${legs[1].reference_table}\` (junction, ${del}).`,
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
    // uniqueness guarantee §1 uses for `table_name`. This is the exact form the analyst
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
    "| From | Field | To | Cardinality | Kind | fk_format | Delete behavior |",
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
  // `table.field` and emit an unnumbered `### `table.field`` heading (analyst
  // v5.4+ convention). The member values inside each block keep their defined
  // (lifecycle / semantic) order; only the block order and headings change.
  const blocks: Array<{ key: string; values: string[] }> = [];
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
    for (const v of b.values) out.push(`- \`${v}\``);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function permissionsCatalog(perms: any[]): string {
  const out: string[] = [
    "## 8.1 Permissions catalog",
    "",
    "| permission | tier | description | included in `:admin`? | reconciliation |",
    "| --- | --- | --- | --- | --- |",
  ];
  // Deterministic order: read, manage, admin, then others.
  const rank = (p: string) =>
    p.endsWith(":read") ? 0 : p.endsWith(":manage") ? 1 : p.endsWith(":admin") ? 2 : 3;
  const sorted = [...perms].sort((a, b) => rank(a.permission_name) - rank(b.permission_name));
  for (const p of sorted) {
    const name = p.permission_name;
    let tier = "workflow-gate";
    if (name.endsWith(":read")) tier = "baseline-read";
    else if (name.endsWith(":manage")) tier = "baseline-manage";
    else if (name.endsWith(":admin")) tier = "baseline-admin";
    // Fixed convention: baseline read/manage always ✓ (roll up under admin when it exists).
    const inAdmin = tier === "baseline-read" || tier === "baseline-manage" || tier === "workflow-gate" ? "✓" : "-";
    out.push(`| \`${name}\` | ${tier} | ${p.description} | ${inAdmin} | (none) |`);
  }
  return out.join("\n");
}

function governance(
  mod: any, perms: any[], hierarchy: any[], permById: Record<number, any>, roles: any[],
  processes: any[],
): string {
  const upper = mod.domain_code;
  const out: string[] = [];
  out.push("## 8.2 Business rules");
  out.push("");
  out.push("_(none: access_scope is basic, so no permission-gated business rules are authored)_");
  out.push("");
  out.push("## 9. Governance");
  out.push("");
  out.push(`### 9.1 \`${upper}\``);
  out.push("");
  out.push("**Baseline roles:**");
  out.push("");
  // v5.4: two trailing lineage columns (`origin`, `catalog role code`) inserted before
  // the final `reconciliation` column (canonical spec §4). These are display-only — the
  // deployer re-derives both from module_type/slug — so the round-trip is a functional
  // no-op; the modeler parses §9.1 by header name and ignores them as inputs.
  out.push("| role | baseline grant | origin | catalog role code | reconciliation |");
  out.push("| --- | --- | --- | --- | --- |");
  // Role slugs come from LIVE `roles.slug` (the correct fully-underscored canonical form),
  // paired to their grant via the module's default-role FK columns. NOT synthesized from
  // module_slug — that reproduces an architect bug where the spec carried a malformed
  // hyphen/underscore-mixed slug. Live is the truth-source; a diff vs an authored spec on
  // this cell is an upstream authoring defect, not an extractor limitation.
  // Emit each role's live `roles.origin` / `roles.catalog_role_code` in the two new cells.
  const roleById: Record<number, any> = {};
  for (const r of roles) roleById[r.id] = r;
  const roleGrants: Array<[number | null, string | undefined]> = [
    [mod.default_viewer_role_id, mod.view_permission],
    [mod.default_manager_role_id, permById[mod.manage_permission_id]?.permission_name],
    [mod.default_admin_role_id, permById[mod.admin_permission_id]?.permission_name],
  ];
  for (const [roleId, grant] of roleGrants) {
    if (!roleId || !roleById[roleId]) continue;
    const r = roleById[roleId];
    // Built via tableRow so the (commonly empty) catalog-role-code cell renders as a
    // single space, not `|  |` — same empty-cell rule as the §3 field tables.
    out.push(tableRow([`\`${r.slug}\``, `\`${grant}\``, r.origin || "", r.catalog_role_code || "", "✨ to create"]));
  }
  out.push("");
  out.push("**Permission hierarchy:**");
  out.push("");
  out.push("| permission | includes | reconciliation |");
  out.push("| --- | --- | --- |");
  for (const h of hierarchy) {
    const inc = permById[h.including_permission_id]?.permission_name;
    const included = permById[h.included_permission_id]?.permission_name;
    if (inc && included) out.push(`| \`${inc}\` | \`${included}\` | ✨ to create |`);
  }
  out.push("");
  // v5.4: read the module's Processes catalog (no typed `read_process` CRUD tool exists —
  // read via `postgrestRequest` GET `/processes?module_id=eq.<id>`, the same table the
  // modeler writes in living-RACI mode). Emit the §9 catalog in the analyst template's
  // exact format (semantic-spec-template.md:311-315) when rows exist; keep the
  // `_(none: ...)_` placeholder when there are none.
  emitProcesses(out, processes);
  out.push("");
  out.push("### 9.2 Functional ownership and default grants");
  out.push("");
  out.push("_(none: access_scope is basic, no functional-ownership rows are authored)_");
  return out.join("\n");
}

/** §9 Processes catalog. Emits the analyst template's exact shape
 *  (semantic-spec-template.md:311-315): the `**Processes:**` caption line, a blank line,
 *  then a `| process_key | name | description | ordering |` table — one row per live
 *  process, sorted by `ordering` (then `process_key`) for deterministic output. When there
 *  are no processes, keeps the `_(none: ...)_` placeholder (single line, no table). */
function emitProcesses(out: string[], processes: any[]): void {
  if (!processes.length) {
    out.push("**Processes:** _(none: access_scope is basic, no Processes catalog is authored)_");
    return;
  }
  out.push(
    "**Processes:** _(catalog — one row per process, referenced by `process_key`; carried from the blueprint's Processes wired table. PCF columns are blueprint provenance and are dropped here — `process_key` is the join-back key.)_",
  );
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

async function main() {
  // Arg parse: positional <module_slug> [outfile], plus an optional order-independent
  // --force flag. --force is the ONLY way to overwrite an existing outfile.
  const rawArgs = Bun.argv.slice(2);
  const force = rawArgs.includes("--force");
  const positional = rawArgs.filter((a) => a !== "--force");
  const slug = positional[0];
  if (!slug) throw new Error("usage: bun run spec-extract-lib.ts <module_slug> [outfile] [--force]");
  const outfile = positional[1] || `${slug}-semantic-spec.md`;

  // Fail-fast overwrite guard: check the output path BEFORE any live read, so the
  // script never spends a run's worth of network work and then clobbers a file.
  // Refuse unless --force; the skill's Stage 2a asks the user first and passes --force
  // only on an explicit "replace" (or passes a different, non-colliding outfile).
  if (!force && (await Bun.file(outfile).exists())) {
    console.error(
      `refusing to overwrite existing file: ${outfile}\n` +
        `Choose a different output path, or pass --force to replace it.`,
    );
    process.exit(1);
  }

  const mod = (await read("read_module", { filters: `module_slug=eq.${slug}` }))[0];
  if (!mod) throw new Error(`module not found: ${slug}`);

  // Read all owned entities, then impose the canonical modeling order
  // (entity_type tier, then table_name A->Z). The `created_at.asc` read only
  // makes the input deterministic; the EMITTED order is the modeling order,
  // never creation order.
  const ownedRaw = await read("read_entity", { filters: `module_id=eq.${mod.id}`, order: "created_at.asc" });
  const owned = sortEntities(ownedRaw);
  const ownedTables = owned.map((e) => e.table_name);

  const fieldsByTable: Record<string, any[]> = {};
  const loadFields = async (table: string) => {
    const raw = await read("read_field", { filters: `table_name=eq.${table}`, order: "field_order.asc" });
    fieldsByTable[table] = raw.filter((f) => !isStripped(f));
  };
  for (const t of ownedTables) await loadFields(t);

  // Discover related tables (built-ins pulled in as reuse-from §3 blocks).
  const related: any[] = [];
  const seen = new Set(ownedTables);
  for (const t of ownedTables) {
    for (const f of fieldsByTable[t]) {
      const tgt = f.reference_table;
      if (tgt && !seen.has(tgt)) {
        seen.add(tgt);
        const ent = (await read("read_entity", { filters: `table_name=eq.${tgt}` }))[0];
        if (ent) related.push(ent);
      }
    }
  }

  const allEntities = [...owned, ...sortEntities(related)];
  allEntities.forEach((e, i) => {
    e._num = i + 1;
    e._allEntities = allEntities;
    e._fieldsByTable = fieldsByTable;
  });

  // §8/§9 sources.
  const perms = await read("read_permission", { filters: `module_id=eq.${mod.id}` });
  const permIds = perms.map((p) => p.id);
  const permById: Record<number, any> = {};
  for (const p of perms) permById[p.id] = p;
  const allHierarchy = await read("read_permission_hierarchy", {});
  const hierarchy = allHierarchy.filter(
    (h) => permIds.includes(h.including_permission_id) && permIds.includes(h.included_permission_id),
  );
  const roles = await read("read_role", { filters: `module_id=eq.${mod.id}` });

  // §9 Processes catalog. No typed `read_process` CRUD tool exists, so read the
  // `processes` table via the generic `postgrestRequest` GET (the same table + filter the
  // modeler uses to materialize living-RACI processes: `/processes?module_id=eq.<id>`).
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

  // Deploy-provenance: live version of each OTHER module this spec reuses an entity
  // from (the reference targets pulled in above). Lets the analyst's 2a.1 gate detect
  // drift in a reused entity, not just this module's own. Best-effort: skip a module
  // whose row lacks a version (older platform) or can't be read.
  const relatedVersions: Record<string, number> = {};
  const relModuleIds = [...new Set(related.map((e) => e.module_id).filter((id) => id && id !== mod.id))];
  for (const mid of relModuleIds) {
    const rm = (await read("read_module", { filters: `id=eq.${mid}` }))[0];
    if (rm && rm.version !== undefined && rm.version !== null) relatedVersions[rm.module_slug] = rm.version;
  }

  // Assemble.
  const parts: string[] = [];
  // `entities` frontmatter lists every §3 entity (owned + reuse-from built-ins) in the
  // canonical order (entity_type tier, then table_name A->Z), matching the analyst
  // convention (the master includes `users`).
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
  parts.push("## 6. Cross-model link suggestions");
  parts.push("");
  parts.push("_(none: live extraction is reverse-engineering; every cross-module FK already exists as a §3 reference)_");
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
  parts.push(permissionsCatalog(perms));
  parts.push("");
  parts.push(governance(mod, perms, hierarchy, permById, roles, processes));
  parts.push("");

  const md = parts.join("\n");
  await Bun.write(outfile, md);
  console.log(`Wrote ${outfile}: ${owned.length} owned entities, ${related.length} related, ${perms.length} permissions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
