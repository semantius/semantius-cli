#!/usr/bin/env bun
/**
 * scaffold-lib.ts — the deterministic module-scaffold builder + a live-schema
 * preflight, layered on the schema-agnostic primitives in `deploy-lib.ts`.
 *
 * ─── WHY THIS IS A SEPARATE FILE FROM deploy-lib.ts ───────────────────────────
 * `deploy-lib.ts` is schema-AGNOSTIC: `read1` / `readMany` / `write` / `ensure` /
 * `runDeploy` know no column names, which is exactly why that file "never changes"
 * and is always safe to copy. THIS file is schema-COUPLED: it bakes in module /
 * permission / role column names, the `origin` values, the provenance keys, and
 * the six module-record FK wires. So it is VERSION-STAMPED (`SCAFFOLD_LIB_MAJOR`)
 * and must be bumped in lockstep with the analyst / platform major, exactly like
 * the SKILL.md contract. Keeping it out of `deploy-lib.ts` preserves that file's
 * "never changes" guarantee — the thing that makes the primitives trustworthy.
 *
 * ─── WHAT IT ENCAPSULATES ─────────────────────────────────────────────────────
 * The BASELINE module scaffold (use-semantius "Mandatory Creation Order" +
 * modeler `stage-2-reconcile.md` §2a-scaffold steps 1-5) — the deterministic,
 * decision-free core that three deploy post-mortems each dropped a piece of:
 *
 *   module (+ provenance, converged on re-run)
 *     → baseline permissions  (read / manage / [admin], each with module_id)
 *     → baseline hierarchy     (manage→read, [admin→manage])
 *     → baseline roles         (viewer / manager / [admin]: role_name + slug +
 *                               module_id + origin + catalog_role_code, slug
 *                               hyphen-normalized)
 *     → baseline role_permissions
 *     → the SIX module-record FK wires + access_scope
 *
 * Every row kind is written as ONE set (deploy-lib `ensureMany` / `ensurePairs`):
 * one `in.()` read, ONE `create_*` call carrying every missing row, one re-read
 * for the ids, and one id-array `update_*` to converge a drifted `module_id`.
 * Never a loop of single-record creates. Re-running is a pure no-op.
 *
 * It makes NO plan decisions. It takes the already-resolved §8.1 baseline
 * permission descriptions, §9.1 baseline role slugs, and the Stage-2.5 scope as
 * arguments. Everything decision-bearing stays in the bespoke script via the
 * deploy-lib primitives: non-baseline §8.1 permissions (workflow gates),
 * non-baseline §9.1 hierarchy edges, persona / RACI roles, the `logo_color`
 * cosmetic fallback, entities, and fields. `scaffoldModule` covers ONLY the
 * universal baseline that every module has and that kept getting half-built.
 *
 * Import it next to deploy-lib.ts:
 *   import { read1, write, runDeploy } from "./deploy-lib";
 *   import { scaffoldModule, verifyScaffold, preflightSchemas } from "./scaffold-lib";
 *
 * `verifyScaffold(cfg)` is the executable self-audit: pass the SAME config back
 * after the deploy and it re-reads the live catalog, asserts the Stage 5 scaffold
 * checks as code, and THROWS on any drift — run it as the last step inside
 * `runDeploy` so "model is live" can never print over a broken scaffold.
 */

import { read1, write, ensureMany, ensurePairs } from "./deploy-lib";

/** Bump in lockstep with the modeler `EXPECTED_MAJOR` / analyst major. Schema-coupled. */
export const SCAFFOLD_LIB_MAJOR = 5;

// ───────────────────────────── live-schema preflight ─────────────────────────

/** Resolve a local `#/...` JSON-pointer `$ref` (zod → JSON Schema can hoist a schema shared by both `anyOf` variants into `$defs`). */
function deref(node: any, root: any): any {
  if (node && typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    return node.$ref.slice(2).split("/").reduce((o: any, k: string) => o?.[k], root) ?? node;
  }
  return node;
}

