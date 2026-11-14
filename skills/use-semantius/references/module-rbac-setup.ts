#!/usr/bin/env bun
/**
 * module-rbac-setup.ts — creates a module with its icon, color, permissions, permission
 * hierarchy, roles, grants and default roles, or fills what an existing module is missing.
 *
 * Creates `<slug>:read`, `<slug>:manage` and `<slug>:admin`, `manage` includes `read` and
 * `admin` includes `manage`, the roles `<slug with - as _>_viewer`, `_manager` and `_admin`
 * with one grant each, and sets the module's permissions, `access_scope: advanced` and
 * default roles. Everything is read first and only what is missing is written, so a re-run
 * after a failure picks up where it stopped. A value that is set is never changed.
 *
 * Reads and writes through the `semantius` CLI.
 *
 * Usage:   bun module-rbac-setup.ts --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name>
 *          bun module-rbac-setup.ts --slug <module-slug>
 *          The second form is for a module that exists: it takes everything else from the
 *          live module and fills what is missing (an empty icon becomes `box`).
 *          Optional: --domain <CODE>, --color <#rrggbb>, --dry-run (writes nothing),
 *          --adopt (fills a `custom` module that has entities, only after the user agreed).
 *          bun module-rbac-setup.ts --slug <module-slug> --access <access.json>
 *          applies the module's access record (access-rules.ts) to a module that has its entities: the gate
 *          permissions, bundles, hierarchy rows, roles and grants, `access_scope: gated`, the fields the gates
 *          need, the validation rules, computed stamps and select rules, `include_hidden_rows` on the rollups
 *          those affect, and each entity's class and edit permission. Only what is missing or different is
 *          written; a generated rule is recognized by its name. Run again, it is the verification. Not for a
 *          `raci` module or a module with per-entity permissions.
 * Output:  first line `module_id: <id>` (`new` in a dry run), then what was created or kept
 *          per kind, the icon, the color and the role ids. For a module that has entities, the
 *          verify report follows: a `report module` line with its access_scope, one `report entity` line per entity (class, key
 *          type and prefix, view and edit permission, the names of its validation rules and computed fields, whether it has a
 *          select_rule), one `report hierarchy` line per row whose
 *          including permission is `<slug>:*`, and one `report role` line per role of the
 *          module with its grants. With --access, `access …` lines say what was created, set or kept, and
 *          the lines between `access summary:` and `end of access summary` are the module's access in plain
 *          words, as markdown, for the final response. A run that changed
 *          nothing ends `Nothing created or changed.`; a run with --access that wrote ends `Done. Run this once
 *          more: that run is the verification.`; a run with --access that printed a `warning:` ends
 *          `Not verified: <n> problem(s) above; fix them and run this again.`
 * Exit:    0 done; 1 a conflict, named, that the user has to settle; 2 bad flags, a bad access
 *          record (nothing written), or the instance cannot be read; 3 a write was rejected, named;
 *          4 with --access, not verified: the warnings above name what to fix
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkedPermissions, closest } from "./permission-names";
import { PREFIX_RULE, prefixRuleProblem, singularsOf } from "./call-file";
import { planAccess, sameJson } from "./access-rules";

type Row = Record<string, any>;
type Reply = { code: number; out: string; err: string };
export type Transport = (tool: string, args: object) => Promise<Reply>;
export type Options = { slug: string; name?: string; description?: string; icon?: string; domain?: string; color?: string; dryRun: boolean; adopt: boolean; access?: string };

const USAGE = 'Usage: bun module-rbac-setup.ts --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name> [--domain <CODE>] [--color <#rrggbb>] [--dry-run] [--adopt]\n       bun module-rbac-setup.ts --slug <module-slug> --access <access.json> [--dry-run]';
const NOTHING = "Nothing created or changed.";
// With --access, the run after one that wrote is the verification; a run that changed nothing needs no other.
const DONE_ACCESS = "Done. Run this once more: that run is the verification.";
const FIELD_COLUMNS = "table_name,field_name,title,format,enum_values,reference_table,reference_delete_mode,input_type,ctype,rollup,field_order,default_value";
const ENTITY_COLUMNS = "table_name,singular,singular_label,plural_label,label_column,entity_type,id_type,id_prefix,view_permission,edit_permission,computed_fields,validation_rules,select_rule";
const MODULE_COLUMNS = "id,module_name,module_slug,description,icon_name,logo_color,domain_code,access_scope,view_permission,manage_permission,admin_permission,default_viewer_role_id,default_manager_role_id,default_admin_role_id";
const NEXT: Record<1 | 2 | 3, string> = {
  1: "Stop and tell the user what is named above; do not edit those rows. Never create these records by hand.",
  2: "Fix the flags, or make the instance readable, and run this again. Never create these records by hand.",
  3: 'Tell the user what was rejected. Fix the cause and run this again; it picks up where it stopped. If the platform keeps refusing, finish the setup with the calls in rbac.md, "Adding permissions and roles to an existing module", and say so in the final response.',
};
const TIERS = [
  { tier: "viewer", level: "read", title: "Viewer", permission: "Read {name} data", role: "Can view {name} data" },
  { tier: "manager", level: "manage", title: "Manager", permission: "Create, update, and delete {name} data", role: "Can manage all {name} data" },
  { tier: "admin", level: "admin", title: "Admin", permission: "Maintain {name} settings and reference data, and take every gated step", role: "Can maintain {name} settings and reference data, and take every gated step" },
] as const;

class Exit extends Error {
  constructor(readonly code: 1 | 2 | 3, message: string) { super(message); }
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === "";
const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0] ?? "";

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** A dark red, orange, green or blue shade picked by an FNV-1a hash of the slug: the same slug always gives the same color. */
export function slugColor(slug: string): string {
  let hash = 2166136261;
  for (const c of slug) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  const [from, to] = ([[350, 370], [20, 40], [100, 150], [205, 240]] as const)[hash % 4];
  const hue = (from + ((hash >>> 8) % (to - from + 1))) % 360;
  return hslToHex(hue, 55 + ((hash >>> 16) % 36), 18 + ((hash >>> 24) % 13));
}

