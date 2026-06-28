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
 *                               module_id + origin, slug hyphen-normalized)
 *     → baseline role_permissions
 *     → the SIX module-record FK wires + access_scope
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

import { read1, write } from "./deploy-lib";

/** Bump in lockstep with the modeler `EXPECTED_MAJOR` / analyst major. Schema-coupled. */
export const SCAFFOLD_LIB_MAJOR = 5;

// ───────────────────────────── live-schema preflight ─────────────────────────

/**
 * Read a crud tool's LIVE input schema via `semantius info crud <tool>` and
 * return the set of accepted `data` field names (falling back to top-level
 * properties for tools that aren't `{data}`-wrapped). Throws loud if the info
 * command fails or its output can't be parsed — "can't verify" halts, per the
 * loud-failure contract.
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
  const props = schema?.properties?.data?.properties ?? schema?.properties ?? {};
  return new Set(Object.keys(props));
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

/** Ensure a permission exists with `module_id`; return its id (resolved by read, never off the create). */
async function ensurePermission(name: string, description: string, moduleId: number): Promise<number> {
  const live = await read1("read_permission", `permission_name=eq.${name}`);
  if (live) {
    if (isEmpty(live.module_id) || live.module_id !== moduleId) {
      await write("update_permission", { id: live.id, data: { module_id: moduleId } });
    }
    return live.id;
  }
  await write("create_permission", { data: { permission_name: name, description, module_id: moduleId } });
  const created = await read1("read_permission", `permission_name=eq.${name}`);
  if (!created) throw new Error(`scaffold: create_permission ${name} reported success but did not land`);
  return created.id;
}

/** Idempotent hierarchy edge: `including` *includes* `included`. */
async function ensureHierarchy(includingId: number, includedId: number, origin: Origin): Promise<void> {
  const live = await read1(
    "read_permission_hierarchy",
    `including_permission_id=eq.${includingId}&included_permission_id=eq.${includedId}`,
  );
  if (live) return;
  await write("create_permission_hierarchy", {
    data: { including_permission_id: includingId, included_permission_id: includedId, origin },
  });
}

/** Ensure a role exists with `module_id` + `origin`; return its id. Slug is hyphen-normalized. */
async function ensureRole(role: BaselineRole, moduleId: number, origin: Origin): Promise<number> {
  const slug = roleSlug(role.slug);
  const live = await read1("read_role", `slug=eq.${slug}`);
  if (live) {
    if (isEmpty(live.module_id) || live.module_id !== moduleId) {
      await write("update_role", { id: live.id, data: { module_id: moduleId } });
    }
    return live.id;
  }
  await write("create_role", {
    data: { role_name: role.role_name, slug, description: role.description, module_id: moduleId, origin },
  });
  const created = await read1("read_role", `slug=eq.${slug}`);
  if (!created) throw new Error(`scaffold: create_role ${slug} reported success but did not land`);
  return created.id;
}

/** Idempotent role↔permission grant. */
async function ensureRolePermission(roleId: number, permissionId: number): Promise<void> {
  const live = await read1("read_role_permission", `role_id=eq.${roleId}&permission_id=eq.${permissionId}`);
  if (live) return;
  await write("create_role_permission", { data: { role_id: roleId, permission_id: permissionId } });
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
                    "catalog_module_code", "domain_code", "icon_name", "access_scope", "settings"],
    create_permission: ["permission_name", "description", "module_id"],
    create_permission_hierarchy: ["including_permission_id", "included_permission_id", "origin"],
    create_role: ["role_name", "slug", "description", "module_id", "origin"],
    create_role_permission: ["role_id", "permission_id"],
  });

  // 1-2. Module (+ provenance) and baseline permissions.
  const moduleId = await ensureModule(cfg.module, cfg.scope);
  const readId = await ensurePermission(`${slug}:read`, cfg.permissions.read, moduleId);
  const manageId = await ensurePermission(`${slug}:manage`, cfg.permissions.manage, moduleId);
  const adminId = hasAdmin
    ? await ensurePermission(`${slug}:admin`, cfg.permissions.admin!, moduleId)
    : undefined;

  // 3. Baseline hierarchy: manage→read, plus admin→manage when the admin tier exists.
  await ensureHierarchy(manageId, readId, origin);
  if (adminId !== undefined) await ensureHierarchy(adminId, manageId, origin);

  // 4. Baseline roles + their baseline grants.
  const viewerId = await ensureRole(cfg.roles.viewer, moduleId, origin);
  const managerId = await ensureRole(cfg.roles.manager, moduleId, origin);
  const adminRoleId = hasAdmin ? await ensureRole(cfg.roles.admin!, moduleId, origin) : undefined;
  await ensureRolePermission(viewerId, readId);
  await ensureRolePermission(managerId, manageId);
  if (adminRoleId !== undefined && adminId !== undefined) await ensureRolePermission(adminRoleId, adminId);

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