/**
 * The column names a tool accepts under `data`, across every shape the CLI has
 * printed for the crud tools:
 *   (a) legacy   `data: { type: "object", properties: {...} }`
 *   (b) bulk     `data: { anyOf: [ { type: "object", properties }, { type: "array", items: { properties } } ] }`
 *       (every create_* since the array-inserts release; `data` is one record OR an array of records)
 *   (c) tools that are not `{data}`-wrapped → their top-level properties.
 * If a `data` node exists but no object shape can be found under it, THROW: "can't
 * verify" halts. It must NEVER fall back to the top-level `{data, accept}` keys —
 * that fallback is what made every preflight false-fail ("create_module has no
 * field(s) [module_name, ...]. Live schema accepts: [accept, data]") the moment
 * the crud server started publishing shape (b).
 */
function dataKeys(tool: string, schema: any): Set<string> {
  const data = deref(schema?.properties?.data, schema);
  if (!data) return new Set(Object.keys(schema?.properties ?? {}));                       // (c)
  const variants = [data, ...((data.anyOf ?? data.oneOf ?? []) as any[])].map((v) => deref(v, schema));
  for (const v of variants) {                                                              // (a) / (b) object variant
    if (v && v.type !== "array" && v.properties) return new Set(Object.keys(v.properties));
  }
  for (const v of variants) {                                                              // array-only variant
    const items = deref(v?.items, schema);
    if (items?.properties) return new Set(Object.keys(items.properties));
  }
  throw new Error(
    `preflight: ${tool}'s live input schema has a \`data\` node with no object properties ` +
    `(schema shape changed?) — cannot verify the payload keys, halting`,
  );
}

/**
 * Read a crud tool's LIVE input schema via `semantius info crud <tool>` and
 * return the set of accepted `data` field names (see `dataKeys` for the shapes;
 * top-level properties for tools that aren't `{data}`-wrapped). Throws loud if
 * the info command fails or its output can't be parsed — "can't verify" halts,
 * per the loud-failure contract.
 */
async function toolDataKeys(tool: string): Promise<Set<string>> {
  const proc = Bun.spawn(["semantius", "info", "crud", tool], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`preflight: \`semantius info crud ${tool}\` failed (exit ${code}): ${err}`);
  }
  const brace = out.indexOf("{", out.indexOf("Input Schema:"));
  if (brace < 0) throw new Error(`preflight: no input schema in \`semantius info crud ${tool}\` output`);
  let schema: any;
  try {
    schema = JSON.parse(out.slice(brace));
  } catch (e) {
    throw new Error(`preflight: could not parse ${tool} input schema: ${e}`);
  }
  return dataKeys(tool, schema);
}

/**
 * Assert every key in `keys` is a real field on `tool`'s live input schema.
 * Catches the "wrote a payload from memory" class (e.g. `name` on `create_role`
 * when the live field is `role_name`) BEFORE the write, naming the available
 * keys so the fix is obvious.
 */
export async function assertToolSchema(tool: string, keys: string[]): Promise<void> {
  const have = await toolDataKeys(tool);
  const missing = keys.filter((k) => !have.has(k));
  if (missing.length) {
    throw new Error(
      `preflight: ${tool} has no field(s) [${missing.join(", ")}]. ` +
      `Live schema accepts: [${[...have].sort().join(", ")}]. ` +
      `Fix the payload (this is the "wrote it from memory" trap) before retrying.`,
    );
  }
}

/** Batch form: `{ tool: [keys...] }`. Verifies every tool before any write. */
export async function preflightSchemas(map: Record<string, string[]>): Promise<void> {
  for (const [tool, keys] of Object.entries(map)) {
    await assertToolSchema(tool, keys);
  }
}

// ───────────────────────────────── module scaffold ───────────────────────────

export type Origin = "model" | "model_master";
export type Scope = "basic" | "full";

