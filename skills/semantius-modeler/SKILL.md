---
name: semantius-modeler
description: >-
  Deploys a *-semantic-spec.md file (produced by the `semantius-analyst`
  skill) to a live Semantius instance using the `semantius` CLI. The spec is
  already reconciled against the live catalog by the analyst — every entity
  carries an explicit `Reconciliation:` annotation (`create-new`,
  `reuse-from`, `rename-incoming-from`, `promote-to-master`, or `dropped`),
  every cross-model link is resolved, every collision decision is baked in.
  The modeler is a thin executor: parse spec → verify reconciliation
  annotations still hold against live → render plan → execute writes → verify
  → optional sample data. The modeler does NOT detect collisions, classify
  entities, drive merge / rename / promotion widgets, or ask the user about
  catalog ambiguity — that's the analyst's job and the spec is the artifact
  that carries those decisions. If a spec lacks reconciliation annotations or
  the live catalog has drifted since the analyst ran, the modeler refuses to
  execute and routes the user back to the analyst. Trigger when the user has a
  `*-semantic-spec.md` and wants to deploy / apply / push / implement it,
  including phrasings like "deploy the spec", "apply the schema", "push this
  to Semantius", "implement the spec", "now make it real". If the user
  references a `*-semantic-blueprint.md`, route them through the analyst
  first.
---

# semantius-modeler Skill

This skill is the **executor** of the three-skill workflow:

1. **`semantius-architect`** produces the blueprint (entity-level, platform-agnostic).
2. **`semantius-analyst`** reconciles the blueprint against the live Semantius catalog → produces the spec (field-level, with explicit reconciliation annotations on every owned entity).
3. **`semantius-modeler`** (this skill) takes the spec → executes the deploy.

**Division of responsibility:**
- The **analyst** owns the *catalog gatekeeping*: collision detection, classification, merge / rename / promote decisions, optional-entity selection. All of that is baked into the spec by the time the modeler runs.
- This skill owns the *execution workflow*: parsing the spec, verifying the spec's reconciliation annotations still hold, rendering the plan, orchestrating writes, verifying, and optional sample data.
- The **use-semantius skill** owns the *low-level operations*: all Semantius operations are done via the `semantius` CLI tool, following that skill's patterns and reference docs.

## Writing conventions (apply to every output this skill produces)

These rules apply to chat output, plan summaries, verification reports, and anything else this skill writes **for the user to read**. They are not optional style preferences. **They do NOT apply to data the deployer sends to Semantius** — model text (entity descriptions, field descriptions, JsonLogic, enum values, rule messages, etc.) is the user's data and is governed by the "Data fidelity" section below. Never apply em-dash rewrites, US-spelling fixes, or any other house-style edit to a payload bound for `create_entity` / `update_entity` / `create_field` / `update_field` / `create_permission`. The model's content travels untouched into the catalog; the deployer's prose styling stays in chat.

**1. US English spellings, always.** Never British English. Examples that come up often (left = correct US form, right in backticks = banned British form): optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), customize (not `customise`), recognize (not `recognise`), labeled (not `labelled`), materialize (not `materialise`), organization (not `organisation`), summarize (not `summarise`), categorize (not `categorise`), uncategorized (not `uncategorised`), normalize (not `normalise`), harmonize (not `harmonise`), analyze (not `analyse`). When in doubt between two spellings, pick the `-ize` / `-or` / `-er` form.

**2. No em-dashes (`—`, U+2014).** Banned as a parenthetical break or "and" substitute. Replace with: `X — Y` parenthetical → `X (Y)` or `X, Y`; `X — but Y` contrast → `X. But Y.` or `X; Y`; `A — B — C` triplet → split into two sentences. The en-dash (`–`) and hyphen (`-`) are fine in number ranges and compound words; the ban is specifically on `—` used as punctuation. Before writing any file or assistant message, scan for `—` and convert each instance.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?"; "Sounds right?" not "Sound right?". Use the form that agrees with the singular implicit subject; avoid colloquial elided-auxiliary forms in written text.

**4. Semantius entity-label symmetry.** When this skill writes about or proposes entity labels: `singular_label` is the bare singular noun matching `plural_label`. ✅ `Product` / `Products`. ❌ `Product Name` / `Products`. Field-level titles like "Product Name" go on the auto-created `label` field's `title` via `update_field` (the deployer corrects this only when the platform-derived title differs from the §3 Label; see the label-column title note under "Fields That Are Auto-Generated"), never on the entity's `singular_label`.

**5. Plain language in every user-facing surface.** Anything the user reads — `AskUserQuestion` widgets, plan summaries (rendered before each Execute pass), the cross-model-links prompt (when there are 4+ proposals), the final yes/no pre-execute confirmation, verification reports, the closing message, every chat status update along the way — is written for someone who has never opened a spec file. The user is a domain expert (HR director, ATS administrator, operations lead), not a data modeler.

This convention covers **two surfaces** equally:

- **Surface A: `AskUserQuestion` fields and plan/verify summaries** — anything assembled into a structured block the user reads.
- **Surface B: every other thing the user sees in chat** — status updates ("Verifying the spec against your semantic model..."), progress reports, the closing message ("Applied `ats-candidate-crm` to your semantic model. 14 writes.").

Both surfaces follow the same ban list and the same "required" list below.

**Banned in any user-facing surface:**

- Section references: `§1`, `§3`, `§6`, `§7.1`, "the model's §...", "spec's §...". Describe what the section *is* instead — *"the entities list"* (not §3), *"the cross-module connections"* (not §6).
- Reconciliation annotation values as words: `reuse-from`, `rename-incoming-from`, `promote-to-master`, `dropped`, `create-new`.
- File-format / pipeline terms: `spec`, `blueprint`, `frontmatter`, `manifest`, `annotation`, `reconciliation`, `reconcile`, "the spec carries". Where naming the artifact is unavoidable in a status message, use plain English ("the file" / "this design"). *"Reconciliation"* is the analyst's internal name for its own work — never narrate it back to the user; say *"the analyst's pass"* / *"the planning step"* / *"what was decided about reuse"* instead.
- Platform-internal names for the deployed state: `the catalog`, `the live catalog`, `catalog drift`, `the model in the catalog`. The user-facing name is **`your semantic model`** (or *"your live semantic model"* when emphasizing what's deployed). "Catalog" is implementer vocabulary; "semantic model" pairs with the *modeler* skill name and reads as a coherent system in the user's hands.
- Architectural jargon: `gatekeeper`, `data silo`, `embedded master`, `consumer role`, `contributor role`, `mastered_in`, `module_type`, `classDef`, `platform_builtin`, `cross-model link suggestion` (use "connection to another module"), `additive optional column` (use "an optional link").
- Raw identifiers when a display name exists: prefer entity Plural Labels (`Candidates`) over `table_name` (`candidates`), and module display names over slugs. Backticked snake_case tokens are a leak even in status messages.
- **Calling an entity a "field," or calling entities "records."** Keep the three nouns distinct in everything the user reads. An **entity** (table) is a *type of thing the module keeps* — name it by its Plural Label (`Asset Contracts`), or collectively call them **tables** / **record types**, never "fields" and never bare "records." A **field** is a single column / detail *on* a record (`annual cost`) — only columns are "fields." A **record** (row) is one saved item; reserve "records" / "rows" for actual data rows (e.g. sample data). So the deploy contract reads *"Create 5 tables and their fields"* (or *"…and their details"*), ✅ — not *"Create 5 records and their fields"* ❌ (that calls entities "records"), and never *"create the fields"* when the tables/entities are meant ❌.

**Required in any user-facing surface:**

- Entity Singular / Plural Labels from the spec (`Candidates`, `Skill Profiles`).
- Module display names (read from `module_name` via `read_module` when slugs aren't friendly).
- Plain verbs: *connect*, *link*, *add*, *skip*, *deploy*, *update*.
- Plain consequences: *one optional link added between two modules*, *can be removed later by editing the design*, *will resurface next deploy unless removed from the source*.

The internal annotation values (`reuse-from`, `promote-to-master`, etc.) still get **read** from the spec by the parser — only what the user *sees* changes. Plan-summary icons (🟢 / 📥 / 🆎 / ❌) are fine as visual cues; the accompanying text is what needs to read plainly.

**Pre-emit check** (mandatory): before sending any chat message, before firing any `AskUserQuestion`, before printing any plan or verification summary, scan the assembled text for any banned token. Rewrite before sending.

**Narration restraint.** Plain language is necessary but not sufficient. Volume matters too. The user did not ask for a narrated walkthrough of the deploy; they asked for a deployed module. Hard rules:

- **Do not announce what you're about to do** before doing it. No *"Let me verify the reconciliation annotations..."*, no *"Let me check the live catalog..."*. Just do it.
- **Do not narrate self-corrections** mid-flight; fix them silently.
- **Plan summary is one block, not a running commentary.** Render the plan once before execution (per Stage 3), then execute silently. Do not narrate every entity / field / permission creation in chat — the tool-call lines in the transcript are the receipt.
- **Verification (Stage 5)** runs and prints its structured report at the end; nothing else along the way. No intermediate "verifying X..." updates.
- **Close-out is the Closing Contract, nothing more.** The final message is the three-part call-to-action defined in "Closing Contract: clean and sticky" below (a status line, a clickable `[Open <System Name> in Semantius →](<ui_baseurl>/<module_slug>)` link, and the sample-data question). It is not a paragraph, not a recap, not a list of every operation, and never a `/semantius:*` slash command in place of the link. Detailed counts, reused built-ins, and caveats live in the Stage 5 verification summary ABOVE the closing block, separated by a `---`.

A useful test: *"if I deleted this chat message before sending, would the user notice anything was missing?"* If the answer is "no, the work still got done", delete the message.

---

## Data fidelity: model text is user data

Every string the deployer extracts from the model and sends to Semantius (`description`, `singular_label`, `plural_label`, `title`, JsonLogic `message` / `description` cells, enum value labels, `permission` descriptions, `select_rule` and `input_type_rule` JsonLogic, `computed_fields` / `validation_rules` arrays) is **user data**, not deployer prose. It travels into the catalog **byte-for-byte unchanged**. The rules below are not stylistic preferences; they are correctness invariants. A deploy that violates any of them produces silent catalog drift the user cannot see until they read the record in the UI.

**1. No truncation. Ever.** Entity and field descriptions in the model are often multi-sentence (3–6 sentences is normal for entities like `service_requests`, `incidents`, `change_requests`). Every sentence is part of the meaning — typically sentence 2+ encodes invariants, lifecycle rules, terminal states, and gating constraints. Sending only the first sentence loses that information. **Read the full description through to the next blank line / next `**...**` heading / next markdown structural element, and pass the entire span.** If the description spans markdown paragraphs, include the blank line and the second paragraph. Do not summarize for "brevity," do not paraphrase, do not synthesize a shorter version.

**2. No normalization.** The model's text passes through verbatim. Specifically:
- **Backticks** (`` ` ``) around enum tokens, table names, status values stay backticks. *Do not* strip them. They render as inline code in the UI and carry semantic emphasis ("the value `retired` is terminal"). Stripping them turns the prose into "the value retired is terminal" which reads as a different sentence.
- **Apostrophes** (`'`) in possessives (`team's`, `user's`, `incident's`) stay apostrophes. Do not delete them, do not convert to "smart" quotes, do not rewrite the possessive.
- **Em-dashes** (`—`), if the model contains them, stay em-dashes. The Writing Conventions ban on em-dashes applies to deployer chat output only.
- **Quotes** stay as the model wrote them (straight `"`, curly `"`/`"`, doesn't matter — whatever is in the source byte-for-byte).
- **Unicode** characters stay. The platform stores UTF-8; the model is UTF-8; no transliteration is needed.

**3. Shell-safe transport for any text containing special characters.** Backticks, apostrophes, double quotes, dollar signs, multi-line content, and Unicode all break inline shell-arg quoting in subtle ways:
- Double-quoting the JSON (`"{...}"`) makes bash evaluate backticks (`` `cmd` ``) as command substitution. **Disastrous.**
- Single-quoting the JSON (`'{...}'`) breaks the moment any value contains a single quote / apostrophe.
- Escaping is fragile and easy to get wrong field-by-field.
- **Heredocs (`<<'EOF'`) inside an *inline* Bash invocation are NOT enough.** The agent harness transports the entire Bash command as a string through its own quoting layer; an apostrophe inside a heredoc body can still trip the outer parser before bash ever sees the heredoc as a heredoc. Heredocs are safe inside a *file* that bash then reads, not inside a command argument bash is being told to evaluate.

**Canonical pattern: write a script file with the Write tool, then run it.** This is the only form that fully decouples the model's text from any shell quoting layer. The script file is opaque bytes to the harness; the runtime reads it from disk and parses string literals locally.

**Use Bun (TypeScript), not Python.** Bun is a native cross-platform runtime — the same `.ts` file runs identically under PowerShell, Git Bash, macOS, and Linux without path-mapping or interpreter-shim issues. Python is forbidden in this skill: Windows `python3` may not be on `PATH`, `/tmp/` resolves differently between Git Bash and Windows-side Python, and subprocess piping behaves differently across shells. Bun avoids all of that.

```typescript
// Write tool target: <cwd>/.tmp_deploy/deploy_xxx.ts  (see path note below)
async function call(tool: string, payload: unknown) {
  const proc = Bun.spawn(["semantius", "call", "crud", tool], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${tool} failed (${code}): ${stderr}`);
  return JSON.parse(stdout);
}

await call("create_entity", {
  data: {
    description: "Multi-sentence text with `backticks`, apostrophes (team's), and \"quotes\" — all safe.",
  },
});
```

```bash
# Shell: just runs the file, no inline content. Bun reads the .ts source directly.
bun run <cwd>/.tmp_deploy/deploy_xxx.ts
```

The model's text lives inside a TypeScript string literal in a file on disk; it is serialized to JSON by `JSON.stringify` (which never strips backticks, apostrophes, em-dashes, or Unicode); the JSON is fed to `semantius` over stdin as raw bytes by `Bun.spawn`. No shell quoting layer ever sees the text.

**Inline heredoc is a fallback for short ASCII-only payloads only.** When the payload is small and contains no apostrophes, backticks, or Unicode, an inline heredoc is fine:

```bash
semantius call crud create_module <<'JSON'
{"data":{"module_name":"ATS","module_slug":"ats","description":"Applicant Tracking System","module_type":"domain"}}
JSON
```

**Other supported transport forms (when the file already exists on disk, e.g. produced by an earlier Write call):**

```bash
cat /tmp/payload.json | semantius call crud create_entity
semantius call crud create_entity < /tmp/payload.json
```

Build the payload with `JSON.stringify` inside the Bun script (as the in-script wrapper above does). For one-off JSON extraction from a pipeline, use `bun -e` (see the `postgrestRequest` envelope section below). **Never** string-concatenate the model's text into a shell-quoted JSON literal — that's the path that forces character stripping to keep the command parseable. If you find yourself trying to "clean" the model text so it fits an inline command, stop, write a `.ts` script via the Write tool, and run it with `bun run`.

**Cross-platform path note.** Bun on Windows is a native executable, not a POSIX layer, so it resolves paths the same way every shell on the box does — no Git Bash `/tmp/` vs Windows `/tmp/` mismatch. Even so, write deploy scratch files under a folder inside the **current working directory** (e.g. `<cwd>/.tmp_deploy/script.ts`), not under `$TMPDIR` / `/tmp/`. Two reasons: the user can inspect the file by path if a run fails, and `<cwd>` is the one path every shell, the Write tool, and the harness already agree on without translation. Add `.tmp_deploy/` to `.gitignore` once and never think about path mapping again. Clean up the file after the run.

This applies to every write call where the payload contains *any* model-authored text: `create_entity`, `update_entity`, `create_field`, `update_field`, `create_permission`, `update_permission`, anything else that carries user prose or JsonLogic.

**4. Each call carries its own complete payload.** When iterating over multiple entities or fields whose model declarations *look similar* (e.g. the four `*_comments` entities each declare a `visibility` field with the same description and the same `input_type_rule`), do not "optimize" by writing one full payload then short payloads for the rest. Every `create_field` call carries every column the model declares for that field — `description` included — every time. The four comment entities each get their own complete `create_field` for `visibility`, each with the full description string. Identical text repeated across entities is the **expected case**, not a redundancy to eliminate. Generating a batch script that re-uses the first entity's payload as a template and elides "duplicate" keys for subsequent entities is exactly how the `service_request_comments.visibility.description` empty-string regression happens.

**5. `update_*` calls are minimal.** PostgREST PATCH semantics: keys you send are written, keys you omit are left alone. When Stage 4f issues `update_field` to set `data.input_type_rule = <jsonlogic>`, the payload contains **only** `input_type_rule` — never include `description`, `title`, `format`, or any other column unless the model genuinely declares a drift on that column too. **Specifically: the rule-entry's own `description` field** (the analyst's commentary about *the rule itself*, like `"Visibility is editable for the author..."`) **is not the same thing as the field-column's `description`** (the analyst's description of *what the column stores*, like `"Public replies are visible to the requester; internal notes are agent-only"`). The rule-entry's `description` lives **inside** `input_type_rule`'s JsonLogic-array entry and travels into Semantius as part of that array. It must never leak out to become the field's `description` column. Two different surfaces, two different meanings, never crossed.

**Verification posture.** Stage 5's per-entity check (see "Per-area checks") should round-trip every `description` (entity-level and field-level) the model declared and assert byte-equality with the live catalog value. A mismatch is a Stage 5 defect — quote the diff and offer a retry of the offending write. This is the only way truncation / normalization regressions surface before the user notices them in the UI.

---

## Generated artifacts (scripts, intermediate files)

This skill emits shell and Bun (TypeScript) helper scripts during a deploy (e.g. the bulk seeders described in Stage 5, ad-hoc `update_entity` rule appliers, batch field creators when a model has many fields). These are **ephemeral one-shots**, tied to a single model and a single deploy run. They are not skill source.

**Use Bun, not Python.** Any helper that needs more than trivial shell logic — JSON construction, response-envelope unwrapping, capturing IDs across many POSTs, conditional logic over the live catalog — is a `.ts` file run with `bun run`. Python is forbidden: Windows installs don't reliably expose `python3` on `PATH`, virtualenv state pollutes the project, and the Git Bash vs Windows-side `/tmp/` split makes script paths unreliable. Bun is a single native binary, installs once, runs the same on every platform.

**Where they go:**
- **Always** under the current working directory in a scratch folder, e.g. `<cwd>/.tmp_deploy/deploy_<short>.ts` (or `.sh` for the rare pure-shell seeder). `<cwd>` is the one path every shell, the Write tool, and the harness already agree on — no translation, no surprises. Add `.tmp_deploy/` to `.gitignore` once. Delete the file after a successful run.
- Do **not** write to `$TMPDIR` / `/tmp/` / `$env:TEMP`. Those paths resolve differently between Git Bash and Windows-native runtimes, and the user cannot inspect them by path if a run fails.

**Where they must not go:**
- ❌ The skill folder (`.claude/skills/semantius-modeler/`). The skill folder is read-only at runtime; only the maintainer edits it. Never leak deploy scratch files here.
- ❌ The user's working directory. Pollutes the project, surfaces in `git status`, and survives across sessions.
- ❌ Any path under the model file's directory. Same reasons.

**Cleanup:** Delete the scratch file after a successful run with `rm` (Unix / Git Bash) or `Remove-Item` (PowerShell). If the run fails, leave the file in place and report its path so the user can inspect — under `<cwd>/.tmp_deploy/`, never in the skill folder.

This applies to every script this skill writes, not just the seed script at Stage 5.

---

## Schema compatibility: `EXPECTED_MAJOR = 5`

This skill expects spec files written by `semantius-analyst` major `5`. The spec file's front-matter `version: "MAJOR.MINOR"` is checked at the start of Stage 1. **Major must equal `EXPECTED_MAJOR`**, minor is informational and not compared. Files with a different major are rejected with the message:

> *"This spec is for analyst v\<N\>; you have modeler at EXPECTED_MAJOR=5. Re-run `semantius-analyst` on the source blueprint to regenerate the spec."*

A file lacking reconciliation annotations on any entity (the v3.x format) is rejected with the same routing message. The modeler trusts the spec; it does NOT classify entities itself.

The spec also carries `blueprint_version` (the blueprint artifact version the analyst worked against; default `"3.0"`). The modeler does not re-validate it against the architect; the analyst did.

Cross-entity JsonLogic primitives (`set_record`, `let`, `throw_error`) are passed through byte-for-byte inside `validation_rules` / `computed_fields` and (with care) `select_rule`. The "column must exist on this entity" parse check skips column references qualified by a `set_record` / `let` binding (the bound variable's columns resolve against the bound entity). See the anti-pattern table at the bottom of this skill.

**Permission-prefix resolution rule (the "entity-owning-module rule").** Workflow gates and pattern-flag overrides for entity E are prefixed by E's CURRENT owning module slug, not by the installing unit. The rule fires on every install regardless of `module_kind`. Stage 4a-scaffold honors it when minting gates / overrides for entities with re-prefixed-from annotations; Stage 4n handles the master-install reconciliation when a Branch-B promotion moves an entity to a new owning module (sweep every non-canonical-prefixed permission for the entity's verbs, mint sibling canonical-prefixed permissions and `role_permissions` rows, re-emit hierarchy edges; no deletes, per the no-auto-deletion rule).

The history of the deployer's contract changes lives in [`CHANGELOG.md`](./CHANGELOG.md) — what each analyst-lockstep bump changed in the deployer's parser, stage numbering, and audit checks. That file is not loaded at runtime; the body of this SKILL.md is the **current contract**, the CHANGELOG is the **history**.

- **Older major** (e.g. file is `"0.x"`, this skill expects `"1.x"`), the file was written by an older analyst version using a structure this deployer no longer understands. Tell the user to run the analyst skill; its archived-knowledge mode reads the older file and re-authors a current-major file from the same semantic content.
- **Newer major** (e.g. file is `"2.x"`, this skill expects `"1.x"`), the file was written by a newer analyst than this deployer knows about. Tell the user to update this deployer skill before retrying.
- **Missing `version` key** (legacy, pre-versioning), treat as major `0`; same response as older-major above.

When the analyst's major bumps, this skill's `EXPECTED_MAJOR` must be bumped in lock-step (same commit when feasible). The two skills are paired; a major mismatch between the skills themselves is a maintainer error, not a user-facing one.

## Your role: thin executor of a reconciled spec

The analyst is the gatekeeper. The modeler executes.

Semantius is a **unified platform, a universal system of records**. The analyst has already done the catalog-gatekeeping work: collision detection, similarity heuristic, merge / rename / promote widgets, optional-entity selection. By the time the modeler runs, every entity in the spec carries an explicit `**Reconciliation:**` annotation:

| Annotation | Modeler does |
|---|---|
| `create-new` (default, also omitted line) | execute `create_entity` + all fields in the spec |
| `reuse-from <module>.<entity>` | skip `create_entity`; read existing entity for FK targets; the spec has no Fields block for this entity (or has only an `**Additive fields**` block, applied via `create_field`) |
| `rename-incoming-from <module>.<entity> as <new_name>` | execute `create_entity` under `<new_name>` (analyst already chose the disambiguating name) |
| `promote-to-master <master_module>.<entity>` | execute `create_entity` in the master module (not this domain module); add cross-module permission inclusions per spec frontmatter `promotion_decisions` |
| `dropped (optional, user declined)` | skip entirely; no writes |

The modeler **does not**: classify entities itself, detect cross-module collisions, run a similarity heuristic, drive `AskUserQuestion` widgets for catalog decisions, prompt the user about optional entities. All of that lives in the analyst.

The modeler's only catalog-inspection job is a thin **pre-flight verify** (Stage 2): every `reuse-from <module>.<entity>` still resolves to a live entity; every `rename-incoming-from` source still exists; every `promote-to-master <module>.<entity>` target master module is present. If pre-flight fails, halt and route the user back to the analyst — *your semantic model has changed since the planning step ran; re-run `semantius-analyst` to refresh.*

**This skill is designed to be re-run whenever the spec changes.** Because the analyst re-runs against a fresh catalog snapshot whenever the user invokes it, and because the spec carries `reconciled_against_catalog_snapshot` in frontmatter, the modeler can detect "spec is older than current catalog state" and refuse cleanly.

**The spec's entity decisions are fully resolved.** No fuzzy matching at the modeler level for owned entities: every §3 entity carries an explicit `**Reconciliation:**` annotation and every in-model FK target is fully-qualified (`<module>.<table>`). The §6 cross-model link rows are the one exception — they are deliberately *un*resolved hints (`From | To | Verb | Cardinality | Delete`, no module prefix on `To`); the modeler resolves each `To` against the live catalog at deploy time (Stage 2g), proposes the FK when a single match exists, and asks when several plausibly fit.

**Built-ins stay built-ins.** Entities annotated `reuse-from semantius_builtin.<table>` (the analyst flagged them in its Stage 2b) are platform infrastructure (`users`, `roles`, `permissions`, …) and **never replaced**. Additive fields on a built-in are applied via `create_field` per the spec's per-built-in `**Additive fields**` block.

---

## Step 0: Load the use-semantius Skill

Before doing anything else, read the use-semantius skill and its data-modeling reference:

```
Read: ../use-semantius/SKILL.md
Read: ../use-semantius/references/data-modeling.md
```

The data-modeling reference gives you the mandatory creation order, all field formats, the Golden Rules, and exact CLI syntax. Everything in the execution stages below follows those patterns. Also read `references/cli-usage.md` if you need help with CLI invocation, piping, or error handling.

All Semantius operations in this skill are performed using the **`semantius` command-line tool**, for example:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.lead_manager"}'
semantius call crud create_entity '{"data": {...}}'
```

**Always pass `--single` on reads filtered by a unique key** (`id=eq.<int>`, `module_slug=eq.<slug>`, `permission_name=eq.<code>`, `table_name=eq.<unique>`, composite unique keys). `--single` is supported on every `crud` read tool, returns a bare object instead of a one-element array, exits 1 when the row doesn't exist, and exits 2 when the filter is ambiguous — so the canonical "exists / missing / duplicate" branches collapse to the shell exit code, no `[0]` indexing or `[]` checking. Reserve array reads for genuinely zero-or-many queries (catalog sweeps like `read_entity '{}'`, per-table field dumps, list filters).

### Lookup conventions: prefer natural keys, never narrate numeric ids

Three catalog tables carry a **stable, unique, human-readable natural key** alongside their surrogate `id`:

| Table | Natural key | Surrogate |
|---|---|---|
| `modules` | `module_slug` (e.g. `product_roadmap`) | `id` |
| `permissions` | `permission_name` (e.g. `product_roadmap:read`) | `id` |
| `roles` | `slug` (e.g. `product_roadmap_viewer`) | `id` |
| `entities` | `table_name` (e.g. `features`) | implicit, `table_name` is the PK |
| `fields` | `<table_name>.<field_name>` composite | composite, no surrogate |

**Default to the natural key for every read filter, every diff, every verification line, every user-facing narration.** Numeric ids are an internal artifact — they are not stable across instances, not meaningful to a reader of the verification report, and not the natural unit the model file talks in.

- **Existence reads.** Always filter by natural key: `read_module --single {filters: "module_slug=eq.<slug>"}`, `read_permission --single {filters: "permission_name=eq.<code>"}`, `read_role --single {filters: "slug=eq.<slug>_<tier>"}`. The deployer never reads these tables by id unless following an FK back to its natural-key target.
- **FK writes that demand a numeric id.** Some FK columns are typed numeric (`role_permissions.permission_id`, `role_permissions.role_id`, `permission_hierarchy.including_permission_id` / `.included_permission_id`, `modules.manage_permission_id` / `.admin_permission_id`, `modules.default_*_role_id`). For these, **resolve the natural key to its id at write time and discard the id**: `const permId = (await read_permission_single("permission_name=eq.<code>")).id; create_role_permission({role_id, permission_id: permId});`. Never cache numeric ids across calls in a long-lived variable named after the entity (`adminPermId = 10011`) — that creates a stale-coupling failure mode where a redeploy on a different instance silently writes the wrong FK. The pattern is: resolve, use, throw away.
- **FK columns that are text natural keys.** `modules.view_permission` (text holding the permission_name), `entities.view_permission` / `.edit_permission` (text holding permission codes), `fields.reference_table` (text holding a `table_name`) — write the natural key directly; do not resolve to id first. The platform's foreign-key constraint enforces validity via the unique index on the natural-key column.
- **Verification output.** Stage 5 lists modules by slug, permissions by `permission_name`, roles by `slug`, entities by `table_name`. Numeric ids appear in the report only when a row's natural key is missing or the row is being identified by its FK provenance (e.g. *"orphan `permission_hierarchy.id=42` whose `included_permission_id` resolves to no live permission"*). The default-render must not show `id=N` next to a name that already has a natural key.

This is not a stylistic preference. A natural-key read can succeed while a surrogate FK column (e.g. `permissions.module_id`) silently drifts to NULL or the wrong row: the name resolves, so hierarchy and role-permission joins still work, but module-scoped queries miss the row. Stage 5's per-row checks must use the natural key to *locate* the row and then explicitly assert the FK columns on it (see "Module scaffold integrity" in Stage 5).

---

## High-Level Workflow

```
1. Parse spec  →  2. Inspect Semantius  →  2.5 Access-control scope  →  3. Plan & Present  →  4. Execute  →  5. Verify  →  6. Sample Data?
```

Work through each stage in order. Narrate what you're doing at each step.

---

## Stage 1: Parse the spec

Locate the `*-semantic-spec.md` file (produced by `semantius-analyst`). The very first check is the schema-version gate; everything else only runs if the version is compatible.

- **`version`** from YAML frontmatter, required. Compare its **major** part against this skill's `EXPECTED_MAJOR` (see "Schema compatibility" near the top of this file). Major equal → proceed. Major older or missing → stop with a message naming the file's version, this skill's expected major, and the recommended next step (run the analyst's audit mode to migrate). Major newer → stop and ask the user to update this skill. Do not parse the rest of the file when the gate fails; mismatched majors mean the file's structure may not match what the rest of Stage 1 assumes.

