# Per-run diagnostic log (mechanics)

Referenced by `semantius-admin/SKILL.md` (Output discipline section). The *rules* for what reaches chat vs. the log — the surface / never-surface lists, the narration-restraint rules, and the banned-vocabulary list — stay resident in SKILL.md. This file holds only the on-disk mechanics.

---

The pipeline runs inline in a single context (the admin's, Step 4 / Step 6.7), but each sub-skill's own `SKILL.md` still writes its work to a diagnostic file named for that sub-skill's role, so the on-disk trace stays organized by stage. All files live in a single per-run folder named by the run-id. Up to four files (admin, architect, analyst, modeler), one folder.

**The run-id is the timestamp, sampled ONCE.** The admin samples it as the very first action of every invocation and never re-samples it. Sub-skills do NOT call `date` themselves; they read the run-id from the `Run context:` block (Step 7.3) and derive the same folder from it. A second `date` call mid-run would be the bug the file naming is designed to prevent: multiple stages stamping different times, scattering the logs into unrelated files.

```bash
# Admin, very top of Preflight — sample the run-id ONCE for the whole invocation.
RUN_ID="run-$(date -u +%Y%m%d-%H%M%S)"
DIAG_DIR=".tmp_admin/$RUN_ID"
DIAG_LOG="$DIAG_DIR/diag-admin.log"          # the admin's own file (role in the name)
# Best-effort append; a logging failure must never change control flow.
log_diag() { mkdir -p "$DIAG_DIR" 2>/dev/null; printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1" >> "$DIAG_LOG" 2>/dev/null || true; }
```

**File naming — sub-skill role, not a re-sampled timestamp:**

| Agent | Diagnostic file |
|---|---|
| admin (this skill) | `.tmp_admin/<run_id>/diag-admin.log` |
| architect sub-skill | `.tmp_admin/<run_id>/diag-architect.log` |
| analyst sub-skill | `.tmp_admin/<run_id>/diag-analyst.log` |
| modeler sub-skill | `.tmp_admin/<run_id>/diag-modeler.log` |

The admin owns `diag-admin.log`. Each sub-skill writes its own `diag-<role>.log` into the SAME folder, keyed by the shared run-id; the role lives in the filename so the logs never collide and a reader can tell at a glance which stage emitted what. (Sub-skills log per their own SKILLs; the admin sets the folder + naming convention here and holds the single run-id throughout the inline run so each stage joins it.)

Rules for the logs:

- **Best-effort, never blocking.** A failed write is ignored; logging never halts the run or alters a decision.
- **Gitignored and ephemeral.** The whole `.tmp_admin/` tree is in `.gitignore`. The user manages cleanup. Nothing here is committed.
- **Diagnostics, NOT a decision log.** They record check results, timings, and internal transitions, distinct from the banned decision/audit log (see "Things the admin must NEVER do"). Standing decisions still live only in `customizations.yaml`; git remains the decision audit trail.
- **Never named in chat** unless a run fails and the user needs it for support. The final report (Step 6.8) prints the run-folder path once on a failed run; on a clean run, don't mention it at all.