/** Parses and checks the flags; throws `Exit` 2 with every problem it finds. */
export function parseFlags(argv: string[]): Options {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        name: { type: "string" }, slug: { type: "string" }, description: { type: "string" }, icon: { type: "string" },
        domain: { type: "string" }, color: { type: "string" }, "dry-run": { type: "boolean" }, adopt: { type: "boolean" },
        access: { type: "string" },
      },
    }));
  } catch (e) {
    throw new Exit(2, `${e instanceof Error ? e.message : e}\n${USAGE}`);
  }
  const text = (key: string) => (isEmpty(values[key]) ? undefined : (values[key] as string));
  const o: Options = { slug: text("slug") ?? "", name: text("name"), description: text("description"), icon: text("icon"), domain: text("domain"), color: text("color"), dryRun: !!values["dry-run"], adopt: !!values.adopt, access: text("access") };

  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.slug)) problems.push(`--slug must be lowercase, start with a letter or digit, and hold only a-z, 0-9, - and _ (got "${o.slug}")`);
  for (const [flag, value] of [["--name", o.name], ["--description", o.description]] as const) {
    if (value && /[<>]/.test(value)) problems.push(`${flag} still holds a placeholder: "${value}"`);
  }
  if (o.description && o.description.length > 60) problems.push(`--description is ${o.description.length} characters; the limit is 60`);
  if (o.icon && !/^https?:\/\//i.test(o.icon)) {
    const icons: Record<string, string[]> = JSON.parse(readFileSync(join(import.meta.dir, "lucide-icon-tags.json"), "utf8")).icons;
    if (!Object.hasOwn(icons, o.icon)) problems.push(`--icon is not a Lucide icon: "${o.icon}"; find one with lucide-icon-finder.ts, or use box when none fits`);
  }
  if (o.color && !/^#[0-9a-f]{6}$/.test(o.color)) problems.push(`--color must be lowercase #rrggbb (got "${o.color}")`);
  if (o.domain && !/^[A-Z][A-Z0-9_-]*$/.test(o.domain)) problems.push(`--domain must be an uppercase code such as CRM (got "${o.domain}")`);
  if (o.access && o.name) problems.push("--access applies a module's access record to a module that has its entities; create the module first (--name …), then its entities, then run --slug with --access");
  if (problems.length) throw new Exit(2, `${problems.join("\n")}\n${USAGE}`);
  return o;
}

