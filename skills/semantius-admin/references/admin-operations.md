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

## 5.2 Backup and restore

Not run by the admin. Route to the `semantius-transfer` skill: it exports a module (or a table list) to a restorable JSON file with the CLI's `utils/export_module` / `export_entities`, restores it with `import_module` / `import_entities`, and moves modules or tables between hosts. The file is the CLI's transfer format; there is no separate backup format.

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
semantius whoami     # host, where it came from (host_source), user, credential in use (auth_method)
semantius ping       # one getCurrentUser round trip; exit 5 = no usable credential for this host
# Verify a known built-in. A filter is required: read_entity has no "slug" key, and an
# unfiltered read proves nothing about any one entity.
semantius call crud read_entity --single '{"filters": "table_name=eq.users"}'
```

Report `OK / FAIL` with the host, `host_source`, `auth_method` and the failure mode. Exit code matches the underlying call.