export interface ModulePayload {
  module_slug: string;
  module_name: string;
  description: string;               // the ≤40-char tagline
  module_type?: string;             // default "domain"; never flipped on re-deploy
  catalog_module_code: string;      // write-once lineage
  domain_code: string;
  icon_name: string;
  home_page?: string;               // frontmatter home_page: written only when non-empty (default "")
  logo_color?: string;              // frontmatter logo_color: written verbatim when provided; when
                                    // omitted, the bespoke script's cosmetic fallback random-fills an
                                    // empty live value (never overwrites a provided value)
  settings?: Record<string, unknown>;  // module_kind / naming_mode / catalog_snapshot / promotion_decisions
}

export interface BaselineRole {
  slug: string;        // §9.1 verbatim (defensively hyphen-normalized here)
  role_name: string;   // display name
  description: string;
}

export interface ScaffoldConfig {
  module: ModulePayload;
  scope: Scope;
  origin?: Origin;                  // default "model"; "model_master" for a master module
  permissions: { read: string; manage: string; admin?: string };   // §8.1 descriptions, verbatim
  roles: { viewer: BaselineRole; manager: BaselineRole; admin?: BaselineRole };
}

export interface ScaffoldResult {
  moduleId: number;
  permissionIds: { read: number; manage: number; admin?: number };
  roleIds: { viewer: number; manager: number; admin?: number };
}

/** `roles.slug` is `^[a-z0-9_]+$`; module slugs may carry hyphens, role slugs may not. */
export const roleSlug = (s: string): string => s.toLowerCase().replace(/-/g, "_");

const isEmpty = (v: unknown): boolean => v === "" || v === null || v === undefined;

/**
 * Ensure the baseline permissions exist with `module_id` — as ONE set: one
 * `in.()` read, ONE `create_permission` call for the missing rows, one re-read
 * (ids come from the read, never off the create), then ONE `update_permission`
 * with an id ARRAY for any live row whose `module_id` drifted (same `data` for
 * every id, so it is one call). Returns `permission_name → id`.
 */
async function ensurePermissions(
  rows: ReadonlyArray<{ permission_name: string; description: string }>, moduleId: number,
): Promise<Map<string, number>> {
  const live = await ensureMany(
    "read_permission", "permission_name", (r) => r.permission_name,
    "create_permission", rows.map((r) => ({ ...r, module_id: moduleId })),
  );
  const drifted = [...live.values()].filter((p) => isEmpty(p.module_id) || p.module_id !== moduleId).map((p) => p.id);
  if (drifted.length) await write("update_permission", { id: drifted, data: { module_id: moduleId } });
  return new Map([...live].map(([name, p]) => [name, p.id as number]));
}

/**
 * Ensure the baseline roles exist with `module_id` + `origin` (+ `catalog_role_code`
 * lineage, VALUE-only) — as ONE set, same shape as `ensurePermissions`. Slugs are
 * hyphen-normalized (`roles.slug` is `^[a-z0-9_]+$`). Returns normalized `slug → id`.
 */
async function ensureRoles(
  roles: ReadonlyArray<BaselineRole>, moduleId: number, origin: Origin,
): Promise<Map<string, number>> {
  const live = await ensureMany(
    "read_role", "slug", (r) => r.slug,
    "create_role", roles.map((r) => ({
      role_name: r.role_name, slug: roleSlug(r.slug), description: r.description,
      module_id: moduleId, origin, catalog_role_code: r.slug,   // §9.1 baseline-role slug, verbatim (write-once lineage)
    })),
  );
  const drifted = [...live.values()].filter((r) => isEmpty(r.module_id) || r.module_id !== moduleId).map((r) => r.id);
  if (drifted.length) await write("update_role", { id: drifted, data: { module_id: moduleId } });
  return new Map([...live].map(([slug, r]) => [slug, r.id as number]));
}

/** Idempotent hierarchy edges (`including` *includes* `included`), created as ONE set via `ensurePairs`. */
async function ensureHierarchy(
  edges: ReadonlyArray<{ including_permission_id: number; included_permission_id: number }>, origin: Origin,
): Promise<void> {
  if (!edges.length) return;
  await ensurePairs(
    "read_permission_hierarchy", "including_permission_id", "included_permission_id",
    "create_permission_hierarchy", edges.map((e) => ({ ...e, origin })),
  );
}