**Pre-parse structural gate (consistency-check, fail-fast).** Once the version gate passes, run the deterministic cross-section checker the analyst already runs after every spec write (the same script the architect ships) against the spec, as defense-in-depth before any catalog write. It is read-only and verifies identifier / label / edge agreement across sections (frontmatter ⟺ §2 ⟺ §3 entity sets, §2 ⟺ §3 singular labels, and that every §4 / §5 / §8.2 / Mermaid endpoint resolves to a declared entity). It deliberately does NOT judge content (permissions, field formats, JsonLogic validity, tier semantics, `edit_permission` resolution) — those stay this skill's job (Stage 1 parse-time validation, Stage 2 reconciliation, Stage 5 verify).

```bash
# The checker lives under the architect skill's references folder (shared across the three skills).
# Sibling-relative with an installed-skill-path fallback. Defense-in-depth — the analyst already ran
# it post-write, so an unlocatable checker is a 🟡 note, not a halt.
bun "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/../semantius-architect/references/consistency-check.ts" "<path-to-the-spec>"
```

- **Exit 0** → structural consistency confirmed; proceed to extraction.
- **Exit 1 (inconsistencies)** → halt before any write; print the checker's issue list verbatim and route the user back to `semantius-analyst` (a hand-edited spec drifted, or the analyst's post-write gate was skipped). Do not attempt to repair the spec in the deployer.
- **Checker not found / `bun` unavailable** (the cross-skill path didn't resolve) → emit a 🟡 informational note (*"pre-deploy consistency gate skipped: checker not located; the analyst already ran it at spec-write time"*) and proceed. The gate is additive insurance, not a hard dependency.

The §2 entity-summary column shape (`# | table | Singular label | Purpose`) is enforced by this gate, so the extraction below stays deliberately tolerant (it reads the entity list in §2 order) rather than re-pinning the column layout in prose — one shape gate, not two.

With both gates passed (version + consistency), extract the rest:

- **`system_slug`** from YAML frontmatter, this is the module name
- **`module_type`** from YAML frontmatter, optional. Accepted values: `"domain"` (default when the key is absent) or `"master"`. When `"master"`, this is a **master model** and Stage 2a runs the master-model branch (look up existing master by slug match then entity-overlap match, decide create-vs-extend, coordinate rename cascade if applicable). When `"domain"`, normal create-or-update path. Any other value is a 🛑 High blocker.
- **`module_kind`** from YAML frontmatter, optional, informational only. Common values: `domain`, `master`, `starter`. NOT a behavior switch — the deployer's logic is `module_kind`-agnostic. Surface in the Stage 3 plan-summary line `🏷 module_kind = <kind>`; no other consumption. Any unknown value is fine (warned but not blocked).
- **`access_scope`** from YAML frontmatter, optional. Accepted values: `basic` or `full`. **This one IS a behavior switch** (unlike `module_kind`): it drives Stage 2.5 (Access control scope). When the analyst resolved the access-control choice, this key carries it and the spec is already in the matching shape — the modeler obeys it without re-asking. When the key is absent (a direct deploy, or a spec authored before this change), Stage 2.5 resolves the choice at deploy time. Parse it; Stage 2.5 consumes it. Any value other than `basic` / `full` is a 🛑 High blocker.
- **`tagline`** from YAML frontmatter, optional. Carried verbatim; not provisioned to the module record today (no `modules.tagline` column). Follow-up: extend Stage 4a-scaffold step 5 (`update_module`) when the platform exposes the column.
- **`description`** from YAML frontmatter, optional. Longer marketing-voice prose; same posture as `tagline`. The existing `system_description` (≤40-char) is still what populates `modules.description` (see the Module schema note in 2a).
- **`license`** from YAML frontmatter, optional. Catalog metadata; carry only, no provisioning today.
- **`persona`** from YAML frontmatter, flat list. Authoritative create-list for Stage 4k persona provisioning. Each entry is UPPER-CASE hyphen-separated (`RECRUITING-RECRUITER`, `HIRING-MANAGER`); Stage 4k converts to snake_case for the role slug. Cross-check: every name in this list MUST appear in §9.1 RACI `actor` column at least once (Stage 1 enforces; mismatch is a 🛑 blocker).
- **`promotion_decisions`** from YAML frontmatter, optional. A **list** of objects, one per promoted entity: `{entity: <table_name>, host_module: <master_slug>, manage_option: 1|2|3|4}`. Key into it by `entity`: the `promotion_decisions[<entity>]` notation used in Stages 2d / 4c-promote means *the list entry whose `entity` equals `<entity>`*, NOT a map lookup. `manage_option` drives the cross-module manage-inclusion edges (see analyst Stage 3b for the 1–4 semantics); `host_module` names the master to create or join. A mis-read here silently produces the wrong master-inclusion hierarchy with no surface error, so resolve the entry by exact `entity` match and treat a missing entry for a `promote-to-master` entity as a 🛑 blocker (route back to the analyst).
- **Human-readable system name**, from the top-level heading (`# ... — Semantic Model`)
- **Entity list**, from the §2 entity summary table, in order
- **Per-entity details** from each §3 entity subsection:
  - `table_name`, `singular`, `plural`, `singular_label`, `plural_label`, `description`, `label_column`
  - Fields: `field_name`, `format`, required, `title` (= Label column), reference targets, delete modes
  - Enum values from §5
  - **`**Audit log:**`** line, when present (default `no` when absent or empty).
  - **`**Edit permission:**`** line, when present. Accepted values:
    - `manage` (default, also the value when the line is absent) → `edit_permission = <system_slug>:manage`.
    - `admin` → `edit_permission = <system_slug>:admin`.
    - `<narrow_suffix>` matching a `narrow` tier row in §8.1 → `edit_permission = <system_slug>:<narrow_suffix>`. The parser checks §8.1 for a row whose `permission` cell equals `<system_slug>:<narrow_suffix>` and whose `tier` is `narrow`; if no such row exists, this is a 🛑 High blocker (undeclared narrow tier).

    Carry the resolved value through to Stage 4c's `create_entity` call. The line is not required; treat every entity as `manage` when the line is absent.
  - **`**Shared master cluster:**`** line, when present. Optional per-entity annotation emitted by the analyst for entities recognized as classic master concepts (finance reference data, parties, organization data, products, employees). Free-form snake_case identifier (e.g. `finance`, `parties`, `organization`, `products`, `employees`). The hint is **only** consulted at Stage 2d follow-up 1 when this entity becomes a Branch B promotion candidate (host-module name suggestion / recommended-master selection). It has no effect when the entity is not promoted to a master. Missing line means no hint — defaults apply (bare entity name as the master host's default new-module name). Carry through to Stage 2d but do not validate further.
  - **`**Catalog entity code:**`** line (OWNED entities only). The **canonical** uber-model code (`` `vendors` ``), carried from the blueprint §3 `canonical code` column. Parse the backticked identifier into `catalog_entity_code`. This is the value the deployer stamps into `entities.catalog_entity_code` — **the canonical code, NOT the deployed `table_name`** (which may be a dialect / silo rename). Default to the entity's `table_name` only when the line is absent. See "Provenance stamping" below.
  - **`**Entity type:**`** line (OWNED entities only). One of the closed set `operational_workflow` / `operational_record` / `catalog` / `junction` / `computed`, carried from the blueprint §3 `entity_type` column. Parse into `entity_type`. **When the line is absent, use `'unclassified'` (never `''`)** — that is the platform default and the CHECK-valid sixth value; do NOT invent a value outside the closed set. A value outside the six is a 🛑 High blocker (the platform's CHECK would reject it anyway). See "Provenance stamping" below.
  - **`**Catalog alias:**`** line(s) (OPTIONAL, repeatable). Each carries `{alias_code, source_domain, source_module}` — a cross-domain identity merged onto THIS host entity by a reuse/merge reconciliation. Parse each line into an alias element (adding `decided` = today's date at stamp time). The deployer **APPENDS** these to the host entity's `catalog_entity_aliases` array (never rewriting prior elements). Absent on the common case (no merge). See "Provenance stamping" below.
  - **`**Canonical owner:**`** line (OPTIONAL, placeholder masters only). The owner-module slug for an `embedded_master` entity provisioned locally as a placeholder while its canonical owner module is absent (a first-mover `create-new`, or a silo `rename-incoming-from`). Parse into `canonical_owner_module`. When the line is absent (the common case: this module owns the entity, it is local, or it is reused) stamp `''`. See "Provenance stamping" below.
  - **`Computed fields`** sub-block, when present: parse the fenced ```` ```json ```` array verbatim; default to `[]` when the heading is absent. Each entry has `name` (existing scalar field on this entity), `jsonlogic` (object), optional `description`. The deployer passes the array as-is to `create_entity` / `update_entity`.
  - **`Validation rules`** sub-block, when present: parse the fenced ```` ```json ```` array verbatim; default to `[]` when the heading is absent. Each entry has `code` (snake_case, unique within entity), `message` (required), `jsonlogic` (object), optional `description`. The deployer passes the array as-is to `create_entity` / `update_entity`. JsonLogic in this array may invoke two platform-extension operators: `{"value_changed": "<field>"}` (true when the field's value differs from `$old`, true on INSERT) and `{"require_permission": "<permission_code>"}` (returns `true` when the caller holds the permission, throws otherwise). Both are passed through verbatim, no special encoding. **However**, the deployer must cross-check every `require_permission` argument against the §8.1 **Permissions catalog** (the canonical source): collect every distinct `<permission_code>` referenced across all entities' `validation_rules`, verify each one appears as a `permission` row in the catalog. Mismatch is a 🛑 High blocker (see the precedence table below); refuse to deploy and send the user back to the analyst skill rather than calling `create_permission` ad hoc, the analyst's audit should have caught this and the model may have other gaps if it didn't.
  - **`Input type rules`** sub-block, when present: parse the fenced ```` ```json ```` **array of objects** verbatim into a list of `{field, jsonlogic, description?}` entries; default to `[]` when the heading is absent. Same shape as `Computed fields` and `Validation rules` — one parser handles all three. Each entry's `field` must resolve to a real field declared in this entity's §3 field table (Stage 1 enforces; a typo or auto-field name is a 🛑 High blocker). Each entry's `jsonlogic` is an object that the platform evaluates client-side at form render against the current record; the return value must be one of the five `input_type` enum values (`"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`), with the static `input_type` as the platform-side fallback for empty / malformed / out-of-enum returns. The deployer passes each entry's `jsonlogic` verbatim to `update_field`'s `data.input_type_rule` in Stage 4f. JsonLogic shape is not deeply validated at parse time (the platform handles the fallback gracefully); only structural integrity (`field` references a real field, `jsonlogic` is an object) is enforced here. If the deployer encounters a YAML-shaped `Input type rules` block (sometimes seen in older drafts), it's a 🛑 High parse error: route the user to the analyst's audit to regenerate.
  - **`Select rule`** sub-block, when present: parse the fenced ```` ```json ```` **object** (not an array) verbatim; default to `{}` when the heading is absent. The JsonLogic must return a boolean (truthy ⇒ row visible) when evaluated by the platform's generated `FOR SELECT` RLS policy. Every column referenced inside the JsonLogic must resolve to a real field on this entity (Stage 1 enforces; cross-row lookups, FK traversal, and aggregates are out of scope and a 🛑 High blocker if present). Every permission code referenced inside the JsonLogic (e.g. via the platform's permission-check operator when wired through `select_rule`) must appear as a `permission` row in the §8.1 Permissions catalog — same cross-check as `require_permission` (🛑 High blocker on mismatch). **`Select rule` prose × JsonLogic cross-check (critical defense-in-depth).** The deployer also walks the sub-block's `description` (when present) and the entity's §3 prose for bypass-shaped phrases (*"bypass"*, *"elevated"*, *"override"*, *"see every"*, *"unrestricted"*, *"holders of X see"*, *"degrade to"*) and permission tokens (`<slug>:<suffix>`). For every permission token named in prose, the JsonLogic body must literally reference that token (e.g. `{"require_permission": "<code>"}` if the platform documents the operator in SELECT context); for every bypass phrase, either the JsonLogic body must encode the bypass OR the model must carry a §7-resolved architectural-decision entry naming a documented broadening mechanism. A prose claim that doesn't reconcile with the JsonLogic body is a 🛑 High blocker, same severity as the column-doesn't-exist check. The deployer never deploys a rule the analyst's Stage 12.5 audit should have caught. The deployer passes the parsed object verbatim to `update_entity`'s `data.select_rule` in Stage 4f. **An empty object `{}` (or the heading omitted) means "no rule"** — the platform drops any generated RLS policy when the column is reset to `{}`; do not confuse this with the missing-heading-but-live-non-empty drift case (see Conflict Resolution Reference).
- **Relationship table** (§4), confirms `reference_delete_mode` for each FK field
- **§2 Mermaid diagram**, sanity-check it agrees with §3/§4. Entity-set and endpoint agreement (every node / edge resolves to a declared entity) is now guaranteed deterministically by the Stage 1 consistency gate above, so this soft check focuses on what the gate does NOT judge — cardinality and direction. If those disagree, flag for the user before proceeding rather than silently picking one side.
- **§6 Cross-model link suggestions**, parse the §6 markdown table into a list of rows, each carrying `{from_table, to_concept, verb, cardinality, delete_mode}`. Defaults: `cardinality = "N:1"` and `delete_mode = "clear"` when the column is absent or empty; `verb` is required and never defaulted. When §6 is empty it carries the canonical empty-section placeholder `_(none: <short reason>)_` (bare `_(none)_` allowed; detect via `^_\(none\b`) — treat that as "section present, empty": the row list is empty and Stages 2g and 4f are no-ops. Do not parse the placeholder line as a table row and never carry it forward as data. (Grandfathered specs may still read the retired sentence `No cross-model link suggestions.`; treat it identically — empty.) Either way the table-row parse finds zero rows, so this is a no-op. The `related_domains` front-matter is informational only (a discovery tag for humans browsing the catalog); the deployer does not consume it.
- **§7 Open questions**, scan both sub-sections. **§7.1 🔴 Decisions needed is a gate**: if any entry is present and unresolved, stop before Stage 4 and list the blockers to the user; ask them to either (a) answer each question so the model can be updated first via the semantius-architect skill, or (b) explicitly waive and proceed at their own risk. Do not make up answers, and do not silently proceed. **§7.2 🟡 Future considerations is informational only**, note them for the user but do not block.
- **Permissions catalog** (`## 8.1 Permissions catalog`, mandatory) — parse the table verbatim. Five columns in this fixed order: `permission | tier | description | included in :admin? | reconciliation`. Build a `permissions` index from the rows; each entry `{permission, tier, description, included_in_admin, reconciliation}`. The deployer's Stage 2a (module + permissions setup) creates one `create_permission` call per row in table order, using the `permission` and `description` cells. The rollup chain comes from the **§9.1 Permission hierarchy** table (`permission | includes | reconciliation`): after all permissions exist, the deployer issues one `create_permission_hierarchy` call per §9.1 row, with `including_permission = permission` (the broader, the one doing the including) and `included_permission = includes` (the narrower, the one being included). **Parse-time validation** (all 🛑 High blockers, reject before any write):
  - exactly one row with `tier: baseline-read` and `permission = <slug>:read`;
  - exactly one row with `tier: baseline-manage` and `permission = <slug>:manage`;
  - at-most-one row with `tier: baseline-admin` and `permission = <slug>:admin`;
  - **every row has a non-empty `description` cell** (whitespace-only counts as empty; `—` is rejected). The deployer writes the cell verbatim to `permissions.description` without templating or fallback (see Stage 2a-scaffold step 2 and Stage 4b), so an empty cell would land an empty string in the catalog — route the user back to the analyst skill to fill it in;
  - every `tier` value in `{baseline-read, baseline-manage, baseline-admin, workflow-gate (lifecycle), workflow-gate (rule), override (personal_content), override (submit_lock), narrow}`;
  - every §9.1 `permission` and `includes` cell is a `permission` value that also appears in §8.1;
  - **no §9.1 row where `permission = <slug>:manage` and `includes` is a `workflow-gate` (lifecycle or rule) permission** — rolling an elevated gate under `manage` auto-grants every manager the gated authority and defeats the conditional check;
  - **every `narrow` permission is included by `<slug>:manage` or higher in the §9.1 chain (`<slug>:admin` is acceptable *only if* it transitively includes `manage`)** — a `narrow` permission with no §9.1 rollup is a blocker (the narrow tier would not be reachable by `manage` holders, inverting intent); a `narrow` permission included only by `<slug>:admin` in a model where `admin` does *not* roll up to `manage` is also a blocker.

  **Cross-check against the rest of the parse** (also blockers):
  - every `require_permission(<code>)` argument referenced across all `validation_rules` appears as a `permission` row in §8.1;
  - every entity carrying `**Edit permission:** admin` has the `baseline-admin` row (`<slug>:admin`) declared in §8.1;
  - every entity carrying `**Edit permission:** <narrow_suffix>` has `<slug>:<narrow_suffix>` declared as a `narrow` tier row in §8.1;
  - every `workflow-gate (rule)` row is invoked by at least one `require_permission` rule; every `workflow-gate (lifecycle)` row matches a §7 `requires_permission?` state;
  - **lifecycle state field name (fixed `workflow_state`).** Every entity that carries a lifecycle — a §7 lifecycle table, any `workflow-gate (lifecycle)` permission, or a `process_gates` row — stores that state in a field named **exactly `workflow_state`**. Concretely: (a) every `process_gates[].state_column` MUST equal `workflow_state`; (b) every such entity's §3 Fields table MUST contain a `workflow_state` enum field carrying the lifecycle's `enum_values`. A lifecycle state stored under any other field name (`status`, `state`, `lifecycle_state`, …) is a 🛑 High blocker — **FAIL LOUD and route the user back to the analyst**; the deployer never silently renames the field or deploys the mis-named state. This is the deploy-side enforcement of the analyst's fixed-name rule (analyst Stage 4); a spec that reaches the modeler with a non-`workflow_state` lifecycle field is an upstream authoring bug, not something to model around;
  - every `narrow` row is consumed by at least one entity's `Edit permission:` annotation OR invoked by at least one `require_permission` rule.

  §8.1 is the canonical source for the permission set — when §8.1 and a §3 / §9.1 reference disagree, §8.1 wins and the disagreement is a defect surfaced to the user.
- **§8.1 `**Reconciliation:** re-prefixed-from <canonical-module>.<verb>` annotation** (per permission row). Parse into the `permissions` index entry as `{re_prefixed_from: {canonical_module, verb}}` when present. The annotation flags the row as reconciliation-eligible for Stage 4n: when the canonical owner module later installs and Branch-B promotion fires for the entity, Stage 4n mints sibling canonical-prefixed permissions and re-points grants. The annotation is metadata only — it does NOT change Stage 2a-scaffold's mint of the row under the spec's installing-unit slug.
- **§8.2 `has_single_approver` rule named gate**. For every row whose `source flag` is `has_single_approver`, parse the `intent` text and extract the permission code it names (look for `<slug>:<verb>` patterns). The extracted code MUST appear as a `permission` row in the §8.1 Permissions catalog (Stage 1 enforces; mismatch is a 🛑 High blocker — the analyst's pre-save verification should have caught it). The phantom shape `<slug>:approve_<entity>_approval` (a code that appears NOWHERE in §8.1) is rejected; route the user back to the analyst.
- **§6.2 / §6.3 handoff tables** carry a `transition` column with `<to_state> _(<event_category>)_`. Parse each row into `{source_module, target_module, trigger_event, transition: {to_state, event_category}, payload, integration, friction, description}`. `event_category` ∈ {`lifecycle`, `state_change`, `entity_event`}. For `lifecycle` rows, validate that `to_state` exists in the source entity's §7 lifecycle table (Stage 1 enforces; mismatch is a 🛑 blocker — the analyst should have caught it). Stage 4m consumes the parsed rows.
- **§7 ⚠ annotations**. For every lifecycle row whose `description` cell contains `⚠ state-machine shape: <reason>` OR whose `derived gate` cell contains `⚠ unresolved gate: <reason>`, mark the row as `data_quality_flagged` with the verbatim reason. Stage 3 surfaces these as plan-summary lines `⚠️ Skipping <entity>.<state>` — the deployer will SKIP or FAIL LOUD rather than silently provisioning. Never silently auto-resolve a ⚠ row.
- **§9 governance section**. Parse into these sub-indices:
  - `baseline_roles[]` from §9.1's `Baseline roles` table: `{role_slug, baseline_grant}`.
  - `permission_hierarchy[]` from §9.1's `Permission hierarchy` table: `{including, included}` pairs.
  - `raci[]` from §9.1's `RACI realization` table: `{actor, kind: persona|skill, raci: R|A|C|I, process_key, consult_mode, realization, grant_module: <entity's current owning module slug>}`. the process display name and description are NOT on this row (they live in the `Processes` catalog below, joined by `process_key`). The `grant_module` column is the entity-owning-module resolution result. Stage 4k uses it directly when resolving each grant's permission code; the deployer does NOT re-resolve.
  - **RACI mode** (`living | documentation`) from the §9 `**RACI mode:**` header line (and frontmatter). Drives Stage 4k's branch; absent → Stage 4k applies the catalog-aware fallback default.
  - **Processes catalog** from the §9 `Processes` table: `processes[] {process_key, name, description, ordering}`. The display name + description live here; the RACI rows reference `process_key` only.
  - **RACI plan** (living mode only) from the §9 `RACI plan` block: `raci_assignments[] {process_key, role_slug, raci, consult_mode}`, `process_gates[] {process_key, entity, gate_kind, to_state, state_column, emits_events}`, `enforcement_rules[] {entity, rule, jsonlogic}`. Stage 4k materializes these (plus the Processes catalog) via `postgrestRequest`. Each `process_gates[].state_column` MUST be `workflow_state` (the fixed lifecycle state field); reject any other value as a 🛑 per the lifecycle-state-field cross-check above.
  - `functional_ownership[]` from §9.2: `{responsibility: owner|contributor|consumer, business_function, default_role, default_tier}`.
- **The deploy procedure lives in this skill, not the spec.** The spec carries data plus reconciliation annotations only; the module creation order, permission setup, label-column title validation, and built-in dedup are owned by this skill's own Stages 2-5. Read the §8.1 Permissions catalog for the permission catalog. Do not look for a procedural checklist section in the spec — older spec files carried an "Implementation notes" section, but it has been removed (it duplicated this skill).

### Model-to-Entity Mapping

| Model line | `create_entity` / `update_entity` parameter |
|---|---|
| `table_name` (§3 heading) | `table_name` |
| (derived) owning module | `module_id` — **REQUIRED on `create_entity`; the platform rejects `null`** (use-semantius `data-modeling.md`). The id of the module the entity is being created *in*: the module resolved in Stage 2a for `create-new` / `rename-incoming-from`; the **master** module's id for `promote-to-master`. Never omit it — an entity stranded with a NULL `module_id` still reads back by `table_name` (so field diffs and FK targets resolve, masking the defect), but it belongs to no module: it is absent from the module's entity list and from every module-scoped RBAC and UI query. Re-sent on `update_entity` only to repair a NULL/mismatched value (otherwise omitted — a `promote-to-master` move sets it via 4c-promote's `update_entity`). |
| Singular / Plural labels | `singular_label` / `plural_label` |
| Description | `description` |
| Label column | `label_column` |
| `**Audit log:** yes \| no` | `audit_log` (boolean; omit or pass `false` when the model says `no` or is silent) |
| `**Edit permission:** manage \| admin \| <narrow_suffix>` (absent = `manage`) | `edit_permission`: `"<system_slug>:admin"` when the line says `admin`; `"<system_slug>:<narrow_suffix>"` when the line names a bare suffix that matches a `narrow` tier row in §8.1 (Stage 1 has already validated this); otherwise `"<system_slug>:manage"`. `view_permission` is always `"<system_slug>:read"`. Files without the line (any reason) treat every entity as `manage`. |
| `**Edit mode:** auto \| sidebar \| modal \| page` (when present) | `edit_mode` (omit when absent, defaults to `auto`) |
| `**Cube mode:** disabled \| auto` (when present) | `cube_mode` (omit when absent, defaults to `disabled`) |
| `**Computed fields**` JSON block (when present) | `computed_fields` (array; omit or pass `[]` when absent. Sent verbatim — the deployer never edits, reorders, or merges entries.) |
| `**Validation rules**` JSON block (when present) | `validation_rules` (array; omit or pass `[]` when absent. Sent verbatim.) |
| `**Select rule**` JSON block (when present) | `select_rule` (single JSON object, not an array; omit or pass `{}` when absent. Sent verbatim by Stage 4f's `update_entity` call. Sending `{}` (or omitting the key entirely on `create_entity`) leaves the column empty and the platform generates no RLS policy.) |
| `**Catalog entity code:** `<code>`` | `catalog_entity_code` — the **canonical** code (NOT `table_name`). Stamped on `create_entity` (✨ new / rename-incoming / promote). Write-once: never re-sent on a later `update_entity` rename. Default to `table_name` when the line is absent. |
| `**Entity type:** <class>` | `entity_type` — the closed 6-value class. Stamped on `create_entity`. `'unclassified'` (never `''`) when absent. |
| `**Label parent:** `<fk_field_name>`` | `label_parent` — the FK field name that is this entity's identity spine. Passed on `create_entity` / `update_entity` **only when the line is present**; omit the key entirely (leave `null`) when absent. A normal nullable property, NOT a write-once provenance code — re-pointing it is allowed and changes the composed `_label` with no data migration. The deployer does not derive it (the analyst already did); it never targets a junction and never appears on a junction entity. |
| `**Canonical owner:** `<module_slug>`` | `canonical_owner_module` — the owner-module slug from the spec's `**Canonical owner:**` line, for an `embedded_master` provisioned locally as a placeholder while its canonical owner is absent; `''` when this module owns the entity, it is local, or the line is absent. Stamped on `create_entity`. |
| (derived) §3 pattern flags | `pattern_flags` — the sparse `{flag: true}` object built from the entity's authored flags (`personal_content` / `submit_lock` / `single_approver` / `multi_approver` when present). `{}` when none. Stamped on `create_entity`. |
| `**Catalog alias:**` line(s) | `catalog_entity_aliases` — on a reuse/merge onto an existing host, **APPEND** each `{alias_code, source_domain, source_module, decided}` element to the host's array (read-modify-write; never rewrite prior elements). Not set on a plain `create_entity`. |

> `searchable` and `is_child` on the entity are read-only / auto-computed by the platform. **Never** pass them on `create_entity` / `update_entity`. The provenance columns above are **core-provided** (`ctype = 'core'`); pass them as VALUES on `create_entity` / `update_entity` but **never** `create_field` them and **never** write `ctype`. See "Provenance stamping" in Stage 4.

> **Singular / Plural label drift vs the platform.** The spec's `singular` / `plural` originate from the blueprint's explicit §3 `singular` / `plural` columns. When an entity **already exists** in the live catalog and `create_entity` is skipped (`reuse-from`, `promote-to-master` Branch A shared-master match, or any adopt path), read the live `entities.singular_label` / `entities.plural_label` and compare them to the spec's `singular` / `plural`. On a difference, surface it as additive drift in the Stage 3 plan (offer an `update_entity` to align the labels) — do NOT silently leave the live labels stale, and do NOT overwrite without surfacing the change first. On a fresh `create_entity`, the spec values are authoritative and there is nothing to compare.

### Model-to-Field Mapping

| Model column | `create_field` parameter |
|---|---|
| Field name | `field_name` |
| Format | `format` (text formats include `string`, `text`, `multiline`, `html`, `code`; `string` and `text` render single-line inputs, `multiline` renders a `<textarea>`. All five store as Postgres `TEXT`. Format **can** be changed after `create_field`, but **only within the same primitive type** — `text → multiline → html` is safe (all `TEXT`), `text → date` is rejected. Surface a cross-primitive mismatch between model and live as a hard block; a same-primitive mismatch can be reconciled via `update_field`. See the format-rule below.) |
| Label | `title` |
| → `table` | `reference_table` |
| Delete mode from §4 | `reference_delete_mode` |
| Notes annotation `relationship_label: "<verb>"` (FK rows), must equal the §2 Mermaid edge label `\|<verb>\|` for the same FK | `relationship_label` |
| Notes annotation `parent label: "<singular>" / "<plural>"` (parent FK rows only) | `singular_label_parent` / `plural_label_parent` |
| Notes annotation `cube_type: <value>` | `cube_type` (omit when absent, defaults to `auto`) |
| Notes annotation `default: "<value>"` | `default_value` |
| **Description** column (5th column in §3 field tables) | `description` (read the cell verbatim, pass to `create_field`. Blank cell ⇒ omit / pass `""`. Free-form prose found in the Reference / Notes column is **not** mapped — that's an analyst authoring error; surface as a 🟡 to the user and recommend running the analyst's audit pass before redeploying.) |
| Enum values from §5 | `enum_values` |
| `**Input type rules**` JSON-array entry for this field) | `input_type_rule` — the entry's `jsonlogic` object, applied via `update_field` in Stage 4f (never on `create_field` — sequencing requires the field to exist first AND the rule frequently references sibling fields that may also be brand-new). Fields with no matching entry are left at the platform default (`{}` ⇒ no dynamic override; static `input_type` governs). |

> **Default-value guard (re-deploy safety).** Before issuing `create_field` for a **required** field on an **existing entity that already holds rows**, verify a default is supplied. Postgres rejects `ALTER TABLE ... ADD COLUMN ... NOT NULL` (and CHECK-constrained enums in particular) on a non-empty table when no default exists, with `(23514) check constraint "..._check" of relation "..." is violated by some row`. Specifically:
> - For required enums: `default_value` MUST be present in the model and be one of the listed `enum_values`. If the §3 Notes don't carry a `default: "<value>"` annotation, stop and surface this as a 🔴, ask the analyst skill to set one (convention: first enum value, the initial lifecycle state).
> - For required non-FK scalars on a non-empty existing entity: same, refuse to add the column without a default, surface the gap, and ask before proceeding.
> - For required FK fields on a non-empty existing entity: there is no meaningful default. Stop and ask whether to add the column nullable (drop "required") or backfill the FK to a chosen target row before re-running.
> - For brand-new entities (created in this run, zero rows): no guard needed, defaults are nice-to-have but the create won't fail without them.
> Run a quick `read_entity` / `count` against the live table to determine whether it has rows; do not assume.

> **Verb consistency check.** When the §2 Mermaid edge for an FK is labeled `|owns|` but the §3 Notes for that FK has no `relationship_label: "..."` annotation (or a different verb), stop and surface this as a mismatch, do not silently pick one side. The diagram label and the field metadata must agree. The optimizer regenerates the diagram from `relationship_label`, so a mismatch here means the round-trip will lose information.

> The §3 `Required` column is captured as author intent in the model document but is **not** passed to `create_field`. The platform manages nullability internally based on format and delete-mode semantics, do not send an `is_nullable` (or equivalent) parameter.

### Fields That Are Auto-Generated: Never Create These

`create_entity` automatically creates these, skip them when iterating over model fields:

- `id`, `label`, `created_at`, `updated_at`
- The field named in `label_column` (auto-created with `ctype: label`)
- The composed-label columns: the entity's own `_label` (`ctype: _label`) and every `<fk>_label` companion (`ctype: fk_label`). They are platform-owned, read-time projections — never `create_field` them, and skip them on every field diff. They never appear in the spec's Fields tables or in `read_field`.

> **Title correction (validate, don't blanket-fix):** the platform derives a sensible `title` for the auto-created `label_column` field, so there is no blanket `update_field` pass. After `create_entity`, read the field's live `title` and compare it to the §3 Label for that row; issue `update_field` ONLY for the outliers where they differ. When you do, the `id` is the composite string `"<table_name>.<field_name>"` (pass it as a string, not an integer). Most entities need no correction.

### Self-References

Fields that reference their own entity (e.g., `campaign.parent_campaign_id → campaigns`) must be created in a second pass after all entities exist. Flag them during parsing.

---

## Stage 2: Verify reconciliation against the live catalog

**Read before writing, always.** (use-semantius Golden Rule #1)

The analyst has already classified every entity, detected every collision, and made every decision. The modeler's job in Stage 2 is to verify each decision still holds against the *current* live catalog (the catalog may have changed between analyst-run and modeler-run).

### 2a. Resolve the module

Look up the module by `system_slug`:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.<system_slug>"}'
```

- **Exit 0 (exists)**: capture the `id`; plan `update_module` to refresh `module_name` / `description` if they drift.
- **Exit 1 (missing)**: plan `create_module` with `module_name = <system_name>`, `module_slug = <system_slug>`, `description = <system_description>`, `module_type = "domain"`, then run the scaffold pass (subsection 2a-scaffold below).
- **Exit 2 (duplicate)**: hard catalog bug; surface and stop.

> **Module schema note.** Modules carry `module_name` (display), `module_slug` (URL handle), `description` (≤40-char tagline), and `module_type` (`"domain"` default). The §1 Overview prose does NOT go on the module record. `module_type` from the spec (default `"domain"`); reject if it differs from a pre-existing module's `module_type`.

#### 2a-scaffold: standard module scaffold (idempotent)

Every module carries: three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`), three default roles (named in the spec's §9.1 baseline-roles table — conventionally `<slug>_viewer` / `<slug>_manager` / `<slug>_admin`, but the §9.1 `role` column is the authoritative, deploy-ready slug and the deployer uses it verbatim, never reconstructing it from the module slug), and six FK columns on the module record (`view_permission`, `manage_permission_id`, `admin_permission_id`, `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id`).

For each module touched, idempotent steps:

1. **Determine the required tier set.** Two-permission baseline (`read`, `manage`) unless the spec's §8.1 Permissions catalog declares a `baseline-admin` row, in which case three-permission baseline (`read`, `manage`, `admin`).
2. **Create or backfill permissions from §8.1.** Iterate the spec's §8.1 Permissions catalog in table order. For each row, `read_permission --single` by `permission_name`.
   - **Exit 1 (missing):** `create_permission` passing `permission_name = <row.permission>`, `description = <row.description>` (verbatim from §8.1), and **`module_id = <module.id>`**. Never omit `module_id` — it is a load-bearing FK, not optional metadata. A permission minted with a NULL `module_id` still resolves by name (so the permission-hierarchy and role-permission joins pass, and a casual smoke test looks green), but module-scoped queries (`?module_id=eq.<id>`) silently miss the row and per-module RBAC audits report drift.
   - **Exit 0 (exists):** the row is already present — do **not** skip it. Assert its `module_id == <module.id>`; if the live value is NULL or points at a different module, `update_permission` to set it. This step **converges the column to the desired state, it is not create-only**: a permission left with a NULL `module_id` by an earlier buggy deploy is repaired here on the next run, not stranded forever because the create already happened. (This is the durable guard; Stage 5's check only verifies that this backfill landed.)
   The spec is the single source of truth for codes and descriptions. **Note:** when a row carries a `re-prefixed-from <canonical-module>.<verb>` annotation (Stage 1 parsed it into `row.re_prefixed_from`), the row's `permission_name` ALREADY reflects the installing-unit slug (the analyst emitted it that way per the entity-owning-module rule). Mint as-is; Stage 4n will reconcile if/when the canonical module installs. The annotation is metadata only — it does not change the mint here.
3. **Create permission-hierarchy chain.** For each row in the spec's §9.1 Permission hierarchy table: resolve both ends from `permission_name` to id once at the top, then **read-before-write** — `read_permission_hierarchy` filtered by `including_permission_id=eq.<including_id>&included_permission_id=eq.<included_id>` and `create_permission_hierarchy` only on exit 1, with `including_permission_id = <row.permission>.id`, `included_permission_id = <row.includes>.id`, `origin = "model"` (domain) or `"model_master"` (master). A re-run finds every chain row already present and skips it (same guard 4b restates).
4. **Create default roles per tier**, reading each role's `slug` **verbatim from the spec's §9.1 baseline-roles table** (the `role` column is the resolved, deploy-ready slug; the analyst already normalized it to the platform's `roles.slug` rule, so the deployer never reconstructs `<slug>_<tier>` — a module slug may legally carry a hyphen the role slug cannot). Idempotent and converging: `read_role --single` by that §9.1 slug; on **exit 1** `create_role`, passing the §9.1 `slug` verbatim plus `role_name`, `description`, **`module_id` (load-bearing FK — same NULL-drift failure mode as permissions above; never omit it)**, `origin = "model"`. On **exit 0** do not skip — assert the live `module_id == <module.id>` and `update_role` to set it if it is NULL or points elsewhere, so a role stranded with a NULL `module_id` by an earlier deploy is repaired on the next run. Then attach the row's `baseline grant` permission to each role with the same read-before-write guard: `read_role_permission --single` by `role_id=eq.<role_id>&permission_id=eq.<perm_id>` → `create_role_permission` only on exit 1.
5. **Populate the six module-record references, plus the access-scope setting.** After permissions and roles exist, `update_module` to set `view_permission = "<slug>:read"`, `manage_permission_id`, `admin_permission_id` (nullable), `default_*_role_id`, **and `settings.access_scope = <the scope resolved in Stage 2.5>`** (`basic` / `full`). The scope is written on **every** deploy, regardless of which Stage 2.5 resolution path decided it (frontmatter, prior live setting, or the ask) — this per-module record is the signal Stage 2.5's detection (and the analyst's identical detection) counts, so leaving it null silently skews future defaults toward basic. Write only the fields whose live value differs (re-runs are idempotent; a module already carrying the same `settings.access_scope` is skipped). Merge into the existing `settings` JSON rather than overwriting sibling keys such as `raci_mode`.

### 2b. Verify reuse-from annotations

For every spec entity with `**Reconciliation:** reuse-from <module>.<entity>`:

```bash
semantius call crud read_entity --single '{"filters": "table_name=eq.<entity>"}'
```

If the entity is missing, OR its `module_id` no longer matches `<module>`, halt with: *"The design expected `<Plural Label>` to already exist in your semantic model under the `<Module Display Name>` module, but it's not there anymore. Something changed since the planning step ran. Re-run `semantius-analyst` to refresh the design."*

For each reused entity, also read its current fields to populate the FK-target index used in Stage 4:

```bash
semantius call crud read_field '{"filters": "table_name=eq.<entity>"}'
```

### 2c. Verify rename-incoming-from annotations

For every spec entity with `**Reconciliation:** rename-incoming-from <module>.<source> as <new_name>`:

- Confirm `<module>.<source>` exists (the analyst saw it; verify it's still there). If missing → halt with drift message.
- Confirm `<new_name>` does NOT exist anywhere in the catalog. If it now exists → halt with: *"The disambiguated name `<new_name>` is now in use; re-run the analyst to pick a different name."*

### 2d. Verify promote-to-master annotations

For every spec entity with `**Reconciliation:** promote-to-master <master_module>.<entity>`:

- Confirm `<master_module>` exists AND has `module_type = "master"`. If it exists with `module_type = "domain"` → halt (the analyst should have caught this).
- If `<master_module>` doesn't exist yet → it's a Branch-B-with-new-host case; plan `create_module` with `module_type = "master"` per the spec's `promotion_decisions` frontmatter, then create the entity there.
- Apply the manage-inclusion edges per the spec's `promotion_decisions[<entity>].manage_option` (1/2/3/4 — see analyst Stage 3b for the option semantics; the modeler reads the recorded choice and applies the corresponding `permission_hierarchy` rows).

### 2e. Verify dropped annotations

For every spec entity with `**Reconciliation:** dropped (optional, user declined)`: skip entirely. No reads, no writes. Note in the Stage 3 plan.

### 2f. Verify built-in dedups

For every spec entity with `**Reconciliation:** reuse-from semantius_builtin.<table>` (the analyst flagged platform built-ins): confirm `<table>` is in the canonical built-in list (see `use-semantius/references/data-modeling.md`). If the spec annotated a non-built-in as `semantius_builtin.*` → halt (spec corruption; re-run analyst).

### 2g. Resolve cross-model link suggestions

For each parsed §6 row `{from_table, to_concept, verb, cardinality, delete_mode}`, resolve the `to_concept` against the live catalog (the analyst leaves §6 `To` unprefixed and unresolved on purpose — resolution is the modeler's deploy-time job). Single exact / canonical match → mark the row ✨ proposed with the resolved target table captured, and check the auto-generated `<target_singular>_id` field name is free on `from_table` (🛑 field-name collision otherwise, resolved in Stage 3). Multiple plausible matches → mark 🟡 ambiguous for the Stage 3 batched question. No match in the catalog → mark the row 💤 dormant in the plan; do not halt the deploy on an unresolved §6 row (cross-model links are optional FKs, additive). `from_table` that is neither a §3 entity in this model nor a live entity is a 🛑 (Stage 3 routes the user back to the analyst).

### 2h. `module_kind` recognition
Parse the frontmatter `module_kind` value and surface in the Stage 3 plan-summary line `🏷 module_kind = <kind>`. No behavior branches on the value — the deployer's logic is `module_kind`-agnostic. Unknown values are accepted (warned in the plan, not blocked).

### 2i. Canonical-owner detection for re-prefixed permissions
For every spec §8.1 permission row with a `**Reconciliation:** re-prefixed-from <canonical-module>.<verb>` annotation, look up the canonical module in the live catalog:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.<canonical-module>"}'
```

- **Exit 1 (canonical module absent)**: the re-prefix stands. The permission will be minted under the spec's installing-unit slug per Stage 4a-scaffold. Mark the row in the plan as `🔁 Re-prefix: <slug>:<verb> (canonical <canonical-module> not installed)`.
- **Exit 0 (canonical module present)**: queue the row for **Stage 4n reconciliation**. After the entity is moved (Branch-B promotion in 4c-promote) to the canonical module, Stage 4n will:
  - mint the canonical-prefixed sibling permission (`<canonical-module>:<verb>`) if absent;
  - create a sibling `role_permissions` row for every grant on the re-prefixed code (no deletes);
  - re-emit any `permission_hierarchy` edge referencing the re-prefixed code under the canonical prefix.
  - Mark the row in the plan as `🔁 Master-install reconciliation: rename <slug>:<verb> → <canonical-module>:<verb>; migrate <N> grants`.

The sweep is N-to-1: an entity may have accumulated multiple non-canonical prefixes across prior installs (e.g. `hiring-starter:hire_candidate` AND `ats-recruitment-pipeline:hire_candidate` may both exist when `ats-candidate-crm` finally installs). Stage 4n sweeps ALL non-canonical-prefixed permissions for the affected entity's verbs.

### 2j. `has_single_approver` cross-check
For every spec §3 entity carrying the `single_approver` pattern flag, locate the matching §8.2 rule (whose `source flag` is `has_single_approver`). The rule's `intent` text MUST name a permission code (parsed in Stage 1) that appears as a `permission` row in §8.1. The analyst's pre-save verification should have caught any mismatch; this stage is the deploy-boundary re-check. If mismatch: halt with *"The §8.2 rule `<rule_name>` names a permission code (`<code>`) that doesn't appear in §8.1. Re-run `semantius-analyst` on the source blueprint."* Phantom `<slug>:approve_<entity>_approval` codes are rejected here regardless of upstream verification state.

## Stage 2.5: Access control scope (basic vs full RBAC)

This stage guarantees the deploy reflects the user's access-control choice — **basic access** (plain read + edit) or **full RBAC** (admin tier, workflow gates, lifecycle gating, personas / RACI) — even when the spec doesn't carry one. It is the universal backstop: every deploy funnels through the modeler, so this is the one place the choice is *always* honored.

**This is not a re-litigation of the spec.** In the hybrid pipeline the analyst already authored the spec in the chosen shape and stamped `access_scope` in frontmatter; here the modeler simply *reads* that decision and obeys. The prompt below fires **only** when the choice is genuinely unresolved (no frontmatter directive, no prior choice on the module) — the same deploy-time-decision posture as the §6 cross-model-link prompt (a thing the spec deliberately leaves for deploy time). When the spec carries `access_scope`, no prompt fires. This is consistent with "the only confirmation the modeler asks" rule below: a spec that already encodes the decision is never re-asked.

### Resolution order (first hit wins, stop)

1. **Spec frontmatter `access_scope`** present (`basic` / `full`) → use it. No prompt. (The hybrid path: the analyst already shaped the spec to match, so no projection is needed — see below.)
2. **Live module `settings.access_scope`** present (a prior deploy recorded the choice) → use it. No prompt. Read it from the module record resolved in Stage 2a.
3. **Undecided** (neither carries a value) → run the detection below to pick a default, **ask** the user, and persist the answer to `modules.settings.access_scope` (Stage 4a).

**Persist on every path, not only step 3.** Whichever step resolves the scope, record the resolved value to `modules.settings.access_scope` via an idempotent `update_module` at Stage 4a-scaffold (same pattern as `settings.raci_mode = "living"`). Steps 1 and 2 persist too: this per-module record is the signal the detection below (and the analyst's identical detection) counts, so it MUST be populated for every module the pipeline deploys, including the hybrid path where the spec frontmatter already carried the decision. A module left with `settings.access_scope = null` is invisible to the count and silently skews future defaults toward basic.

### Detection (sets the default only)

Count the live modules that recorded a full-access deploy, excluding the module being deployed (a re-deploy must not self-trigger):

```bash
semantius call crud read_module '{"filters": "settings->>access_scope=eq.full,module_slug=neq.<system_slug>"}'
```

Any row → **default Full** (stay consistent with the modules already using full access control). No rows → **default Basic** (don't saddle a setup that isn't using governance with it). This counts the choice each prior deploy recorded on its module record (`modules.settings.access_scope`) — not whether permissions or roles merely exist, since a basic module also creates `<slug>:read` / `<slug>:manage` and viewer / manager roles and so cannot be told apart from full by a permission sniff.

### The prompt (only at resolution step 3)

`AskUserQuestion`, header `Access control`, the Recommended option leading per the detection (Basic on a fresh instance, Full on one already using RBAC). Plain language, no `access_scope` token, US spelling, no em-dashes:

- label `Basic access (read and edit)` — *"Anyone allowed in can read and edit records. No roles to manage, no approval steps, no per-stage gating. The records and their stages still exist; moving a record through its stages just isn't restricted. You can add advanced access control later."*
- label `Advanced access control` — *"An admin tier, role-based permissions, approval gates on sensitive actions, and per-stage gating of record lifecycles. More to set up, fine-grained control over who can do what."*

### Realizing `basic`

If the resolved scope is `basic` **and the spec is already in the two-permission fallback shape** (frontmatter said `basic`, the analyst authored it that way), there is nothing to strip — deploy as written. The check: §8.1 carries only `<slug>:read` + `<slug>:manage`, no `workflow-gate` / `override` / `narrow` rows, §9.1 has only viewer + manager + the `manage → read` edge, no §9 RACI/persona surface. When that holds, `basic` is a no-op beyond persisting the setting.

If the resolved scope is `basic` **but the spec is full-shaped** (the backstop case: a full spec with no directive, or `settings.access_scope = basic` against a full spec), apply the **two-permission projection** — deterministically deploy the spec as if it declared the two-permission fallback. Project, do not delete (the no-auto-deletion rule still holds; on a re-deploy that flips an existing full module to basic, the projection simply stops provisioning the higher-governance objects — any already-live gates/roles remain as quiet orphans, surfaced in the Stage 5 summary, never deleted):

| Stage | Full behavior | Basic projection |
|---|---|---|
| 2a-scaffold / 4a / 4b | create every §8.1 permission, the full hierarchy chain, viewer/manager/admin roles | create only `<slug>:read` + `<slug>:manage`, the single `manage → read` edge, and the `<slug>_viewer` + `<slug>_manager` roles. Skip `<slug>:admin`, every `workflow-gate` / `narrow` / `override` permission, the admin role, and every gate rollup. Leave the module record's admin FK columns null. |
| 4c (entities) | `edit_permission` per §3 `**Edit permission:**` (`admin` / `<narrow>` / `manage`) | force every entity's `edit_permission` to `<slug>:manage`. Lifecycle `workflow_state` enum fields are still created (the machine exists, ungated). |
| 4e (write-side rules) | apply all `validation_rules` / `computed_fields` | drop any entry whose JsonLogic gates on a dropped permission (`require_permission` / `has_permission` on a code that no longer exists); keep pure data-integrity / computed entries. |
| 4f (read-side rules) | apply `select_rule` / `input_type_rule` | apply none from the spec (treat as absent); for a *live* non-empty `select_rule` follow the existing 4f "model omits, live present → ask" path (never silently clear). Drop any `input_type_rule` that gates on a dropped permission. |
| 4k / 4l / 4m | personas + RACI, functional-ownership grants, lifecycle handoffs | skip entirely. |

**Unsplittable mixed rule (rare).** If a single `validation_rules` entry's JsonLogic *interleaves* a permission gate with a data-integrity check such that dropping the gate cannot cleanly preserve the integrity check, do not guess — **halt and route back to the analyst**: *"This design mixes a permission check with a data rule in one entry (`<code>` on `<table>`); deploying it as basic access needs the analyst to split them. Re-run `semantius-analyst` with basic access."* This mirrors the existing "spec doesn't match, re-run the analyst" posture; it is the one place basic-on-a-full-spec routes back instead of projecting.

The projection only narrows; it never invents. A basic deploy is always a strict subset of the full deploy, so re-running the same spec under `full` later is purely additive (every skipped object is created on the next full deploy, idempotently).

## Stage 3: Plan and Present (and resolve ambiguity)

Before running any writes, show the user a clear plan. The plan must have two parts: (1) the normal module/permission/entity summary, and (2) **an ambiguity-decisions section if any 🛑 buckets were raised in Stage 2**. No writes happen until every 🛑 has an explicit decision.

### Normal plan (example)

```
📦 Module: saas_expense_tracker
  ✨ Will create (new module)
  🔑 Permissions: ✨ saas_expense_tracker:read, ✨ saas_expense_tracker:manage, ✨ saas_expense_tracker:admin
  🔗 Permission hierarchy: ✨ admin → manage, ✨ manage → read
  🛠 Admin-tier entities (edit_permission = saas_expense_tracker:admin): departments, budget_periods
  🛠 Operational entities (edit_permission = saas_expense_tracker:manage): every other entity below

🗂 Entities (7 total):
  🔒 users (Semantius built-in, reusing; model declares 3 extra fields: `department_id`, `job_title`, `employee_id`, will add additively with user confirmation)
  ✨ vendors: will create + 6 fields
  ✨ subscriptions: will create + 26 fields
  ✨ departments: will create + 5 fields
  ✨ budget_periods: will create + 6 fields
  ✨ budget_lines: will create + 8 fields
  ✨ license_assignments: will create + 7 fields

Total to create: 1 module, 3 permissions, 2 hierarchy rows, 6 entities, ~58 fields
Plus: 3 additive fields on built-in `users` (pending confirmation)

🧠 Entity-level rules (calculated values and save-time checks):
  ✨ `subscriptions`: 1 computed_fields, 3 validation_rules
  ✨ `budget_lines`: 2 validation_rules

👁 Entity-level read rules (who can see which records):
  ⚠️ `license_assignments`: ✨ select_rule, will scope per-row visibility to the row's `assignee_user_id` (medium-risk visibility change, pending confirmation)

🎛 Field-level UI rules (how fields behave on the form):
  ✨ `subscriptions.renewal_date`: input_type_rule (hidden until workflow_state=`renewed`)
  ✨ `subscriptions.cancelled_at`: input_type_rule (hidden until workflow_state=`cancelled`, then readonly)
  ✨ `budget_lines.approved_at`: input_type_rule (readonly once workflow_state=`approved`)

🔗 Connections to other modules:
  ✨ Propose on `subscriptions`: + `contract_id → contracts` (governs, clear); pending confirmation
  ✨ Propose on `subscriptions`: + `project_id → projects` (charged to, clear); pending confirmation
  💤 Skipped (target not in catalog): `subscriptions → cost_allocation_rules`
```

The read-side and UI-rule sub-sections only appear when the model declares them (most models omit them; the sub-sections are omitted from the plan too — don't render empty bullets). The `select_rule` row carries the `⚠️` marker because applying it changes who can see which rows (medium-risk visibility shift); the deployer pauses for explicit confirmation on every `select_rule` create / modify / remove, same posture as a tier flip on `edit_permission`.

If the module already exists, swap `✨ Will create` for `♻️ Exists (ID: 12), will update module metadata from the new model and diff entities to apply only changes`. Render the field-level deltas inline under each ♻️ entity so the user sees exactly what's about to change, not just a vague "will diff" promise:

```
🗂 Entities (7 total):
  ♻️ subscriptions: 26 fields, 4 drifted, 1 new
     ~ vendor_name.description: "Vendor" → "Legal name of the contracting vendor"
     ~ workflow_state.enum_values: + "renewed", + "expired"
     ~ amount.searchable: false → true
     ~ contract_url.format: text → html (same primitive, accepted)
     + renewal_date (date, optional)
     ⚠️ select_rule: new (model adds row-level visibility scope on `created_by_user_id`)
     + renewal_date.input_type_rule: hidden-until-renewed
  ♻️ vendors: 6 fields, no drift
  ✨ budget_lines: will create + 8 fields
```

Use `~` for drifted properties (with `old → new`), `+` for additions, and surface `🛑` separately for anything that blocks the fast-path (enum removals, cross-primitive format changes, field deletions, tier flips). The 🛑 deltas route through the normal Stage 3 ambiguity dialog; the `~` and `+` deltas are informational and apply automatically once the plan is approved (or under the clean re-run fast-path, immediately). The `⚠️ select_rule` line is **not** auto-applied even under the fast-path — read-visibility changes always pause for explicit user confirmation (same rule as `edit_permission` tier flips).

### Plan-summary lines for master-data flows

The Stage 3 plan emits these standardized line types when master-data operations are in play. They appear alongside the normal `📦 ✨ ♻️ 🔑 🔗 🛠 🗂 🔒 🧠 👁 🎛 💤` vocabulary; each is a discrete decision the user sees before approval.

| Line | Meaning |
|---|---|
| `🟢 <entity> → already shared in <master_module>` | Branch A wire-up. Entity exists in a master module; this consumer is being added. Includes the read inclusion (always) and notes whether manage inclusion is also planned (depends on the per-consumer manage prompt). |
| `🔗 Permission inclusions (cross-module, new)` block | Lists every `permission_hierarchy` row this deploy will create across module boundaries, with `[origin=model_master]` annotations and the manage-option label from Stage 2d's follow-up. |
| `🆕 Master module created: <slug>` | A new `module_type = "master"` module will be created (either by promotion at Stage 2d Branch B, or by an upfront master-model deploy). |
| `🔁 Renaming master module:` block | A master-model deploy is renaming an existing master in place (cascade per Stage 4b-rename: module slug + per-tier permission codes + per-tier role slugs). Old → new on each line. |
| `📥 Merging master modules:` block | A master-model deploy is consolidating multiple single-entity masters into one domain cluster (Path 2, plan §5.4.5). Lists each source master being merged in and the target. Source masters are left as quiet orphans (never deleted per "No auto-deletion"). |
| `✨ <slug>:admin / <slug>_admin role` | Three-permission upgrade case: the model now needs `:admin` where the live module only had `:read` / `:manage`. Adds the missing permission, role, hierarchy row, and module FK columns. |
| `🌱 Seeded <master>_manager with N members from <original>_manager` | Branch B promotion seeds the master's manager role from the original module's manager-role members. Snapshot-time copy; new `<original>_manager` members added later don't auto-inherit master stewardship. |
| `💡 Cluster hint: <entity> → <cluster>` | An entity in this deploy carries an analyst-emitted `**Shared master cluster:**` annotation, and the hint is shaping a Stage 2d follow-up 1 default (existing-master match or new-module name suggestion). Informational; the user can override at the prompt. |
| `🏷 module_kind = <kind>` | Informational label from frontmatter (`domain` / `master` / `starter` / etc.). No behavior switch. |
| `🔐 Access control: Basic (read + edit)` | The Stage 2.5 resolved scope is `basic`. The plan shows the two-permission shape: `<slug>:read` + `<slug>:manage`, viewer + manager roles, no admin tier / gates / personas / RACI. When the spec was full-shaped and projected, add `(projected; N permissions, M roles, K lifecycle gates skipped)` so the user sees what was suppressed. |
| `🔐 Access control: Full RBAC (<N> permissions, <M> roles, lifecycle gates)` | The Stage 2.5 resolved scope is `full`. The plan shows the complete governance surface (current behavior). |
| `👥 Personas to provision: <list>` | Per-persona summary from §9 RACI + frontmatter `persona`. Stage 4k creates each named persona as a tenant role and grants its RACI permissions. Each line names the persona slug and the count of grants. **Omitted under `🔐 Access control: Basic`.** |
| `🏢 Functional ownership: owner = <function>.<role>, contributor = <function>.<role>` | Summary from §9.2 functional ownership table. Stage 4l grants the named default-tier permission to the named default role for each row. |
| `🔁 Re-prefix: <slug>:<verb> (canonical <module> not installed)` | The permission row in §8.1 carries a `re-prefixed-from <canonical-module>.<verb>` annotation AND the canonical module isn't installed. Stage 4a-scaffold mints the permission under the installing-unit slug; Stage 2i has queued it for future reconciliation. |
| `🔁 Master-install reconciliation: rename <slug>:<verb> → <canonical-module>:<verb>; migrate <N> grants` | The canonical module IS installed AND a Branch-B promotion will move the entity. Stage 4n will mint the canonical-prefixed sibling permission, create sibling `role_permissions` rows for every grant on every accumulated non-canonical prefix, and re-emit matching `permission_hierarchy` edges. No deletes. |
| `⚠️ Skipping <entity>.<state> — ⚠ <annotation kind>` | Per §7 lifecycle row carrying a `⚠ state-machine shape` or `⚠ unresolved gate` annotation. The deployer SKIPS the row (does NOT silently provision). The line is informational + halt-on-execute. |
| `💤 Skipping FK <from>.<target_id> → <target_entity> — target not installed (presence-conditional)` | Per §5 edge with `delete_mode: none (required-if-present)` AND target absent from live catalog. Stage 4d skips the FK column emission entirely (no broken non-null restrict). |

Example master-data plan block (Branch B promotion + Branch A wire-up + cluster hint):

```
🗂 Master-data operations:
  🛑 vendors — cross-module collision with `itsm.vendors` (domain module)
     💡 Cluster hint: vendors → parties
     ⚠️ Will request: 4-option resolution (promote / rename incoming / use existing / abort) + follow-ups (host module, manage decision)
  🟢 cost_centers → already shared in `finance` master (auto-wire)
  💡 Cluster hint: cost_centers → finance (matched existing master `finance`, recommended)
  🌱 (planned) Seed `parties_manager` with 3 members from `itsm_manager` if option 1 picked
🔗 Permission inclusions (cross-module, new):
   itam:read    → parties:read         [origin=model_master, always]
   itam:manage  → parties:manage       [origin=model_master, pending manage-option pick]
   itsm:read    → parties:read         [origin=model_master, always]
   itsm:manage  → parties:manage       [origin=model_master, pending manage-option pick]
   itam:read    → finance:read         [origin=model_master, Branch A read inclusion]
```

### Cross-model link suggestions (additive, reversible)

§6 link proposals are **additive and reversible**: adding an optional cross-module FK never breaks the local module, never deletes data, and can be removed later by editing the model and redeploying. Because of that the deployer's posture is *err toward implementing*. Don't drag the user through individual confirmation when the analyst has already drafted a hint and the target exists in the catalog.

**Print the link-proposal summary as prose first** (the same `🔗 Connections to other modules` block from the normal plan), so the user has the list in front of them before any widget appears.

**Resolve Ambiguous rows first.** Any rows marked 🟡 Ambiguous in Stage 2g (multiple plausible targets matched the `To` concept) gate which proposals are even askable. Batch one question per ambiguous row into a single `AskUserQuestion` call. Each question's options list the candidate target tables (with their owning module for context) plus a "skip this row" option. After the user picks, the Ambiguous rows that resolved promote into the ✨ Proposed list and the rest drop out.

**Resolve Field-name collisions next.** Any row marked 🛑 Field-name collision in Stage 2g (the auto-generated `<target_singular>_id` already exists on `from_table`) is also batched into the same `AskUserQuestion` call. Options: provide an alternative field name (the runtime's "Other" slot accepts free text) or skip the row. Unresolved-source rows are also surfaced here for the user to fix the model via the analyst skill before this stage retries.

**Then approve the Proposed list.**

- **0 proposals**, skip this section entirely; nothing to ask.
- **1–3 proposals**, present inline with one combined confirmation: *"Apply these N cross-model link suggestions? [yes / review each / skip all]"*. Default branch on `yes` is "apply all".
- **4 or more proposals**, call `AskUserQuestion`:

  - **question**: `"Found N possible connections between this module and other modules already deployed. How should we handle them?"`
  - **header**: `"Module connections"`
  - **multiSelect**: `false`
  - **options** (in this order, recommended first):
    1. label `"Connect all (Recommended)"`, description `"Add every connection in one pass. Each is an optional link, removable later if you change your mind. Best when the other modules are familiar."`
    2. label `"Review each one"`, description `"Walk through each connection individually. Use when you're unsure about any of the targets, or when a connection touches a sensitive shared module."`
    3. label `"Skip them all"`, description `"Deploy the module without any of these connections. They'll come back next deploy unless you remove them from the design first."`

**On `Apply all`**, Stage 4h executes every Proposed row without further prompts.

**On `Review each one`**, fall back to one batched `AskUserQuestion` with one question per proposal (yes / skip), then Stage 4h executes only the accepted ones.

**On `Skip all`**, Stage 4h is a no-op. The dormant rows and the explicitly-skipped ones are noted in the verification summary so the user knows nothing was wired up.

This flow is **distinct from the 🛑 ambiguity protocol below for entity name collisions**. Entity-name ambiguity gates are blockers; the deploy cannot proceed until the user picks merge / rename / etc. Link proposals are not blockers; skipping them lets the deploy proceed unchanged. Keep the two flows separate.

### No ambiguity widgets at the modeler layer

The modeler does NOT drive `AskUserQuestion` widgets for cross-module collisions, similar-name flags, master promotions, or merge / rename decisions. Every such decision is already encoded in the spec as a `**Reconciliation:**` annotation. If Stage 2 detected drift (an annotated `reuse-from` target is missing, a `rename-incoming-from` target name now exists, a `promote-to-master` host module is missing or wrong type), the modeler halts and routes the user back to the analyst — it does not try to re-decide.

**The only confirmation the modeler asks** is the final pre-execute yes/no after the plan summary:

> *"Plan shown above. Proceed with execution?"*

A `select_rule` create / modify or an `edit_permission` tier flip still pauses for explicit confirmation (medium-risk: read-visibility or write-tier change). The **Stage 2.5 access-control prompt** is the one other permitted mid-flow prompt, and it is bounded the same way: it fires **only** when the access-control choice is genuinely undecided (no `access_scope` in the spec frontmatter, no `settings.access_scope` on the module). When the spec encodes the choice — the hybrid path — no prompt fires; the modeler obeys, exactly as it obeys a `**Reconciliation:**` annotation. The prompt is a deploy-time decision the spec deliberately left open (same category as the §6 cross-model-link prompt), not a re-litigation of a decision the spec already made. These are the only mid-flow prompts.

### Merge / rename rules (informational)

When the spec carries `rename-incoming-from <existing_module>.<existing_entity> as <new_name>`, the modeler creates `<new_name>` as a brand-new entity in this module. There is no `update_entity` rename — the existing entity stays where it is, untouched. The user has decided (via the analyst) that the two concepts are different and should silo.

When the spec carries `promote-to-master <master_module>.<entity>`, the modeler **reassigns the existing entity to `<master_module>`** via `update_entity` (changes `module_id` only — the entity's `slug`, underlying Postgres table, data, and every `reference_table` pointer at it across the catalog stay byte-for-byte unchanged). Creates `<master_module>` if missing per the spec's `promotion_decisions` frontmatter. Seeds the master's `<master>_manager` role from the original module's `<original>_manager` members, and adds cross-module permission inclusions per the recorded `manage_option`. The original module gets a `permission_hierarchy` row `<original>:read → <master>:read` (always) and `<original>:manage → <master>:manage` (conditional on `manage_option`). **No data migration, no FK rewires, no orphan tables** — this is a metadata-only operation in the catalog.

When the spec carries `reuse-from <module>.<entity>` for a master/shared entity, the modeler adds a `permission_hierarchy` row `<consumer>:read → <master>:read` (always, idempotent) and `<consumer>:manage → <master>:manage` (if the spec's `promotion_decisions` says so).

## Stage 4: Execute

> **Access-control projection (Stage 2.5).** When Stage 2.5 resolved `basic` and the spec is full-shaped, every sub-stage below is **narrowed per the Stage 2.5 two-permission projection table** — fewer permissions / roles / hierarchy rows (4a-scaffold, 4b), `edit_permission` forced to `<slug>:manage` (4c), permission-gated rules dropped (4e / 4f), and governance stages (4k / 4l / 4m) skipped entirely. When Stage 2.5 resolved `full`, or `basic` against an already-two-permission spec, every sub-stage runs as written. The projection only narrows; it never creates anything a full deploy wouldn't.

Follow the use-semantius mandatory creation order exactly:

```
Module → Permissions → Entities → Fields (per entity, in model order)
```

**Failure is loud and halting (the recovery model depends on it).** The deploy's entire recovery story is re-run convergence: the spec is the target, every Stage 4 op is read-before-write and idempotent, and a failed or partial deploy is recovered by **re-running** — there is no transaction, rollback, or resume (PostgREST is stateless). That model is only safe if a partial failure is **visible**. So when any Stage 4 sub-stage's write fails (a `create_*` / `update_*` / `postgrestRequest` returns non-zero, a platform constraint trips, or a ⚠ row forces a FAIL LOUD), **stop immediately and tell the user the deploy is incomplete and must be re-run** — do not swallow the error, do not continue to the next sub-stage, and never let the closing message or the Stage 5 summary print a success-shaped result over a partial write. The single way this model breaks in practice is a partial failure that reads as success, so the operator never re-runs. State the halt plainly (and within the Writing Conventions, no em-dashes in this user-facing line): *"Deploy halted at `<sub-stage>` after N writes. The deploy is incomplete: fix the cause and re-run, and the modeler reconciles forward from wherever it stopped (every op is idempotent, so re-running never double-creates)."* This is especially load-bearing inside 4k living-mode, which materializes the RACI engine across five separate `postgrestRequest` batches (`processes` → `raci_assignments` → `process_gates` → enforcement rules → `raci_mode` flag): a mid-sequence abort there must surface, never be summarized away.

Refer to `use-semantius/references/data-modeling.md` for the exact CLI syntax for each operation. **Before executing, apply every ambiguity decision from Stage 3** to the in-memory plan, renames propagate to every `reference_table` and relationship reference in the model. The sequence:

### Provenance stamping (core columns; applies to every create in this stage)

The platform ships core provenance columns the modeler is the only writer of. **The deployer stamps these values at provision time** — they are how rename detection, canonical-owner-arrival, behavior discovery, and cross-domain merges become deterministic platform reads downstream (the analyst on re-reconcile, and every `use-*` discovery skill). The rules, once, for the whole stage:

- **Stamp VALUES only — never `create_field` these columns, never write `ctype`.** Core registers them with `ctype = 'core'` (so `is_core` is *derived* as `ctype <> ''`); `ctype` is privilege-locked. The modeler does **not** create these columns and does **not** stamp `is_core` — it passes the column values on the `create_*` / `update_*` payload it already sends. (If a deploy ever errors that one of these columns is missing, the platform is too old — surface that; do not try to `create_field` it.)
- **`entities.catalog_entity_code` = the CANONICAL code**, from the spec's `**Catalog entity code:**` line (NOT `table_name`, which holds the deployed / dialect / silo name). Default to `table_name` only when the line is absent.
- **`entities.canonical_owner_module`** = the owner-module slug from the spec's `**Canonical owner:**` line (an `embedded_master` provisioned locally as a placeholder while its canonical owner module is absent); `''` when the line is absent (this module owns the entity (`role = master`), or it is local). Soft string, not an FK.
- **`entities.entity_type`** = the class from the spec's `**Entity type:**` line; **`'unclassified'` (never `''`) when absent.** Must be one of the six CHECK values.
- **`entities.pattern_flags`** = the sparse `{flag: true}` object from the entity's authored flags; `{}` when none.
- **`entities.catalog_entity_aliases`** = **APPENDED** to on a reuse/merge that renames an incoming entity onto an existing host (read the host's current array, push each new `{alias_code, source_domain, source_module, decided}` element, write back). **Never rewrite or drop prior elements**; a plain `create_entity` leaves it at `[]`.
- **`modules.catalog_module_code`** = the catalog blueprint / `system_slug` the module was provisioned from; plus the `modules.settings` keys (`naming_mode`, `module_kind`, `domain_code`, `catalog_snapshot`, `promotion_decisions`), on `create_module` / `update_module`.
- **`roles.catalog_role_code`** = the catalog persona/role slug a role was provisioned from, on every `create_role`.
- **Codes are write-once at create.** The two scalar codes (`catalog_entity_code` / `catalog_module_code`) are set on the create call and **never re-sent on a later rename** — a rename touches `table_name` / `module_slug` only. Core enforces immutability-once-non-empty, so a re-send of a *changed* value is rejected; a re-run that re-sends the *same* value is a harmless idempotent no-op.

**4a. Module**, If missing, `create_module` with `module_name: "<system_name>"`, `module_slug: "<system_slug>"`, `description: "<system_description>"`, `module_type: "<frontmatter_module_type>"` (defaulting to `"domain"`), **`catalog_module_code: "<source blueprint code / system_slug>"`** (write-once lineage; the catalog blueprint this module was provisioned from, or `system_slug` for greenfield), and the **`settings`** provenance keys (`settings.naming_mode` from the spec's `naming_mode`, `settings.module_kind` from `module_kind`, `settings.domain_code` from the spec's frontmatter `domain_code`, `settings.catalog_snapshot` from the spec's frontmatter `reconciled_against_catalog_snapshot`, `settings.promotion_decisions` from the frontmatter when present, **`settings.access_scope` from the Stage 2.5 resolved scope** — record `basic` / `full` so future re-deploys read it back at Stage 2.5 step 2 and never re-ask). If it already exists, `update_module` to refresh `module_name`, `description`, and (if missing) `module_slug` from the model, and fill any **empty** provenance keys (do not overwrite a non-empty `catalog_module_code`; merge `settings` keys rather than replacing the object). **`settings.access_scope` is the exception to "fill only empty"** — when Stage 2.5 resolved a scope (whether from the spec directive or a fresh prompt), write it even if a prior value exists, so an explicit re-choice (e.g. the user re-deploys the spec under a new scope) sticks; a deploy that merely read the live value back at step 2 re-writes the same value (idempotent no-op). **Never flip `module_type`** on a re-deploy of a domain module — promotion is the explicit Stage 2d Branch B flow, not an inferred update. Never create a duplicate module with the same `module_slug`. The `alias` field is gone, do not pass it.

**Master-model branch.** When frontmatter `module_type: master`, 4a takes the master-model resolution from Stage 2a (exact-slug match → entity-overlap match → create-new). For the exact-slug-match branch with a slug rename approved by the user, also run the rename cascade in 4b-rename below. For entity-overlap consolidation of multiple sibling masters, the per-source consolidate decisions feed into 4c-merge-master.

**Scaffold pass.** After 4a's module create-or-update, run the standard scaffold (Stage 2a-scaffold steps 2–5): create permissions per tier (idempotent), create the hierarchy chain tagged `origin = "model"` (domain) or `"model_master"` (master), create default roles per tier using the §9.1-resolved role slugs (read verbatim, not reconstructed from the module slug) with `origin` tagged matching the module type **and `catalog_role_code` stamped from the §9.1 baseline-role slug** (lineage; VALUE-only, write-once), attach `role_permissions`, and populate the six module-record FK / column references. Each step is idempotent on re-run. Surface the three-permission upgrade case as `✨ <slug>:admin / <slug>_admin role` plan lines.

**`logo_color` fallback.** After the create-or-update, read the module's live `logo_color`. If it is empty (`""` or null), compute one random dark shade of red, green, blue, or orange at runtime and write it back via `update_module`. Use HSL so the dark-and-readable constraint is enforced uniformly across hues, then convert to hex.

Recipe:

1. Pick a hue family uniformly from `{red, green, blue, orange}`, then pick a hue degree uniformly from that family's band:
   - Red: `H ∈ [350, 360] ∪ [0, 10]`
   - Orange: `H ∈ [20, 40]`
   - Green: `H ∈ [100, 150]`
   - Blue: `H ∈ [205, 240]`
2. Pick saturation `S ∈ [55, 90]` (%) — saturated enough to read as a real color, not muddy.
3. Pick lightness `L ∈ [18, 30]` (%) — the dark band; below 18 gets crushed to near-black, above 30 stops reading as "dark".
4. Convert HSL to hex (`#rrggbb`, lowercase, 6 digits) and write via `update_module`.

Only fill the gap — never overwrite a `logo_color` the user (or an earlier deploy) already set. This is purely a cosmetic guardrail so module selector chips get a dark, readable backdrop instead of the platform's empty-string default. Picking a fresh shade per deploy means re-runs against the same empty-state module will land different colors; that's intentional — once set, it sticks, and the user can override at any time.

**4b. Permissions and hierarchy.** Permission creation itself is owned by the Stage 2a-scaffold pass (run as part of 4a's create-or-update): it iterates the §8.1 Permissions catalog index in table order and creates every missing row, passing the §8.1 `description` cell verbatim — baseline tiers (`<slug>:read`, `<slug>:manage`, `<slug>:admin`) and workflow tiers alike. **Do not restate or override those descriptions here.** 4b's responsibility is the **permission hierarchy chain** plus the re-run reconciliation that follows.

Then ensure the **permission hierarchy chain** exists via `create_permission_hierarchy` so broader (including) permissions transitively grant narrower (included) ones (see use-semantius `references/rbac.md` § "Set Up Permission Hierarchy"). A row reads as `including_permission_id` ── *includes* ──▶ `included_permission_id`:

- For three-permission models: `including_permission_id` = `<slug>:admin`, `included_permission_id` = `<slug>:manage`; AND `including_permission_id` = `<slug>:manage`, `included_permission_id` = `<slug>:read`.
- For two-permission models: `including_permission_id` = `<slug>:manage`, `included_permission_id` = `<slug>:read`.

`read_permission_hierarchy` first with `including_permission_id=eq.<including_id>&included_permission_id=eq.<included_id>` to check whether the row already exists (re-runs are idempotent). Create only missing rows. **Never invert direction** — the narrower permission must never appear on the including side (that would mean the narrower one "includes" the broader, which breaks RBAC).

**Re-run reconciliation.** When the module already exists with the legacy two-permission baseline but the current model has been upgraded to need three (any §3 entity now carries `**Edit permission:** admin`), the deploy adds the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row additively. Surface this in the Stage 3 plan as `✨ saas_expense_tracker:admin` and `✨ admin → manage` so the user can see the upgrade. Never delete or rename existing permissions or hierarchy rows.

**4b-rename: master-model rename cascade.** When a master-model deploy resolved Stage 2a via exact-slug or entity-overlap match AND the user opted to rename the existing master to the model's `system_slug` (e.g. `vendors` → `vendor_management`), coordinate the cascade. Platform behavior (confirmed):

- `modules.module_slug` rename works on populated modules.
- Permission codes whose names embed the slug (`vendors:read`) do not auto-rename. The deployer explicitly calls `update_permission`.
- Default-role slugs (`vendors_viewer`) do not auto-rename. The deployer explicitly calls `update_role`. (Permitted by `system_role_slug_immutable`: only `origin = "system"` slugs are locked; `model` / `model_master` are deployer-rewritable.)
- Role-permission links are FK-based and don't need to be touched.
- Entity `module_id` FKs and cross-module `permission_hierarchy` rows reference by id; no rename needed.

Orchestration sequence per rename:

1. `update_module` to set new `module_slug`, `module_name`, `description`, AND `view_permission = "<new>:read"` together (the text-column natural-key reference embeds the slug; write it in the same update).
2. `update_permission` for each of `<old>:read`, `<old>:manage`, `<old>:admin` (the latter only when it exists). New `permission_name` reflects the new slug.
3. `update_role` for each of `<old>_viewer`, `<old>_manager`, `<old>_admin` (the latter only when it exists). New `slug` reflects the new module slug.

Roughly 6–8 writes for a typical master rename. Each step is a pure name swap with no FK changes, so the cascade is **forward-recoverable**: if any step fails partway, the catalog is in a half-renamed state (some records on the new slug, others still on the old), and re-running the deploy completes the cascade. At the start of each rename pass the deployer reads the current `module_slug`, `permission_name`, and `role.slug` values and only issues `update_*` calls for records still pointing at the old slug. No rollback path (PostgREST is stateless and has no transaction envelope); forward recovery is the only recovery model.

Surface in the Stage 3 plan as a `🔁 Renaming master module:` block listing each old → new pair (module + permission codes + role slugs). If any `update_*` call fails for a structural reason (e.g. `update_module` rejects the slug rename), stop and surface a 🛑 with the platform error.

**4c. Entities**, Walk model §2 in order and apply each entity's bucket decision:

- 🔒 Built-in → skip entirely. Do not `create_entity` for `users`, `roles`, etc. The §3 `**Edit permission:**` annotation, if any, has no effect on built-ins.
- 🟢 Shared-master match (Branch A) → skip `create_entity`. The target is the existing entity in the master module. Field diffs on the master entity are applied additively in 4d as usual. JSON arrays (`computed_fields`, `validation_rules`) are merged with `source_module` tagging per 4e-merge instead of wholesale-replaced. The cross-module wire-up happens in 4i. **Provenance:** the master entity already carries its own stamped `catalog_entity_code` / `entity_type` — do NOT restamp them (the codes are write-once). If the spec carries `**Catalog alias:**` line(s) on this host (this domain's blueprint called the concept by a different canonical code that reconciled onto the shared master), APPEND each element to the master's `catalog_entity_aliases` exactly as in the merge case below.
- ♻️ Same-module match → skip `create_entity`. **First converge the owning FK: if the live entity's `module_id` is NULL or does not equal this module's id, `update_entity` to set it** (repairs an entity stranded with a NULL `module_id` by an earlier buggy deploy — the scaffold converges, it does not skip a row just because it already exists). Then, if the model's `**Audit log:**`, `**Edit permission:**`-derived `edit_permission`, `**Label parent:**`-derived `label_parent`, `singular_label`, `plural_label`, `description`, **`computed_fields`**, or **`validation_rules`** differ from the live entity, call `update_entity` to sync (for `label_parent`: set it to the spec's named FK when the line is present, or clear it to null when the spec omits the line and live carries a stale value). **Behavior depends on the host module's `module_type`:** for `module_type = "domain"`, `computed_fields` and `validation_rules` are **wholesale replacements** (existing behavior, see 4e); for `module_type = "master"`, they are **merged by `source_module` tag** (see 4e-merge). For `edit_permission` specifically: read the live entity's current `edit_permission` first, and only `update_entity` when the resolved permission name (e.g. `<slug>:admin` vs `<slug>:manage`) differs; surface the change to the user in the Stage 3 plan as a tier flip so they can sanity-check (a tier flip is a real RBAC change). Then fall through to 4d (field diff).
- ✨ New → `create_entity`. **Pass `module_id` = the id of the module this entity is being created in** (the Stage 2a-resolved domain module here; the master module's id under `promote-to-master`). This is **required** — the platform rejects a null `module_id`, and an entity that slips through with NULL belongs to no module (see the Model-to-Entity Mapping note). Pass `audit_log` from the §3 `**Audit log:**` line (default `false` when the line is missing or says `no`). Pass `view_permission: "<system_slug>:read"` and `edit_permission` derived from the §3 `**Edit permission:**` line: `"<system_slug>:admin"` when the line says `admin`, `"<system_slug>:manage"` otherwise (default, or when the line is absent). Pass `computed_fields` and `validation_rules` from the §3 sub-blocks (default `[]` when absent). For a master-module deploy (`module_type: master`), each `computed_fields` / `validation_rules` entry is tagged with `source_module = "<system_slug>"` before send. **Stamp the provenance columns on this same `create_entity` payload** (per "Provenance stamping" above): `catalog_entity_code` = the spec's `**Catalog entity code:**` (CANONICAL, default `table_name`); `entity_type` = the spec's `**Entity type:**` (`'unclassified'` when absent); `canonical_owner_module` = the spec's `**Canonical owner:**` slug (a placeholder `embedded_master` whose owner is absent), else `''`; `pattern_flags` = the sparse `{flag:true}` object (else `{}`). Also pass `label_parent` = the spec's `**Label parent:**` FK name **only when the line is present** (omit the key entirely — leaving `null` — when absent); it is a normal nullable property, not a write-once provenance code. After creation, correct the `label_column` field title if needed with `update_field`.
- 🛑 Resolved as **merge** → skip `create_entity`. The target is the existing entity in the other module. Record the mapping; the merge is realized in 4d by adding the non-overlapping fields additively to the existing entity. **If the spec carries `**Catalog alias:**` line(s) on the host (a cross-domain identity renamed onto it), APPEND each `{alias_code, source_domain, source_module, decided}` element to the host's `catalog_entity_aliases`:** read the host's current array, push the new element(s) only when an equal `(alias_code, source_domain)` pair is not already present (idempotent on re-run), and `update_entity` with the extended array. Never rewrite or drop prior elements.
- 🛑 Resolved as **rename incoming** → `create_entity` using the new name. (Plan-level rewrite of `reference_table` values has already happened before this stage.)
- 🛑 Resolved as **rename existing** → attempt `update_entity` on the existing entity's `table_name` first, before any new creates. If the platform rejects the rename, stop and return to Stage 3, never continue silently. Once the rename succeeds, Semantius repoints every catalog-side `reference_table` automatically; no follow-up `update_field` pass is needed.
- 🛑 Resolved as **rename both** → do the existing-rename first, then `create_entity` for the incoming under its new name.
- 🛑 Resolved as **promote to shared master** (Branch B, option 1 of the four-option widget) → run 4c-promote (below). Plan line `📥 Promoting <entity> → <master>`.
- 🛑 Resolved as **abort** → stop Stage 4 entirely; tell the user to iterate on the model with the analyst skill.

**4c-promote: Branch B promotion.** When the user picked "Promote to shared master module" at Stage 2d-branch-b, the follow-up answers carry the host-module decision (existing master to join OR new master to create) and the manage option (1–4). 4c-promote orchestrates the move:

1. **Ensure the master module exists.** If the user picked "create new master," issue `create_module` with `module_type: "master"` and the chosen slug / name (`<system_name>` defaults to the slug humanized, e.g. `parties` → `Parties`), **stamping `catalog_module_code` and the `settings` provenance keys per 4a**. Then run the scaffold pass (Stage 2a-scaffold steps 2–5) so the master has its three permissions, three default roles (each with `catalog_role_code` stamped), and six module-record references. If the user picked an existing master, capture its id and skip create; if its scaffold has gaps (a master created in a prior tenant lifecycle before scaffolding was standard), the scaffold pass fills them now. Plan line: `🆕 Master module created: <slug>` for new masters, omitted for existing.
2. **Move the entity.** Read the entity's live `module_id` first; issue `update_entity` setting `module_id` to the master module's id **only when it isn't already there** (a re-run finds the entity already moved and skips the write — read-before-write, like every other Stage 4 op). The platform repoints every catalog-side FK that references this `table_name` automatically. **Confirmed:** `update_entity` accepts `module_id` change on a populated table; no DDL needed, FKs survive. **Provenance:** the entity now lives in its canonical home, so in the same `update_entity` clear `canonical_owner_module` to `''` (the placeholder pointer is satisfied — this module owns it now). Do **not** touch `catalog_entity_code` — it is write-once and was stamped at the entity's original create. (For the variant where `promote-to-master` *creates* the entity fresh in the master because it was never on a placeholder, the ✨-New `create_entity` stamping applies, but with `canonical_owner_module = ''` since the create lands in the canonical owner.)
3. **Tag JSON arrays with source.** For each entry in the moved entity's `computed_fields` and `validation_rules`, set `source_module = "<original_module_slug>"` so re-runs of either module can merge correctly (see 4e-merge). Done via `update_entity` setting the arrays.
4. **Cross-module wire-up** runs in 4i (every consumer gets its read inclusion, plus manage inclusion per the picked option).
5. **Seed master manager role** runs in 4j (snapshot copy of `<original>_manager` members into `<master>_manager`).

**4c-merge-master: master-vs-master consolidation (Path 2 cleanup).** When a master-model deploy resolved Stage 2a via entity-overlap match AND multiple source masters host the model's declared entities, the per-source consolidate decisions from Stage 2a feed in here. For each source master the user opted to consolidate:

1. **Move each affected entity.** `update_entity` to change `module_id` to the target master.
2. **Re-point consumer cross-module bridges.** For every cross-module `permission_hierarchy` row `(parent, child)` whose child is one of the source master's read/manage permissions (`<source_master>:read` or `<source_master>:manage`) AND whose parent is in a *different* module (i.e. an outside consumer, not the source master's own internal chain), check whether the equivalent target-master bridge already exists. If it does (e.g. the consumer was already wired to the target master via a prior merge or a Branch A wire-up), **leave the source bridge alone** — it now points at the orphan source-master permission, which is harmless because the source master is itself an orphan, and the deployer never deletes catalog rows. If the target bridge does not yet exist, call `update_permission_hierarchy` to set the child to the corresponding target-master permission (the row's id stays the same). Result: the consumer ends up with exactly one live bridge per tier to the target master, and any duplicate source-side bridges are left as inert orphans referencing the orphan source master.
   The source master's **internal** chain rows (`<source_master>:manage → <source_master>:read` tagged `origin = "model_master"`) are also left alone — they point at orphan permissions inside an orphan module, no functional effect.
3. **Leave source masters alone.** The deployer never deletes the now-empty source master, its permissions, its default roles, its `role_permissions`, or its intra-master hierarchy rows. They remain as quiet orphans in the catalog (see "No auto-deletion" rule below). An admin who notices may drop them manually; the verification report does not flag them.

Plan line: `📥 Merging master modules:` block listing each source → target pair. Path 2 should approach zero in practice; this branch exists for the rare misauthored case.

**4d. Fields**, For each entity, create missing fields in model order with `create_field`. Skip auto-generated ones (`id`, `label`, `created_at`, `updated_at`, the `label_column` field, and the platform-derived composed-label columns `_label` / `<fk>_label`). **Reserved-name guard (defense-in-depth):** before any `create_field`, reject any `field_name` that starts with `_` or ends with `_id_label` — those are platform-reserved for the `_label` / `<fk>_label` columns and the platform rejects them too. A spec carrying such a name is an authoring bug; FAIL LOUD and route the user back to the analyst rather than attempting the write. Always include `width: "default"` and `input_type: "default"`. For FK fields whose `reference_table` is a built-in (`users`, `roles`, …) or a merged existing entity, point directly at that `table_name`, the platform doesn't care whose module owns it.

**Presence-conditional FK skip.** Before issuing a `create_field` for a reference / parent FK whose `reference_table` would target an entity declared in the spec via a §5 edge with `delete_mode: none (required-if-present)`, check whether the target entity is installed in the live catalog AND not in this deploy. If the target is absent in BOTH places, **SKIP the field create entirely**. No column is emitted and no constraint is created. Without this skip, a broken non-null restrict would land on every row; instead nothing is emitted. Plan line: `💤 Skipping FK <from>.<target_id> → <target_entity> — target not installed (presence-conditional)`. The skipped row is recorded in Stage 5's structured verification report.

**⚠ annotation handling.** For each parsed §7 lifecycle row marked `data_quality_flagged` (carrying `⚠ state-machine shape` or `⚠ unresolved gate`), the deployer **SKIPS or FAILS LOUD**: do NOT auto-resolve, do NOT silently provision. The default is SKIP with a Stage 5 line `⚠️ Skipped on ⚠ flag: <entity>.<state> — <verbatim reason>`. When the ⚠ row is one whose presence the rest of the deploy depends on (e.g. a `⚠ unresolved gate` on a state that another stage references), the deployer FAILS LOUD with the verbatim reason, asking the user to fix the source data and re-run the analyst.

**Computed-field columns are deployed as `input_type: "disabled"`.** Before issuing each `create_field`, check whether its `field_name` appears in the parent entity's `computed_fields[].name` list. If yes, override `input_type` to `"disabled"` instead of `"default"`, regardless of anything else the model says about that field's input_type. The platform silently overwrites caller-supplied values for any column listed in `computed_fields` (see use-semantius `references/data-modeling.md` § "Evaluation semantics" — *"Caller-supplied values for a computed field are silently overwritten"*), so the UI hint must match the semantics — otherwise the auto-generated form lets users type into a field whose value will be clobbered on save. `"disabled"` (greyed-out, cannot receive focus) is the right mode rather than `"readonly"` (rendered as plain text but still focusable / submittable): the value is platform-owned, not user-corrected, and the greyed-out treatment signals that unambiguously. This is a deployer-enforced consistency rule between two model declarations the user has already made consistent in intent; the JsonLogic stays verbatim and the model file is not modified.

For ♻️ same-module matches and 🛑 merges, do not just create the missing fields and stop — walk every model field against its live counterpart and emit `update_field` for each property that has drifted. The diff is essentially free: one `read_field` per entity (filter `table_name=eq.<table>`) already returns every property in a single round-trip, and local comparison is microseconds. Skipping the diff is the reason changed descriptions, title corrections, enum extensions, and same-primitive format adjustments fail to land on re-runs.

For each model field on this entity:

- **Field absent live** → `create_field` as before (auto-generated fields `id`, `label`, `created_at`, `updated_at`, the entity's `label_column`, and the composed-label columns `_label` / `<fk>_label` are still skipped).
- **Field present live** → compute the property delta against the model and emit **one** `update_field` carrying every changed key. Issue one call per drifted field (not one per property) so the audit log records a coherent change set per column. Properties to compare:
  - `title`, `description` — sync to model value.
  - `required`, `searchable`, `width`, `input_type` — sync to model value.
  - `format` — sync to the model value and let the platform decide. Same-primitive changes are accepted by Semantius (TEXT family: `text`/`multiline`/`html`/`json`/`email`; numeric: `integer`/`number`; temporal: `date`/`datetime`). Cross-primitive changes return a primitive-change error — quote the error back verbatim and route the user to the analyst skill for a model-level rethink. The deployer doesn't keep its own primitive taxonomy; Semantius is authoritative.
  - `enum_values` — only sync **additive** extensions (model values the live row doesn't have). Removals (live values the model omits) are unsafe — existing rows may carry the removed value and the constraint tightening will fail at write time. Removals are caught in Stage 2 and surfaced as a 🛑 in Stage 3, never silently applied here.
  - `reference_table`, `reference_delete_mode`, `relationship_label`, `is_unique` (FK metadata) — sync to model value.

The `disabled` rule from Stage 4d's create path also applies on re-runs: for every existing field whose name appears in `computed_fields[].name`, if its live `input_type` is anything other than `"disabled"`, include `input_type: "disabled"` in the same `update_field` call. This catches both newly-introduced computed fields (the column existed first, then the model added it to `computed_fields`) and corrections to live data where someone manually toggled the input_type to an editable mode. Live fields still carrying the legacy `"readonly"` (from deploys made before this skill switched modes) are migrated to `"disabled"` on the next re-run by this same rule.

**Don't blind-upsert.** Calling `update_field` on every field regardless of drift is tempting because it's one less branch, but it bloats the audit log, masks live drift that the user may want to see (e.g. someone tightened a description live and the model is stale — the diff exposes that, a blind overwrite silently destroys it), and is strictly slower (more write round-trips than necessary). The diff is the fast path.

**4e. Apply write-side rules (computed_fields, validation_rules).** The platform validates `computed_fields[].name` against the entity's fields at deploy time, so these arrays can only be set once every field they reference exists. Sequence:

- For ✨ **new entities**, pass `computed_fields` / `validation_rules` on `create_entity` only when **every** referenced field is also auto-created by Semantius (rare: typically only the `label_column`). The safer default is to pass `[]` (or omit) on `create_entity`, then call `update_entity` with the full arrays after 4d has created the referenced fields. Either path lands the same trigger.
- For ♻️ **same-module matches** and 🛑 **merges**, call `update_entity` with the model's arrays after 4d's field diff has synced the underlying columns. If a referenced column doesn't yet exist on the live entity but is being added in this run, sequence the field create first.
- For 🔒 **built-ins**, never push `computed_fields` or `validation_rules` from the model onto a built-in entity — those tables run platform logic and the model's rules would conflict. Stop and surface this to the user before any write.

After the call, surface to the user: *"Applied N computed_fields and M validation_rules on `<table_name>`."* If `update_entity` rejects the arrays (malformed JsonLogic, unresolved field name, duplicate `code`), the error message names the offending entry's array index — quote it back to the user and ask the analyst skill to fix the model before re-running. Do not attempt to repair JsonLogic in the deployer.

**4e-merge: master entity JSON-array merge with `source_module` tagging.** For entities whose host module's `module_type = "master"` — which includes Branch A wire-ups, 4c-promote target masters, and master-model deploys — `computed_fields` and `validation_rules` are **merged**, not wholesale-replaced. The merge model lets multiple consuming models contribute rules to the same master entity without trampling each other.

Each entry carries an optional `source_module` field. The deployer sets it automatically when emitting an entity update: the value is the `system_slug` of the model currently being deployed. Legacy entries without `source_module` (created before this design, or admin-edited via the UI) are treated as `source_module = "user"` for rule purposes.

**Merge logic (per array, per master entity).** Read the live entity's arrays first; build the merged result by walking each incoming entry against the live state. The natural key is `name` for `computed_fields` and `code` for `validation_rules`, treated **globally within the entity** — `source_module` is reconciliation metadata, not part of the uniqueness key.

1. **Incoming entry, same key, same `source_module` as a live entry** → incoming replaces the live entry (per-source wholesale replacement; existing behavior, scoped). Tag the merged entry with the same `source_module`.
2. **Incoming entry, same key, different `source_module` from a live entry** → conflict. Surface as a 🛑 via `AskUserQuestion` with the comparison block printed as prose first:
   - keep live (drop incoming, recommended when live is admin-authored or from a stable source);
   - keep incoming (replace live, sets `source_module` to the incoming model's slug);
   - rename the incoming code (e.g. `vendor_email_required` → `<incoming_slug>_vendor_email_required`) and add as a new entry;
   - abort the deploy.
   Rule 2 always beats rule 4: a key collision is a real conflict even when the live owner isn't part of this deploy.
3. **Incoming entry, no key match in live** → additive: append to the merged array, tagged with the incoming model's `source_module`.
4. **Live entry whose key is not touched by any incoming entry** → leave alone, regardless of `source_module`. Entries from other consumers and admin-created entries (`source_module = "user"`) are preserved across re-runs.

Send the merged array via `update_entity`. The platform replaces the column wholesale (it does not know about the merge); the deployer is the entity that owns reconciliation.

**Source-tagging the platform's own rules.** The three platform-installed validation rules (`origin_immutable_roles`, `system_role_slug_immutable`, `origin_immutable_hierarchy`) are tagged `source_module: "platform"`. Treat `"platform"` as a reserved source name: the deployer never emits it for model-driven rules, and the merge always leaves `"platform"`-tagged entries alone (rule 4).

**Where the merge applies.** Only to entities hosted in a `module_type = "master"` module. Domain entities keep wholesale-replacement semantics from the existing 4e flow. Branch A wire-ups never `create_entity` the master entity (it already exists); they only contribute additive fields (4d) and merged JSON entries (4e-merge).

**4f. Apply read-side rules (select_rule, input_type_rule).** Read-side rules sit one layer up from write-side rules: `select_rule` filters per-row visibility (an entity-level RLS policy), and `input_type_rule` overrides each field's UI mode per-record at form render. Same prerequisite as 4e — every field referenced inside either rule's JsonLogic must already exist — so 4f runs **after** 4d (field diff) and **after** 4e (write-side rules) so error messages stay attributable to the right rule type.

Sequence per entity:

- **`select_rule` (per entity).** Read the model's parsed `select_rule` object for this entity. Compare against the live value (Stage 2's `read_entity` already returns it):
  - Model carries `Select rule` heading with a non-empty object AND live is empty → `update_entity` with `data.select_rule = <model_object>`. **Warn the user before the call:** *"About to apply `select_rule` to `<table_name>`. After this, callers will see only rows matching the rule. Confirm rollout?"* This is a medium-risk read-visibility change (rows that callers used to see disappear); the user must explicitly confirm.
  - Model carries `Select rule` heading with the same object as live → no-op.
  - Model carries `Select rule` heading with a non-empty object that differs from live non-empty → `update_entity` with `data.select_rule = <model_object>` after showing the diff to the user and confirming. Same medium-risk warning as above.
  - Model carries `Select rule` heading with `{}` AND live is non-empty → `update_entity` with `data.select_rule = {}`. The platform drops the generated `FOR SELECT` RLS policy function. **Warn the user explicitly:** *"About to remove `select_rule` from `<table_name>`. After this, all rows become visible to anyone with `view_permission`. Confirm?"* This is a medium-risk widening change; the user must confirm.
  - Model omits the `Select rule` heading entirely AND live is empty → no-op.
  - Model omits the `Select rule` heading entirely AND live is non-empty → **ambiguous**. Do not silently clear (same rule as `computed_fields` / `validation_rules` drift). Surface the live rule to the user: *"`<table_name>` has a live `select_rule` but the model omits the heading. Keep the live rule (round-tripped through optimizer would have echoed it) or remove it (pass `{}` to drop the RLS policy)?"* Wait for a decision; do not proceed.

- **`input_type_rule` (per field, then in aggregate).** For each entry in the entity's parsed `Input type rules` list:
  - Resolve the entry's `field` against the entity's live field list (it must exist — Stage 4d created it if it didn't). Call `update_field` on `<table_name>.<field>` with `data.input_type_rule = <entry.jsonlogic>`. Pass the JsonLogic object verbatim; do not normalize, reformat, or attempt to validate the return-type. The platform's per-render fallback to the static `input_type` handles malformed or out-of-enum returns gracefully.
  - For each live field whose `input_type_rule` is non-empty but whose name does NOT appear in the model's `Input type rules` list: **ambiguous, same rule as the entity-level case above**. Do not silently clear. Surface the field + its live rule to the user and ask whether to keep or remove (pass `{}` to clear).

- For 🔒 **built-ins**, never push `select_rule` or `input_type_rule` from the model onto a built-in entity or its fields — those tables run platform logic and the model's rules would conflict. Stop and surface this to the user before any write (same posture as the write-side built-in guard in 4e).

After the per-entity 4f pass, surface to the user a one-line summary: *"Applied select_rule on `<table_name>` and N input_type_rule(s) across `<list_of_fields>`."* If `update_entity` or `update_field` rejects the JSON (the `select_rule_is_object` constraint trips, a malformed JsonLogic structure, etc.), the error message names the offending entry — quote it back to the user and ask the analyst skill to fix the model before re-running. Do not attempt to repair JsonLogic in the deployer.

**Audit-trail surface.** Read-visibility changes (any `select_rule` create/modify/remove on an entity that already holds rows) deserve a one-line entry in the Stage 5 verification summary alongside permission changes — they're the read-side analog of an `edit_permission` flip and carry the same "user noticing 'why can't I see X anymore'" failure mode if rolled out silently.

**4g. Built-in extensions.** If the user confirmed additive field extensions on a built-in (e.g. the model declares `users.department_id` and the built-in doesn't have it), create those fields after all custom entities are done. Do not modify existing built-in fields, do not change formats or enum values.

**Second pass.** After all entities exist, create any self-reference fields (e.g. `departments.parent_department_id` → `departments`) and any cross-reference pairs that had to wait (e.g. the mutual `departments.manager_user_id` ↔ `users.department_id`).

After each entity's fields are done, share the UI link:
`{ui_baseurl}/<module_slug>/<table_name>` — capture `ui_baseurl` once from `getCurrentUser` (`semantius call crud getCurrentUser | jq -r .ui_baseurl`, e.g. `https://<org>.semantius.app`) and reuse it for every link below. Never hardcode the org host. URL paths use the lowercase `module_slug`, never the display `module_name`.

**4h. Cross-model link suggestions.** After all in-module creates and built-in extensions are done, walk the Proposed list from Stage 3 and execute each confirmed row as an additive `create_field` call. **Read-before-write:** check the source entity's live fields first (`read_field` filtered by `table_name`); if the target FK column (`<target_singular>_id`, or the user-supplied alternative) already exists, the row landed on a prior deploy — skip the create as a clean idempotent no-op. Do not re-create it and do not count it as a failure.

For each confirmed row `{from_table, resolved_target_table, target_singular, verb, cardinality, delete_mode, field_name}`:

- `field_name` is the auto-generated `<target_singular>_id` from Stage 2g (or the user-supplied alternative if the row went through the field-name-collision flow in Stage 3).
- `format` is always `reference` for §6 rows; `parent` is never used (cross-module ownership is not allowed).
- `reference_delete_mode` is the row's `delete_mode` from §6 (default `clear`; `restrict` is allowed; `cascade` is rejected at parse time).
- `relationship_label` is the row's `verb` from §6.
- `title` is derived from the target's singular form (e.g. `Hardware Asset`) or set from the verb-plus-target idiom; the analyst's verb is the authoritative metadata, the `title` is just a UI label.
- Always include `width: "default"` and `input_type: "default"`.
- Pass `is_unique: true` only when the row's cardinality is `1:1`.

```bash
# Example: a §6 row read `incidents | hardware_assets | affected by | N:1 | clear`,
# Stage 2g resolved hardware_assets to itam.hardware_assets, Stage 3 confirmed.
semantius call crud create_field '{
  "data": {
    "table_name": "incidents",
    "field_name": "hardware_asset_id",
    "title": "Hardware Asset",
    "format": "reference",
    "reference_table": "hardware_assets",
    "reference_delete_mode": "clear",
    "relationship_label": "affected by",
    "width": "default",
    "input_type": "default"
  }
}'
```

For each created field, share the UI link to the source table so the user can inspect:
`{ui_baseurl}/<from_module_slug>/<from_table>` (URL uses the source module's lowercase `module_slug`; reuse the `ui_baseurl` captured from `getCurrentUser` above).

**Skip silently** for any Stage-3 confirmed proposal the platform rejects (e.g. the resolved target was renamed between Stage 2g inspection and 4h write). Surface the failure in the verification summary; do not retry. (An *already-exists* result is not a rejection — the read-before-write check above turns it into a clean no-op, so re-runs don't pad the "parked" count with rows that actually landed on a prior deploy.) Skipped, ambiguous-and-skipped, dormant, and resolved-but-declined rows are listed in the verification summary so the user can see how many §6 hints landed and how many parked.

**Stale rows in the model.** §6 rows whose target is dormant today may resolve on a later deploy of any model. The user can refresh by re-running this skill against any model whose §6 references the newly-arrived target; nothing is persisted on module metadata, so the redeploy is the trigger.

**4i. Cross-module permission inclusions.** After in-module hierarchy is set up (4b), and after any master-promotion entity moves (4c-promote, 4c-merge-master), wire up the cross-module `permission_hierarchy` rows that bridge consumers to masters. The shape:

- **Read inclusion (always).** For every consumer module of a master entity: a row with `including_permission_id = <consumer>:read.id`, `included_permission_id = <master>:read.id`, `origin = "model_master"` (the consumer's `:read` includes the master's `:read`). Created at Branch B promotion (for both `<original>` and `<incoming>`) and at every Branch A wire-up (one per new consumer). Without this row, consumers can't see the shared entity through their own module's read permission.
- **Manage inclusion (conditional, per consumer).** A row with `including_permission_id = <consumer>:manage.id`, `included_permission_id = <master>:manage.id`, `origin = "model_master"` (the consumer's `:manage` includes the master's `:manage`). Created only when this consumer's manage answer (Stage 2d-branch-a binary prompt, or Stage 2d-branch-b option 2/3/4) opts the consumer into write access via hierarchy rather than role membership. Branch A never modifies prior consumers' inclusions — each consumer's decision is recorded independently.

Idempotency: `read_permission_hierarchy` filtered by `(including_permission_id, included_permission_id)` first; create only on exit 1. Rows tagged `origin = "user"` are never touched (admin's manual additions are sovereign). Rows tagged `origin = "model_master"` may be updated by the deployer (including / included FK adjustments during master-rename via 4b-rename or master-merge via 4c-merge-master) but **never deleted by the deployer** (see "No auto-deletion" below).

Plan line: `🔗 Permission inclusions (cross-module, new)` block (see Stage 3 plan vocabulary).

**4j. Seed master manager role (Branch B only).** Right after 4c-promote moves the entity into the master, snapshot the current members of `<original_module>_manager` into `<master>_manager`. One-time copy at promotion (not a dynamic link; new `<original>_manager` members added later don't auto-inherit master stewardship). Runs unconditionally regardless of which Stage 2d-branch-b option (1–4) the user picked — the role exists in all four; the seed is independent of any hierarchy inclusion the user added on top.

Mechanics:

```bash
# Read original manager role members
semantius call crud read_user_role '{"filters": "role_id=eq.<original_manager_role_id>"}'
# For each member, create_user_role into <master>_manager (idempotent: read first, skip if user already in master_manager)
semantius call crud create_user_role '{"data": {"user_id": <user_id>, "role_id": <master_manager_role_id>}}'
```

Plan line: `🌱 Seeded <master>_manager with N members from <original>_manager`.

**Gate B fires** if the seed produces zero members (the original module's manager role is empty). Surface as 🟡 in the plan with explicit user confirmation per Stage 5/6 Gates.

**4k. Persona provisioning + RACI.** **Skipped entirely under the Stage 2.5 `basic` projection** (no personas, no RACI). For each persona named in the spec's frontmatter `persona` list (cross-checked against §9.1 RACI `actor` column at parse time).

**Mode pre-step.** Resolve the module's RACI mode: **honor the spec's `**RACI mode:**` line** if present (the analyst already asked — do NOT prompt). If absent (old spec / headless analyst run), apply the catalog-aware fallback: `living` when ≥1 module already uses RACI (`GET /processes?limit=1` non-empty, or any `modules.settings.raci_mode = living`), else `documentation`. If the live instance lacks the RACI engine (no `processes` entity registered), force `documentation`. Surface the resolved mode in the Stage 3 plan (`🧭 RACI mode: <mode>`). **Role creation (point 1) and the write-tier grant happen in both modes**; gate-grant compilation (point 2) is the **documentation** realization; the **living** realization (below) adds the catalog matrix + live-enforcement rules.

1. **Idempotent role check.** Compute the persona slug as lowercased snake-case (UPPER-CASE hyphen-separated → lowercase underscores): `RECRUITING-RECRUITER` → `recruiting_recruiter`. Then `read_role --single by slug=<persona_slug>`.
   - **Exit 0 (exists)**: reuse. Never recreate under a different module; persona roles are global to the tenant once minted.
   - **Exit 1 (missing)**: `create_role` with `slug = <persona_slug>`, `role_name = <UPPER-CASE original>`, `origin = "model"`, `module_id = <installing-unit module id>` (so the persona role is tracked under whoever first introduces it), and **`catalog_role_code = <UPPER-CASE original persona name>`** (provenance lineage; the catalog persona this role was provisioned from, stamp as a VALUE, never `create_field` the column; write-once).
2. **Grant resolution per RACI row.** For each parsed §9.1 RACI row whose `actor` is this persona AND `kind = persona`:
   - For `raci = responsible | accountable`: walk the row's parsed grant list (from the `realization` column's `grant gates [<list>]` form). For each gate code in the list, **resolve the actual permission code using the row's `grant_module` column** (the entity-owning-module lookup result). The resolved code = `<grant_module>:<verb>`. NEVER assume the installing-unit prefix — the gate's prefix follows the entity, which may live in another module if a previous install created it there.
   - Idempotent grant: `read_role_permission --single by role_id=eq.<persona_role_id>&permission_id=eq.<resolved_perm_id>` → `create_role_permission` on exit 1. The grant FK points at whatever module currently owns the gate's entity.
   - Also grant the persona on the entity's write tier (`<entity_owning_module>:<tier>` where `<tier>` is the suffix of the entity's resolved `edit_permission` — i.e. the `manage` / `admin` / `<narrow_suffix>` value Stage 1 derived from the entity's §3 `**Edit permission:**` line). The spec carries the write tier as that `**Edit permission:**` line, not as a literal `write tier` column (that column name is the blueprint's; the analyst transforms it into `**Edit permission:**` on emission). Same idempotent pattern.
   - For `raci = consulted`: grant an advisory read on the gate's owning module (`<entity_owning_module>:read`). Idempotent. The row's `consult_mode` (`read` / `notify` / `block`) is **not** behaviorally distinguished in `documentation` mode — all three collapse to the advisory-read grant. The `notify` / `block` semantics are realized only in `living` mode (carried on the `raci_assignments` row and enforced by the `has_consultation` C-block rule + the `emits_events` notify trigger; see the living-mode materialization below).
   - For `raci = informed`: defer to Stage 4m (handoff wiring) — no role grant; the notification is a side effect.
3. **Skill actor rows.** RACI rows where `kind = skill` resolve to a **role held by an agent user** (`users.is_agent = true`), the agent-native parallel to a persona. Idempotent: `read_role --single by slug=<skill_slug>` → `create_role` on miss (`origin = "model"`); ensure an agent service user exists (`read_user` by a stable external_id → `create_user` with `is_agent = true` on miss) and hold the role via `create_user_role` (idempotent). Then treat the skill's role_id exactly like a persona's for grants and (in living mode) `raci_assignments`. _(The matrix-level "Accountable must be human" guard and JIT agent tokens are not enforced here.)_
4. **Idempotency**: persona provisioning is safe to re-run; a second-installer's run on an existing persona just adds grants the first run didn't cover. The role itself is reused.

Plan line per persona: `👥 Persona: <slug> (<N> grants on <list of grant modules>)`.

**Living mode — materialize the RACI matrix + enforcement.** When the resolved RACI mode is `living`, after role + write-tier grants, materialize the analyst's RACI plan via the generic `postgrestRequest` tool (the `crud` server exposes no dedicated `create_process` verb — use `{method, path, body}` against the registered RACI tables). All emissions are idempotent (GET-by-natural-key → POST on miss):

1. **`processes`** — for each Processes-catalog row: `GET /processes?module_id=eq.<id>&process_key=eq.<key>` → `POST /processes {module_id, process_key, name, description, ordering}` on miss (existing row whose `name`/`description`/`ordering` drifted → `PATCH`). Capture the `id`.
2. **`raci_assignments`** — for each `raci_assignments[]` row, resolve `role_slug` → role_id and `process_key` → process_id, then `GET /raci_assignments?process_id=eq.&role_id=eq.&raci=eq.` → `POST /raci_assignments {process_id, role_id, raci, consult_mode, origin:"system"}` on miss. **Pre-verify at most one `accountable` per process** before POST (clean error; the platform also enforces a partial unique index `idx_raci_one_accountable`).
3. **`process_gates`** — for each `process_gates[]` row: `GET /process_gates?process_id=eq.&entity=eq.&gate_kind=eq.&to_state=eq.` → `POST /process_gates {process_id, entity, gate_kind, to_state, state_column, emits_events}` on miss. Setting `emits_events = true` is what drives the platform's emit trigger (→ `raci_events` → `raci_notify` queue) for C-notify / I.
4. **Enforcement rules** — author each `enforcement_rules[]` entry as a `validation_rule` (A-gate, C-block) via `update_entity`, or a `select_rule` (ownership / `personal_content`) via the Stage 4f mechanism — the same path the modeler already uses for §8.2 rules. The A-gate `{"is_raci_actor": [...]}` **replaces** the hand-authored `has_single_approver` gate when living.
5. **Per-module flag** — `update_module` (or `PATCH /modules`) to set `modules.settings.raci_mode = "living"`, so future installs read it (the adaptive-default signal).

Plan lines: `🧭 RACI mode: living`, `⚖ Processes: <N>`, `🔗 RACI assignments: <N> (A/R/C/I breakdown)`, `🚪 Process gates: <N> (<M> emit)`, `🛡 Enforcement rules: <N>`, `🤖 Agent actors: <list>`.

In `documentation` mode, none of the above runs — point 2's grant compilation is the whole realization.

**4l. Functional-ownership default grants.** **Skipped entirely under the Stage 2.5 `basic` projection.** Walk the parsed §9.2 `functional_ownership` index. For each row `{responsibility, business_function, default_role, default_tier}`:

1. Resolve the named `default_role` to a live tenant role. For the baseline three (`viewer`, `manager`, `admin`), use the installing unit's default roles (`<slug>_viewer` / `<slug>_manager` / `<slug>_admin`). For named functions whose role isn't a baseline, the deployer attempts to find a tenant role whose `role_name` matches the business function (case-insensitive); on no match, surface a 🟡 informational row in Stage 5 with the recommendation that the user create the role manually before re-running.
2. Resolve the named `default_tier` (`:read` / `:manage` / `:admin`) to the installing unit's permission code (`<slug>:read` etc.).
3. Idempotent grant: `read_role_permission --single` → `create_role_permission` on exit 1.

Plan line: `🏢 Functional ownership: owner = <function>.<role>, contributor = <function>.<role>`. Per-row grants summary in Stage 5.

**4m. Boundary-crossing handoff wiring.** **Skipped entirely under the Stage 2.5 `basic` projection** (handoffs are part of the lifecycle-gating surface basic access drops). For each parsed §6.2 outbound and §6.3 inbound handoff row whose `event_category` is `lifecycle` or `state_change`:

1. Verify the source entity's §7 lifecycle table contains the `to_state` named in the row's `transition` column. Parse-time has already enforced this; this is the deploy-boundary re-check.
2. Compute `source_module`: follow the **entity-owning-module rule** — the source_module is the source entity's CURRENT owning module slug in the live catalog, not the installing unit. When the source entity is an `embedded_master` whose canonical owner is absent, the source_module IS the installing unit (the entity's current owning module IS the installing unit). When canonical owner is present, the source_module is the canonical module.
3. If the platform exposes a transition trigger registry (`transition_event_triggers` or equivalent), call the appropriate `create_*` CLI to wire the trigger: `(source_module, source_entity, from_state, to_state, event_name, event_category)` → target module's handler. Today the platform may not expose this; in that case, emit a 🟡 informational row in Stage 5: *"Handoff `<source>.<entity>.<event>` → `<target>.<module>` not wired (no trigger registry support); the analyst's spec documents the intent."*
4. **Entity-event handoffs** (`event_category = entity_event`) don't have a state to bind; wire as a raw insert/update/delete listener (when supported) or surface as 🟡.

Same reconciliation semantics as 4n: when a handoff was emitted under a non-canonical source_module and the canonical owner later installs, the handoff re-attribution is part of 4n's sweep (the source_module column is updated to the canonical module).

Plan line: `📡 Handoff: <source_module>.<source_entity>.<event> _(<event_category>)_ → <target_module>`. Per-row status in Stage 5.

**4n. Permission reconciliation on owner-module change.** Fires whenever Branch-B promotion (4c-promote) moves an entity to a new owning module AND Stage 2i queued the entity for reconciliation. Per the entity-owning-module rule, the entity's gates / overrides must now bear the new owner's prefix.

Procedure (per affected entity):

1. **Identify accumulated non-canonical prefixes.** Read every permission in the live catalog whose `permission_name` matches the pattern `<prefix>:<verb>` where the verb appears on this entity's §3 / §9 grant lists. Filter to rows whose `<prefix>` is NOT the new canonical owner's slug. Multiple prior non-canonical prefixes are possible — e.g. after `[hiring-starter, ats-recruitment-pipeline]` both ran with `ats-candidate-crm` absent, `candidates` may have gates under BOTH `hiring-starter:` and `ats-recruitment-pipeline:`. Sweep ALL of them.

   ```bash
   # For each verb in the entity's grant list:
   semantius call crud read_permission '{"filters": "permission_name=like.*:%verb%"}'
   ```

2. **Mint canonical-prefixed sibling permissions.** For each `<old_prefix>:<verb>` resolve `<new_prefix>:<verb>`. `read_permission --single by permission_name=eq.<new_prefix>:<verb>` → `create_permission` on exit 1, with `module_id = <new owner's module id>` and `description` copied from the source permission row.

3. **Sibling role_permissions.** For each `role_permissions` row whose `permission_id` is one of the old-prefixed permissions: `read_role_permission --single by role_id=eq.<role>&permission_id=eq.<new_perm_id>` → `create_role_permission` on exit 1. **No deletion** (per the no-auto-deletion symmetric rule); the old-prefixed rows remain as quiet orphans.

4. **Sibling permission_hierarchy.** For each `permission_hierarchy` row referencing an old-prefixed permission (in either `including_permission_id` or `included_permission_id`): re-emit the equivalent edge against the new-prefixed permission (idempotent: `read_permission_hierarchy --single` first). Old rows remain (no-delete).

5. **N-to-1 sweep semantics.** Every grant on every non-canonical prefix gets ONE sibling grant on the canonical prefix. There is no "pairwise" reconciliation across non-canonical prefixes; the canonical prefix is the single target.

6. **Stage 5 summary.** Render a `🔁 Permission reconciliation` block listing every entity reconciled with per-entity (old prefixes → new prefix) and grant-row count.

**4n symmetry across install orderings.** Whether the canonical owner installs first (no work; entity created under canonical owner from the start), mid-sequence (reconciles whatever non-canonical prefixes have accumulated), or last (reconciles every non-canonical prefix), the rule is the same: when an entity's owning module changes via promotion, sweep and sibling-grant.

**No auto-deletion of catalog records (load-bearing safety rule).** The deployer never deletes roles, permissions, `role_permissions`, `permission_hierarchy` rows, or modules, regardless of `origin`. This is symmetric across every catalog-record kind the deployer can write. Even `model_master` rows the deployer wrote in a previous run are off-limits for deletion in subsequent runs. The only legal mutation on them is FK adjustment (`including_permission_id` / `included_permission_id`) during master operations.

Specifically:
- **Master-merge** (4c-merge-master): leaves source masters and their unused permissions, default roles, `role_permissions`, and intra-master hierarchy rows in place as quiet orphans. The deployer does not actively detect or report these as orphans either.
- **Master-rename** (4b-rename): updates slugs and names; no deletions, no orphans (rename is in-place updates).
- **Any reduction in the model file** (entity removed, permission removed, role removed): treated as a no-op against the live catalog. The model file shrinking is not a signal to delete; it might be a typo, a refactor in progress, or the author thinking the entity is now obsolete but other consumers still depend on it.

The deployer does not maintain an orphan registry, does not detect orphans in re-runs, and does not surface orphan candidates in the verification report. The rule is a safety boundary against accidentally destroying admin work, not a feature for catalog hygiene.

---

## Stage 5: Verify

After all creates are done, emit a **structured verification report** with explicit counts and FK consistency checks, not a single ✓. The report groups facts by category so any drift between intended and actual deploy is visible at a glance.

**Narration (per the Narration-restraint rules at the top of this skill).** The per-area checks below run **silently**: no *"verifying X..."* trail, no narrated re-run when a check has to be re-issued (fix any tooling hiccup quietly), no machinery named in chat. Only the final report is surfaced, and it reads in plain language, counts and **natural keys** (module slugs, entity Plural Labels, `permission_name`s), never internal vocabulary or bare numeric ids. The report is a result the user cares about (what is now live); the work that produces it is not.

### Per-area checks

1. **Module scaffold integrity (every module touched).** Load the module by `module_slug=eq.<slug>`, then for every FK column on the module row, **dereference the FK and assert the natural key matches the expected value**. Reading the FK column alone is not enough; a non-null FK can still point at the wrong row.
   - `module.view_permission` (text) equals `<slug>:read`. (No deref needed; the column itself stores the natural key.)
   - `module.manage_permission_id` dereferences to a permission whose `permission_name = <slug>:manage`. (Issue `read_permission --single` by `id=eq.<module.manage_permission_id>` and assert the returned `permission_name`.)
   - `module.admin_permission_id` is null OR dereferences to `<slug>:admin`.
   - **Every permission row declared by this model has `module_id = <module.id>`.** For each `<slug>:*` row from the §8.1 Permissions catalog, `read_permission --single` by `permission_name` and assert `.module_id == <module.id>`. A NULL or mismatched `module_id` is a 🛑 — the permission resolves by name (so hierarchy and role-permission joins still work, masking the defect from a casual smoke test), but module-scoped queries (`?module_id=eq.<id>`) silently miss it, and per-module RBAC audits report drift. Stage 4's scaffold step 2 backfills this column on **every** deploy (both on create and on the exit-0 converge path), so a Stage 5 hit means that backfill did not land — re-issue the `update_permission` to set the column and halt if it still will not take, rather than reporting the deploy as clean.
   - `module.default_viewer_role_id` dereferences to the role whose `slug` is the viewer row in the spec's §9.1 baseline-roles table (read verbatim, not reconstructed as `<slug>_viewer` from the module slug), `origin ∈ {"model", "model_master"}` matching the module's type, and a `role_permissions` row linking it to `<slug>:read` (verify via `read_role_permission` filtered on the resolved `role_id` + `permission_id`).
   - Same for manager and admin roles.
   - If any FK is null where the model expected a value, or if a non-null FK dereferences to the wrong natural key, surface as 🛑. Quote the row in the report by natural key — never as a bare `id=N` — so the user can recognize what failed without cross-referencing.

2. **Master promotion (per promoted entity).**
   - Entity's `module_id` matches the master module's id.
   - Master module's `module_type = "master"`.
   - Count of live records in the entity matches the pre-move count.
   - Every `reference_table = "<entity>"` FK across the catalog still resolves (no orphans).
   - `<master>_manager` role member count >= seed count.

3. **Cross-module hierarchy (per inclusion created).**
   - Row exists with the expected `(parent, child)` pair.
   - Cross-module bridge rows have `origin = "model_master"` (covers both intra-master chains and consumer-to-master bridges).
   - No rows were created with `origin = "user"` overwriting prior admin intent (paranoia check; should be impossible per Stage 4i idempotency).

4. **Merged JSON arrays (master entities only).**
   - Every entry has a non-null `source_module` (legacy entries treated as `"user"`).
   - **No `code` duplicates** within `validation_rules` on an entity, regardless of `source_module`. The natural key is `code` alone; `source_module` is reconciliation metadata, not part of the uniqueness key.
   - **No `name` duplicates** within `computed_fields` on an entity, same rule.
   - Pre-merge entries from non-current sources are still present (preserved across re-runs per 4e-merge rule 4).

5. **Per-entity field counts and labels** (existing behavior):
   - `read_entity` on each custom entity, confirm `label_column` is set.
   - **Owning `module_id`.** For every entity this deploy owns (`create-new` / `rename-incoming-from` → this module; `promote-to-master` → the master module), assert live `entities.module_id` equals the expected module id. A NULL or mismatched value is a 🛑 — the platform is documented to reject a null `module_id` on create, so a live NULL means the create either omitted it or it was nulled later; the entity then belongs to no module and is invisible to module-scoped queries. Stage 4c sets this on create and converges it on the same-module path, so a Stage 5 hit means that did not land — re-issue the `update_entity` and halt if it still will not take. (Reused/built-in entities are out of scope: they keep their source module's id.)
   - `read_field` per entity, confirm field count matches the model (minus auto-generated).
   - Spot-check that `reference_table` targets exist for FK fields (including any that point at built-ins like `users`).
   - **Lifecycle state field name (`workflow_state`).** For every entity that has a lifecycle (carries a `workflow-gate (lifecycle)` permission or a `process_gates` row), confirm the live entity has a field named exactly `workflow_state`. A lifecycle state stored under any other field name is a 🛑 — the Stage 1 parse gate should have caught it pre-write, so a Stage 5 hit means the gate was bypassed.
   - **`label_parent` round-trips.** For every owned entity whose spec carries a `**Label parent:**` line, confirm live `entities.label_parent` equals the named FK field; for every owned entity without the line, confirm live `label_parent` is null/absent. A mismatch is a 🛑 — the composed `_label` would fold on the wrong spine, or not at all. While here, confirm the deploy did **not** materialize `_label` / `<fk>_label` as real `fields` rows (a `read_field` hit on a `_`-prefixed or `*_id_label` name means the reserved-name guard was bypassed).

5a. **Text-fidelity round-trip (every entity and every field this deploy touched).** For each entity, compare live `description`, `singular_label`, `plural_label` against the parsed model values **byte-for-byte**. For each field declared in the model, compare live `description` and `title` against the model byte-for-byte. Any mismatch is a Stage 5 defect — surface the entity / field, quote both strings with their byte counts, and recommend re-issuing the offending `create_*` / `update_*` with the model-sourced text. Catches every failure mode the "Data fidelity" section enumerates: truncation (live byte-count shorter than model), normalization (live missing backticks / apostrophes / Unicode the model carried), and empty-string-clobber on `update_field` (live empty where model is non-empty). Equivalent round-trip applies to permission `description` against the §8.1 Permissions catalog `description` cell. The check is cheap (every relevant column is already in the `read_entity` / `read_field` / `read_permission` response from earlier verification steps) and is the single load-bearing assertion that catches data-mutation regressions before the user does.

6. **Read-side rules round-trip**: for every entity whose model carried a `Select rule` block, `read_entity` and confirm the live `select_rule` equals the model's parsed object. For every field whose model carried an `Input type rules` entry, `read_field` and confirm the live `input_type_rule` equals the entry's `jsonlogic`. A round-trip mismatch is a Stage 5 defect — quote the diff to the user and offer a retry of the offending `update_*` call. The platform's constraint checks usually surface the failure at Stage 4f instead, so a Stage 5 catch here is rare; when it does fire, it's almost always a transient/concurrency issue worth a single retry before escalating.

7. **Live RACI engine (living mode only).** When Stage 4k ran in `living` mode, round-trip every artifact it materialized — this is the verify counterpart to the five-batch 4k living-mode write, and without it a mid-sequence 4k failure is invisible to Stage 5:
   - **`modules.settings.raci_mode == "living"`** on the module record.
   - For each Processes-catalog row: a `processes` row exists with the expected `process_key` under this module (`GET /processes?module_id=eq.<id>&process_key=eq.<key>`), with `name` / `description` / `ordering` matching the spec.
   - For each `raci_assignments[]` row: a live assignment exists for the resolved `(process_id, role_id, raci)` with `consult_mode` matching. **Assert at most one `accountable` per process** (the platform's partial unique index `idx_raci_one_accountable` also enforces this; a Stage 5 catch means the Stage 4k pre-check was skipped).
   - For each `process_gates[]` row: a live gate exists for `(process_id, entity, gate_kind, to_state)` with `emits_events` matching — a C-notify / I gate that lost `emits_events = true` silently breaks the `raci_events` → `raci_notify` queue.
   - Each `enforcement_rules[]` entry landed as the expected `validation_rule` (A-gate `is_raci_actor`, C-block `has_consultation`) or `select_rule` on its entity — round-trip the JsonLogic as in checks 4 and 6.
   - Any missing or drifted artifact is a 🛑, quoted by natural key (`process_key`, role `slug`): a half-materialized matrix enforces partial governance (e.g. an A-gate present but its `accountable` assignment missing locks the transition for everyone). In `documentation` mode this whole check is skipped — the grant compilation is already covered by the persona-grant round-trip.

### Structured Stage 5 report

```
=== Verification report ===

Modules:
  itsm                       ✓ module_type=domain    permissions=2/2  default_roles=2/2
  vendors_master  (NEW)      ✓ module_type=master    permissions=2/2  default_roles=2/2

Roles (deployer-managed, origin ∈ {model, model_master}):
  itsm_viewer                ✓ origin=model         12 members   carries itsm:read
  itsm_manager               ✓ origin=model         3 members    carries itsm:manage
  vendors_master_viewer      ✓ origin=model_master  0 members    carries vendors_master:read
  vendors_master_manager     ✓ origin=model_master  3 members    carries vendors_master:manage  [seeded from itsm_manager]

Entities:
  vendors                    ✓ moved itsm → vendors_master   247 records intact   12 FKs repointed
  incidents                  ✓ 8 fields added                 no drift

Permission hierarchy:
  itsm:admin → itsm:manage           ✓ origin=model
  itsm:manage → itsm:read            ✓ origin=model
  itsm:read → vendors_master:read    ✓ origin=model_master    (NEW)

Merged JSON arrays:
  vendors.computed_fields:    4 entries  (3 from itsm, 1 from itam, 0 conflicts)
  vendors.validation_rules:   7 entries  (5 from itsm, 2 from itam, 1 conflict resolved)
  conflicts:
    - validation_rules code 'email_required' had two source models;
      kept itsm version, renamed itam version to 'email_required_itam'

Counters:
  modules created:    1
  modules updated:    1
  entities moved:     1
  entities updated:   1
  fields added:       8
  permissions added:  2  (origin=model)
  roles added:        2  (1 origin=model, 1 origin=model_master)
  hierarchy added:    3  (2 origin=model, 1 origin=model_master)
  warnings (🟡):      0
  blockers (🛑):      0

✓ Verification passed.
```

Counters at the bottom break down by `origin` so any drift between what the deployer was supposed to create and what actually landed is visible in one place. No orphan section; the deployer does not detect or report orphans (per Stage 4 "No auto-deletion").

**Additional report sections** (rendered immediately after Counters, before the final ✓ line):

```
Functional ownership grants (4l):  applied N rows
  owner = Recruiting.admin (granted hiring-starter:admin)
  contributor = Legal.manage (granted hiring-starter:manage)

Personas provisioned (4k):  M personas, K total grants
  recruiting_recruiter        ✓ created   carries [hiring-starter:hire_candidate, hiring-starter:manage]
  hiring_manager              ✓ existed   carries [hiring-starter:approve_offer, hiring-starter:manage]
  recruiting_sourcer          ✓ created   carries [hiring-starter:publish_posting, hiring-starter:manage]
  ...

Re-prefixed permissions (Stage 4a-scaffold):  N permissions
  hiring-starter:hire_candidate        (canonical ats-recruitment-pipeline not installed)
  hiring-starter:approve_offer         (canonical ats-offers not installed)
  hiring-starter:view_all_candidates   (canonical ats-candidate-crm not installed)
  ...

Master-install reconciliation (Stage 4n):  P entities reconciled, Q permissions renamed, R grants re-pointed
  candidates: hiring-starter:view_all_candidates → ats-candidate-crm:view_all_candidates (3 grants → 3 siblings)
  candidates: hiring-starter:hire_candidate → ats-candidate-crm:hire_candidate (2 grants → 2 siblings)
  ...

Boundary-crossing handoffs (Stage 4m):  S wired, T unwired (no trigger registry)
  ✓ hiring-starter.candidates.hired (lifecycle) → hcm-lifecycle-workflows
  🟡 hiring-starter.job_applications.rejected (state_change) → ats-talent-pools (no trigger registry)

Skipped FKs (presence-conditional):  U skips
  💤 job_offers.background_check_id → background_checks (target not installed)
  💤 job_offers.offer_version_id → offer_versions (target not installed)
  💤 job_offers.onboarding_journey_id → onboarding_journeys (target not installed)

Skipped on ⚠ flag:  V skips
  ⚠️ <entity>.<state> — <verbatim reason>

Live RACI engine (Stage 4k living mode):  W processes, X assignments, Y gates, Z enforcement rules
  raci_mode = living          ✓
  processes:                  offer_approval ✓   onboarding ✓
  raci_assignments:           8  (2 A / 3 R / 2 C / 1 I)   ✓ one accountable per process
  process_gates:              3  (2 emit_events)            ✓
  enforcement rules:          offer_approval A-gate ✓   onboarding C-block ✓

✓ Verification passed.
```

Each block is rendered only when it has non-zero content. Personas, functional ownership, and re-prefixed permissions are the most common new lines (most deploys carry §9). Master-install reconciliation and boundary-crossing handoff wiring fire only when their stages execute. Skipped FKs and ⚠ flags are situational. The Live RACI engine block renders only for `living`-mode deploys (in `documentation` mode the persona-grant lines above are the whole RACI realization).

**Compact summary line** (still emitted, for backwards-compatibility with existing logs): *"✅ Done. Created 1 module, 3 permissions, 2 hierarchy rows, 5 entities (2 admin-tier, 3 operational), 47 fields. Reused built-ins: users. Additive fields on built-ins: 2. Applied 2 `select_rule`(s) and 7 `input_type_rule`(s)."*

When the model is on the two-permission fallback (no admin-tier entities), the summary reads "2 permissions, 1 hierarchy row, N entities (all operational)". The admin-tier breakdown is omitted when there are no admin-tier entities. The read-side-rule counts are omitted when both totals are zero (the common case for models that don't use the read-side surfaces).

**Access-control callout (mandatory).** The verification summary names the resolved Stage 2.5 scope on its own line: *"🔐 Access control: Basic (read + edit). Deployed `<slug>:read` + `<slug>:manage`, viewer + manager roles."* or *"🔐 Access control: Full RBAC."* When `basic` was a **projection** of a full-shaped spec, also state what was suppressed and (on a re-deploy that flipped an existing full module to basic) which already-live higher-governance objects are now quiet orphans: *"Skipped N permissions, M roles, K lifecycle gates, P persona grants. L pre-existing gate(s)/role(s) left in place (not deleted; re-deploy under full access to re-activate)."* This is the read-side analog of the access-control choice surfacing in the plan: the user sees, after the fact, exactly which governance the basic choice excluded.

**Read-visibility callout (mandatory when any `select_rule` was created or modified).** Any Stage 4f write that created, changed, or removed an entity's `select_rule` deserves its own one-line callout in the verification summary, separate from the bulk counts: *"⚠️ Applied `select_rule` on `<table_name>`. Callers will now see only rows where `<short-description-of-rule>`. Confirm rollout is the intent."* This mirrors how `edit_permission` tier flips get their own callout (a real RBAC change); read-visibility changes have the same "user noticing 'why can't I see X anymore'" failure mode and benefit from being named in the summary the user reads.

### Gates

Two gate concepts in addition to the existing collision and version gates.

**Gate A: pre-write planned-state integrity check.** Fires in Stage 3, before any Stage 4 writes. Build the full intended end-state object graph in memory and verify internal consistency:

- Every planned FK target exists or is being created in this run.
- Every role member is a real user.
- No circular permission hierarchy. (Load-bearing: today's design only adds rows shaped `<consumer>:read → <master>:read` and `<consumer>:manage → <master>:manage`, which can't cycle. But a future feature that adds inclusions in the other direction, e.g. `<master>:read → <consumer>:read`, could form a cycle. The check stays in place to catch that.)
- Every default-role slot in every module's scaffold has a planned role.
- Every cross-module inclusion has both parent and child planned or live.
- Every merged JSON entry has a `source_module` value.

If any check fails, surface as a 🛑 with the broken reference quoted. Catches design bugs before they touch the catalog.

**Gate B: steward seed non-empty.** Fires in Stage 4 immediately after 4j seeded `<master>_manager`. If member count is 0 (e.g., the original module's manager role was empty), don't fail outright but emit a 🟡 in the plan and require explicit user confirmation:

> *"`<master>_manager` has zero members. `<entity>` will be effectively read-only for everyone until you assign a steward. Proceed?"*

User can choose to proceed anyway, or to abort and assign someone to `<original>_manager` first.

---

## Closing Contract: clean and sticky

**This contract applies only to a deploy that completed Stage 4 without halting.** If any Stage 4 sub-stage failed and the deploy halted (per "Failure is loud and halting" at the top of Stage 4), the final message is the loud halt message (*"Deploy halted at `<sub-stage>` after N writes. The deploy is incomplete: fix the cause and re-run..."*), NOT the success closing below. Never emit `The <System Name> model is live ✅` over a partial write, and the sticky-footer rule below does **not** fire on a halted deploy — a "model is live" footer stapled onto a halt message is exactly the success-shaped-over-failure result the loud-failure invariant forbids. On a halt, the call-to-action is "re-run," not "open in UI."

For a clean, fully-completed deploy, the final assistant message is a **call-to-action**, not a recap. It must contain exactly three things, in this order, and nothing else:

1. One status line: `The <System Name> model is live in Semantius ✅`
2. **Open in UI:** `{ui_baseurl}/<module_slug>`, module landing page, on its own line, prominent (use a markdown link so it's clickable, e.g. `[Open <System Name> in Semantius →](<ui_baseurl>/<module_slug>)`). `ui_baseurl` comes from `getCurrentUser` (e.g. `https://<org>.semantius.app`) — never hardcode the org host. The URL path is the lowercase `module_slug` (e.g. `crm`); the link text uses the human display `system_name` (e.g. `CRM`).
3. The Stage 6 sample-data question, on its own line and clearly marked as a question (a real `(yes / no)` prompt, never blended into the status line or the recap). This is an **unanswered gate**: the message ends with the question and waits. Per Stage 6's consent gate, NO sample records are written until the user replies with an explicit, unambiguous "yes" to this specific question. A continuation word (`continue`, `ok`, `proceed`, `go on`) or a vague / bundled "yes" is NOT consent; re-ask and wait.

Everything else, what was created, what was skipped, why built-ins were reused, counts, per-entity links, caveats, justifications, belongs in the Stage 5 verification summary **before** this closing block, separated by a horizontal rule (`---`). Do not mix the two. The closing must not contain reasoning, parentheticals, or "by the way" notes; those dilute the call to action.

This block is **sticky**: if a follow-up turn (audit, "did I miss anything?", fix-up, clarification) interrupts before the user has answered the sample-data question, **re-emit the same three lines at the end of the follow-up reply**. Treat them as a footer that re-attaches itself until the user accepts sample data, declines it, or explicitly closes the session ("we're done", "thanks, that's all"). Before sending any assistant message that comes after a **clean** Stage 4 completion, scan the draft: if it does not contain both the module landing-page link and the sample-data question, append the closing block. **Suppress this footer entirely when the deploy halted** (see the carve-out at the top of this section) — a halted deploy never reached a "live" state, so re-attaching a "model is live" footer would misreport the outcome.

---

## Stage 6: Sample Data

> 🛑 **MUST-FIRE consent gate, sample data is NEVER written without an explicit, scoped "yes."** Seeding writes business records into the user's live model. It is the one accidental-write surface in this skill, so it is gated harder than anything else here. Three hard rules, no exceptions:
>
> 1. **Ask, then STOP.** Present the sample-data question as its own standalone question and END THE TURN. Do not generate the seed script, do not run anything, do not "prepare to seed" in the same turn. Wait for a fresh user reply that answers this question.
> 2. **Only an explicit, unambiguous "yes" to THIS question is consent.** The reply must clearly mean "yes, create the sample records" (e.g. "yes", "yes seed them", "go ahead and create the sample data"). The following are **NOT consent** and MUST lead to a re-ask or no action, NEVER to a seed:
>    - Continuation / acknowledgement words: `continue`, `ok`, `okay`, `go on`, `proceed`, `next`, `sure`, `go ahead`, `keep going`, `fine`, `k`, a thumbs-up, or silence.
>    - A "yes" that could be answering something else, or that arrives bundled with other instructions.
>    - Any reply where it is not *certain* the user is opting into sample-data writes.
> 3. **Default is NO.** On no answer, an ambiguous answer, a topic change, a request to do something else, a non-interactive run, or session close, **do not seed.** When in any doubt, re-ask the single question (*"Confirm: create 10 sample records in each new entity? (yes / no)"*) and wait. Treating ambiguous input as consent is the exact failure this gate exists to prevent: one wrong inference writes dozens of rows into a live model, and that is never acceptable.
>
> This gate governs every path into the seed script below. Wherever this section later says the user's "yes" authorizes the run, it means *this* yes and nothing weaker.

After verification, ask the sample-data question on its own (this is a gate, not a footer; see the consent gate above):

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](<ui_baseurl>/<module_slug>)
>
> Would you like me to generate 10 realistic sample records for each newly-created entity?

### How many records (the count is not optional)

**The default is exactly 10 records per eligible entity. Seed that many unless the user names a different number.** The "10" in the question above is a commitment, not a loose suggestion: if the user says "yes" to that question, you have promised 10 per entity and must deliver 10 per entity. Seeding 2 or 3 "to show it populated" is a defect, not a shortcut — it under-delivers what the user agreed to and makes the model look empty in lists and reports.

- **The only ways to legitimately seed fewer than 10 for an entity:**
  1. The user explicitly asked for a different count (then use their number, for every entity).
  2. An FK into an ineligible table can supply fewer than 10 distinct real IDs and the field is **required** (so rows can't be created without it). In that case, seed as many as the available IDs allow and **say so in the summary** for that entity — never silently truncate.
- **Self-check before you run the script:** count the `post(...)` calls per entity in the generated script. If any eligible entity has fewer than 10 (or fewer than the user's chosen number) without a reason from the list above, the script is wrong — add rows until it hits the count before running it.
- The example in "Script pattern" below is **abbreviated to two rows for readability only**. Do not mirror its row count — generate the full 10.

### How sample data gets written (read this before any insert)

**The single Bun seed script is the ONLY way this stage writes records.** Generate it (see below), run it once with `bun run`, done. Do not insert records any other way.

- **No probe, test, or "gate-check" inserts.** Never hand-run an individual `semantius call crud postgrestRequest` to "test the lifecycle gates", "see if the account can write", or "trip the ownership rules" before bulk-seeding. Writing a deliberately-bad or throwaway row into a live table is never a diagnostic step: it pollutes shared state if it lands, and there is nothing to learn that the real seed run won't tell you. If a record would violate a gate, fix the seed data, not the gate.
- **Only an explicit, scoped "yes" authorizes the seed run** (per the consent gate at the top of this stage). Once the user has unambiguously opted into sample data for THIS question, running the prescribed seed script is the in-scope, intended action, not a workaround. But a continuation word (`continue`, `ok`, `proceed`, `go on`, `next`, `sure`) or an off-topic / bundled reply is NOT that yes; re-ask and wait, do not seed. The Bun-script form is prescribed for context-efficiency (one `bun run` instead of dozens of tool calls); it is not a trick to hide writes, and it is never a license to skip the consent gate.

**If running the seed script needs a permission approval**, say so once, in plain language, and let the user grant it or choose another option. For example: *"Seeding runs a script that inserts the sample rows; your setup will ask you to approve running it once. Approve it and I'll continue, or I can hand you the script to run yourself."* Then stop and wait.

- Do NOT name, quote, or describe the harness permission system, the Bash classifier, or any "guard" / "write-protection" machinery. The user does not need the agent's sandbox internals, and dramatizing a routine approval prompt as a "guard" with "intent" is confusing and alarming.
- Do NOT present an invented denial message as a verbatim quote.
- Keep every line here within the Writing Conventions above (US English, no em-dashes).

### Scope: whose tables get sample data

**Only entities this run created get sample records.** Everything else is off-limits. Writing seed data into an existing table pollutes live records, confuses reports, and can break referential integrity for users who are actively using the platform.

| Bucket | Eligible for sample data? |
|---|---|
| ✨ New entities created this run | ✅ Yes |
| 🛑 Resolved as "rename incoming" (a new table under the renamed name) | ✅ Yes, it's a new table |
| 🛑 Resolved as "rename both", the *incoming* side | ✅ Yes, new table |
| 🛑 Resolved as "rename existing" | ❌ **Never**, the table already has records |
| 🛑 Resolved as "merge", target existing entity | ❌ **Never**, existing table |
| ♻️ Same-module match (entity already existed) | ❌ **Never**, existing table |
| 🔒 Built-in `users` | ⚠️ Off by default, allowed only after explicit confirmed override (see below) |
| 🔒 Other Semantius built-ins (`roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`) | ❌ **Never, under any circumstances**, no override |

**Sample `users`, off by default, confirmed override allowed.** `users` is platform infrastructure, it controls authentication. Fake users cannot log in (no password, no real IdP identity), cannot receive meaningful role assignments, and will pollute audit trails. **Default behavior: decline and explain these limitations.** If after that explanation the user still wants sample users and explicitly confirms they understand the generated users cannot log in, you may proceed. When you do:

- Use clearly-synthetic identifiers: `email: "sample1@example.invalid"` (the `.invalid` TLD is reserved exactly for this), `full_name: "Sample User 1"`, etc.
- If the model has a `workflow_state` / `is_active` / similar field on users, seed to an inactive/test value so the rows can't be mistaken for real accounts.
- Never assign roles to sample users (no `user_roles` inserts, that's the absolute-never bucket below).
- Surface the override in the final summary: *"Created N sample users per your explicit request, none of them can log in."*

**Other built-in tables stay absolute, no override.** `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`. These control RBAC, integrations, and the platform's own schema; seeding fake rows corrupts real users' access and the platform itself. Decline every request, even confirmed ones.

### FK fields that point at ineligible tables

A new entity often has FKs to built-ins or existing entities (e.g. `subscriptions.business_owner_id → users`, `subscriptions.primary_department_id → departments` when `departments` is pre-existing). For those fields:

- **Read existing records** from the target table (e.g. `GET /users?select=id&limit=20`) and **pick real IDs at random** to use as FK values.
- Never insert synthetic target records to satisfy the FK. If the target table has zero rows and seeding would require inventing one, skip the FK (leave it null if nullable) or skip the sample record entirely.
- For FKs into **other newly-created entities** in the same run, capture the inserted IDs from those earlier POSTs (see script pattern below) and reference them normally.

Create records in dependency order (entities with no parent FKs first, junction tables last, the model §4 order is usually correct), restricted to the eligible set defined above.

**Generate a single Bun (TypeScript) script** for all sample data rather than making individual CLI calls. This avoids context bloat from dozens of sequential tool invocations. Write the script under `<cwd>/.tmp_deploy/seed_<short>.ts`, run it once with `bun run`, check the output, and delete it. **Never write generated scripts into the skill folder or the working directory root.** They are ephemeral one-shots; persisting them across runs accumulates as catalog drift, mixes throw-away artifacts with skill source, and survives session boundaries. See the "Generated artifacts" section above for the full rule.

A Bun script is preferred over a `.sh` script for seeding because it keeps JSON construction, response-envelope unwrapping, and FK-id capture in one cross-platform runtime — no `python3 -c` extractors, no shell-quoting puzzles for record bodies containing apostrophes or Unicode, no Windows-vs-Git-Bash subprocess-piping surprises. The script consists of sequential `semantius call crud postgrestRequest` calls, one per record, capturing inserted IDs directly from the POST response for use in FK fields.

### postgrestRequest response shape

By default `semantius call` **already unwraps to `response.data`** — stdout is the array PostgREST returned, not the `{"request":..., "response":...}` envelope. (Use `--diag` if you ever need the full envelope; you almost never do.) On top of that, `--single` asserts exactly one row and emits the single object directly:

- no flags → stdout is `[{...}, {...}, ...]` (array, possibly empty)
- `--single` → stdout is `{...}` (single object); exit 1 on 0 rows, exit 2 on 2+ rows
- `--diag` → stdout is `{"request":..., "response":{"data":..., ...}}` (full envelope)

For a `POST` that inserts one row, **always use `--single`** so you get the object directly and the CLI fails loudly if the insert returned the wrong cardinality. For a `GET` you expect to match one row, `--single` doubles as a sanity check.

```bash
# Correct — --single returns the inserted row as a bare object
ID=$(semantius --single call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')

# Also correct — no flag, stdout is the array, take [0]
ID=$(semantius call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | bun -e 'console.log((await Bun.stdin.json())[0].id)')

# WRONG — stdout is already unwrapped; there is no .response.data unless you passed --diag
ID=$(... | bun -e 'console.log((await Bun.stdin.json()).response.data[0].id)')
```

`GET` count via the unwrapped array:

```bash
COUNT=$(semantius call crud postgrestRequest '{"method":"GET","path":"/campaigns?select=id"}' \
  | bun -e 'console.log((await Bun.stdin.json()).length)')
```

`python3 -c "import json,sys; ..."` extractors are forbidden — they don't work reliably on Windows where `python3` may not be on `PATH`, and they pull a second runtime into a deploy that otherwise only needs Bun and `semantius`.

### Script pattern

```typescript
// <cwd>/.tmp_deploy/seed_<short>.ts — run with: bun run <path>
async function pgSingle(body: unknown): Promise<any> {
  const proc = Bun.spawn(["semantius", "--single", "call", "crud", "postgrestRequest"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(body));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`postgrestRequest failed (exit ${code}): ${stderr}`);
  return JSON.parse(stdout); // already a single object (--single enforces 1 row)
}

const post = (path: string, body: Record<string, unknown>) =>
  pgSingle({ method: "POST", path, body });

// NOTE: this example shows 2 rows per entity for READABILITY ONLY.
// A real seed run creates 10 per eligible entity (see "How many records" above) — expand each block to the full count.
console.log("=== Seeding campaigns ===");
const campaigns = [];
for (const row of [
  { campaign_name: "Spring Launch", workflow_state: "active" },
  { campaign_name: "Fall Promo", workflow_state: "draft" },
  // ... 8 more, 10 total — cycle §5 enum values so each appears at least once ...
]) {
  campaigns.push(await post("/campaigns", row));
}
console.log(`  seeded ${campaigns.length} campaigns`);

console.log("=== Seeding leads ===");
// Use captured IDs for FK fields — never assume sequential IDs
for (const row of [
  { lead_name: "Jane Smith", campaign_id: campaigns[0].id },
  // ... 9 more, 10 total ...
]) {
  await post("/leads", row);
}
```

`--single` is the right default for seed inserts because every row is created individually and the cardinality contract is "exactly one". If `RETURNING` ever produces 0 rows (RLS suppressed the result) or 2+ rows (PostgREST returned multiple), the CLI exits non-zero and the script aborts — much better than silently picking `data[0]` from an empty or surprising array.

The script is invoked from any shell with:

```bash
bun run <cwd>/.tmp_deploy/seed_<short>.ts
```

**Important for FK fields:** Capture IDs directly from each POST response, do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?campaign_name=eq.Spring Launch`) require URL encoding; capturing from the POST response avoids this entirely.

**Enum safety, read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not, using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**String safety:** Inside the Bun script, `JSON.stringify` handles every character correctly — Unicode punctuation, apostrophes, backticks, multi-line strings, all pass through to `semantius` unchanged. This is exactly why the seed script is a `.ts` file and not a `.sh` file: a pure-shell seeder using `echo '{...}'` or `$PG '...'` would still break on apostrophes and embedded shell metacharacters, and "fixing" that by stripping characters from seed data is the same correctness bug as truncating descriptions. Generate realistic seed strings (including Unicode where the domain has it); do not pre-strip.

Generate realistic data:
- Real-sounding names and emails (not "Test User 1")
- Enums: cycle through all valid model §5 values for that specific field so every value appears at least once
- Dates: realistic mix of past and future
- Numbers: plausible domain ranges
- Booleans: realistic mix

Run the complete script in one `bun run` call (the only write path; see "How sample data gets written" above, no probe inserts) and report the final output summary. If the `bun run` needs a permission approval, handle it plainly and once per that section, never by hand-running individual inserts and never by narrating the harness permission machinery.

**Report the per-entity count in the summary.** State how many records landed in each entity, e.g. `Asset Contracts: 10, SaaS Subscriptions: 10, ...`. This is both the user's receipt and your own honesty check: if any eligible entity shows fewer than 10 (or fewer than the user's chosen number), the line must carry the reason from "How many records" above (user-chosen count, or FK-id scarcity on a required field). An unexplained low count is a defect to fix, not a summary to ship.

---

## Conflict Resolution Reference

| Conflict | Risk | Action |
|---|---|---|
| Module with same `system_slug` already exists | ✅ Low | `update_module`, never create a duplicate |
| Field `format` mismatch, same primitive (TEXT family / numeric / temporal) | ✅ Low | `update_field` accepted by the platform — sync to model value. |
| Field `format` mismatch, cross primitive (e.g. `text → date`, `email → integer`) | 🛑 High | Platform rejects. Quote the primitive-change error back and route to the analyst skill. |
| Entity label/description mismatch | ✅ Low | Offer `update_entity` (skip for built-ins) |
| Field title/description mismatch | ✅ Low | `update_field` — included in the per-field walk at Stage 4d. |
| `enum_values` differ, additive (model adds values the live row doesn't have) | ✅ Low | `update_field` — sync the extended list. No existing record carries the new values, so no constraint break. |
| `enum_values` differ, removal (live row still carries values the model omits) | 🛑 High | Existing rows may hold the removed value and the check-constraint tightening will fail. Surface in Stage 3 so the user can drop the value (and reconcile existing rows first) or keep it in the model. |
| Extra fields/entities not in model | None | Leave them alone |
| Model declares a built-in (`users`, `roles`, …) | None | Dedup: skip create, reuse built-in as `reference_table` target; never replace |
| Model declares extra fields on a built-in | ⚠️ Medium | Offer additive `create_field`; never modify existing built-in fields |
| **Cross-module exact-name collision** (entity with same `table_name` exists in another module) | 🛑 High, ambiguity gate | Stage 3 decision dialog: promote to shared master / rename incoming / use existing directly / abort. Never silently coexist. Rename-existing and rename-both remain available via the auto-"Other" slot but are no longer surfaced — both break live references and are strictly worse than promote. |
| **Similar-name collision** (root, synonym, qualifier, prefix/suffix) | 🛑 High, ambiguity gate | Same dialog as above. User may decline, in which case record the decision and proceed. |
| Merge requires changing field format **across primitive types** (e.g. `text → date`) | 🛑 High | Merge is impossible, fall back to a rename option. Same-primitive format changes (`text → multiline → html`, all `TEXT`) are allowed and can be applied via `update_field` before the merge — not a blocker. |
| Existing-entity rename rejected by platform | 🛑 High | Stop. Offer "rename incoming" or "promote to shared master" as fallback. Never continue silently. (Only reachable when the user took the rename-existing path via the auto-"Other" slot, since it is no longer in the surfaced widget.) |
| §6 row whose `To` target is in the catalog (exact match) and whose auto-generated `<target_singular>_id` field name is free on `From` | ⚠️ Medium | Stage 3 user-confirmed proposal; Stage 4h executes as `create_field` on the source table with the §6 verb as `relationship_label`. |
| §6 row whose `To` target is not in the catalog (and no near-name match) | ✅ Low | Dormant. Skip silently this run; redeploy any model whose §6 references the target once it later arrives. |
| §6 row whose `To` matches multiple plausible targets in the catalog (`vendors` vs `suppliers` vs `saas_vendors`) | ⚠️ Medium | Stage 3 batched `AskUserQuestion` lists candidates with their owning module; user picks one or skips. |
| §6 row's auto-generated FK field name (`<target_singular>_id`) already exists on `From` | ⚠️ Medium | Stage 3 batched `AskUserQuestion` offers a free-text alternative or skip. |
| §6 row whose `From` is neither a `table_name` in this model's §3 nor an existing entity in the catalog | 🛑 High | Stop before Stage 4h. Ask the user to fix the model via the analyst skill so `From` resolves. |
| §6 row uses `cascade` delete or `M:N` cardinality | 🛑 High | Reject at parse time. Cross-model cascade implies ownership across modules; M:N requires an unowned junction table. Send the user back to the analyst skill. |
| Front-matter `version` major older than `EXPECTED_MAJOR` (or `version` key missing entirely) | 🛑 High | Stop at Stage 1. Tell the user the file is from an older analyst major; the analyst's archived-knowledge mode can re-author a current-major file from it. Do not deploy older majors. |
| Front-matter `version` major newer than `EXPECTED_MAJOR` | 🛑 High | Stop at Stage 1. The file was written by a newer analyst than this deployer knows. Ask the user to update this deployer skill before retrying. |
| Model-side `computed_fields` / `validation_rules` array differs from live entity (♻️ same-module match) | ⚠️ Medium | `update_entity` with the model's array verbatim (wholesale replacement). The platform regenerates the BEFORE INSERT/UPDATE trigger; existing rows are not retro-validated. Surface the diff to the user before applying when an entry is being **removed** (the rule will stop firing on future writes). |
| Model omits `Computed fields` / `Validation rules` heading but live entity carries non-empty arrays | ⚠️ Medium | Ambiguous: the analyst might mean "leave as-is" or "I dropped these". Do not silently clear. Surface the live arrays to the user and ask whether to keep them or pass `[]` to remove. The semantic-model-optimizer would have round-tripped them; absence after a round-trip means deliberate removal. |
| Model carries `Computed fields` referencing a field that does not yet exist on the entity | ⚠️ Medium | Sequence: create the referenced field first (Stage 4d), then push the array via `update_entity` (Stage 4e). The platform rejects arrays whose `name` does not resolve to a field. |
| Field is referenced by `computed_fields[].name` but its `input_type` is not `disabled` (either on create or on a re-run, including live fields still carrying the legacy `"readonly"`) | ✅ Low | Auto-set `input_type: "disabled"` — on create via the `create_field` payload (Stage 4d), on re-run via `update_field`. The column is platform-owned: every caller value is clobbered by the compute pass at trigger time, so the UI hint is just being aligned with platform behavior. `"disabled"` is preferred over `"readonly"` because the value is not user-corrected, it is system-derived; the greyed-out treatment communicates that unambiguously. The model and its JsonLogic are not modified. |
| Model carries `validation_rules` with a duplicate `code` within the entity | 🛑 High | Reject at parse time. Send the user back to the analyst skill to fix; the deployer will not silently rename. |
| Model declares `computed_fields` / `validation_rules` on a Semantius built-in (`users`, `roles`, …) | 🛑 High | Refuse. Built-ins run platform logic; model-driven rules would conflict. The model is buggy, escalate to the analyst skill. |
| Model's `validation_rules` JsonLogic invokes `{"require_permission": "<code>"}` for a `<code>` that is not a row in the §8.1 Permissions catalog | 🛑 High | Reject at parse time, before any write. The platform will throw at rule-evaluation time on every write that hits the gate because the permission doesn't exist; that's a runtime failure mode the analyst's audit should have caught. Surface the offending rule's entity + `code` and the missing permission to the user, ask them to re-run the analyst skill's audit on the file. Do not call `create_permission` ad hoc, an undeclared permission usually signals the model is missing the matching hierarchy row and entity-tier wiring too. |
| Model declares a workflow-gate row in the §8.1 Permissions catalog (e.g. `<slug>:approve_<noun>`) that no `validation_rules` JsonLogic invokes via `require_permission` | ⚠️ Medium | Surface to the user as an "orphan workflow permission" finding in Stage 3 plan. The deployer can still create the permission (it does no harm), but the model is likely buggy, either a `require_permission` call was dropped or the permission was declared speculatively. Ask the user whether to create it anyway or send the file back to the analyst. |
| Live module has workflow permissions (`<slug>:approve_<noun>` etc.) that the model's §8.1 Permissions catalog no longer lists | ✅ Low | **No-op per the no-auto-deletion rule (Stage 4 / plan §7.5a).** The deployer never deletes permissions of any origin, even ones it created itself in a previous run, even on user confirmation. A live permission absent from the current model is treated as a deliberate keep — the model file shrinking is not a signal to delete. If the user genuinely wants the permission removed, that's a manual SQL operation through the §10.3 platform escape hatch, out of band of any deploy. Surface in Stage 3 plan as a 🟡 note ("`<slug>:approve_foo` is live but no longer declared in the model — left in place") so the user is aware, but never propose a delete. |
| Model's §9.1 hierarchy has a row where `permission = <slug>:manage` and `includes` is a `workflow-gate` permission (rolling an elevated gate up under the baseline manage tier) | 🛑 High | Reject before any write. This edge auto-grants every `<slug>:manage` holder the gated authority, defeating the conditional `require_permission` check the workflow permission was created for. The analyst's audit should have caught this. Surface the offending row to the user and route back to the analyst skill; the fix is either to re-parent the gate under `<slug>:admin` (promoting the model to three-permission baseline if needed) or to remove the §9.1 row so the workflow permission is granted directly. |
| Model has a `narrow` tier permission in §8.1 that the §9.1 hierarchy does not include under `<slug>:manage` (no `manage → narrow` row, or it is included only under `<slug>:admin` in a model where `admin` does not transitively include `manage`) | 🛑 High | Reject before any write. The narrow tier's intent is that holders of `<slug>:manage` transitively pass the narrow check; a rollup that excludes `manage` from the chain inverts that intent. Surface the offending permission and route back to the analyst skill; the fix is to add a §9.1 `manage → <narrow>` row (the default) or to ensure the baseline chain includes `manage → admin`. |
| Model carries `**Edit permission:** <narrow_suffix>` but §8.1 has no `narrow` tier row for `<slug>:<narrow_suffix>`) | 🛑 High | Reject before any write — the entity binds to an undeclared narrow tier. Surface the offending entity and route back to the analyst skill to declare the row, or change the annotation back to `manage`/`admin`. |
| Live entity's `edit_permission` is `<slug>:<narrow_suffix>` but model annotates it as `manage` (or vice versa)) | ⚠️ Medium | Surface as a tier flip in Stage 3 plan, same posture as the `manage ↔ admin` flip — this is a real RBAC change (different population of users gains or loses write access on this entity). `update_entity` only after explicit user confirmation. |
| Model's §8.1 Permissions catalog is missing entirely (an older analyst skipped the section) | 🛑 High | Reject at Stage 1. The current contract requires the section. Route the user back to analyst Mode D Rebuild to materialize the file from the existing content. Do not attempt to synthesize the table from per-entity `Edit permission:` annotations or any other section; the contract requires the analyst to produce the table as a deliberate authoring step, not a deployer-side inference. |
| Model carries `**Edit permission:** admin` annotations but the live module is on the legacy two-permission baseline (only `<slug>:read` and `<slug>:manage`) | ✅ Low | Additive upgrade. Stage 4b creates the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row; Stage 4c sets `edit_permission` on the admin-tier entities. Surface in Stage 3 plan as `✨` rows so the user can confirm. |
| Model carries no `**Edit permission:**` annotations but the live module has all three permissions and admin-tier entities | ✅ Low | Leave alone. Some specs don't author tier annotations; do not flip live entities' `edit_permission` from `<slug>:admin` back to `<slug>:manage` based on the absence of an annotation. To sync, the user runs the analyst's Mode B audit first (which proposes annotations + the three-permission baseline in the §8.1 Permissions catalog) and redeploys against the updated file. |
| Live entity's `edit_permission` is `<slug>:admin` but model annotates it as `manage` (or vice versa) | ⚠️ Medium | Surface as a tier flip in Stage 3 plan. `update_entity` only after explicit user confirmation, this is a real RBAC change; everyone with the old tier loses or gains edit access on that entity. Do not silently switch. |
| Re-run on a module whose live hierarchy has the inclusion direction inverted (e.g. `read includes manage`) | 🛑 High | Stop. An inverted row breaks RBAC; the deployer never authored this. The deployer **does not delete it** (per the no-auto-deletion rule below — `permission_hierarchy` rows of any origin are off-limits, even on confirmation). It ensures the correct-direction row exists additively (the Stage 4b idempotent create already does this) and surfaces the inverted row to the user as a 🛑, with the recommendation to remove it manually through the platform escape hatch, out of band of any deploy. Never `update` or delete a hierarchy row silently. |
| Live `<slug>:*` permission row exists but `permissions.module_id` is NULL or points at a different module | ⚠️ Medium | Admin-edited drift or a stale FK from an earlier deploy. The permission resolves by name (so hierarchy and role-permission joins work) but module-scoped queries silently miss it. `update_permission` setting `module_id = <this module.id>`. Stage 5 surfaces this as a 🛑 if the corrective write doesn't land. |
| Model-side `select_rule` differs from live entity (♻️ same-module match)) | ⚠️ Medium | `update_entity` with the model's object verbatim. The platform regenerates the `FOR SELECT` RLS policy function; existing reads are filtered from the next query onward. **Always warn the user before applying a `select_rule` create or modification** — rows that callers used to see disappear (medium-risk visibility change). The Stage 5 verification summary names the entity so the change is visible alongside permission flips. |
| Model omits `Select rule` heading but live entity carries a non-empty `select_rule`) | ⚠️ Medium | Ambiguous: the analyst might mean "leave as-is" or "I dropped it". Do not silently clear. Surface the live rule to the user and ask whether to keep it (the optimizer would round-trip an existing rule, so absence after a round-trip means deliberate removal) or pass `{}` to drop the RLS policy. Removing widens visibility (every row becomes visible to anyone with `view_permission`); confirm before applying. |
| Model carries `Select rule` JsonLogic referencing a column that does not exist on the entity) | 🛑 High | Reject at parse time, **with one exception**: when the column reference is qualified by a `set_record` or `let` binding name (e.g. `{"var": "order.workflow_state"}` inside `{"set_record": ["order", "orders", ...]}`), resolve the binding's `<entity_name>` against the live catalog instead. The bound variable's column lookup is checked against the *bound entity's* fields, not the current entity's. Unbound column references that don't resolve on this entity are still a Blocker — `select_rule` runs per-row inside the platform's RLS policy, and a bare reference to a missing column throws at evaluation time. Surface the offending column name (and which binding it lives under, if any) when rejecting. |
| Model carries `validation_rules` / `computed_fields` JsonLogic that uses `{"set_record": ["<name>", "<entity>", ...]}` whose `<entity>` does not exist in the live catalog (and is not a Semantius built-in)) | 🛑 High | Reject at parse time. `set_record` loads a row from `<entity>` by id; if the table doesn't exist when the rule fires, the platform throws on every write. Surface the offending `set_record` entity argument and the rule's entity + `code` / `name`, route back to the analyst skill (typo, dropped entity, or an FK target that lives in a sibling module that hasn't been deployed yet). |
| Model carries `validation_rules` JsonLogic whose body is `{"throw_error": "<message>"}` placed at the *top level* of the rule (not inside an `if`)) | 🛑 High | Reject at parse time. A top-level `throw_error` raises on every write — that's what `view_permission` / `edit_permission` are for (table-level gates) and an unconditional throw via `validation_rules` is always wrong shape. The pattern is `{"if": [<trigger-predicate>, {"throw_error": "..."}, true]}`. Surface the rule's entity + `code` and route back to the analyst skill to wrap the throw in an `if`. |
| Model carries `Select rule` JsonLogic that calls `{"set_record": ...}` | ⚠️ Medium | Surface in Stage 3 plan as a perf-warning row. `set_record` *is* technically callable inside `select_rule` (the platform's JsonLogic engine is the same as `validation_rules`), but it runs an extra `SELECT` per row of every read of this entity, and quickly dominates query cost on any non-trivial workload. Default posture: warn the user, ask whether the design genuinely needs cross-entity per-row visibility AND `has_permission` / column-encoded broadening can't express it. If yes, deploy as-is with a Stage 5 note recommending tracking the entity's read-query timings; if no, route back to the analyst skill to rework the rule. |
| Model's `Select rule` sub-block `description` (or any §3 prose about that entity's visibility) names a permission code as a "bypass" / "elevated" / "override" / "see every row" path BUT the JsonLogic body does NOT reference that permission) critical defect) | 🛑 High | Reject at parse time. This is the canonical bypass-prose defect: the prose promises a bypass the platform cannot honor (there is no documented permission-check operator in the SELECT context, and the JsonLogic is the only thing the platform evaluates per row). Deploying the rule would ship dangerous-looking but broken RBAC — the prose says one thing, the per-row filter does another, and access decisions land based on the rule, not the prose. The analyst skill's Stage 12.5 audit should have caught this. Surface the offending entity, the prose claim, and the JsonLogic body to the user, and route back to the analyst's Mode B audit to resolve (either delete the prose claim, or convert it to an explicit §7 architectural-decision entry naming a documented broadening mechanism — separate cube view, Postgres `BYPASSRLS` role attribute, etc.). |
| Model declares `select_rule` on a Semantius built-in (`users`, `roles`, …)) | 🛑 High | Refuse. Built-ins have their own platform-level visibility rules; a model-driven `select_rule` would conflict. The model is buggy, escalate to the analyst skill. |
| Model-side `input_type_rule` for a field differs from live (♻️ same-module match)) | ✅ Low | `update_field` with the model's object verbatim. Pure UI override, no data impact; the platform's per-render fallback covers malformed returns. Stage 5 lists the field in the per-entity summary. |
| Model omits the `Input type rules` entry for a field but live field carries a non-empty `input_type_rule`) | ⚠️ Medium | Ambiguous, same posture as the entity-level `Select rule` ambiguity. Do not silently clear. Surface the live rule + the field to the user and ask whether to keep or pass `{}` to remove. |
| Model carries an `Input type rules` entry whose `field` doesn't appear in this entity's §3 field table) | 🛑 High | Reject at parse time. Typo or stale entry; cannot map to a live field. Surface the offending `field` name and the entity, send back to the analyst skill. |
| Model declares `input_type_rule` entries on a Semantius built-in's fields) | 🛑 High | Refuse. Built-in field UI shapes are platform-governed; model-driven overrides would conflict and may not survive platform upgrades. Escalate to the analyst skill. |
