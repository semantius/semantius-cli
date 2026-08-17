# Admin-only operations (procedures)

Referenced by `semantius-admin/SKILL.md` Step 5. These operations don't involve the architect / analyst / modeler chain; the admin executes them directly via `use-semantius` (CLI patterns) without spawning sub-skill agents. (Get started / onboarding, Step 5.5, stays resident in SKILL.md because it is a top-level request type with its own flow.)

---

## 5.1 Status

**Status** — when the user asks what is deployed, show what's in the workspace and what's live. Render as markdown prose, NOT code-fenced:

> **Workspace:**
>
> - `semantius/blueprints/ats-candidate-crm-semantic-blueprint.md` (blueprint, blueprint_version 2.0, slug `ats-candidate-crm`)
> - `semantius/specs/ats-candidate-crm-semantic-spec.md` (spec, version 4.1, reconciled 2026-05-25, owns 6 entities)
>
> **Live semantic model:**
>
> - `ats-candidate-crm` — 6 entities, 7 permissions
> - `hcm-core` — 23 entities, 9 permissions
> - `iwms` — 14 entities, 11 permissions
>
> Last deployed: 2026-05-25 by `martin.amm`.

Implementation: read workspace front-matters; call `read_module` / `read_entity` / `read_permission` via use-semantius to list live state.

## 5.2 Backup (semantic-model snapshot)

**Backup** — when the user asks to back up or snapshot, dump the live semantic model into a versioned JSON file (optionally scoped to one module).

Scope:
- With a `module-slug` argument: snapshot just that module (entities, fields, permissions, role-permissions, permission-hierarchy edges, webhook receivers).
- Without an argument: snapshot every module.

Output: `semantius-backup-<YYYYMMDD-HHMMSS>.json` in the current working directory. The format is a stable, replay-friendly JSON shape (one top-level key per resource type, arrays of records).

> Backup does NOT deploy or modify anything. It is read-only.

Implementation:

```bash
mkdir -p .tmp_admin
# Use postgrestRequest or read_* to dump each resource type
# Combine into a single JSON file with deterministic key ordering
# Move to workspace with timestamped filename
```

Backup files include a `_backup_format_version` field so future restore tooling can reject incompatible dumps.

## 5.3 Listing operations

| Command | Behavior |
|---|---|
| `list modules` | `read_module '{}'` → table of `slug / display_name / entity_count / created_at` |
| `list entities in <module>` | `read_entity '{}'` filtered to `module_id` matching `<module>` |
| `list permissions in <module>` | `read_permission '{}'` filtered to `module_id` |
| `list users` | `read_user '{}'` → table of `email / display_name / is_disabled` |
| `list roles` | `read_role '{}'` → table of `role_name / slug / module_id` |

These are convenience wrappers that produce readable terminal output. No interactive prompts; pure reads.

## 5.4 Health check

**Health** — when the user asks to check the connection, verify the instance is reachable and a known entity reads back.

```bash
# Probe — pass '{}' explicitly even though this tool takes no args: a bare
# no-argument call reads its payload from stdin, which hangs indefinitely on
# Windows/PowerShell (see use-semantius/SKILL.md "Core CLI Commands").
semantius call crud getCurrentUser '{}'
# Verify a known built-in
semantius call crud read_entity '{"slug": "users"}'
```

Report `OK / FAIL` with the failure mode. Exit code matches the underlying call.