/** Idempotent role↔permission grants, created as ONE set via `ensurePairs`. */
async function ensureRolePermissions(
  grants: ReadonlyArray<{ role_id: number; permission_id: number }>,
): Promise<void> {
  if (!grants.length) return;
  await ensurePairs("read_role_permission", "role_id", "permission_id", "create_role_permission", grants);
}

/**
 * Create-or-converge the module record; return its id. Converges provenance per
 * modeler stage-4 4a: always refresh name / description / access_scope; fill the
 * write-once / provenance columns only when empty (never overwrite a non-empty
 * `catalog_module_code`); merge `settings` (never drop sibling keys); never send
 * `module_type` on the converge path (it is not flipped on re-deploy).
 */
async function ensureModule(m: ModulePayload, scope: Scope): Promise<number> {
  const live = await read1("read_module", `module_slug=eq.${m.module_slug}`);
  if (!live) {
    await write("create_module", {
      data: {
        module_name: m.module_name,
        module_slug: m.module_slug,
        description: m.description,
        module_type: m.module_type ?? "domain",
        catalog_module_code: m.catalog_module_code,
        domain_code: m.domain_code,
        icon_name: m.icon_name,
        // home_page / logo_color: top-level columns, written only when the frontmatter provided a
        // non-empty value (omitted otherwise → platform default ""). logo_color's random-fill
        // fallback for an empty value stays in the bespoke script, per the file header.
        ...(isEmpty(m.home_page) ? {} : { home_page: m.home_page }),
        ...(isEmpty(m.logo_color) ? {} : { logo_color: m.logo_color }),
        access_scope: scope,
        settings: m.settings ?? {},
      },
    });
    const created = await read1("read_module", `module_slug=eq.${m.module_slug}`);
    if (!created) throw new Error(`scaffold: create_module ${m.module_slug} reported success but did not land`);
    return created.id;
  }
  const data: Record<string, unknown> = {
    module_name: m.module_name,
    description: m.description,
    access_scope: scope,                                   // always (the one provenance exception)
    settings: { ...(live.settings ?? {}), ...(m.settings ?? {}) },  // merge, never replace
  };
  if (isEmpty(live.catalog_module_code)) data.catalog_module_code = m.catalog_module_code;  // write-once
  if (isEmpty(live.domain_code)) data.domain_code = m.domain_code;
  if (isEmpty(live.icon_name)) data.icon_name = m.icon_name;
  // home_page / logo_color: a frontmatter-provided value is authoritative on re-deploy too, so write it
  // whenever the spec carries a non-empty value (not fill-only-empty). When the frontmatter omits it,
  // leave the live value alone; logo_color's empty-live case is handled by the script's cosmetic fallback.
  if (!isEmpty(m.home_page)) data.home_page = m.home_page;
  if (!isEmpty(m.logo_color)) data.logo_color = m.logo_color;
  await write("update_module", { id: live.id, data });
  return live.id;
}

/**
 * Build the full BASELINE module scaffold idempotently and wire the six
 * module-record FK columns. Self-verifies the field names of every tool it uses
 * against the live schema first (so a stale field name fails loud before any
 * write). Returns the resolved module / permission / role ids for the caller's
 * downstream entity creates.
 *
 * `scope` drives the admin tier: under "basic" the admin permission, admin role,
 * the `admin→manage` edge, and the module's admin FK columns are all skipped
 * (left null), matching the modeler Stage 2.5 basic projection — even when `cfg`
 * supplies admin descriptions / role. Under "full", admin is built only when
 * `cfg.permissions.admin` AND `cfg.roles.admin` are both present.
 */
