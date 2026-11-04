---
name: semantius-optimizer
description: >-
  Reverse-engineers a `*-semantic-spec.md` file from a live Semantius module:
  entities, fields, enum values, permissions, roles, and permission hierarchy,
  plus referenced built-ins (e.g. `users`), in the standard spec format.
  Deterministic. Trigger
  when the user wants to extract / export / optimize / snapshot /
  reverse-engineer / pull / regenerate a spec from a live Semantius module,
  build a spec for a module created without one, bring a customized live
  module back in sync with a markdown spec, or see a diagram of a deployed
  module. Example phrases: "generate a spec from the `{slug}` module",
  "reverse-engineer the `{slug}` module into a spec", "someone built a
  module in the UI, get me a spec", "draw a diagram of the `{slug}` module".
  Do NOT trigger for moving a module with its data between hosts, or
  backing it up as a restorable file: that is semantius-transfer.
---

# semantius-optimizer Skill

Goes from the live catalog to a `*-semantic-spec.md`.

The `*-semantic-spec.md` this skill produces has the standard spec format:
same front-matter keys, same section structure (§1 Overview … §9 Governance), same
reconciliation annotations. That compatibility is the point: without it, a module
built directly in the Semantius UI (or customized live) has no spec.

**Primary use case:** a module exists in production with no spec (built in the UI,
or drifted from its original). This skill produces the missing `*-semantic-spec.md`
from live state.

## Division of responsibility

- **This skill** owns the workflow: pick the module, run the deterministic
  extractor, and present the result.
- **`references/spec-extract-lib.ts`** owns the mapping: it is the single
  deterministic source of the generated markdown. All live→spec rules live there,
  not in prose, so the output is reproducible and every rule is one place.
- **`use-semantius`** owns the platform contract (the `semantius` CLI, PostgREST
  encoding, the built-ins list).
- **This skill is READ-ONLY against Semantius.** It never writes to the platform.
  Any fix is applied to the `.md` only.

## Writing conventions (every output this skill produces)

1. **US English spellings, always** (optimize not `optimise`, behavior not
   `behaviour`, modeling not `modelling`, canceled not `cancelled`). Prefer the
   `-ize` / `-or` / `-er` form.
2. **No em-dashes (`—`).** Use `(...)`, a comma, or split sentences. En-dash and
   hyphen in ranges/compounds are fine.
3. **Singular-subject grammar in prompts** ("Looks good?" not "Look good?").

---

## File format version

This skill writes files at `version: "3.1"` (the `FORMAT_VERSION` constant in
`spec-extract-lib.ts`), the file format version shared by every skill.

`version` is the file format version. It changes only when the file format changes,
and only with the user's approval.

---

## Step 0: Load required context

Read first:

- `<skills-root>/use-semantius/SKILL.md` and
  `<skills-root>/use-semantius/references/data-modeling.md` (built-ins list,
  platform constraints).
- `references/spec-extract-lib.ts` in this skill folder (the mapping).

---

## High-level workflow

```
1. Pick module  →  2. Pre-flight the output path, then run the extractor  →  3. Present + verify
```

