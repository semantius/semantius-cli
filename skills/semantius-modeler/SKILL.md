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

**The deploy script's committed resources are two files:** [`references/deploy-lib.ts`](./references/deploy-lib.ts) (schema-agnostic primitives — the loud `write` transport, the exit-code-aware `read1` / `readMany` existence checks, the create-or-read `ensure`, and the halting `runDeploy` harness; knows no column names, so it never changes) and [`references/scaffold-lib.ts`](./references/scaffold-lib.ts) (schema-coupled and version-stamped — the baseline-scaffold builder `scaffoldModule()` plus the live-schema `preflightSchemas` guard). Copy both into `.tmp_deploy/` and import them; never re-implement the primitives or hand-roll the baseline scaffold in each script. [`references/deploy-script-template.md`](./references/deploy-script-template.md) shows how to assemble the bespoke orchestration around them. A script that wraps writes in a bare `catch` and continues will report success over a partial deploy — the exact failure the "Failure is loud and halting" invariant exists to prevent.

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

Cross-entity JsonLogic primitives (`set_record`, `let`, `throw_error`) are passed through byte-for-byte inside `validation_rules` / `computed_fields` and (with care) `select_rule`. The "column must exist on this entity" parse check skips column references qualified by a `set_record` / `let` binding (the bound variable's columns resolve against the bound entity). See `references/conflict-resolution.md`.

**Permission-prefix resolution rule (the "entity-owning-module rule").** Workflow gates and row-scope overrides for entity E are prefixed by E's CURRENT owning module slug, not by the installing unit. The rule fires on every install regardless of `module_kind`. Stage 4a-scaffold honors it when minting gates / overrides for entities with re-prefixed-from annotations; Stage 4n handles the master-install reconciliation when a Branch-B promotion moves an entity to a new owning module (sweep every non-catalog-prefixed permission for the entity's verbs, mint sibling catalog-prefixed permissions and `role_permissions` rows, re-emit hierarchy edges; no deletes, per the no-auto-deletion rule).

The history of the deployer's contract changes lives in [`CHANGELOG.md`](./CHANGELOG.md) — what each analyst-lockstep bump changed in the deployer's parser, stage numbering, and audit checks. That file is not loaded at runtime; the body of this SKILL.md is the **current contract**, the CHANGELOG is the **history**.

- **Older major** (e.g. file is `"0.x"`, this skill expects `"1.x"`), the file was written by an older analyst version using a structure this deployer no longer understands. Tell the user to run the analyst skill; its archived-knowledge mode reads the older file and re-authors a current-major file from the same semantic content.
- **Newer major** (e.g. file is `"2.x"`, this skill expects `"1.x"`), the file was written by a newer analyst than this deployer knows about. Tell the user to update this deployer skill before retrying.
- **Missing `version` key** (legacy, pre-versioning), treat as major `0`; same response as older-major above.

## Your role: thin executor of a reconciled spec

The analyst is the gatekeeper. The modeler executes.

> **Hard prerequisite before any write: Step 0.** Everything below is the *workflow* (what to deploy, in what order). *How* each write actually talks to Semantius — response shapes, the exact field column names, nullability rules, the `update_field` id format, the Golden Rules — lives in the **use-semantius** skill you load at **Step 0** below. Step 0 is a gate you pass through before issuing a single `create_*` / `update_*`, not a "read it if you get stuck" reference. The single most common way this deploy fails is authoring a Bun script straight from the spec without loading use-semantius first, then tripping over column names and response shapes that Step 0 documents. A condensed safety-net cheat table lives in Step 0 too — but it is a backstop, not a substitute for reading the files.

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

## Cross-cutting safety invariants

These rules apply across every stage and stay resident in the spine. The canonical copies are here; where a stage file repeats one (provenance, fail-loud, no-deletion) it carries a marked-duplicate note pointing back here.