export async function scaffoldModule(cfg: ScaffoldConfig): Promise<ScaffoldResult> {
  const origin: Origin = cfg.origin ?? "model";
  const slug = cfg.module.module_slug;
  const hasAdmin = cfg.scope === "full" && !!cfg.permissions.admin && !!cfg.roles.admin;

  // Preflight: fail loud on any stale field name BEFORE the first write.
  await preflightSchemas({
    create_module: ["module_name", "module_slug", "description", "module_type",
                    "catalog_module_code", "domain_code", "icon_name", "home_page", "logo_color",
                    "access_scope", "settings"],
    create_permission: ["permission_name", "description", "module_id"],
    create_permission_hierarchy: ["including_permission_id", "included_permission_id", "origin"],
    create_role: ["role_name", "slug", "description", "module_id", "origin", "catalog_role_code"],
    create_role_permission: ["role_id", "permission_id"],
  });

  // 1-2. Module (+ provenance), then the baseline permissions as ONE set (one in.() read, one
  //      create_permission call for the missing rows, one re-read, one id-array converge).
  const moduleId = await ensureModule(cfg.module, cfg.scope);
  const perms = await ensurePermissions([
    { permission_name: `${slug}:read`, description: cfg.permissions.read },
    { permission_name: `${slug}:manage`, description: cfg.permissions.manage },
    ...(hasAdmin ? [{ permission_name: `${slug}:admin`, description: cfg.permissions.admin! }] : []),
  ], moduleId);
  const readId = perms.get(`${slug}:read`)!;
  const manageId = perms.get(`${slug}:manage`)!;
  const adminId = hasAdmin ? perms.get(`${slug}:admin`)! : undefined;

  // 3. Baseline hierarchy as ONE set: manage→read, plus admin→manage when the admin tier exists.
  await ensureHierarchy([
    { including_permission_id: manageId, included_permission_id: readId },
    ...(adminId !== undefined ? [{ including_permission_id: adminId, included_permission_id: manageId }] : []),
  ], origin);

  // 4. Baseline roles as ONE set, then their baseline grants as ONE set.
  const roles = await ensureRoles([
    cfg.roles.viewer, cfg.roles.manager, ...(hasAdmin ? [cfg.roles.admin!] : []),
  ], moduleId, origin);
  const viewerId = roles.get(roleSlug(cfg.roles.viewer.slug))!;
  const managerId = roles.get(roleSlug(cfg.roles.manager.slug))!;
  const adminRoleId = hasAdmin ? roles.get(roleSlug(cfg.roles.admin!.slug))! : undefined;
  await ensureRolePermissions([
    { role_id: viewerId, permission_id: readId },
    { role_id: managerId, permission_id: manageId },
    ...(adminRoleId !== undefined && adminId !== undefined ? [{ role_id: adminRoleId, permission_id: adminId }] : []),
  ]);

  // 5. Wire the six module-record FK columns + access_scope (the step most often dropped).
  const wire: Record<string, unknown> = {
    view_permission: `${slug}:read`,           // text column (permission NAME)
    manage_permission_id: manageId,            // numeric FK (permission id)
    default_viewer_role_id: viewerId,
    default_manager_role_id: managerId,
    access_scope: cfg.scope,
  };
  if (hasAdmin) {
    wire.admin_permission_id = adminId;
    wire.default_admin_role_id = adminRoleId;
  }
  await write("update_module", { id: moduleId, data: wire });

  return {
    moduleId,
    permissionIds: { read: readId, manage: manageId, ...(adminId !== undefined ? { admin: adminId } : {}) },
    roleIds: { viewer: viewerId, manager: managerId, ...(adminRoleId !== undefined ? { admin: adminRoleId } : {}) },
  };
}

// ───────────────────────────────── scaffold verify ───────────────────────────

export type Severity = "ok" | "warn" | "fail";
export interface Finding { severity: Severity; check: string; detail: string; }

function throwIfFailed(findings: Finding[]): void {
  const fails = findings.filter((x) => x.severity === "fail");
  if (fails.length) {
    throw new Error(
      `verifyScaffold: ${fails.length} scaffold check(s) FAILED — the deploy is NOT complete:\n` +
      fails.map((x) => `  🛑 ${x.check}: ${x.detail}`).join("\n") +
      `\nFix the cause and re-run (every op is idempotent, so re-running converges).`,
    );
  }
}