A request for only a diagram of the module runs the shorter
[Diagram-only run](#diagram-only-run) instead, which writes no file.

### Communicating during the run — work quietly; the report is the deliverable

This is deterministic, mostly mechanical work. On the happy path the user should see
**only three things**: (1) the module-picker table, *if* the module is ambiguous or
was not named; (2) the overwrite question, *if* the output file already exists; (3)
the final report (Stage 3). Nothing else.

Do NOT narrate the steps or explain internal mechanics between tool calls. The
tool-call chips already show progress, so prose like the lines below — every one of
them taken from a real run — is pure noise. Never write anything of this kind:

- "The skill is symlinked to `semantius-plugin/skills/semantius-optimizer`."
- "The canonical output path does not exist yet, so it's free to write."
- "`bun 1.3.12` is available."
- "Running the extractor now (no `--force` needed since the file doesn't exist)."
- "The manual filter didn't apply, but the extractor uses the correct shape internally."

The stage names in this workflow are internal structure — never announce "Stage 1",
"Stage 2a", etc. Load the required context, pre-flight the output path, and run the
extractor **silently**. If the module was named and unambiguous, hand its slug
straight to the extractor — it fails fast with a clear error on an unknown slug, so a
separate confirmation read is optional; don't perform one just to have something to
report. The next words the user reads after their request should be the Stage 3
report itself.

## Stage 1: Pick the module

If the user named a module, use its slug directly. Otherwise list candidates:

```bash
semantius call crud read_module '{"order": "module_name.asc"}'
```

Present `module_name`, `module_slug`, `module_type`, `access_scope` (`custom` /
`basic` / `advanced` / `gated` / `raci`, copied verbatim into the spec) as a compact
table and ask which to extract. Never guess when several match. Never create a
module here (read-only).

## Stage 2: Run the extractor

### Stage 2a: Pre-flight, never overwrite silently

BEFORE doing any work, check whether the output file already exists:

```bash
test -f semantius/specs/<module_slug>-semantic-spec.md && echo EXISTS || echo FREE
```

(PowerShell: `Test-Path semantius/specs/<module_slug>-semantic-spec.md`.)

- **FREE (does not exist):** go to Stage 2b and write it.
- **EXISTS:** STOP and ask the user which they want, then wait for the answer:
  1. **Replace** the existing file.
  2. **Save under a different name** (the user supplies one, or you suggest an
     unused path such as `<slug>-semantic-spec-2.md`).
  3. **Stop** and change nothing.

  Do not guess and do not proceed until the user picks. This check is up front on
  purpose: the extractor must never do a run's worth of reads and then clobber a
  file, and it must never replace an existing file without an explicit yes.

### Stage 2b: Run

```bash
bun run references/spec-extract-lib.ts <module_slug> <chosen_outfile>
```

Pass the path the user chose. Add `--force` ONLY when the user chose **Replace**;
without `--force` the script refuses to overwrite. The script applies the same guard
itself, and it checks the output path first, before any live read, so a direct
invocation also fails fast instead of doing work and then clobbering.

The script reads module, entities (creation order), fields (field-order, auto-
fields stripped), permissions (the rows the module holds, then the rows other modules
hold that it reaches through hierarchy rows, entity columns and rules), roles, and
permission hierarchy; discovers referenced built-ins; and writes the spec. It prints a one-line summary
(entity / permission counts). It is idempotent and side-effect-free against the
platform.

If `bun` is unavailable, `node` also runs it (the script uses only `Bun.spawn` /
`Bun.write`; on plain Node, invoke via `bunx` or install bun; do not hand-port the
mapping into prose, that reintroduces the non-determinism this design removes).

## Stage 3: Present and verify

The deliverable is a SHORT, human-facing report — roughly 6-10 lines. The reader
asked for a spec; answer the three questions they actually have, in order:

1. **Did it work, and where's the file?** One line, with the path as a clickable link.
2. **How far can I trust it?** One sentence: the spec mirrors the live module, so
   everything the platform stores (entities, fields, relationships, enums,
   permissions, roles) is faithful.
3. **What must I fix by hand?** A short list — usually 2-4 items — of things the live
   module doesn't store, so they couldn't be recovered. Phrase each as a plain to-do
   about the spec.

**Write it for the reader.** Do NOT put any of this in the report:
stage numbers, the labels "Category A/B", "byte-compatible", "reverse pass",
"canonical order", "reconciliation annotations", a dumped list of frontmatter keys, or a "trust these" enumeration
of every faithfully-copied section. That vocabulary is internal; reciting it is the
noise this section exists to prevent. If the report runs long, it is narrating
machinery — cut it.

### Worked example of a good report (it-ops-starter)

> **Done — wrote [`it-ops-starter-semantic-spec.md`](semantius/specs/it-ops-starter-semantic-spec.md).**
>
> It mirrors the live module, so the entities, fields, relationships, enums,
> permissions, and roles come straight from what's deployed — trust those.
>
> Three things to fix by hand (the live module doesn't store them, so I couldn't
> recover them):
> - **Overview** is just a placeholder — the module's one-line tagline. Rewrite it
>   into a couple of real sentences.
> - **Field descriptions** are mostly blank; only a few fields carry one.
> - **Some record labels** (e.g. "Contract Number") were guessed from the column
>   name — skim them to make sure they read right.

Adapt the bullets to what actually applies to the module (drop any that don't; the
Overview one almost always applies). Mention lost provenance metadata (license,
source blueprint, related modules, the original request, personas) only if it matters
to this reader, and in one line — never a key-by-key list.

### Internal reference: faithful vs best-effort (use it to choose what to flag; never recite it)

**Category A — faithful from live (trust; nothing to flag):** all platform
frontmatter; §2 table & labels; the Mermaid edge set; every §3 entity annotation
(plural label, label column — omitted on a junction whose live value is null and on a
based entity, audit log, view and edit permission as the entity's live full codes (the
edit line is omitted on a computed entity, and when the live value is the platform default
`admin`), entity type, label parent, key type / prefix /
`**Based on:**`, reconciliation, including `reuse-from <module>.<table>` for a related
entity of another module such as a family base); every §3 field's name / format /
required / Notes; §3 Relationships prose (with the family sentence); §4 rows; §5
enumerations (a `{value, label}` entry as a `` - `value` `` bullet with its `label`, `color`, `icon` and `description` as property sub-bullets); the dotted family edges;
§8.1 permission names, descriptions, `included in :admin?` (derived from the live
hierarchy) and, under `access_scope: raci`, `high risk?` (✓ on a
`workflow-gate (lifecycle)` row that the `<slug>:admin` hierarchy does not include).
§8.1 lists the rows the module holds plus the rows it reaches through hierarchy rows,
its entities' columns and its entities' rules, so an owner-named row another module
holds stays in the spec; another module's `read`, `manage`, `admin` or narrow tier is
never a §8.1 row here. §9.1 baseline roles (with `♻ exists`, since live is the source),
§9.1 hierarchy (every row from a §8.1 permission to a §8.1 permission, whichever module
holds them, plus a family edit grant to another module's bundle), §9.1
Processes catalog. Entity order is the canonical `entity_type` tier
then `table_name` A->Z, so it round-trips against a convention-compliant spec.

**Category B — best-effort or omitted (this is your fix-by-hand source):**
1. Authored frontmatter keys — `description` block, `license`,
   `created_at`, `reconciled_*`, `source_blueprint`, `related_modules`,
   `related_domains`, `departments`, `initial_request`, `persona`,
   `raci_mode` / `raci_mode_source`. Omitted (not persisted).
2. §1 Overview — seeded from the tagline.
3. §2 Purpose column — first sentence of each entity description.
4. §3 label-column titles — humanized field name (`contract_title` → "Contract
   Title"); irregulars like `app_name` → "Application Name" are not recoverable.
5. §3 field Description — live truth, often empty.
6. Built-in entity description (e.g. `users`) — live value, not authored prose.
7. §6 relationship table, §6 `### Outbound handoffs` / `### Inbound handoffs`, §7.1, §7.2 —
   emitted as `_(none: …)_` placeholders (the platform exposes no handoff registry).
8. §8.1 `tier`: a heuristic over what the spec can prove, always a value a deploy
   accepts. `entity-write` is a `write_*` code an owned entity's edit permission names
   or that includes its own `read_*`; `entity-read` is a `read_*` code an owned entity's
   view permission names, or that the module's `read` or its own `write_*` includes.
   Under `access_scope: custom` neither tier is used. `narrow` is a code that includes a
   write permission, or any other code an owned entity's edit permission names,
   `override` a `view_all_*` / `manage_all_*` code, and `bypass_submit_lock` is always
   `workflow-gate (rule)`. Another code a rule cites through `has_permission` or
   `require_permission` is `workflow-gate (lifecycle)` when the citing rule is a
   `workflow_state` transition rule (`value_changed` on `workflow_state`), the code
   sits in the `has_permission` branch next to `is_raci_actor`, or it is checked by a
   create guard (an insert-only rule, `if` on `{"==": [{"var": "$old"}, null]}`), and
   `workflow-gate (rule)` otherwise; a code no rule cites is
   `workflow-gate (lifecycle)`. Under `access_scope: gated`, `high risk?` is `-` on
   every row: the admin holds every gate there, so live state cannot show which gates
   are high-risk.
9. §8.2 Business rules and §9.2 Functional ownership — `_(none: …)_` placeholders
   (the definitional reason under `access_scope: basic` / `custom`, "not extracted"
   otherwise; the Processes placeholder is definitional under every value but `raci`).
10. The RACI surface (`**RACI mode:**`, `**RACI realization:**`, the RACI plan) — NOT
    emitted at all (not even as placeholders; `consistency-check.ts` keys its
    `raci_mode` provenance gate on the `**RACI realization:**` literal). Author by
    hand under `access_scope: raci`.
11. A junction M:N's hand-authored business verb — the structure round-trips (canonical
    "`X` ↔ `Y` is many-to-many through the `<junction>` junction table"), the verb does not.

**Drift check (only when comparing against an authored source spec).** If a value the
platform *does* persist differs from the source spec, that is a deploy bug, not a
limitation here — surface it separately and plainly. Observed on `it-ops-starter`: a
dropped label-field title and some dropped `field.description` values; a malformed
hyphen/underscore role slug. A plain generate run has no source to diff, so this note
does not apply to it.

## Diagram-only run

When the user asks only for a picture of a deployed module ("draw a diagram of the
`{slug}` module", "show how the `{slug}` entities relate"), no spec is written, so
Stage 2a and Stage 3 do not apply:

1. Pick the module as in Stage 1.
2. Run the extractor in diagram mode:

   ```bash
   bun run references/spec-extract-lib.ts <module_slug> --diagram
   ```

   It prints the §2 Mermaid block a full run would write, built from live state: one node per
   entity (related entities of other modules and built-ins included), each diagram edge labeled
   with its relationship field's `relationship_label`, dotted edges for entity families,
   built-ins and shared masters shaded green. Never draw the diagram by hand, and never
   as an `erDiagram` listing columns.
3. Show the printed block unchanged in a `mermaid` fence, after one line naming the
   module and its entity count. Only when a relationship's diagram edge (`-->`) has no label, add
   one line naming those diagram edges (`<from> → <to>`): their relationship fields carry no
   relationship label in the live module, so the arrow has no text until one is set.

Work quietly, as in a full run: the user sees the module picker when it is needed,
then the diagram.

---

## What this skill does not do

- Does **not** write to Semantius (read-only reverse-engineering).
- Does **not** capture user assignments, sample business data, or webhook logs.
- Does **not** invent authored content (§1 beyond a seed, §6/§7, authored
  frontmatter).