const spawnTransport: Transport = async (tool, args) => {
  const proc = Bun.spawn(["semantius", "call", "crud", tool, JSON.stringify(args)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};

/** A value for a PostgREST `in.()` list: plain when safe, else double-quoted with `\` and `"` escaped. */
const pgValue = (s: string): string => (/^[A-Za-z0-9_$.\-:@]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`);

/** `created a, b; kept c`, with `to create` in a dry run. */
const summary = (dryRun: boolean, created: string[], kept: string[]): string =>
  [created.length ? `${dryRun ? "to create" : "created"} ${created.join(", ")}` : "", kept.length ? `kept ${kept.join(", ")}` : ""].filter(Boolean).join("; ") || "none";

async function setup(o: Options, transport: Transport, out: (line: string) => void): Promise<number> {
  let warned = 0;
  const print = (line: string) => {
    if (line.startsWith("warning:")) warned++;
    out(line);
  };
  const read = async (tool: string, args: object): Promise<Row[]> => {
    const reply = await transport(tool, args);
    if (reply.code !== 0) throw new Exit(2, `${tool} could not read the instance: ${firstLine(reply.err || reply.out)}`);
    try {
      return JSON.parse(reply.out);
    } catch {
      throw new Exit(2, `${tool} did not return JSON: ${firstLine(reply.out)}`);
    }
  };
  const write = async (tool: string, args: object): Promise<void> => {
    const reply = await transport(tool, args);
    if (reply.code !== 0) throw new Exit(3, `${tool} was rejected: ${firstLine(reply.err || reply.out)}`);
  };

  const { slug } = o;
  const permissionOf = (level: string) => `${slug}:${level}`;
  const roleSlugOf = (tier: string) => `${slug.replace(/-/g, "_")}_${tier}`;
  const permissionNames = TIERS.map((t) => permissionOf(t.level));
  const roleSlugs = TIERS.map((t) => roleSlugOf(t.tier));
  const hierarchy = [[permissionOf("manage"), permissionOf("read")], [permissionOf("admin"), permissionOf("manage")]];

  // Each round trip to the host costs seconds, so the reads that do not depend on each other go out together: first
  // the module, with what needs only the slug; then what is filtered by the module's id; the grants need the role ids.
  const roleColumns = { filters: `slug=in.(${roleSlugs.join(",")})`, select: "id,slug,module_id" };
  const [modules, livePermissions, firstRoles, firstHierarchy, rollupRows] = await Promise.all([
    read("read_module", { select: MODULE_COLUMNS }),
    read("read_permission", { filters: `permission_name=in.(${permissionNames.join(",")})`, select: "permission_name,module_id" }),
    read("read_role", roleColumns),
    read("read_permission_hierarchy", { filters: `including_permission_name=ilike.${slug}:*`, select: "including_permission_name,included_permission_name" }),
    o.access ? read("read_field", { filters: "ctype=eq.rollup", select: "id,table_name,rollup" }) : Promise.resolve([] as Row[]),
  ]);
  const live = modules.find((m) => m.module_slug === slug);
  if (!live) {
    const missing = [["--name", o.name], ["--description", o.description], ["--icon", o.icon]].filter(([, v]) => !v).map(([flag]) => flag);
    if (missing.length) throw new Exit(2, `Module ${slug} does not exist yet; a new module also needs ${missing.join(", ")}\n${USAGE}`);
  }

  const name: string = o.name ?? live!.module_name;
  const [firstEntities, firstModuleRoles] = live
    ? await Promise.all([
      read("read_entity", { filters: `module_id=eq.${live.id}`, select: ENTITY_COLUMNS }),
      read("read_role", { filters: `module_id=eq.${live.id}`, select: "id,slug,module_id" }),
    ])
    : [[] as Row[], [] as Row[]];
  let moduleHierarchy = firstHierarchy;
  let moduleRoles = firstModuleRoles;
  let entities = firstEntities;
  let liveRoles = firstRoles;
  const roleBySlug = (s: string) => liveRoles.find((r) => r.slug === s);
  if (o.access) {
    if (!live) throw new Exit(2, `Module ${slug} does not exist yet: --access applies the access record to a module and its entities, so create them first and run this again`);
    if (live.access_scope === "raci") throw new Exit(2, `Module ${slug} is raci: its gates follow its RACI matrix (rbac.md, "A gate in a raci module"), so --access does not apply to it`);
    const perEntity = entities.filter((e) => /:read_/.test(String(e.view_permission ?? "")));
    if (perEntity.length) throw new Exit(2, `Module ${slug} has per-entity permissions (${perEntity.map((e) => e.table_name).join(", ")}), the shape of a module deployed from a spec; --access writes the module-wide shape, so it does not apply to this module`);
  }

  const conflicts: string[] = [];
  const twin = o.name ? modules.find((m) => m.module_name === o.name && m.module_slug !== slug) : undefined;
  if (twin) conflicts.push(`Module name "${o.name}" is already used by the module ${twin.module_slug}`);
  if (live) {
    if (o.name && live.module_name !== o.name) conflicts.push(`Module ${slug} exists under the name "${live.module_name}", not "${o.name}"`);
    if (live.access_scope === "basic") conflicts.push(`Module ${slug} is access_scope basic, which has no admin level`);
    if (live.access_scope === "custom" && entities.length && !o.adopt) conflicts.push(`Module ${slug} is access_scope custom and has entities, so its permissions may be set by hand; only after the user agrees, run this again with --adopt`);
    const reference = (column: string, level: string, ...unset: string[]) => {
      const value = live[column];
      if (!isEmpty(value) && value !== permissionOf(level) && !unset.includes(value)) conflicts.push(`Module ${slug} has ${column} = ${value}, not ${permissionOf(level)}`);
    };
    reference("view_permission", "read", "user:read");
    reference("manage_permission", "manage");
    reference("admin_permission", "admin");
    for (const t of TIERS) {
      const value = live[`default_${t.tier}_role_id`];
      if (!isEmpty(value) && value !== roleBySlug(roleSlugOf(t.tier))?.id) conflicts.push(`Module ${slug} has default_${t.tier}_role_id = ${value}, which is not the role ${roleSlugOf(t.tier)}`);
    }
  }
  for (const p of livePermissions) if (p.module_id !== live?.id) conflicts.push(`Permission ${p.permission_name} is held by another module (id ${p.module_id})`);
  for (const r of liveRoles) if (r.module_id !== live?.id) conflicts.push(`Role ${r.slug} belongs to another module (id ${r.module_id})`);
  if (conflicts.length) throw new Exit(1, conflicts.join("\n"));

  const icon: string = live && !isEmpty(live.icon_name) ? live.icon_name : (o.icon ?? "box");
  const color: string = live && !isEmpty(live.logo_color) ? live.logo_color : (o.color ?? slugColor(slug));

  const update: Row = {};
  if (live) {
    if (isEmpty(live.icon_name)) update.icon_name = icon;
    if (isEmpty(live.logo_color)) update.logo_color = color;
    if (isEmpty(live.domain_code) && o.domain) update.domain_code = o.domain;
    if (isEmpty(live.description) && o.description) update.description = o.description;
  }
  if (!live || isEmpty(live.view_permission) || live.view_permission === "user:read") update.view_permission = permissionOf("read");
  if (!live || isEmpty(live.manage_permission)) update.manage_permission = permissionOf("manage");
  if (!live || isEmpty(live.admin_permission)) update.admin_permission = permissionOf("admin");
  if (!live || isEmpty(live.access_scope) || live.access_scope === "custom") update.access_scope = "advanced";

  const heldPermissions = new Set(livePermissions.map((p) => p.permission_name));
  const missingPermissions = TIERS.filter((t) => !heldPermissions.has(permissionOf(t.level)));
  const heldHierarchy = new Set(moduleHierarchy.map((h) => `${h.including_permission_name}>${h.included_permission_name}`));
  const missingHierarchy = hierarchy.filter(([a, b]) => !heldHierarchy.has(`${a}>${b}`));
  const missingRoles = TIERS.filter((t) => !roleBySlug(roleSlugOf(t.tier)));
  const grantRoleIds = [...new Set([...liveRoles, ...moduleRoles].map((r) => r.id))];
  const accessTables = entities.map((e) => e.table_name);
  // With --access the module's fields are read in the same round trip as the grants: neither needs the other.
  const [firstGrants, accessFields] = await Promise.all([
    grantRoleIds.length ? read("read_role_permission", { filters: `role_id=in.(${grantRoleIds.join(",")})`, select: "role_id,permission_name" }) : Promise.resolve([] as Row[]),
    o.access && live && accessTables.length ? read("read_field", { filters: `table_name=in.(${accessTables.join(",")})`, select: FIELD_COLUMNS }) : Promise.resolve([] as Row[]),
  ]);
  let liveGrants = firstGrants;
  const heldGrants = new Set(liveGrants.map((g) => `${g.role_id}>${g.permission_name}`));
  const grantHeld = (t: (typeof TIERS)[number]) => {
    const role = roleBySlug(roleSlugOf(t.tier));
    return !!role && heldGrants.has(`${role.id}>${permissionOf(t.level)}`);
  };
  const missingGrants = TIERS.filter((t) => !grantHeld(t));
  const missingDefaults = TIERS.filter((t) => !live || isEmpty(live[`default_${t.tier}_role_id`]));

  let moduleId: number | string = live?.id ?? "new";
  if (!o.dryRun) {
    if (!live) {
      await write("create_module", { data: { module_name: name, module_slug: slug, description: o.description, icon_name: icon, logo_color: color, ...(o.domain ? { domain_code: o.domain } : {}) } });
      const created = await read("read_module", { filters: `module_slug=eq.${slug}`, select: "id" });
      if (!created[0]) throw new Exit(3, `create_module reported success but module ${slug} is not there`);
      moduleId = created[0].id;
    }
    if (missingPermissions.length) {
      await write("create_permission", { data: missingPermissions.map((t) => ({ permission_name: permissionOf(t.level), description: t.permission.replace("{name}", name), module_id: moduleId })) });
    }
    if (Object.keys(update).length) await write("update_module", { id: moduleId, data: update });
    if (missingHierarchy.length) {
      await write("create_permission_hierarchy", { data: missingHierarchy.map(([a, b]) => ({ including_permission_name: a, included_permission_name: b })) });
    }
    if (missingRoles.length) {
      await write("create_role", { data: missingRoles.map((t) => ({ role_name: `${name} ${t.title}`, slug: roleSlugOf(t.tier), description: t.role.replace("{name}", name), module_id: moduleId })) });
      liveRoles = await read("read_role", roleColumns);
      const lost = missingRoles.filter((t) => !roleBySlug(roleSlugOf(t.tier)));
      if (lost.length) throw new Exit(3, `create_role reported success but ${lost.map((t) => roleSlugOf(t.tier)).join(", ")} is not there`);
    }
    if (missingGrants.length) {
      await write("create_role_permission", { data: missingGrants.map((t) => ({ role_id: roleBySlug(roleSlugOf(t.tier))!.id, permission_name: permissionOf(t.level) })) });
    }
    if (missingDefaults.length) {
      await write("update_module", { id: moduleId, data: Object.fromEntries(missingDefaults.map((t) => [`default_${t.tier}_role_id`, roleBySlug(roleSlugOf(t.tier))!.id])) });
    }
  }

  let changed = !live || missingPermissions.length > 0 || Object.keys(update).length > 0 || missingHierarchy.length > 0 || missingRoles.length > 0 || missingGrants.length > 0 || missingDefaults.length > 0;
  const missingNames = new Set(missingRoles.map((t) => t.tier));
  const grantLabel = (t: (typeof TIERS)[number]) => `${roleSlugOf(t.tier)} holds ${permissionOf(t.level)}`;
  const settings = [...Object.keys(update), ...missingDefaults.map((t) => `default_${t.tier}_role_id`)];

  print(`module_id: ${moduleId}`);
  print(`module: ${live ? "kept" : o.dryRun ? "to create" : "created"} ${name}`);
  print(`permissions: ${summary(o.dryRun, missingPermissions.map((t) => permissionOf(t.level)), permissionNames.filter((p) => heldPermissions.has(p)))}`);
  print(`hierarchy: ${summary(o.dryRun, missingHierarchy.map(([a, b]) => `${a} includes ${b}`), hierarchy.filter(([a, b]) => heldHierarchy.has(`${a}>${b}`)).map(([a, b]) => `${a} includes ${b}`))}`);
  print(`roles: ${summary(o.dryRun, missingRoles.map((t) => `${name} ${t.title} (${roleSlugOf(t.tier)})`), TIERS.filter((t) => !missingNames.has(t.tier)).map((t) => roleSlugOf(t.tier)))}`);
  print(`grants: ${summary(o.dryRun, missingGrants.map(grantLabel), TIERS.filter(grantHeld).map(grantLabel))}`);
  print(`module settings: ${settings.length ? `${o.dryRun ? "to fill" : "filled"} ${settings.join(", ")}` : "kept"}`);
  print(`icon: ${icon}`);
  print(`color: ${color}`);
  print(`role_ids: ${TIERS.map((t) => `${t.tier}=${roleBySlug(roleSlugOf(t.tier))?.id ?? "new"}`).join(", ")}`);

  // --access: the gates and roles of the module's access record (access-rules.ts), after the tiers they build on.
  let scope = update.access_scope ?? live?.access_scope;
  let accessSummary = "";
  let reread = false;
  if (o.access && live) {
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(o.access, "utf8").replace(/^﻿/, ""));
    } catch (e) {
      throw new Exit(2, `${o.access} is not a readable JSON access record: ${e instanceof Error ? e.message : e}`);
    }
    const plan = planAccess({ slug, moduleName: name, record, entities: entities as any, fields: accessFields as any, otherRollups: rollupRows as any });
    if (plan.problems.length) throw new Exit(2, `${o.access}: nothing was written; fix the access record and run this again:\n${plan.problems.map((p) => `  - ${p}`).join("\n")}`);

    const wantedPermissions = plan.permissions.map((p) => p.permission_name);
    const accessRoleColumns = { filters: `slug=in.(${plan.roles.map((r) => r.slug).join(",") || "none"})`, select: "id,slug,module_id" };
    const [heldAccess, firstAccessRoles] = await Promise.all([
      wantedPermissions.length ? read("read_permission", { filters: `permission_name=in.(${wantedPermissions.map(pgValue).join(",")})`, select: "permission_name,module_id" }) : Promise.resolve([] as Row[]),
      plan.roles.length ? read("read_role", accessRoleColumns) : Promise.resolve([] as Row[]),
    ]);
    for (const p of heldAccess) if (p.module_id !== live.id) print(`warning: permission ${p.permission_name} is held by another module (id ${p.module_id}); the record names it as this module's`);
    const newPermissions = plan.permissions.filter((p) => !heldAccess.some((h) => h.permission_name === p.permission_name));
    const newHierarchy = plan.hierarchy.filter(([x, y]) => !heldHierarchy.has(`${x}>${y}`));
    let accessRoles = firstAccessRoles;
    for (const r of accessRoles) if (r.module_id !== live.id) print(`warning: role ${r.slug} belongs to another module (id ${r.module_id})`);
    const newRoles = plan.roles.filter((r) => !accessRoles.some((x) => x.slug === r.slug));
    const accessGrants = accessRoles.length ? await read("read_role_permission", { filters: `role_id=in.(${accessRoles.map((r) => r.id).join(",")})`, select: "role_id,permission_name" }) : [];
    const grantMissing = (r: (typeof plan.roles)[number]) => {
      const role = accessRoles.find((x) => x.slug === r.slug);
      return !role || !accessGrants.some((g) => g.role_id === role.id && g.permission_name === r.bundle);
    };
    const newGrants = plan.roles.filter(grantMissing);
    const gateScope = plan.gated && live.access_scope !== "gated";
    const ungateScope = !plan.gated && live.access_scope === "gated";
    const entityChanges: Array<{ table: string; data: Row; keys: string[] }> = [];
    const ruleLines: string[] = [];
    for (const [table, desired] of plan.entities) {
      const e = entities.find((x) => x.table_name === table)!;
      const data: Row = {};
      for (const [k, value] of Object.entries(desired)) if (value !== undefined && !sameJson(e[k] ?? (k === "select_rule" ? {} : undefined), value)) data[k] = value;
      if (!Object.keys(data).length) continue;
      entityChanges.push({ table, data, keys: Object.keys(data) });
      for (const r of (data.validation_rules ?? []) as Row[]) {
        const was = (e.validation_rules ?? []).find((x: Row) => x?.name === r.name);
        if (!was) ruleLines.push(`added ${table}.${r.name}`);
        else if (!sameJson(was, r)) ruleLines.push(`replaced ${table}.${r.name}`);
      }
    }
    if (!o.dryRun) {
      if (newPermissions.length) await write("create_permission", { data: newPermissions.map((p) => ({ ...p, module_id: live.id })) });
      if (newHierarchy.length) await write("create_permission_hierarchy", { data: newHierarchy.map(([x, y]) => ({ including_permission_name: x, included_permission_name: y })) });
      if (newRoles.length) {
        await write("create_role", { data: newRoles.map((r) => ({ role_name: r.role_name, slug: r.slug, description: r.description, module_id: live.id })) });
        accessRoles = await read("read_role", accessRoleColumns);
        const lost = newRoles.filter((r) => !accessRoles.some((x) => x.slug === r.slug));
        if (lost.length) throw new Exit(3, `create_role reported success but ${lost.map((r) => r.slug).join(", ")} is not there`);
      }
      if (newGrants.length) await write("create_role_permission", { data: newGrants.map((r) => ({ role_id: accessRoles.find((x) => x.slug === r.slug)!.id, permission_name: r.bundle })) });
      if (gateScope || ungateScope) await write("update_module", { id: live.id, data: { access_scope: gateScope ? "gated" : "advanced" } });
      if (plan.fields.length) await write("create_field", { data: plan.fields });
      for (const r of plan.rollups) await write("update_field", { id: r.id, data: { rollup: r.rollup } });
      for (const c of entityChanges) await write("update_entity", { table_name: c.table, data: c.data });
    }
    const accessChanged = newPermissions.length + newHierarchy.length + newRoles.length + newGrants.length + plan.fields.length + plan.rollups.length + entityChanges.length > 0 || gateScope || ungateScope;
    print(`access permissions: ${summary(o.dryRun, newPermissions.map((p) => p.permission_name), wantedPermissions.filter((p) => !newPermissions.some((x) => x.permission_name === p)))}`);
    print(`access hierarchy: ${summary(o.dryRun, newHierarchy.map(([x, y]) => `${x} includes ${y}`), plan.hierarchy.filter((h) => !newHierarchy.includes(h)).map(([x, y]) => `${x} includes ${y}`))}`);
    print(`access roles: ${summary(o.dryRun, newRoles.map((r) => `${r.role_name} (${r.slug})`), plan.roles.filter((r) => !newRoles.includes(r)).map((r) => r.slug))}`);
    print(`access grants: ${summary(o.dryRun, newGrants.map((r) => `${r.slug} holds ${r.bundle}`), plan.roles.filter((r) => !newGrants.includes(r)).map((r) => `${r.slug} holds ${r.bundle}`))}`);
    print(`access scope: ${gateScope || ungateScope ? `${o.dryRun ? "to set" : "set"} ${gateScope ? "gated" : "advanced"}` : `kept ${live.access_scope}`}`);
    print(`access fields: ${plan.fields.length ? `${o.dryRun ? "to create" : "created"} ${plan.fields.map((f) => `${f.table_name}.${f.field_name}`).join(", ")}` : "none to create"}`);
    if (plan.rollups.length) print(`access rollups: ${o.dryRun ? "to set" : "set"} ${plan.notes.join("; ")}`);
    print(`access entities: ${entityChanges.length ? `${o.dryRun ? "to update" : "updated"} ${entityChanges.map((c) => `${c.table} (${c.keys.join(", ")})`).join(", ")}` : "kept"}`);
    if (ruleLines.length) print(`access rules: ${ruleLines.join(", ")}`);
    for (const w of plan.warnings) print(`warning: ${w}`);
    accessSummary = plan.accessSummary;
    if (accessChanged) changed = true;
    if (accessChanged && !o.dryRun) {
      // The report and the checks below read the module as these writes left it.
      const [again, moduleNow, hierarchyNow, rolesNow, rolesBySlug] = await Promise.all([
        read("read_entity", { filters: `module_id=eq.${live.id}`, select: ENTITY_COLUMNS }),
        read("read_module", { filters: `module_slug=eq.${slug}`, select: "access_scope" }),
        read("read_permission_hierarchy", { filters: `including_permission_name=ilike.${slug}:*`, select: "including_permission_name,included_permission_name" }),
        read("read_role", { filters: `module_id=eq.${live.id}`, select: "id,slug,module_id" }),
        read("read_role", roleColumns),
      ]);
      entities = again;
      scope = moduleNow[0]?.access_scope ?? scope;
      moduleHierarchy = hierarchyNow;
      moduleRoles = rolesNow;
      liveRoles = rolesBySlug;
      const ids = [...new Set([...liveRoles, ...moduleRoles].map((r) => r.id))];
      liveGrants = ids.length ? await read("read_role_permission", { filters: `role_id=in.(${ids.join(",")})`, select: "role_id,permission_name" }) : [];
      reread = true;
    }
  }
  if (scope === "advanced") {
    for (const e of entities.filter((x) => x.entity_type === "operational_workflow")) {
      print(`warning: ${e.table_name} is an operational_workflow but the module is advanced: create its gate (rbac.md, "Restricted steps (gates)"), which makes the module gated, or reclassify it operational_record.`);
    }
  }
  if (scope === "gated" && !entities.some((e) => [...checkedPermissions(e.validation_rules)].some((p) => !permissionNames.includes(p)))) {
    print(`warning: the module is gated but no validation rule checks a gate: create the missing gates (rbac.md, "Restricted steps (gates)"), or set access_scope to advanced when the module has none.`);
  }
  // A name that is not a permission is false for every caller, and the platform saves the rule without a word.
  const checks = entities.flatMap((e) => (["validation_rules", "select_rule"] as const).flatMap((source) =>
    [...checkedPermissions(e[source])].filter((p) => !permissionNames.includes(p)).map((p) => ({ where: `${e.table_name}.${source}`, name: p }))));
  if (checks.length) {
    const names = [...new Set(checks.map((c) => c.name))];
    const known = new Set((await read("read_permission", { filters: `permission_name=in.(${names.map(pgValue).join(",")})`, select: "permission_name" })).map((p) => p.permission_name));
    const missing = checks.filter((x) => !known.has(x.name));
    const own = missing.length ? [...permissionNames, ...(await read("read_permission", { filters: `module_id=eq.${live!.id}`, select: "permission_name" })).map((p) => p.permission_name)] : [];
    for (const c of missing) {
      const near = closest(c.name, own);
      print(`warning: ${c.where} checks "${c.name}", which is not a permission, so the check is false for every caller${near ? ` (did you mean "${near}"?)` : ""}: fix the name or create the permission (rbac.md, "Restricted steps (gates)"). The tiers are ${permissionNames.join(", ")}; viewer, manager and admin are role names.`);
    }
  }
  // A key prefix call-file.ts would have refused: an entity created past it, or before the rule.
  for (const e of entities.filter((x) => ["typeid", "is_a"].includes(x.id_type))) {
    const singulars = singularsOf(e);
    const wrong = prefixRuleProblem(e.id_prefix, singulars);
    if (!wrong) continue;
    const what = e.id_type === "is_a"
      ? "An is_a prefix never changes (90245): leave it."
      : "Change it with update_entity only on an entity this build created that has no records yet; leave any other entity's prefix as it is, because its records keep the old one.";
    print(`warning: ${e.table_name}: id_prefix "${e.id_prefix}" ${wrong}; a key prefix is ${PREFIX_RULE}, here "${singulars[0]}" (data-modeling.md, "Choosing the key type"). ${what}`);
  }
  // The verify report of a module that has entities: what a build checks, read in the same run.
  if (live && entities.length) {
    const names = (value: unknown) => (Array.isArray(value) && value.length ? value.map((x: any) => x?.name ?? x?.code ?? "?").join(", ") : "none");
    const hasRule = (rule: unknown) => !!rule && typeof rule === "object" && Object.keys(rule as object).length > 0;
    if (changed && !reread) print("report: read before this run's writes");
    print(`report module ${slug}: access_scope ${scope}`);
    for (const e of entities) {
      print(`report entity ${e.table_name}: ${e.entity_type}, key ${e.id_type}${e.id_prefix ? ` ${e.id_prefix}` : ""}, view ${e.view_permission}, edit ${e.edit_permission}; validation rules: ${names(e.validation_rules)}; computed fields: ${names(e.computed_fields)}; ${hasRule(e.select_rule) ? "a select_rule" : "no select_rule"}`);
    }
    for (const h of moduleHierarchy) print(`report hierarchy: ${h.including_permission_name} includes ${h.included_permission_name}`);
    const roles = [...new Map([...liveRoles, ...moduleRoles].filter((r) => r.module_id === live.id).map((r) => [r.id, r])).values()];
    for (const r of roles) {
      const held = liveGrants.filter((g) => g.role_id === r.id).map((g) => g.permission_name);
      print(`report role ${r.slug}: holds ${held.length ? held.join(", ") : "nothing"}`);
    }
  }
  if (accessSummary) print(`access summary:\n${accessSummary}\nend of access summary`);
  // With --access, a warning means the module does not match its record yet: the run is not a verification.
  if (o.access && warned) {
    print(`Not verified: ${warned} problem(s) above; fix them and run this again.`);
    return 4;
  }
  print(!changed ? NOTHING : o.dryRun ? "Dry run: nothing was written." : o.access ? DONE_ACCESS : "Done.");
  return 0;
}

/** Runs the script and returns its exit code. */
export async function main(argv: string[], transport: Transport = spawnTransport, print: (line: string) => void = console.log, printError: (line: string) => void = console.error): Promise<number> {
  try {
    return await setup(parseFlags(argv), transport, print);
  } catch (e) {
    const exit = e instanceof Exit ? e : new Exit(3, e instanceof Error ? e.message : String(e));
    printError(exit.message);
    printError(NEXT[exit.code]);
    return exit.code;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
