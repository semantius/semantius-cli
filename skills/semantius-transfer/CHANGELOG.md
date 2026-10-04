# semantius-transfer — changelog

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## Unreleased: signs in to a named host on request

2026-10-04. When `semantius --host <h> whoami` exits 5 in Preflight 3, the skill no longer only tells the user to run `semantius login --host <h>`: it asks (Sign in / Stop) and, on Sign in, runs `semantius login --host <h>` in the background and relays the sign-in link, with `--login-flow device` when the user is not at the machine. It still never runs `use` (which would switch the current host) or `logout`. The Writing conventions list that question beside the Stage 3 gate. The preflight's CLI version note is gone; the skill ships with the CLI it describes.

---

## Unreleased: `id_refentity` is create-only

2026-09-28. The resident rules name `id_refentity` (the base of an `is_a` / `has_a` entity) alongside `id_type`: set only when the import creates the entity; an existing entity keeps its own.

---

## Initial version

2026-09-26. New skill owning the CLI's four `utils` transfer tools (`export_module`, `export_entities`, `import_module`, `import_entities`, CLI 0.8.9 or later) and the workflow around them: transfer between hosts, backup to a file, restore from a file. Before it, the requests these tools serve routed elsewhere by description: a module move to `semantius-optimizer` (a markdown spec, no records), a table clone to `semantius-admin`'s clone-and-deploy (no records, wrong host), a backup to admin's hand-rolled 5.2 dump (no restore path), a restore nowhere.

- Preflight probes every named host with `semantius --host <h> whoami` before any tool runs, because the transfer tools report an authentication failure as exit 4, not 5. Never runs `login`, `logout` or `use`.
- One confirmation gate before an import, naming the target host, the per-entity record counts, and the overwrite-by-id behavior.
- Verification re-runs the import (a converged import writes nothing) and counts records on the target.
- States that validation rules are written before records (CLI change `64bd779`), so a record that violates them fails the import, and a retry is not the fix.

Companion edits: `semantius-admin` (backup verb, routing, clone trigger), `semantius-optimizer` and `semantius-importer` (description exclusions), `use-semantius` (routing row), `/semantius:backup`.
