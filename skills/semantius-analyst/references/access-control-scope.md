# Access-control scope: detection and question

*Reference for `semantius-analyst`. Fired only from step 4 (Detect + ask) of the resident Access-control resolution order in SKILL.md.*

**Detection (sets which option leads as Recommended).** Count the live modules that recorded a full-access deploy, excluding the module being reconciled (so a re-deploy doesn't self-trigger):

```bash
semantius call crud read_module '{"filters": "access_scope=eq.full,module_slug=neq.<system_slug>"}'
```

Any row → **default Full** (stay consistent with the modules already using full access control). No rows → **default Basic** (don't impose governance on a setup that isn't using it).

This reads the choice each prior deploy recorded on its own module record (the top-level `modules.access_scope` column), the authoritative per-module signal. Do NOT sniff whether permissions or roles merely exist: a basic-access module also creates `<slug>:read` / `<slug>:manage` permissions and viewer / manager roles, so permission presence cannot tell basic from full and would wrongly default Full on an instance whose other modules are all basic. The modeler persists `access_scope` on every deploy path, so this signal is populated for every module the pipeline has touched.

**The question** (`AskUserQuestion`, header `Access control`, the Recommended option leading per detection; plain language, US spelling, no em-dashes):

- **When the instance already uses access control:**
  - question: *"Your other modules use role-based access control. Set `<system_name>` up the same way, or keep it to basic access (read and edit only)?"*
  - option 1 (default): label `Advanced access control (Recommended)`, description *"Roles, permissions, approval gates, and per-stage gating, consistent with how your other modules work."*
  - option 2: label `Basic access (read and edit)`, description *"Just read and edit. No roles to manage, no approval steps, no per-stage gating. Records and their stages still exist; moving a record through its stages just isn't restricted. You can add advanced access control later."*
- **When the instance does not yet use access control:**
  - question: *"How should `<system_name>` handle access control?"*
  - option 1 (default): label `Basic access (read and edit) (Recommended)`, description *"Just read and edit, the simplest way to get going. No roles, no approval steps, no per-stage gating. You can add advanced access control later."*
  - option 2: label `Advanced access control`, description *"Roles, permissions, approval gates on sensitive actions, and per-stage gating of record lifecycles. More to set up, fine-grained control over who can do what."*