/**
 * Re-read the live catalog and assert the baseline scaffold matches `cfg` — the
 * EXECUTABLE form of the modeler Stage 5 "Module scaffold integrity" checks. Pass
 * the SAME config you gave `scaffoldModule`. Returns the ok/warn findings for the
 * Stage 5 report on success; THROWS loud (listing every failure) on any hard
 * drift, so when this runs as the last step inside `runDeploy`, a failed audit
 * halts the script and "model is live" can never print over it.
 *
 * Scope: the baseline scaffold only (module + permissions + hierarchy + roles +
 * the six FK wires + provenance) — the most-regressed surface, and a MECHANICAL
 * check ("did the write land / is the FK null / does it deref to the right row").
 * It does not catch semantic errors ("did I build the wrong thing") — that needs
 * an independent reviewer. Entity / field / rule verification stays in Stage 5.
 *
 *   const cfg = { ... };
 *   await scaffoldModule(cfg);
 *   // ... entities, fields, rules ...
 *   const findings = await verifyScaffold(cfg);   // throws on drift; halts the deploy
 *   for (const x of findings) console.log(`${x.severity === "warn" ? "🟡" : "✓"} ${x.check} ${x.detail}`);
 */
export async function verifyScaffold(cfg: ScaffoldConfig): Promise<Finding[]> {
  const f: Finding[] = [];
  const ok = (check: string, detail = "") => f.push({ severity: "ok", check, detail });
  const warn = (check: string, detail: string) => f.push({ severity: "warn", check, detail });
  const fail = (check: string, detail: string) => f.push({ severity: "fail", check, detail });

  const slug = cfg.module.module_slug;
  const hasAdmin = cfg.scope === "full" && !!cfg.permissions.admin && !!cfg.roles.admin;

  const mod = await read1("read_module", `module_slug=eq.${slug}`);
  if (!mod) {
    fail("module exists", `no module with module_slug=${slug}`);
    throwIfFailed(f);
    return f;
  }
  ok("module exists", `${slug} (id ${mod.id})`);

  if (mod.access_scope !== cfg.scope) fail("module.access_scope", `expected ${cfg.scope}, live ${mod.access_scope}`);
  else ok("module.access_scope", cfg.scope);
  if (isEmpty(mod.catalog_module_code)) fail("module.catalog_module_code", "empty — lineage stamp did not land");
  else ok("module.catalog_module_code", String(mod.catalog_module_code));
  if (mod.view_permission !== `${slug}:read`) fail("module.view_permission", `expected ${slug}:read, live ${mod.view_permission}`);
  else ok("module.view_permission", `${slug}:read`);

  // Module permission FKs dereference to the right permission_name (or null under basic).
  const checkPermFk = async (col: string, expectedName: string | null) => {
    const id = mod[col];
    if (expectedName === null) {
      if (!isEmpty(id)) warn(`module.${col}`, `expected null under basic, live ${id}`);
      else ok(`module.${col}`, "null (basic)");
      return;
    }
    if (isEmpty(id)) { fail(`module.${col}`, `null — expected to dereference to ${expectedName}`); return; }
    const p = await read1("read_permission", `id=eq.${id}`);
    if (!p) fail(`module.${col}`, `id ${id} dereferences to no permission`);
    else if (p.permission_name !== expectedName) fail(`module.${col}`, `dereferences to ${p.permission_name}, expected ${expectedName}`);
    else ok(`module.${col}`, expectedName);
  };
  await checkPermFk("manage_permission_id", `${slug}:manage`);
  await checkPermFk("admin_permission_id", hasAdmin ? `${slug}:admin` : null);

  // Baseline permissions exist and carry module_id.
  const checkPerm = async (name: string): Promise<any | null> => {
    const p = await read1("read_permission", `permission_name=eq.${name}`);
    if (!p) { fail(`permission ${name}`, "missing"); return null; }
    if (isEmpty(p.module_id) || p.module_id !== mod.id) fail(`permission ${name}.module_id`, `expected ${mod.id}, live ${p.module_id}`);
    else ok(`permission ${name}`, `id ${p.id}`);
    return p;
  };
  const readP = await checkPerm(`${slug}:read`);
  const manageP = await checkPerm(`${slug}:manage`);
  const adminP = hasAdmin ? await checkPerm(`${slug}:admin`) : null;

  // Baseline hierarchy edges.
  const checkEdge = async (incl: any, included: any, label: string) => {
    if (!incl || !included) return;   // an upstream permission check already failed
    const e = await read1("read_permission_hierarchy",
      `including_permission_id=eq.${incl.id}&included_permission_id=eq.${included.id}`);
    if (!e) fail(`hierarchy ${label}`, "edge missing");
    else ok(`hierarchy ${label}`, "present");
  };
  await checkEdge(manageP, readP, `${slug}:manage→read`);
  if (hasAdmin) await checkEdge(adminP, manageP, `${slug}:admin→manage`);

  // Default-role FKs dereference to the right role (slug + module_id + origin), each with its baseline grant.
  const checkRole = async (col: string, role: BaselineRole | undefined, grantPerm: any, tier: string) => {
    if (!role) return;
    const wantSlug = roleSlug(role.slug);
    const id = mod[col];
    if (isEmpty(id)) { fail(`module.${col}`, `null — expected role ${wantSlug}`); return; }
    const r = await read1("read_role", `id=eq.${id}`);
    if (!r) { fail(`module.${col}`, `id ${id} dereferences to no role`); return; }
    let clean = true;
    if (r.slug !== wantSlug) { fail(`module.${col}`, `dereferences to role ${r.slug}, expected ${wantSlug}`); clean = false; }
    if (isEmpty(r.module_id) || r.module_id !== mod.id) { fail(`role ${wantSlug}.module_id`, `expected ${mod.id}, live ${r.module_id} (orphan — invisible in module governance)`); clean = false; }
    if (r.origin !== "model" && r.origin !== "model_master") { fail(`role ${wantSlug}.origin`, `expected model/model_master, live ${r.origin}`); clean = false; }
    if (clean) ok(`role ${wantSlug}`, `id ${r.id}, origin ${r.origin}`);
    if (grantPerm) {
      const rp = await read1("read_role_permission", `role_id=eq.${r.id}&permission_id=eq.${grantPerm.id}`);
      if (!rp) fail(`role_permission ${wantSlug}→${tier}`, "grant missing");
      else ok(`role_permission ${wantSlug}→${tier}`, "present");
    }
  };
  await checkRole("default_viewer_role_id", cfg.roles.viewer, readP, `${slug}:read`);
  await checkRole("default_manager_role_id", cfg.roles.manager, manageP, `${slug}:manage`);
  if (hasAdmin) await checkRole("default_admin_role_id", cfg.roles.admin, adminP, `${slug}:admin`);
  else if (!isEmpty(mod.default_admin_role_id)) warn("module.default_admin_role_id", `expected null under basic, live ${mod.default_admin_role_id}`);

  throwIfFailed(f);
  return f;
}

