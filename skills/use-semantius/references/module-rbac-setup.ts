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
 * Output:  first line `module_id: <id>` (`new` in a dry run), then what was created or kept
 *          per kind, the icon, the color and the role ids. A run that changed nothing ends
 *          `Nothing created or changed.`
 * Exit:    0 done; 1 a conflict, named, that the user has to settle; 2 bad flags or the
 *          instance cannot be read; 3 a write was rejected, named
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Row = Record<string, any>;
type Reply = { code: number; out: string; err: string };
export type Transport = (tool: string, args: object) => Promise<Reply>;
export type Options = { slug: string; name?: string; description?: string; icon?: string; domain?: string; color?: string; dryRun: boolean; adopt: boolean };

const USAGE = 'Usage: bun module-rbac-setup.ts --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name> [--domain <CODE>] [--color <#rrggbb>] [--dry-run] [--adopt]';
const NOTHING = "Nothing created or changed.";
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
      },
    }));
  } catch (e) {
    throw new Exit(2, `${e instanceof Error ? e.message : e}\n${USAGE}`);
  }
  const text = (key: string) => (isEmpty(values[key]) ? undefined : (values[key] as string));
  const o: Options = { slug: text("slug") ?? "", name: text("name"), description: text("description"), icon: text("icon"), domain: text("domain"), color: text("color"), dryRun: !!values["dry-run"], adopt: !!values.adopt };

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
  if (problems.length) throw new Exit(2, `${problems.join("\n")}\n${USAGE}`);
  return o;
}

const spawnTransport: Transport = async (tool, args) => {
  const proc = Bun.spawn(["semantius", "call", "crud", tool, JSON.stringify(args)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};

/** Every permission a validation rule checks with `has_permission` or `require_permission`. */
function checkedPermissions(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) checkedPermissions(v, out);
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if ((key === "has_permission" || key === "require_permission") && typeof v === "string") out.add(v);
      else checkedPermissions(v, out);
    }
  }
  return out;
}

/** A value for a PostgREST `in.()` list: plain when safe, else double-quoted with `\` and `"` escaped. */
const pgValue = (s: string): string => (/^[A-Za-z0-9_$.\-:@]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`);

/** The entry of `pool` nearest to `name` by edit distance, when it is at most 3 edits away. */
function closest(name: string, pool: ReadonlyArray<string>): string | undefined {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best: string | undefined;
  let bestDistance = 4;
  for (const p of new Set(pool)) {
    const d = distance(name, p);
    if (d < bestDistance) [best, bestDistance] = [p, d];
  }
  return best;
}

/** `created a, b; kept c`, with `to create` in a dry run. */
const summary = (dryRun: boolean, created: string[], kept: string[]): string =>
  [created.length ? `${dryRun ? "to create" : "created"} ${created.join(", ")}` : "", kept.length ? `kept ${kept.join(", ")}` : ""].filter(Boolean).join("; ") || "none";

async function setup(o: Options, transport: Transport, print: (line: string) => void): Promise<void> {
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
  const modules = await read("read_module", { select: MODULE_COLUMNS });
  const live = modules.find((m) => m.module_slug === slug);
  if (!live) {
    const missing = [["--name", o.name], ["--description", o.description], ["--icon", o.icon]].filter(([, v]) => !v).map(([flag]) => flag);
    if (missing.length) throw new Exit(2, `Module ${slug} does not exist yet; a new module also needs ${missing.join(", ")}\n${USAGE}`);
  }

  const name: string = o.name ?? live!.module_name;
  const permissionOf = (level: string) => `${slug}:${level}`;
  const roleSlugOf = (tier: string) => `${slug.replace(/-/g, "_")}_${tier}`;
  const permissionNames = TIERS.map((t) => permissionOf(t.level));
  const roleSlugs = TIERS.map((t) => roleSlugOf(t.tier));
  const hierarchy = [[permissionOf("manage"), permissionOf("read")], [permissionOf("admin"), permissionOf("manage")]];

  const entities = live ? await read("read_entity", { filters: `module_id=eq.${live.id}`, select: "table_name,entity_type,validation_rules,select_rule" }) : [];
  const livePermissions = await read("read_permission", { filters: `permission_name=in.(${permissionNames.join(",")})`, select: "permission_name,module_id" });
  const roleColumns = { filters: `slug=in.(${roleSlugs.join(",")})`, select: "id,slug,module_id" };
  let liveRoles = await read("read_role", roleColumns);
  const roleBySlug = (s: string) => liveRoles.find((r) => r.slug === s);

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
  const liveHierarchy = await read("read_permission_hierarchy", { filters: `including_permission_name=in.(${hierarchy.map(([a]) => a).join(",")})`, select: "including_permission_name,included_permission_name" });
  const heldHierarchy = new Set(liveHierarchy.map((h) => `${h.including_permission_name}>${h.included_permission_name}`));
  const missingHierarchy = hierarchy.filter(([a, b]) => !heldHierarchy.has(`${a}>${b}`));
  const missingRoles = TIERS.filter((t) => !roleBySlug(roleSlugOf(t.tier)));
  const liveGrants = liveRoles.length ? await read("read_role_permission", { filters: `role_id=in.(${liveRoles.map((r) => r.id).join(",")})`, select: "role_id,permission_name" }) : [];
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

  const changed = !live || missingPermissions.length > 0 || Object.keys(update).length > 0 || missingHierarchy.length > 0 || missingRoles.length > 0 || missingGrants.length > 0 || missingDefaults.length > 0;
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

  const scope = update.access_scope ?? live?.access_scope;
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
  print(!changed ? NOTHING : o.dryRun ? "Dry run: nothing was written." : "Done.");
}

/** Runs the script and returns its exit code. */
export async function main(argv: string[], transport: Transport = spawnTransport, print: (line: string) => void = console.log, printError: (line: string) => void = console.error): Promise<number> {
  try {
    await setup(parseFlags(argv), transport, print);
    return 0;
  } catch (e) {
    const exit = e instanceof Exit ? e : new Exit(3, e instanceof Error ? e.message : String(e));
    printError(exit.message);
    printError(NEXT[exit.code]);
    return exit.code;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
