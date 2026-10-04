# Access-control scope: detection and question

*Reference for `semantius-analyst`. Used only from step 4 of the resident Access-control resolution order in SKILL.md.*

> **Interaction level** (the `.interaction_level` switch, read at Step 0). **Saved answer** (`.access_scopes.<system_slug>`, step 1 of the resolution): use it. **Otherwise, advanced mode off:** when this module already exists live, keep its own access control (`semantius call crud read_module --single '{"filters": "module_slug=eq.<system_slug>"}'`, its `access_scope` value; a run with advanced mode off never changes an existing module's access control). For a new module, or an existing one whose `access_scope` is empty, run the detection below and apply its default (**full**, shown to the user as advanced access control, when any row comes back, otherwise **basic**). In both cases create no `Q:` task, fire no widget, do not write `.access_scopes`, and name the choice in the 3g "Picked for you" line ("basic access (read and edit)", "advanced access control, matching your other modules", or, for an existing module, "<basic access | advanced access control> kept as it is"). **Advanced mode on:** run the detection, then ask the question below.
> **Yolo mode, after the go-ahead:** a saved answer still wins; otherwise apply the standard default above (the "advanced mode off" case: an existing module keeps its own access control, a new module follows the instance), with no "Picked for you" line; log it; don't ask ([yolo-mode.md](../../semantius-admin/references/yolo-mode.md)).

**Detection (sets which option leads as Recommended).** Count the live modules that recorded a full-access deploy, excluding the module being reconciled (so a re-deploy doesn't self-trigger):

```bash
semantius call crud read_module '{"filters": "access_scope=eq.full,module_slug=neq.<system_slug>"}'
```

Any row → **default Full** (stay consistent with the modules already using full access control). No rows → **default Basic** (don't impose governance on a setup that isn't using it).

This reads the choice each prior deploy recorded on its own module record (the top-level `modules.access_scope` column), the authoritative per-module signal. Do NOT sniff whether permissions or roles merely exist: a basic-access module also creates `<slug>:read` / `<slug>:manage` permissions and viewer / manager roles, so permission presence cannot tell basic from full and would wrongly default Full on an instance whose other modules are all basic. The modeler persists `access_scope` on every deploy path, so this signal is populated for every module the pipeline has touched.

**The question** (with advanced mode on only; a `Q:` ledger task per SKILL.md → Task tracking, subject = `Q: ` + the exact question text below, `Recorded in: .access_scopes.<system_slug>`; asked per the ledger sequence, and it may share a call with the Stage 3 `Q:` tasks once those are enumerated. `AskUserQuestion` header `Access control`, the Recommended option leading per detection; plain language, US spelling, no em-dashes):

- **When the instance already uses access control:**
  - question: *"Your other modules use role-based access control. Set `<system_name>` up the same way, or keep it to basic access (read and edit only)?"*
  - option 1 (default): label `Advanced access control (Recommended)`, description *"Roles, permissions, approval gates, and per-stage gating, consistent with how your other modules work."*
  - option 2: label `Basic access (read and edit)`, description *"Just read and edit. No roles to manage, no approval steps, no per-stage gating. Records and their stages still exist; moving a record through its stages just isn't restricted. You can add advanced access control later."*
- **When the instance does not yet use access control:**
  - question: *"How should `<system_name>` handle access control?"*
  - option 1 (default): label `Basic access (read and edit) (Recommended)`, description *"Just read and edit, the simplest way to get going. No roles, no approval steps, no per-stage gating. You can add advanced access control later."*
  - option 2: label `Advanced access control`, description *"Roles, permissions, approval gates on sensitive actions, and per-stage gating of record lifecycles. More to set up, fine-grained control over who can do what."*