// ──────────────────────────── deploy-version stamp (Stage 5b) ─────────────────

export interface DeployVersionStamp {
  specPath: string;              // the *-semantic-spec.md that was just deployed (the file to stamp)
  moduleSlug: string;            // this module's slug
  relatedModuleSlugs?: string[]; // reuse-from / promote-to-master SOURCE modules → deployed_related_versions
}

/**
 * Stage 5b, MECHANIZED — the un-skippable version stamp, run as the last step inside
 * `runDeploy` right after `verifyScaffold`. Reads the platform-maintained
 * `modules.version` / `version_date` (the platform bumps them on every schema write,
 * so they are stable only AFTER all Stage 4 writes settle — call this LAST), then
 * upserts `deployed_version` / `deployed_version_date` / `deployed_related_versions`
 * into the spec file's YAML frontmatter (an in-place upsert — no other byte changes).
 * Finally it RE-READS the file and asserts the stamp landed and equals live; it THROWS
 * on mismatch, exactly like `verifyScaffold`, so a missing / failed stamp HALTS the
 * deploy instead of letting "model is live" print. This is why the stamp can't be
 * silently skipped the way a prose instruction can.
 *
 * The analyst's Stage 2a.1 gate reads `deployed_version` next run to decide, in one
 * read, whether prod drifted since deploy. This is the ONLY write the modeler makes
 * to the spec file.
 *
 * Graceful degradation: if the live module has no `version` (platform predates the
 * column), it logs and returns null WITHOUT touching the spec — an un-stamped spec is
 * safe (the analyst gate falls back to full inspection).
 */