**Failure is loud and halting (the recovery model depends on it).** The deploy's entire recovery story is re-run convergence: the spec is the target, every Stage 4 op is read-before-write and idempotent, and a failed or partial deploy is recovered by **re-running** — there is no transaction, rollback, or resume (PostgREST is stateless). That model is only safe if a partial failure is **visible**. So when any Stage 4 sub-stage's write fails (a `create_*` / `update_*` / `postgrestRequest` returns non-zero, a platform constraint trips, or a ⚠ row forces a FAIL LOUD), **stop immediately and tell the user the deploy is incomplete and must be re-run** — do not swallow the error, do not continue to the next sub-stage, and never let the closing message or the Stage 5 summary print a success-shaped result over a partial write. The single way this model breaks in practice is a partial failure that reads as success, so the operator never re-runs. State the halt plainly (and within the Writing Conventions, no em-dashes in this user-facing line): *"Deploy halted at `<sub-stage>` after N writes. The deploy is incomplete: fix the cause and re-run, and the modeler reconciles forward from wherever it stopped (every op is idempotent, so re-running never double-creates)."* This is especially load-bearing inside 4k living-mode, which materializes the RACI engine across five separate `postgrestRequest` batches (`processes` → `raci_assignments` → `process_gates` → enforcement rules → `raci_mode` flag): a mid-sequence abort there must surface, never be summarized away.

### Provenance stamping (core columns; applies to every create in this stage)

The platform ships core provenance columns the modeler is the only writer of. **The deployer stamps these values at provision time** — they are how rename detection, catalog-owner-arrival, behavior discovery, and cross-domain merges become deterministic platform reads downstream (the analyst on re-reconcile, and every `use-*` discovery skill). The rules, once, for the whole stage:

- **Stamp VALUES only — never `create_field` these columns, never write `ctype`.** Core registers them with `ctype = 'core'` (so `is_core` is *derived* as `ctype <> ''`); `ctype` is privilege-locked. The modeler does **not** create these columns and does **not** stamp `is_core` — it passes the column values on the `create_*` / `update_*` payload it already sends. (If a deploy ever errors that one of these columns is missing, the platform is too old — surface that; do not try to `create_field` it.)
- **`entities.catalog_entity_code` = the catalog code**, from the spec's `**Catalog entity code:**` line (NOT `table_name`, which holds the deployed / dialect / silo name). Default to `table_name` only when the line is absent.
- **`entities.catalog_owner_module`** = the owner-module slug from the spec's `**Catalog owner:**` line (an `embedded_master` provisioned locally as a placeholder while its catalog owner module is absent); `''` when the line is absent (this module owns the entity (`role = master`), or it is local). Soft string, not an FK.
- **`entities.entity_type`** = the class from the spec's `**Entity type:**` line; **`'unclassified'` (never `''`) when absent.** Must be one of the six CHECK values.
- **`entities.catalog_entity_aliases`** = **APPENDED** to on a reuse/merge that renames an incoming entity onto an existing host (read the host's current array, push each new `{alias_code, source_domain, source_module, decided}` element, write back). **Never rewrite or drop prior elements**; a plain `create_entity` leaves it at `[]`.
- **`modules.catalog_module_code`** = the catalog blueprint / `system_slug` the module was provisioned from; the top-level columns `domain_code`, `access_scope`, and `icon_name`; plus the `modules.settings` keys (`naming_mode`, `module_kind`, `catalog_snapshot`, `promotion_decisions`), on `create_module` / `update_module`.
- **`roles.catalog_role_code`** = the catalog persona/role slug a role was provisioned from, on every `create_role`.
- **Codes are write-once at create.** The two scalar codes (`catalog_entity_code` / `catalog_module_code`) are set on the create call and **never re-sent on a later rename** — a rename touches `table_name` / `module_slug` only. Core enforces immutability-once-non-empty, so a re-send of a *changed* value is rejected; a re-run that re-sends the *same* value is a harmless idempotent no-op.

**No auto-deletion of catalog records (load-bearing safety rule).** The deployer never deletes roles, permissions, `role_permissions`, `permission_hierarchy` rows, or modules, regardless of `origin`. This is symmetric across every catalog-record kind the deployer can write. Even `model_master` rows the deployer wrote in a previous run are off-limits for deletion in subsequent runs. The only legal mutation on them is FK adjustment (`including_permission_id` / `included_permission_id`) during master operations.

Specifically:
- **Master-merge** (4c-merge-master): leaves source masters and their unused permissions, default roles, `role_permissions`, and intra-master hierarchy rows in place as quiet orphans. The deployer does not actively detect or report these as orphans either.
- **Master-rename** (4b-rename): updates slugs and names; no deletions, no orphans (rename is in-place updates).
- **Any reduction in the model file** (entity removed, permission removed, role removed): treated as a no-op against the live catalog. The model file shrinking is not a signal to delete; it might be a typo, a refactor in progress, or the author thinking the entity is now obsolete but other consumers still depend on it.

The deployer does not maintain an orphan registry, does not detect orphans in re-runs, and does not surface orphan candidates in the verification report. The rule is a safety boundary against accidentally destroying admin work, not a feature for catalog hygiene.

**Sample-data consent gate.** Sample records are NEVER written without an explicit, scoped "yes" to the sample-data question. Continuation words (`continue` / `ok` / `proceed` / `go on`) are NOT consent. Full rules: `references/stage-6-sample-data.md`.

**Natural keys over numeric ids.** Every read filter, diff, verification line, and user-facing narration uses the natural key. Full convention: "Lookup conventions" below in this file.

---

## Preflight (runs before Step 0, every invocation)

The environment checks are shared across all four Semantius skills and live in one place: **[`../semantius-admin/references/preflight.md`](../semantius-admin/references/preflight.md)**. Do not duplicate them here.

- **Orchestrated by `semantius-admin` (a `Run context:` block is present in your input):** the admin already ran the preflight (toolchain installed, CLI authenticated, `adenin` guard passed). Skip the checks and proceed.
- **Standalone (no `Run context:` block):** run the shared preflight yourself. In brief: stay in the repo root; install the toolchain if missing; probe `getCurrentUser` to install/authenticate the CLI and halt if the org is `adenin`. The modeler critically needs **Bun** (its deploy and sample-data scripts run with `bun run`); `jq` parses CLI JSON. The modeler does **not** consult the customizations file, so check 4 (the `CUSTOMIZATIONS_FILE` computation) does not apply — specs already carry every decision. The full per-check procedure and install matrix are in the reference file.

---

## Step 0 (hard gate): Load the use-semantius Skill

**This is a blocking prerequisite, not a suggestion. Do not author a deploy script and do not issue a single `create_*` / `update_*` call until you have read both files below.** Every write this skill makes goes through use-semantius's patterns. The failures that look like platform bugs — wrong column names, `null` rejected on a column you thought was optional, "I got an array, I expected an object" — are almost always Step 0 not being read. Read both, now:

```
Read: ../use-semantius/SKILL.md
Read: ../use-semantius/references/data-modeling.md
```

The data-modeling reference gives you the mandatory creation order, all field formats, the Golden Rules, and exact CLI syntax. Everything in the execution stages below follows those patterns. Also read `references/cli-usage.md` if you need help with CLI invocation, piping, or error handling.

### Safety-net cheat table (does NOT replace reading the two files above)

These are the traps that have actually broken deploys. This table is a backstop for when you read Step 0 but a detail slips — it is a pointer to the authoritative text, never a substitute for it. **When anything here is incomplete or seems to conflict with use-semantius, use-semantius wins; go read the cited section.**

| Trap | Wrong | Right | Authoritative section |
|---|---|---|---|
| **Read response shape** | Treating a `crud` read as a bare object; trusting exit `0` to mean "found" | `crud` reads return a JSON **array** by default (even for one row); exit `0` + `[]` means "found nothing." Pass **`--single`** for any read that must resolve to exactly one row: it returns a bare object and exits `1` (none) / `2` (ambiguous). | use-semantius SKILL.md → *Response handling: exit code is not enough* |
| **Make a field mandatory / unique** | A `required` field column (`"required": true`) | There is **no `required` column**. Mandatory = **`input_type: "required"`**. Unique = **`unique_value: true`**. Two different columns, two different concepts. | data-modeling.md → *All Field Properties*, *`unique_value`* |
| **Nullability** | Sending `is_nullable` on `create_field` / `update_field` | **Never send `is_nullable`** — the platform computes nullability from `format`. Only `reference`, `date`, and `date-time` allow NULL; every other format is `NOT NULL` with an auto-default. | data-modeling.md → *`default_value`*, *Relationships* |
| **Non-nullable integers** | `null` for `module_id` or any `integer` / `int32` / `int64` field | Integers are `NOT NULL`. `module_id` must be a real (non-null) integer id; required integer fields auto-default to `0`. Never pass `null` to an integer column. | data-modeling.md → *Key Entity Fields*, *`default_value`* |
| **`update_field` / `delete_field` id** | A PostgREST-style `{"filters": "..."}` | Identify the field by its **composite `id` `"<table_name>.<field_name>"`**, e.g. `update_field {"id": "tickets.approved_at", "data": {...}}`. `filters` is a *read*-tool concept; `update_field` / `delete_field` take `id`. | data-modeling.md → *Updating and Deleting Entities* |
| **`update_entity` identifier** | `{"id": <int>, "data": {...}}` (copying `update_field` / `update_module`) | `update_entity` is keyed by **`table_name` at the top level**: `update_entity {"table_name": "tickets", "data": {...}}`. Three different shapes to keep straight: `update_entity` → `table_name`; `update_field` → composite `id` string; `update_module` / `update_permission` / `update_role` → numeric `id`. | data-modeling.md → *Updating and Deleting Entities* |
| **Layer-2 `postgrestRequest` payload** | `{method, path, data: record}` | The record field is **`body`**, not `data`: `{method, path, body: record}`. Use the `post(path, body)` / `pgRequest(...)` helpers in `deploy-lib.ts` so the call site never hand-rolls it. | use-semantius `references/crud-tools.md` → *postgrestRequest*; `deploy-lib.ts` |
| **Golden Rule #1 — read before write** | `create_*` straight from the spec | **Always `read_*` first.** Read-before-write is what makes every Stage 4 op idempotent, which is the whole basis of the re-run recovery model. Skip it and you double-create and corrupt dedup. | use-semantius SKILL.md → *Golden Rules* #1 |
| **Trusting a create response for the new id** | Reading `.id` (or `module_id`, any natural key) off the `create_*` / `write()` return value | **Do not depend on the create response carrying the new row's `id` or natural key.** Resolve it with a `read1` by natural key *after* the create (or use the `ensure` helper in `deploy-lib.ts`, which read-before-writes then re-reads). This is the same "resolve, use, throw away" rule the Lookup conventions already state for FK targets. | This file → *Lookup conventions* (FK writes that demand a numeric id) |
| **Wrong field names from memory** | Copying a `create_*` payload from memory or a stale example (e.g. `name` / `label` on `create_role`) | `create_role` takes `role_name` + `slug` + `module_id` + `origin` (no `name` / `label`); a domain-module role needs `origin: "model"` + `module_id` or it orphans at `origin: "user"`. When unsure of any tool's exact fields, run **`semantius info crud <tool>`** — it prints the live input schema, cheaper than a failed write. | use-semantius `references/rbac.md`; live `semantius info crud <tool>` |

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

Work through the stages in order. **Before executing each stage, read its reference file** (column below); each holds the full procedure this spine only names. Narrate tersely per the Writing conventions.

| Stage | What it does | Read first |
|---|---|---|
| 1. Parse | Version + consistency gate, then extract every section of the spec (entities, fields, permissions, RACI, ...). All parse-time rejections live here. | `references/stage-1-parse.md` |
| 2. Reconcile | Verify each reconciliation annotation still holds against the live catalog; resolve cross-model links; scaffold the module. | `references/stage-2-reconcile.md` |
| 2.5 Access scope | Resolve basic vs full RBAC (frontmatter, then live setting, then ask). The two-permission projection table lives here. | `references/stage-2-reconcile.md` |
| 3. Plan | Render the plan + ambiguity decisions; the cross-model-link flow. **Gate A** (pre-write integrity) fires here. | `references/stage-3-plan.md` |
| 4. Execute | All writes, sub-stages 4a-4n (module, permissions, entities, fields, rules, master-data, personas/RACI, reconciliation). **Gate B** fires here. Provenance, fail-loud, and no-deletion (above) govern every write. | `references/stage-4-execute.md` |
| 5. Verify | Structured verification report + per-area FK and text-fidelity round-trips. | `references/stage-5-verify.md` |
| 6. Sample data | Consent-gated seeding (see the consent gate above). | `references/stage-6-sample-data.md` |

Whenever any stage hits a conflict, ambiguity, format mismatch, or collision, consult `references/conflict-resolution.md` on demand.

---

## Closing Contract: clean and sticky

**This contract applies only to a deploy that completed Stage 4 without halting.** If any Stage 4 sub-stage failed and the deploy halted (per "Failure is loud and halting" at the top of Stage 4), the final message is the loud halt message (*"Deploy halted at `<sub-stage>` after N writes. The deploy is incomplete: fix the cause and re-run..."*), NOT the success closing below. Never emit `The <System Name> model is live ✅` over a partial write, and the sticky-footer rule below does **not** fire on a halted deploy — a "model is live" footer stapled onto a halt message is exactly the success-shaped-over-failure result the loud-failure invariant forbids. On a halt, the call-to-action is "re-run," not "open in UI."

For a clean, fully-completed deploy, the final assistant message is a **call-to-action**, not a recap. It must contain exactly three things, in this order, and nothing else:

1. One status line: `The <System Name> model is live in Semantius ✅`
2. **Open in UI:** `{ui_baseurl}/<module_slug>`, module landing page, on its own line, prominent (use a markdown link so it's clickable, e.g. `[Open <System Name> in Semantius →](<ui_baseurl>/<module_slug>)`). **Read `ui_baseurl` as a discrete field from `getCurrentUser`** (`semantius call crud getCurrentUser '{}' | jq -r .ui_baseurl`, e.g. `https://<org>.semantius.app`). Do NOT derive it from `api_baseurl`, do NOT string-replace `.ai`→`.app`, and do NOT read it off `whoami`: the UI host (`.semantius.app`) is a different subdomain from the API host (`.semantius.ai`), and only the `ui_baseurl` field is guaranteed to carry the right one. Never hardcode the org host. The URL path is the lowercase `module_slug` (e.g. `crm`); the link text uses the human display `system_name` (e.g. `CRM`).
3. The Stage 6 sample-data question, on its own line and clearly marked as a question (a real `(yes / no)` prompt that states the per-table count, the eligible-table count, and the resulting total as visible math, e.g. `10 records × 6 tables = 60 records`, never blended into the status line or the recap). This is an **unanswered gate**: the message ends with the question and waits. Per Stage 6's consent gate, NO sample records are written until the user replies with an explicit, unambiguous "yes" to this specific question. A bare continuation word (`continue`, `ok`, `proceed`, `go on`) or a vague / bundled "yes" is NOT consent; re-ask and wait. **A reply that specifies sample-data counts (e.g. "ok, but 30 customers", "20 each") IS consent and sets those counts (a global `COUNT` plus per-table overrides), honored without re-asking — the count beats the continuation word (see Stage 6's consent gate).**

Everything else, what was created, what was skipped, why built-ins were reused, counts, per-entity links, caveats, justifications, belongs in the Stage 5 verification summary **before** this closing block, separated by a horizontal rule (`---`). Do not mix the two. The closing must not contain reasoning, parentheticals, or "by the way" notes; those dilute the call to action.

This block is **sticky, but only while the sample-data question is unanswered.** If a follow-up turn (audit, "did I miss anything?", fix-up, clarification) interrupts before the user has answered it, **re-emit the same three lines at the end of the follow-up reply**. Treat them as a footer that re-attaches itself until the user accepts sample data, declines it, or explicitly closes the session ("we're done", "thanks, that's all"). Before sending any assistant message that comes after a **clean** Stage 4 completion **and before the user has answered the sample-data question**, scan the draft: if it does not contain both the module landing-page link and the sample-data question, append the closing block.

**Once the user answers the sample-data question, the gate is closed: never re-emit the question.** An explicit "yes" is consent, the next action is to seed and report the per-entity counts, not to ask again. A "no" or decline ends it. Critically, do **not** treat "consented but not yet seeded" (the seed run is pending, still in progress, was interrupted, or could not complete) as "unanswered" and re-attach the footer, that is exactly the confusing double-ask the user sees after they already said yes. If seeding is blocked, handle the blocker per Stage 6 (explain once, offer to hand over the script, and wait) **without** re-emitting the yes/no question.

**Suppress this footer entirely when the deploy halted** (see the carve-out at the top of this section) — a halted deploy never reached a "live" state, so re-attaching a "model is live" footer would misreport the outcome.