export async function stampDeployedVersion(
  stamp: DeployVersionStamp,
): Promise<{ version: number; versionDate: string | null; related: Record<string, number> } | null> {
  const mod = await read1("read_module", `module_slug=eq.${stamp.moduleSlug}`);
  if (!mod) throw new Error(`stampDeployedVersion: module ${stamp.moduleSlug} not found (deploy incomplete?)`);
  if (mod.version === undefined || mod.version === null) {
    console.warn("🟡 deployed_version: live module has no `version` column (platform too old) — spec left un-stamped.");
    return null;
  }
  const version = Number(mod.version);
  const versionDate: string | null = mod.version_date ?? null;

  // Related (reused / promoted) module versions — lets the analyst detect drift in a REUSED entity too.
  const related: Record<string, number> = {};
  for (const s of stamp.relatedModuleSlugs ?? []) {
    if (s === stamp.moduleSlug) continue;
    const rm = await read1("read_module", `module_slug=eq.${s}`);
    if (rm && rm.version !== undefined && rm.version !== null) related[s] = Number(rm.version);
  }

  // In-place frontmatter upsert (EOL-preserving, CRLF-tolerant).
  const text = await Bun.file(stamp.specPath).text();
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!fm) throw new Error(`stampDeployedVersion: no YAML frontmatter found in ${stamp.specPath}`);
  const start = fm.index ?? 0;
  const before = text.slice(0, start);
  const after = text.slice(start + fm[0].length);

  const kept: string[] = [];
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^deployed_version\s*:/.test(lines[i]) || /^deployed_version_date\s*:/.test(lines[i])) continue;
    if (/^deployed_related_versions\s*:/.test(lines[i])) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++;  // drop the nested map lines too
      continue;
    }
    kept.push(lines[i]);
  }

  const block: string[] = [`deployed_version: ${version}`];
  if (versionDate) block.push(`deployed_version_date: "${versionDate}"`);
  const relKeys = Object.keys(related).sort();
  if (relKeys.length) {
    block.push("deployed_related_versions:");
    for (const k of relKeys) block.push(`  ${k}: ${related[k]}`);
  }

  const entIdx = kept.findIndex((l) => /^entities\s*:/.test(l));   // place before entities:, matching the template
  if (entIdx >= 0) kept.splice(entIdx, 0, ...block);
  else kept.push(...block);

  await Bun.write(stamp.specPath, `${before}---${eol}${kept.join(eol)}${eol}---${eol}${after}`);

  // Re-read + assert the stamp landed and matches live — the verifyScaffold-style hard gate.
  const check = await Bun.file(stamp.specPath).text();
  const cfm = check.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const got = cfm && cfm[1].match(/^deployed_version\s*:\s*(\d+)\s*$/m);
  if (!got || Number(got[1]) !== version) {
    throw new Error(
      `stampDeployedVersion: assertion FAILED — spec ${stamp.specPath} deployed_version=${got?.[1] ?? "<absent>"} ` +
      `does not match live modules.version=${version}. The stamp did not land; the deploy is not finalized.`,
    );
  }
  console.log(`✓ deployed_version ${version} stamped into ${stamp.specPath}${relKeys.length ? ` (+${relKeys.length} related)` : ""}`);
  return { version, versionDate, related };
}
