---
name: semantic-model-deployer
description: Safely deploys a *-semantic-model.md file (produced by the semantic-model-analyst skill) to a live Semantius instance using the semantius. Before any writes, reconciles the model against the existing catalog, updates an existing module in place when the slug matches, extends Semantius built-ins (`users`, `roles`, `permissions`, …) additively instead of replacing them, refuses duplicate entity names across modules, surfaces explicit merge/rename decisions for near-duplicates (e.g. `contracts` vs `saas_contracts` vs `vendor_contracts`), and offers master-data promotion when two modules collide on a shared concept (`vendors`, `cost_centers`, `currencies`) so the entity moves to a neutral master module both can consume. Applies a standard module scaffold (three permissions, three default roles, six FK columns) to every module, domain or master. Supports master models (`module_type: master` in frontmatter) to formalize an ad-hoc master into a proper domain cluster, including in-place rename cascade and multi-master consolidation. Use whenever a semantic-model file exists and the user wants to deploy, apply, push, sync, integrate, reconcile, or roll out the model, including phrasings like "implement the model", "deploy the model", "apply the schema", "set up the entities", "create the entities in Semantius", "push this to Semantius", "integrate this model with what's already there", "now make it real", "promote vendors to a master module", "this entity should be shared", "extend vendors with more entities", or "formalize the finance master". Also trigger when the user uploads or references a *-semantic-model.md and asks to do anything that would materialize it. Trigger proactively when such a file is present and the user's intent is clearly to deploy it.
---

# semantic-model-deployer Skill

This skill bridges the gap between a self-contained semantic model (produced by the `semantic-model-analyst` skill) and a live Semantius instance.

**Division of responsibility:**
- This skill owns the *workflow*, parsing the model, inspecting what's already deployed, diffing, deduplicating against built-ins, **detecting name collisions and near-collisions across the entire entity catalog**, planning, and orchestrating the sequence of steps.
- The **use-semantius skill** owns the *execution*, all Semantius operations are done via the `semantius` CLI tool, following that skill's patterns and reference docs.

## Writing conventions (apply to every output this skill produces)

These rules apply to chat output, plan summaries, verification reports, and anything else this skill writes **for the user to read**. They are not optional style preferences. **They do NOT apply to data the deployer sends to Semantius** — model text (entity descriptions, field descriptions, JsonLogic, enum values, rule messages, etc.) is the user's data and is governed by the "Data fidelity" section below. Never apply em-dash rewrites, US-spelling fixes, or any other house-style edit to a payload bound for `create_entity` / `update_entity` / `create_field` / `update_field` / `create_permission`. The model's content travels untouched into the catalog; the deployer's prose styling stays in chat.

**1. US English spellings, always.** Never British English. Examples that come up often (left = correct US form, right in backticks = banned British form): optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), customize (not `customise`), recognize (not `recognise`), labeled (not `labelled`), materialize (not `materialise`), organization (not `organisation`), summarize (not `summarise`), categorize (not `categorise`), uncategorized (not `uncategorised`), normalize (not `normalise`), harmonize (not `harmonise`), analyze (not `analyse`). When in doubt between two spellings, pick the `-ize` / `-or` / `-er` form.

**2. No em-dashes (`—`, U+2014).** Banned as a parenthetical break or "and" substitute. Replace with: `X — Y` parenthetical → `X (Y)` or `X, Y`; `X — but Y` contrast → `X. But Y.` or `X; Y`; `A — B — C` triplet → split into two sentences. The en-dash (`–`) and hyphen (`-`) are fine in number ranges and compound words; the ban is specifically on `—` used as punctuation. Before writing any file or assistant message, scan for `—` and convert each instance.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?"; "Sounds right?" not "Sound right?". Use the form that agrees with the singular implicit subject; avoid colloquial elided-auxiliary forms in written text.

**4. Semantius entity-label symmetry.** When this skill writes about or proposes entity labels: `singular_label` is the bare singular noun matching `plural_label`. ✅ `Product` / `Products`. ❌ `Product Name` / `Products`. Field-level titles like "Product Name" go on the auto-created `label` field's `title` via `update_field` (this is what §8 step 5 of the model handles), never on the entity's `singular_label`.

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

**Canonical pattern: write a script file with the Write tool, then run it.** This is the only form that fully decouples the model's text from any shell quoting layer. The script file is opaque bytes to the harness; bash reads it from disk and parses the heredocs locally.

```python
# Write tool target: <cwd>/.tmp_deploy/deploy_xxx.py  (see Cross-platform path note below)
import json, subprocess, os, tempfile

def call(tool, payload):
    fd, path = tempfile.mkstemp(suffix=".json", prefix="deploy-")
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f)
    try:
        return subprocess.run(["semantius", "call", "crud", tool],
                              stdin=open(path), capture_output=True, text=True)
    finally:
        os.unlink(path)

call("create_entity", {"data": {"description": "Multi-sentence text with `backticks`, apostrophes (team's), and \"quotes\" — all safe."}})
```

```bash
# Bash: just runs the file, no inline content
python3 <cwd>/.tmp_deploy/deploy_xxx.py
```

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

Build the payload with a JSON encoder (`python3 -c "import json,sys; json.dump(obj, sys.stdout)"` or the in-script wrapper above) writing to a temp file. **Never** string-concatenate the model's text into a shell-quoted JSON literal — that's the path that forces character stripping to keep the command parseable. If you find yourself trying to "clean" the model text so it fits an inline command, stop, write a script file via the Write tool, and run it.

**Cross-platform path note (Windows / Git Bash).** Git Bash's `/tmp/` and Windows-side Python's `/tmp/` resolve to *different* directories — a Write call to `/tmp/foo.py` may land in `C:\Users\<user>\AppData\Local\Temp\foo.py` (Windows view) while the same path under Git Bash sees an empty `/tmp/`. Two robust options:
- **Preferred:** Write the script under a deploy-scratch folder inside the **current working directory** (e.g. `<cwd>/.tmp_deploy/script.py`) — both shells agree on `<cwd>`. Add `.tmp_deploy/` to `.gitignore` once and never think about path mapping again. Clean up the file after the run.
- Use `$(mktemp -t deploy-XXXXXX.py)` *from inside Bash* and pass the resolved path through to subsequent Write/Read calls — `mktemp` returns a path bash and the local Python both understand because it lives under bash's view of `/tmp/`. Don't write to a literal `/tmp/foo.py` from the Write tool blind; the path may resolve elsewhere.

This applies to every write call where the payload contains *any* model-authored text: `create_entity`, `update_entity`, `create_field`, `update_field`, `create_permission`, `update_permission`, anything else that carries user prose or JsonLogic.

**4. Each call carries its own complete payload.** When iterating over multiple entities or fields whose model declarations *look similar* (e.g. the four `*_comments` entities each declare a `visibility` field with the same description and the same `input_type_rule`), do not "optimize" by writing one full payload then short payloads for the rest. Every `create_field` call carries every column the model declares for that field — `description` included — every time. The four comment entities each get their own complete `create_field` for `visibility`, each with the full description string. Identical text repeated across entities is the **expected case**, not a redundancy to eliminate. Generating a batch script that re-uses the first entity's payload as a template and elides "duplicate" keys for subsequent entities is exactly how the `service_request_comments.visibility.description` empty-string regression happens.

**5. `update_*` calls are minimal.** PostgREST PATCH semantics: keys you send are written, keys you omit are left alone. When Stage 4f issues `update_field` to set `data.input_type_rule = <jsonlogic>`, the payload contains **only** `input_type_rule` — never include `description`, `title`, `format`, or any other column unless the model genuinely declares a drift on that column too. **Specifically: the rule-entry's own `description` field** (the analyst's commentary about *the rule itself*, like `"Visibility is editable for the author..."`) **is not the same thing as the field-column's `description`** (the analyst's description of *what the column stores*, like `"Public replies are visible to the requester; internal notes are agent-only"`). The rule-entry's `description` lives **inside** `input_type_rule`'s JsonLogic-array entry and travels into Semantius as part of that array. It must never leak out to become the field's `description` column. Two different surfaces, two different meanings, never crossed.

**Verification posture.** Stage 5's per-entity check (see "Per-area checks") should round-trip every `description` (entity-level and field-level) the model declared and assert byte-equality with the live catalog value. A mismatch is a Stage 5 defect — quote the diff and offer a retry of the offending write. This is the only way truncation / normalization regressions surface before the user notices them in the UI.

---

## Generated artifacts (scripts, intermediate files)

This skill emits shell and Python helper scripts during a deploy (e.g. the bulk seeders described in Stage 5, ad-hoc `update_entity` rule appliers, batch field creators when a model has many fields). These are **ephemeral one-shots**, tied to a single model and a single deploy run. They are not skill source.

**Where they go:**
- **Preferred (cross-shell safe):** under the current working directory in a scratch folder, e.g. `<cwd>/.tmp_deploy/deploy_<short>.py`. Both Git Bash and Windows-side Python agree on `<cwd>` paths, so a script created via the Write tool can be executed by either runtime without path mismatch. Add `.tmp_deploy/` to `.gitignore` once. Delete the file after a successful run.
- Unix / Git Bash (Linux/macOS or pure Git Bash workflows): `mktemp -t deploy-XXXXXX.sh` (or `.py`). The OS reaps `/tmp` automatically.
- PowerShell: `Join-Path $env:TEMP "deploy-$(Get-Random).sh"`. Delete after a successful run.

**Cross-platform path warning (Windows / Git Bash):** Git Bash's `/tmp/` and Windows-side Python's `/tmp/` may resolve to different directories. A Write call to literal `/tmp/foo.py` can land somewhere bash later cannot find. Use the `<cwd>/.tmp_deploy/` form, or use `$(mktemp -t ...)` from inside Bash to resolve a path *first*, then pass the resolved path to Write — never blindly write to a literal `/tmp/...` from a tool that may use a different mount view.

**Where they must not go:**
- ❌ The skill folder (`.claude/skills/semantic-model-deployer/`). Past sessions have leaked files like `_ats_deploy_entities.sh`, `_seed_v2.py`, `_apply_rules.sh` into this folder — that's a discipline failure, not a convention. The skill folder is read-only at runtime; only the maintainer edits it.
- ❌ The user's working directory. Pollutes the project, surfaces in `git status`, and survives across sessions.
- ❌ Any path under the model file's directory. Same reasons.

**Cleanup:** Delete the tempfile after a successful run with `rm` (Unix) or `Remove-Item` (PowerShell). If the run fails, leave the file in place and report its path so the user can inspect — but still in `$TMPDIR`, not in the skill folder.

This applies to every script this skill writes, not just the seed script at Stage 5.

---

## Schema compatibility: `EXPECTED_MAJOR = 3`

This skill expects model files written by `semantic-model-analyst` major `3`. The model file's front-matter `version: "MAJOR.MINOR"` is checked at the start of Stage 1. **Major must equal `EXPECTED_MAJOR`**, minor is informational and not compared. Files with a different major are rejected with a request to update the model via the analyst before retrying.

Analyst major `3.0` adds two forward-compatible authoring conventions on top of `2.x`: an optional `module_type: master` frontmatter directive (default `"domain"`), and an optional per-entity `**Shared master cluster:** <name>` annotation in §3. Pre-3.0 files parse with both fields defaulted, but a pre-3.0 deployer reading a 3.0 master-typed model would silently create a regular domain module instead of a master, producing the wrong shape rather than a missed optimization. The major bump is the honest signal that the two skills must move in lockstep.

The history of the deployer's contract changes lives in [`CHANGELOG.md`](./CHANGELOG.md) — what each analyst-lockstep bump changed in the deployer's parser, stage numbering, and audit checks. That file is not loaded at runtime; the body of this SKILL.md is the **current contract**, the CHANGELOG is the **history**.

- **Older major** (e.g. file is `"0.x"`, this skill expects `"1.x"`), the file was written by an older analyst version using a structure this deployer no longer understands. Tell the user to run the analyst skill; its archived-knowledge mode reads the older file and re-authors a current-major file from the same semantic content.
- **Newer major** (e.g. file is `"2.x"`, this skill expects `"1.x"`), the file was written by a newer analyst than this deployer knows about. Tell the user to update this deployer skill before retrying.
- **Missing `version` key** (legacy, pre-versioning), treat as major `0`; same response as older-major above.

When the analyst's major bumps, this skill's `EXPECTED_MAJOR` must be bumped in lock-step (same commit when feasible). The two skills are paired; a major mismatch between the skills themselves is a maintainer error, not a user-facing one.

## Your role: gatekeeper of a unified catalog

Semantius is a **unified platform, a universal system of records**. It is **not** a collection of independent silos stitched together. Each semantic model you implement is a *point solution* that drops into a shared catalog of modules, entities and fields. Other point solutions have been, or will be, installed into the same instance.

**Two entities called `contracts` owned by two different modules is exactly the kind of drift that makes the platform unusable for both humans and agents.** The moment the catalog contains ambiguous names, downstream reasoning falls apart: users don't know which table to use, agents pick the wrong one, reports double-count, and FK references point to the wrong concept.

**Cross-model link suggestions.** Closing silos goes beyond name-collision policing. The model's §6 carries a flat hint table of FKs that would add value if the named target entity exists in the catalog (e.g. `incidents → hardware_assets`, `incidents → configuration_items`). For each row, the deployer resolves the `To` against the live catalog: an exact match becomes an additive `create_field` proposal, ambiguity (multiple plausible targets like `vendors` vs `suppliers` vs `saas_vendors`) triggers a single user confirmation, and a missing target is silently skipped. Cross-module changes are strictly additive (new optional FKs); §6 never carries renames, type changes, deletions, or entity-overlap declarations. Entity overlap (vendors-vs-suppliers, contracts-vs-saas_contracts) is detected separately at Stage 2d/2e by inspecting the live catalog. See Stage 2g and Stage 4h.

Your job as the implementer is to **refuse to introduce ambiguity**. Before creating any entity you must:

1. Check whether it already exists as a built-in (see Stage 2b), never replace, may extend additively.
2. Check whether it already exists as a custom entity in this same module (Stage 2c), this is a re-run; update in place.
3. Check whether an entity with the **same** name already exists in a **different** module (Stage 2d), **ambiguity gate; the user must decide merge vs rename before you proceed.**
4. Check whether an entity with a **similar** name exists anywhere (Stage 2d), **ambiguity gate; the user must decide.**

Never silently coexist conflicting names. Never pick a side for the user. Resolving catalog ambiguity is the single most important thing this skill does.

**This skill is designed to be re-run whenever the model changes.** Because it always inspects Semantius before acting, re-running on an updated model is safe, it diffs the new model against what's already deployed and applies only the delta (new entities, new fields, updated labels/enums). If a module with the same `system_slug` already exists, **always update that module**, never create a duplicate. Things that haven't changed are skipped. Things in Semantius that are no longer in the model are left alone.

**The model is self-contained.** The semantic-model file produced by `semantic-model-analyst` declares every entity the domain needs, including ones that happen to overlap with Semantius built-ins (e.g. `users`, `roles`, `permissions`, `webhook_receivers`). Those built-ins are platform infrastructure, they control authentication, RBAC, and integration, and **must never be replaced**. They *may* be extended additively (new fields on `users`, for instance). See Stage 2b.

---

## Step 0: Load the use-semantius Skill

Before doing anything else, read the use-semantius skill and its data-modeling reference:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
```

The data-modeling reference gives you the mandatory creation order, all field formats, the Golden Rules, and exact CLI syntax. Everything in the execution stages below follows those patterns. Also read `references/cli-usage.md` if you need help with CLI invocation, piping, or error handling.

All Semantius operations in this skill are performed using the **`semantius` command-line tool**, for example:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.lead_manager"}'
semantius call crud create_entity '{"data": {...}}'
```

**Always pass `--single` on reads filtered by a unique key** (`id=eq.<int>`, `module_slug=eq.<slug>`, `permission_name=eq.<code>`, `table_name=eq.<unique>`, composite unique keys). `--single` is supported on every `crud` read tool, returns a bare object instead of a one-element array, exits 1 when the row doesn't exist, and exits 2 when the filter is ambiguous — so the canonical "exists / missing / duplicate" branches collapse to the shell exit code, no `[0]` indexing or `[]` checking. Reserve array reads for genuinely zero-or-many queries (catalog sweeps like `read_entity '{}'`, per-table field dumps, list filters).

---

## High-Level Workflow

```
1. Parse PRD  →  2. Inspect Semantius  →  3. Plan & Present  →  4. Execute  →  5. Verify  →  6. Sample Data?
```

Work through each stage in order. Narrate what you're doing at each step.

---

## Stage 1: Parse the semantic model

Locate the `*-semantic-model.md` file. The very first check is the schema-version gate; everything else only runs if the version is compatible.

- **`version`** from YAML frontmatter, required. Compare its **major** part against this skill's `EXPECTED_MAJOR` (see "Schema compatibility" near the top of this file). Major equal → proceed. Major older or missing → stop with a message naming the file's version, this skill's expected major, and the recommended next step (run the analyst's audit mode to migrate). Major newer → stop and ask the user to update this skill. Do not parse the rest of the file when the gate fails; mismatched majors mean the file's structure may not match what the rest of Stage 1 assumes.

Once the version gate passes, extract the rest:

- **`system_slug`** from YAML frontmatter, this is the module name
- **`module_type`** from YAML frontmatter, optional. Accepted values: `"domain"` (default when the key is absent) or `"master"`. When `"master"`, this is a **master model** and Stage 2a runs the master-model branch (look up existing master by slug match then entity-overlap match, decide create-vs-extend, coordinate rename cascade if applicable). When `"domain"`, normal create-or-update path. Any other value is a 🛑 High blocker.
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
    - `<narrow_suffix>` matching a `Type: workflow-narrow` row in the §2 Permissions summary → `edit_permission = <system_slug>:<narrow_suffix>`. The parser checks the §2 table for a row whose `Permission` cell equals `<system_slug>:<narrow_suffix>` and whose `Type` is `workflow-narrow`; if no such row exists, this is a 🛑 High blocker (undeclared narrow tier).

    Carry the resolved value through to Stage 4c's `create_entity` call. The line is not required; treat every entity as `manage` when the line is absent.
  - **`**Shared master cluster:**`** line, when present (analyst v3.0+). Optional per-entity annotation emitted by the analyst for entities recognized as classic master concepts (finance reference data, parties, organization data, products, employees). Free-form snake_case identifier (e.g. `finance`, `parties`, `organization`, `products`, `employees`). The hint is **only** consulted at Stage 2d follow-up 1 when this entity becomes a Branch B promotion candidate (host-module name suggestion / recommended-master selection). It has no effect when the entity is not promoted to a master. Missing line means no hint — defaults apply (bare entity name as the master host's default new-module name). Carry through to Stage 2d but do not validate further.
  - **`Computed fields`** sub-block, when present: parse the fenced ```` ```json ```` array verbatim; default to `[]` when the heading is absent. Each entry has `name` (existing scalar field on this entity), `jsonlogic` (object), optional `description`. The deployer passes the array as-is to `create_entity` / `update_entity`.
  - **`Validation rules`** sub-block, when present: parse the fenced ```` ```json ```` array verbatim; default to `[]` when the heading is absent. Each entry has `code` (snake_case, unique within entity), `message` (required), `jsonlogic` (object), optional `description`. The deployer passes the array as-is to `create_entity` / `update_entity`. JsonLogic in this array may invoke two platform-extension operators: `{"value_changed": "<field>"}` (true when the field's value differs from `$old`, true on INSERT) and `{"require_permission": "<permission_code>"}` (returns `true` when the caller holds the permission, throws otherwise). Both are passed through verbatim, no special encoding. **However**, the deployer must cross-check every `require_permission` argument against the §2 **Permissions summary** table (the canonical source): collect every distinct `<permission_code>` referenced across all entities' `validation_rules`, verify each one appears as a `Permission` row in the table. Mismatch is a 🛑 High blocker (see the precedence table below); refuse to deploy and send the user back to the analyst skill rather than calling `create_permission` ad hoc, the analyst's audit should have caught this and the model may have other gaps if it didn't.
  - **`Input type rules`** sub-block, when present: parse the fenced ```` ```json ```` **array of objects** verbatim into a list of `{field, jsonlogic, description?}` entries; default to `[]` when the heading is absent. Same shape as `Computed fields` and `Validation rules` — one parser handles all three. Each entry's `field` must resolve to a real field declared in this entity's §3 field table (Stage 1 enforces; a typo or auto-field name is a 🛑 High blocker). Each entry's `jsonlogic` is an object that the platform evaluates client-side at form render against the current record; the return value must be one of the five `input_type` enum values (`"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`), with the static `input_type` as the platform-side fallback for empty / malformed / out-of-enum returns. The deployer passes each entry's `jsonlogic` verbatim to `update_field`'s `data.input_type_rule` in Stage 4f. JsonLogic shape is not deeply validated at parse time (the platform handles the fallback gracefully); only structural integrity (`field` references a real field, `jsonlogic` is an object) is enforced here. If the deployer encounters a YAML-shaped `Input type rules` block (sometimes seen in older drafts), it's a 🛑 High parse error: route the user to the analyst's audit to regenerate.
  - **`Select rule`** sub-block, when present: parse the fenced ```` ```json ```` **object** (not an array) verbatim; default to `{}` when the heading is absent. The JsonLogic must return a boolean (truthy ⇒ row visible) when evaluated by the platform's generated `FOR SELECT` RLS policy. Every column referenced inside the JsonLogic must resolve to a real field on this entity (Stage 1 enforces; cross-row lookups, FK traversal, and aggregates are out of scope and a 🛑 High blocker if present). Every permission code referenced inside the JsonLogic (e.g. via the platform's permission-check operator when wired through `select_rule`) must appear as a `Permission` row in the §2 Permissions summary table — same cross-check as `require_permission` (🛑 High blocker on mismatch). **`Select rule` prose × JsonLogic cross-check (critical defense-in-depth).** The deployer also walks the sub-block's `description` (when present) and the entity's §3 prose for bypass-shaped phrases (*"bypass"*, *"elevated"*, *"override"*, *"see every"*, *"unrestricted"*, *"holders of X see"*, *"degrade to"*) and permission tokens (`<slug>:<suffix>`). For every permission token named in prose, the JsonLogic body must literally reference that token (e.g. `{"require_permission": "<code>"}` if the platform documents the operator in SELECT context); for every bypass phrase, either the JsonLogic body must encode the bypass OR the model must carry a §7-resolved architectural-decision entry naming a documented broadening mechanism. A prose claim that doesn't reconcile with the JsonLogic body is a 🛑 High blocker, same severity as the column-doesn't-exist check. The deployer never deploys a rule the analyst's Stage 12.5 audit should have caught. The deployer passes the parsed object verbatim to `update_entity`'s `data.select_rule` in Stage 4f. **An empty object `{}` (or the heading omitted) means "no rule"** — the platform drops any generated RLS policy when the column is reset to `{}`; do not confuse this with the missing-heading-but-live-non-empty drift case (see Conflict Resolution Reference).
- **Relationship table** (§4), confirms `reference_delete_mode` for each FK field
- **§2 Mermaid diagram**, sanity-check it agrees with §3/§4 (the model's own audit should have caught mismatches; if it disagrees here, flag for the user before proceeding rather than silently picking one side)
- **§6 Cross-model link suggestions**, parse the §6 markdown table into a list of rows, each carrying `{from_table, to_concept, verb, cardinality, delete_mode}`. Defaults: `cardinality = "N:1"` and `delete_mode = "clear"` when the column is absent or empty; `verb` is required and never defaulted. If §6 reads "No cross-model link suggestions.", the list is empty and Stages 2g and 4f are no-ops. The `related_domains` front-matter is informational only (a discovery tag for humans browsing the catalog); the deployer does not consume it.
- **§7 Open questions**, scan both sub-sections. **§7.1 🔴 Decisions needed is a gate**: if any entry is present and unresolved, stop before Stage 4 and list the blockers to the user; ask them to either (a) answer each question so the model can be updated first via the semantic-model-analyst skill, or (b) explicitly waive and proceed at their own risk. Do not make up answers, and do not silently proceed. **§7.2 🟡 Future considerations is informational only**, note them for the user but do not block.
- **Permissions summary** (`### Permissions summary` sub-section under `## 2`, mandatory in analyst v2.0+) — parse the table verbatim. Five columns in this fixed order: `Permission | Type | Description | Used by | Hierarchy parent`. Build a `permissions` index from the rows; each entry `{permission, type, description, used_by, hierarchy_parent}`. The deployer's Stage 2a (module + permissions setup) creates one `create_permission` call per row in table order, using the `Permission` and `Description` cells. After all permissions exist, the deployer iterates the index once more and issues one `create_permission_hierarchy` call per row whose `hierarchy_parent` is non-`—`, with `parent_permission = hierarchy_parent` and `child_permission = permission`. **Parse-time validation** (all 🛑 High blockers, reject before any write):
  - exactly one row with `Type: baseline-read` and `Permission = <slug>:read`;
  - exactly one row with `Type: baseline-manage` and `Permission = <slug>:manage`;
  - at-most-one row with `Type: baseline-admin` and `Permission = <slug>:admin`;
  - **every row has a non-empty `Description` cell** (whitespace-only counts as empty; `—` is rejected). The deployer writes the cell verbatim to `permissions.description` without templating or fallback (see Stage 2a-scaffold step 2 and Stage 4b), so an empty cell would land an empty string in the catalog — route the user back to the analyst skill to fill it in;
  - every `Type` value in `{baseline-read, baseline-manage, baseline-admin, workflow, workflow-narrow}` (the `workflow-narrow` value was added in analyst v2.1; files stamped older than `2.1` that include it should not exist in the wild, refuse and route to the analyst);
  - every `Hierarchy parent` cell either `—` or a `Permission` value that also appears in the table;
  - **no `Type: workflow` (elevated) row whose `Hierarchy parent` is `<slug>:manage`** — rolling an elevated permission under `manage` auto-grants every manager the gated authority and defeats the conditional check;
  - **every `Type: workflow-narrow` row's `Hierarchy parent` is `<slug>:manage` or higher in the baseline chain (`<slug>:admin` is acceptable *only if* it transitively includes `manage`)** — a `workflow-narrow` row whose `Hierarchy parent` is `—` is a blocker (the narrow tier would not be reachable by `manage` holders, inverting intent); a `workflow-narrow` row whose `Hierarchy parent` is `<slug>:admin` in a model where `admin` does *not* roll up to `manage` is also a blocker.

  **Cross-check against the rest of the parse** (also blockers):
  - every `require_permission(<code>)` argument referenced across all `validation_rules` appears as a `Permission` row;
  - every entity carrying `**Edit permission:** admin` appears in the `baseline-admin` row's `Used by` cell (and vice versa);
  - every entity carrying `**Edit permission:** <narrow_suffix>`) has `<slug>:<narrow_suffix>` declared as a `Type: workflow-narrow` row, AND the entity appears in that row's `Used by` cell;
  - every `Type: workflow` (elevated) row is invoked by at least one `require_permission` rule;
  - every `Type: workflow-narrow` row is consumed by at least one entity's `Edit permission:` annotation OR invoked by at least one `require_permission` rule.

  The table is the canonical source — when the table and a §3 / §8 reference disagree, the table wins and the disagreement is a defect surfaced to the user.
- **Implementation notes** (§8), always follow these. **In v2.0 files, §8 step 1 references the §2 Permissions summary table rather than enumerating permissions inline.** Read §8 for the procedural sequence (module creation order, label-column fixups, dedup-against-builtin, etc.) but read the Permissions summary table for the permission catalog itself.

### Model-to-Entity Mapping

| Model line | `create_entity` / `update_entity` parameter |
|---|---|
| `table_name` (§3 heading) | `table_name` |
| Singular / Plural labels | `singular_label` / `plural_label` |
| Description | `description` |
| Label column | `label_column` |
| `**Audit log:** yes \| no` | `audit_log` (boolean; omit or pass `false` when the model says `no` or is silent) |
| `**Edit permission:** manage \| admin \| <narrow_suffix>` (absent = `manage`) | `edit_permission`: `"<system_slug>:admin"` when the line says `admin`; `"<system_slug>:<narrow_suffix>"` when the line names a bare suffix that matches a `Type: workflow-narrow` row in the §2 Permissions summary (Stage 1 has already validated this); otherwise `"<system_slug>:manage"`. `view_permission` is always `"<system_slug>:read"`. Files without the line (any reason) treat every entity as `manage`. |
| `**Edit mode:** auto \| sidebar \| modal \| page` (when present) | `edit_mode` (omit when absent, defaults to `auto`) |
| `**Cube mode:** disabled \| auto` (when present) | `cube_mode` (omit when absent, defaults to `disabled`) |
| `**Computed fields**` JSON block (when present) | `computed_fields` (array; omit or pass `[]` when absent. Sent verbatim — the deployer never edits, reorders, or merges entries.) |
| `**Validation rules**` JSON block (when present) | `validation_rules` (array; omit or pass `[]` when absent. Sent verbatim.) |
| `**Select rule**` JSON block (when present) | `select_rule` (single JSON object, not an array; omit or pass `{}` when absent. Sent verbatim by Stage 4f's `update_entity` call. Sending `{}` (or omitting the key entirely on `create_entity`) leaves the column empty and the platform generates no RLS policy.) |

> `searchable` and `is_child` on the entity are read-only / auto-computed by the platform. **Never** pass them on `create_entity` / `update_entity`.

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
| **Description** column (5th column in §3 field tables) | `description` (read the cell verbatim, pass to `create_field`. Blank cell ⇒ omit / pass `""`. Free-form prose found in the Reference / Notes column is **not** mapped — that's an analyst authoring error per the v1.8 convention; surface as a 🟡 to the user and recommend running the analyst's audit pass before redeploying.) |
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

> **Title correction:** The auto-created `label_column` field gets its title from `singular_label`. If the model specifies a different title for that field, use `update_field` to fix it after entity creation.

### Self-References

Fields that reference their own entity (e.g., `campaign.parent_campaign_id → campaigns`) must be created in a second pass after all entities exist. Flag them during parsing.

---

## Stage 2: Inspect the Unified Catalog

**Read before writing, always.** (use-semantius Golden Rule #1)

This stage does four things in order: (a) resolve the module, (b) inspect built-ins, (c) load the full entity catalog, (d) classify every model entity and surface ambiguity.

### 2a. Resolve the module: update if it already exists

**Branch on `module_type` from Stage 1.** A `module_type: master` model takes the master-model branch (subsection 2a-master below); a `module_type: domain` model (default) takes the standard domain branch.

Look up the module by its slug (lowercase URL handle), since `system_slug` is the model's URL-shaped identifier:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.<system_slug>"}'
```

Exit 0 = exists (reuse the returned `id`); exit 1 = missing (plan a `create_module`); exit 2 = duplicate (a hard catalog bug — surface and stop).

> **Module schema note.** Modules carry both a **`module_name`** (unique human-facing display name shown in the UI selector and landing page header, keep acronyms as acronyms, e.g. `CRM`, `ITSM`, `CMDB`) and a **`module_slug`** (lowercase URL/permission handle, e.g. `crm`, `itsm`, `cmdb`), plus a **`module_type`** enum (`"domain"` or `"master"`, default `"domain"`). The earlier `alias` field is **removed**. `module_name` maps to the model's `system_name`; `module_slug` maps to the model's `system_slug`; the module's `description` maps to the model's `system_description` (compact tagline, ≤40 chars, e.g. `Customer Relationship Management`); `module_type` maps to the model's frontmatter `module_type` (default `"domain"`). The §1 Overview prose does **not** go on the module record, it is too long for the selector chip; keep it in the markdown file only.

#### Domain module (`module_type: domain`, default)

- **Exists** → plan an `update_module` to refresh `module_name`, `description`, and (if missing on the existing record) `module_slug`, drawing them from the model's `system_name`, `system_description`, and `system_slug` respectively. Capture the existing `module_id` to reuse. **Never create a second module with the same slug.** **Never flip `module_type` on `update_module`** — a domain module's type cannot be promoted to master via re-deploy; promotion is the explicit Stage 2d Branch B flow. On re-run, also reconcile permissions: if the model now requires `<system_slug>:admin` (per Stage 1's parsed §3 `**Edit permission:**` annotations) but the live module only has `<system_slug>:read` and `<system_slug>:manage` (the legacy two-permission baseline), plan an additive permission create plus the missing hierarchy row, plus the matching scaffold role (`<slug>_admin`) and FK update. See Stage 4b for the full reconciliation rules.
- **Missing** → plan a `create_module` with `module_name: "<system_name>"`, `module_slug: "<system_slug>"`, `description: "<system_description>"`, `module_type: "domain"`, followed by the **scaffold pass** (subsection 2a-scaffold below).

#### Master model (`module_type: master`, analyst v3.0+)

A master model is a self-contained spec for a master-data module — either declaring a new master upfront (rare), or formalizing an ad-hoc runtime-promoted master into a properly-modeled domain cluster (more common). Stage 2a's master-model branch tries three match strategies in order:

1. **Exact slug match.** `read_module --single` by `module_slug=eq.<system_slug>`. If the matched module exists and is already `module_type = "master"`, this is a master-model **extend-in-place** deploy. No rename needed. Capture the `module_id` and proceed to scaffold reconciliation + entity diffs. If the matched module exists but is `module_type = "domain"`, surface a 🛑: a master model's slug collides with a live domain module — the user must either rename the model's `system_slug` (via the analyst) or abort. Do not flip `module_type` silently.

2. **Entity-overlap match.** If no exact slug match, query master modules whose `module_type = "master"` and load each one's entities. If any of the model's declared entities (from §2) already live in an existing master, that master is a candidate. Build a candidate list:

   ```bash
   semantius call crud read_entity '{"filters": "table_name=in.(<entity_1>,<entity_2>,...)&select=table_name,module_id"}'
   semantius call crud read_module '{"filters": "module_type=eq.master&id=in.(<distinct_module_ids>)"}'
   ```

   - **One candidate.** Use it as the target master. If its `module_slug` differs from the model's `system_slug`, ask via `AskUserQuestion`: (a) rename master to model slug (recommended when the model's slug is more descriptive, e.g. `vendor_management` over bare `vendors` — coordinate the cascade per Stage 4b-rename); (b) keep existing slug, apply only cosmetic updates from the model. After the user picks, capture the (possibly renamed) module's id.
   - **Multiple candidates.** Surface to the user via `AskUserQuestion` with one question per candidate master ("which master should `<entity>` consolidate into?"), then for the chosen target master apply the same rename / keep prompt. The unchosen candidates become Path-2 master-merge sources: for each, fire the per-source consolidate / skip / abort prompt described in Stage 4c-merge-master.

3. **No match.** No existing master holds any declared entity, and no exact slug match. This is the upfront-master-deploy case. Plan `create_module` with `module_type: "master"` and the model's `system_name` / `system_slug` / `system_description`.

After the module is identified (or planned), run the scaffold pass.

#### 2a-scaffold: standard module scaffold

Every module (domain or master) carries a standard scaffold: three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`), three default roles (`<slug>_viewer`, `<slug>_manager`, optionally `<slug>_admin`), and six FK / column references on the module record (`view_permission`, `manage_permission_id`, `admin_permission_id`, `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id`).

The scaffold pass is **idempotent** — on re-run, the deployer reads what's already in place and creates only the missing pieces. For each module touched by this deploy:

1. **Determine the required tier set.** Two-permission baseline (`read`, `manage`) unless any entity carries `**Edit permission:** admin` in the model, in which case three-permission baseline (`read`, `manage`, `admin`).

2. **Create permissions from §2.** Iterate the model's §2 Permissions summary index (built in Stage 1) in table order. For each row, `read_permission --single` by `permission_name=eq.<row.permission>`; `create_permission` only on exit 1, passing `permission_name = <row.permission>` and `description = <row.description>` (the §2 `Description` cell, verbatim). **The model is the single source of truth for every permission code and every description** — baseline tiers (`<slug>:read`, `<slug>:manage`, `<slug>:admin`) and workflow tiers (`<slug>:approve_*`, `<slug>:publish_*`, narrow tiers, etc.) all follow the same rule. There is no per-tier template, no fallback string, and no synthesized text; if the §2 cell is empty Stage 1 has already rejected the file. Treating baselines specially is the exact failure mode that caused descriptions like *"View IT Service Management data"* to overwrite the model's own *"Read access to ticketing, knowledge base, and reference data..."* — `<slug>:read` is not more deserving of a default than `<slug>:approve_change`.

3. **Create permission-hierarchy chain.** `read_permission_hierarchy` by the `(parent, child)` pair; `create_permission_hierarchy` only on exit 1. Tag the row's `origin`:
   - `"model"` when the module's `module_type = "domain"` (rows correspond to the model's §2 Permissions summary table, plus the standard baseline chain).
   - `"model_master"` when the module's `module_type = "master"` (covers the master's internal `<master>:admin → <master>:manage → <master>:read` chain and any workflow rollups declared in a master-model's §2 Permissions summary).

4. **Create default roles per tier, with stable slugs.** Roles use the convention `<slug>_viewer`, `<slug>_manager`, `<slug>_admin`. For each tier:
   - `read_role --single` by `slug=eq.<module_slug>_<tier_role>`.
   - **Slug collision check.** If a live row exists with that slug AND its `origin = "user"`, this is a 🛑 (the deployer never modifies user-created roles). Surface as `AskUserQuestion` with two options: (a) "Rename existing user role first" — admin renames in the UI to free the slug; deploy aborts and resumes on re-run, or (b) "Abort deploy." No silent claim, no `origin` flip, no auto-adoption.
   - `create_role` if exit 1, passing `slug = "<module_slug>_<tier_role>"`, `role_name = "<Module Name> <Tier Role>"` (e.g. `"CRM Viewer"`), `label = "<Module Name> <Tier Role>"`, `description = "Default <tier_role> role for <Module Name>"`, `module_id = <module_id>`, `origin = "model"` (domain) or `"model_master"` (master).
   - `create_role_permission` to attach the matching permission (`<slug>:read` to viewer, `<slug>:manage` to manager, `<slug>:admin` to admin). Idempotent: read first.

5. **Populate the six module-record references.** After permissions and roles exist, `update_module` to set `view_permission = "<slug>:read"` (text, holds the permission_name — natural-key link via the unique index on `permissions.permission_name`), `manage_permission_id = <id of <slug>:manage>` (integer FK), `admin_permission_id = <id of <slug>:admin>` (nullable, only when three-tier), `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id` (nullable, only when three-tier). Idempotent: write only the fields whose live value differs from the planned value.

6. **Master-model entity-overlap re-points.** When a master-model deploy resolved via entity-overlap match and consolidates from multiple sources (Path 2 in plan §5.4.5), the per-source consolidate / skip / abort decisions inform Stage 4c-merge-master. Record them on the plan.

> **Required model keys.** `system_name`, `system_slug`, and `system_description` are all required front-matter keys. If the model file is missing `system_description`, stop and route the user back to the analyst skill (Mode B audit) to backfill it before deploying, the deployer will not invent a description.

If the module exists but the user's model genuinely belongs to a different domain and the shared slug is itself the collision, stop and ask, that's a model-level naming problem the analyst skill should fix, not something to paper over.

### 2b. Inspect Semantius built-ins

The semantic model may declare entities that already exist as built-ins (`users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`, see `use-semantius/references/data-modeling.md` for the authoritative list). **These tables control the platform (authentication, RBAC, integration). They must never be replaced.**

For each built-in referenced by the model:

- **Skip `create_entity`** entirely. The built-in already exists; recreating would break the platform.
- **Reuse as a `reference_table` target** for any FK in the model that points at it.
- **Additive fields only.** If the model declares extra scalar fields on a built-in (e.g. `users.department`, `users.employee_id`), offer them to the user as `create_field` calls. **Never modify existing built-in fields**, never change formats or enum values on a built-in.

### 2c. Load the full entity catalog

Ambiguity detection only works if you can see every entity in the instance, not just the ones in this module. Load the catalog:

```bash
semantius call crud read_entity '{}'
```

Build an index of every existing entity keyed by `table_name`, carrying at least `{module_id, module_name, module_slug, singular, plural, description, label_column}`. The owning module's `module_name` (display) and `module_slug` (URL/permission handle) are both useful: use `module_name` when narrating conflicts to the user ("`vendors` already exists in module CRM"), and `module_slug` when constructing UI links or permission strings. You will use the index in 2d.

### 2d. Classify each model entity

For every entity declared in the model's §2, determine which bucket it falls into. **Buckets marked 🛑 are ambiguity gates, the user must make an explicit decision in Stage 3 before any writes happen.** The 🟢 shared-master bucket is the auto-wired Branch A — it never raises a collision widget.

| Bucket | Condition | Action |
|---|---|---|
| 🔒 Built-in | `table_name` matches a Semantius built-in | Reuse. Offer additive fields only (see 2b). |
| ♻️ Same-module match | Entity exists and its `module_id` equals our module's id | Re-run case, proceed to field-level diff (see "What to compare" below). |
| 🟢 Shared-master match (Branch A) | Entity exists with the **same `table_name`** AND its owning module's `module_type = "master"` | **Auto-wire as a consumer.** No collision widget. Plan a cross-module `permission_hierarchy` row `<consumer>:read → <master>:read` (always, tagged `origin = "model_master"`). Stage 2d follow-up fires the Branch A binary manage prompt (see 2d-branch-a) to decide whether to add `<consumer>:manage → <master>:manage`. Field-level diff still runs on the master entity if the model declares additive fields, but field changes on a master are merged-with-source-tagging per Stage 4e. |
| 🛑 Cross-module exact name (Branch B) | Entity exists with the **same `table_name`** AND its owning module's `module_type = "domain"` (i.e. it's in another domain module, not a master) | **Gatekeeper decision required.** Never silently coexist, see 2e. The Stage 3 collision widget surfaces **four** options: promote to shared master module (the master-promotion path described in 2d-branch-b), rename the incoming entity, use the existing entity directly, abort. |
| 🛑 Similar name | An existing entity's `table_name` is *near* a model entity's name (see heuristic below) | **Gatekeeper decision required.** Similarity is a hint, not a verdict; the user decides. The "Promote to shared master" option is **not** offered for similar-name flags — promotion is only sensible for an exact concept match. |
| ✨ New | No match of any kind | Create normally in Stage 4. |

For field-level checks on a same-module match, run the usual reads:

```bash
semantius call crud read_permission --single '{"filters": "permission_name=eq.<slug>:read"}'
semantius call crud read_field --single '{"filters": "table_name=eq.<table_name>&field_name=eq.<field_name>"}'
```

Both filter on unique keys, so `--single` is the right pattern: exit 1 means "create it"; exit 0 means "use the returned record".

### 2e. Similarity heuristic: when to flag

You, the agent, are responsible for detecting near-names. Flag any pair where:

- One name is a prefix or suffix of the other, `contracts` ↔ `saas_contracts`, `orders` ↔ `sales_orders`
- They share a singular root or a lemma, `contract` ↔ `contracts`, `customer` ↔ `customers`, `vendor` ↔ `vendors`
- They differ only by a domain qualifier, `vendor_contracts` ↔ `saas_contracts`, `support_ticket` ↔ `it_ticket`
- They are obvious synonyms for the same business concept, `customers` ↔ `clients`, `employees` ↔ `staff`, `products` ↔ `items`
- Edit distance is small and the tokens look related (not just typos of unrelated words)

If you're uncertain whether two names refer to the same concept, **flag it**. A false positive costs the user one confirmation click; a missed collision pollutes the catalog permanently and cannot be cleaned up without data migration.

### 2d-branch-a. Wiring up a new consumer to an existing master

The 🟢 shared-master bucket fires automatically when an incoming entity matches a live entity already in a `module_type = "master"` module. No collision widget. The deploy plans two pieces of wiring per consumer:

1. **Cross-module read inclusion (always).** A `permission_hierarchy` row with `parent_permission = <consumer>:read`, `child_permission = <master>:read`, `origin = "model_master"`. Without this row, consumers can't see the shared entity through their own module's `:read` permission; users would have to be added to `<master>_viewer` individually, defeating the point of the shared host.

2. **Cross-module manage inclusion (conditional).** Asked via `AskUserQuestion` as a per-consumer binary prompt. The prompt fires for each consuming module — each consumer's decision is recorded independently, in its own `<consumer>:manage → <master>:manage` row when applicable. Previous consumers' inclusion decisions are never modified by a later consumer's deploy.

Prompt shape (Branch A):

> *Should `<consumer>` managers be able to edit `<master>` records?*
>
> 1. **No — read-only via the inclusion already created. Edits only by `<master>_manager` members.** (recommended)
> 2. **Yes — add `<consumer>:manage → <master>:manage` hierarchy inclusion.** `<consumer>` managers can edit; no role-membership change.

Default-recommended option is `No`: proper MDM governance keeps edit rights inside `<master>_manager`, and consumers see master records through the read inclusion plus optional individual membership in `<master>_manager` for stewards.

Idempotency: on re-run, the deployer checks for existing rows matching `(parent, child)` before creating; never duplicates a bridge. Rows tagged `origin = "model_master"` may be updated by the deployer (FK adjustments during master-rename or master-merge) but are **never deleted by the deployer** (see "No auto-deletion" below).

### 2d-branch-b. Promotion of a domain-owned entity to shared

When the incoming entity collides exact-name with a live entity in another **domain** module (not a master), surface a **four-option** widget. Phrase every option in plain outcome + risk language — never in scaffold / module / additive terms the user shouldn't have to understand. Order is promote first (the path that solves the cross-domain case cleanly), then the two single-domain alternatives ranked by safety (silo before gatekeeper), then abort:

> 1. **Promote `<entity>` to shared `<host>` module** — both `<original_module>` and `<incoming_module>` read the same `<entity>` table. No duplication, no gatekeeper, each team's permissions automatically extend. Adds one neutral master module to the catalog.
> 2. **Rename new `<entity>` to `<incoming>_<entity>`** — creates a data silo. Each module gets its own copy. Reports can't combine them, and the two will drift apart. Pick this only when the two concepts are genuinely different (e.g. SaaS subscription agreements vs facility leases).
> 3. **Use existing `<original_module>.<entity>` directly** — requires manual permission review afterwards. `<incoming_module>` users need explicit grants to read `<original_module>`'s table, and `<original_module>` becomes the gatekeeper for any future schema changes to `<entity>`.
> 4. **Abort the deploy.**

The `(Recommended)` annotation is **dynamic**, placed on the option that fits the actual situation as inferred from Stage 1 / Stage 2f:

- **Cluster hint matches** (model carries `**Shared master cluster:** <cluster>` on this entity): annotate option 1. This is the universal Path 1 lifecycle (see master-data sharing reference). The host module suggestion in follow-up 1 is the cluster name.
- **No cluster hint, comparison block shows non-overlapping fields and clearly different concepts**: annotate option 2. Silo is the correct call when the entities just happen to share an English word.
- **No cluster hint, comparison block shows substantial overlap / same concept**: annotate option 1 anyway; the deployer's recommendation favors shared-master over single-domain ownership whenever sharing makes sense.
- **Default fallback** (analysis inconclusive): no `(Recommended)` annotation, force the user to make a deliberate choice.

Picking option 1 triggers two follow-up questions (host module + manage decision) in the same `AskUserQuestion` batch (per the batching rule at Stage 3).

**On the dropped options.** Earlier drafts of this widget surfaced two additional choices: *rename existing* (rename `<original_module>.<entity>` to a domain-prefixed name) and *rename both*. Both are dead once promote-to-shared exists — *rename existing* touches live records and FKs and breaks every saved view, report, integration, and skill that referenced the old name; *rename both* combines silo duplication with rename-existing breakage. If a user has a niche reason for either, the auto-`Other` slot accepts a custom answer and the mechanics described under "Merge / rename rules" still apply.

**Follow-up 1: which host module.** The default-name and recommendation logic uses two inputs: existing master modules in the catalog, and the optional `**Shared master cluster:**` annotation from the model file's §3 entity definition (parsed in Stage 1).

> *Where should `<entity>` live?*
>
> **Case A — no master modules exist yet, no cluster hint:**
>   - Create new module, name: `<entity>` (default, editable in the "Other" slot)
>
> **Case B — no master modules exist yet, cluster hint `<cluster>`:**
>   - Create new module, name: `<cluster>` (recommended, from cluster hint)
>   - Create new module, name: `<entity>` (entity-style alternative)
>
> **Case C — masters exist, cluster hint matches one:**
>   - Existing master module `<cluster>` (recommended, matches cluster hint)
>   - Other existing masters (in slug order)
>   - Create new module, name: `<entity>` or `<cluster>` if different from any existing master
>
> **Case D — masters exist, cluster hint doesn't match any:**
>   - Existing masters listed in slug order, no recommendation annotation
>   - Create new module, name: `<cluster>` (recommended) or `<entity>`

Defaults are suggestions, not bindings. The user can always type a custom name in the "Other" slot. The bare entity name (`vendors`, not `vendors_master`) is the default new-module suggestion when no cluster hint is available — the `module_type: "master"` flag is the actual marker of shared status, not the name.

When neither a cluster hint nor an existing master applies, this is what lets `cost_centers` join an existing `finance` master rather than spawning `cost_centers_master`: the user picks at the prompt. With cluster hints, the analyst contributes its domain knowledge so the recommendation is correct the first time.

**Follow-up 2: who manages the master entity.** Branch B is the initial promotion (two modules in play). The user is deciding for both modules at once. Surface the seed size up front so the user knows exactly who is about to be promoted to master steward:

> *Who can create / edit `<entity>`?*
>
> *`<original>_manager` currently has **N members**. Picking the recommended option seeds all N as `<master>_manager` members. If the original role is broad, prune the seeded set after deploy via the role-members UI, or pick option 2/3/4 to grant manage via hierarchy without copying membership.*
>
> 1. **`<master>_manager` role only** (recommended) — proper MDM governance. Seeded with all N current members of `<original>_manager`. Add or remove members in the UI after deploy.
> 2. **`<master>_manager` plus both modules' managers** — add hierarchy inclusions so `<original>:manage` and `<incoming>:manage` both transitively grant `<master>:manage`. Seed still runs.
> 3. **`<master>_manager` plus original module's managers only** — inclusion from `<original>:manage` to `<master>:manage`. The incoming module is read-only. Seed still runs.
> 4. **`<master>_manager` plus incoming module's managers only** — inclusion from `<incoming>:manage` to `<master>:manage`. Rare. Seed still runs.

The role exists in all four options. The seed (Stage 4j) runs unconditionally regardless of option, so options 2–4 layer hierarchy on top of seeded role membership. The read inclusion is always created for both modules; only the manage inclusion edge is conditional on the user's choice.

> **Continuity at promotion.** Picking option 1 requires that `<master>_manager` has at least one member or the entity is unmanageable. The seed (Stage 4j) handles this for the typical case. If the original module's manager role is empty, **Gate B** fires (see Stage 5/6 Gates).

### 2f. For each 🛑, compare the concepts before asking the user

You cannot ask a useful question without first understanding both entities. For every flagged pair, pull the existing entity's fields and build a side-by-side comparison:

```bash
semantius call crud read_field '{"filters": "table_name=eq.<existing_table_name>"}'
```

Note for each:

- Module it lives in, `singular`, `plural`, `description`, `label_column`
- Field names, formats, required-ness
- Overlap: which fields mean the same thing (often same name, sometimes just same concept under a different name)
- Format conflicts on conceptually-same fields (cross-primitive → blocks merge; same-primitive can be reconciled via `update_field` before merge)

This comparison goes into the Stage 3 plan so the user can decide on informed grounds.

### What to compare when a same-module entity already exists

| Property | Risk | Notes |
|---|---|---|
| Field `format` | ⚠️ Medium within primitive, 🛑 High across primitives | Same-primitive changes are accepted by `update_field` (e.g. `text` ↔ `multiline` ↔ `html` ↔ `json` ↔ `email`, all TEXT-backed; `integer` ↔ `number`, both numeric; `date` ↔ `datetime`). Cross-primitive changes (`text → date`, `email → integer`) are rejected by the platform — fall back to a model-level rethink via the analyst skill. Don't maintain a parallel primitive taxonomy here; sync to the model and let Semantius adjudicate. |
| Field `enum_values` | ✅ Low for additive, 🛑 High for removals | Adding values the live row doesn't have is safe (no existing record carries the new value); sync via `update_field`. Removing values the live row still carries is unsafe: existing rows may hold the removed value and the check-constraint tightening will fail. Surface removals in the Stage 3 plan so the user can decide (drop the value and reconcile existing rows first, or keep it in the model). |
| Entity labels, descriptions | ✅ Low | Safely updatable |
| Field `title`, `description` | ✅ Low | Safely updatable |
| Field `required`, `searchable`, `width`, `input_type` | ✅ Low | Safely updatable; sync to model value. |
| Field `reference_table`, `reference_delete_mode`, `relationship_label`, `is_unique` | ✅ Low | FK metadata is safely updatable; sync to model value. |

### 2g. Resolve §6 cross-model link suggestions against the live catalog

Walk every row in the §6 hint list parsed in Stage 1. For each row `{from_table, to_concept, verb, cardinality, delete_mode}`, resolve `to_concept` against the global entity catalog already loaded in 2c.

Three outcomes per row:

- **Exact match** (one entity in the catalog has `table_name == to_concept`): mark the row ✨ **Proposed**, record the resolved target's `table_name`, `singular`, and owning `module_name` for use in Stage 3 and Stage 4f. Auto-generate the FK column name from the target's singular form using the `<target_singular>_id` convention (e.g. `hardware_assets` becomes `hardware_asset_id`). If a field with that name already exists on `from_table`, mark it 🛑 **Field-name collision** and carry the conflict into Stage 3 for the user to resolve (rename the new FK or skip the row).
- **No match** (no entity has `table_name == to_concept` and no near-name match either): mark 💤 **Dormant**. Skip silently; the target module is not deployed. Do not surface the row in Stage 3.
- **Multiple plausible matches** (no exact match, or an exact match plus near-name candidates): mark 🟡 **Ambiguous**. Run the same similarity heuristic that Stage 2e uses for entity collisions (prefix/suffix/synonym/qualifier, small edit distance with related tokens) over the catalog index, and collect every plausible target. Stage 3 will ask the user to pick one or skip.

Field-source-side check: every row's `from_table` must be a `table_name` that will exist after this deploy completes, on either this module's side (a `table_name` declared in this model's §3) or on a module already in the catalog. If `from_table` is neither in this model's §3 nor in the catalog, surface as a 🛑 **Unresolved source** so the user can fix the model via the analyst skill before Stage 4h tries to create a field on a non-existent table.

Build a `link_proposals` list carrying the resolved rows (Proposed, Ambiguous, Field-name collision, Unresolved source) for Stage 3. Dormant rows do not appear in the plan; they are noted in the verification summary so the user knows how many suggestions were silently parked. Carry that summary into Stage 3 so the user sees the cross-module impact alongside the in-module plan.

---

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
  🔒 users — Semantius built-in, reusing (model declares 3 extra fields: `department_id`, `job_title`, `employee_id` — will add additively with user confirmation)
  ✨ vendors — will create + 6 fields
  ✨ subscriptions — will create + 26 fields
  ✨ departments — will create + 5 fields
  ✨ budget_periods — will create + 6 fields
  ✨ budget_lines — will create + 8 fields
  ✨ license_assignments — will create + 7 fields

Total to create: 1 module, 3 permissions, 2 hierarchy rows, 6 entities, ~58 fields
Plus: 3 additive fields on built-in `users` (pending confirmation)

🧠 Entity-level rules (write-side, from §3 `Computed fields` / `Validation rules`):
  ✨ `subscriptions`: 1 computed_fields, 3 validation_rules
  ✨ `budget_lines`: 2 validation_rules

👁 Entity-level read rules (from §3 `Select rule`):
  ⚠️ `license_assignments`: ✨ select_rule — will scope per-row visibility to the row's `assignee_user_id` (medium-risk visibility change, pending confirmation)

🎛 Field-level UI rules (from §3 `Input type rules`):
  ✨ `subscriptions.renewal_date`: input_type_rule (hidden until status=`renewed`)
  ✨ `subscriptions.cancelled_at`: input_type_rule (hidden until status=`cancelled`, then readonly)
  ✨ `budget_lines.approved_at`: input_type_rule (readonly once status=`approved`)

🔗 Cross-model link suggestions (from §6):
  ✨ Propose on `subscriptions`: + `contract_id → contracts` (governs, clear) — pending confirmation
  ✨ Propose on `subscriptions`: + `project_id → projects` (charged to, clear) — pending confirmation
  💤 Skipped (target not in catalog): `subscriptions → cost_allocation_rules`
```

The read-side and UI-rule sub-sections only appear when the model declares them (most models omit them; the sub-sections are omitted from the plan too — don't render empty bullets). The `select_rule` row carries the `⚠️` marker because applying it changes who can see which rows (medium-risk visibility shift); the deployer pauses for explicit confirmation on every `select_rule` create / modify / remove, same posture as a tier flip on `edit_permission`.

If the module already exists, swap `✨ Will create` for `♻️ Exists (ID: 12) — will update module metadata from the new model; will diff entities and apply only changes`. Render the field-level deltas inline under each ♻️ entity so the user sees exactly what's about to change, not just a vague "will diff" promise:

```
🗂 Entities (7 total):
  ♻️ subscriptions — 26 fields, 4 drifted, 1 new
     ~ vendor_name.description: "Vendor" → "Legal name of the contracting vendor"
     ~ status.enum_values: + "renewed", + "expired"
     ~ amount.searchable: false → true
     ~ contract_url.format: text → html (same primitive, accepted)
     + renewal_date (date, optional)
     ⚠️ select_rule: new (model adds row-level visibility scope on `created_by_user_id`)
     + renewal_date.input_type_rule: hidden-until-renewed
  ♻️ vendors — 6 fields, no drift
  ✨ budget_lines — will create + 8 fields
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

**Print the link-proposal summary as prose first** (the same `🔗 Cross-model link suggestions` block from the normal plan), so the user has the list in front of them before any widget appears.

**Resolve Ambiguous rows first.** Any rows marked 🟡 Ambiguous in Stage 2g (multiple plausible targets matched the `To` concept) gate which proposals are even askable. Batch one question per ambiguous row into a single `AskUserQuestion` call. Each question's options list the candidate target tables (with their owning module for context) plus a "skip this row" option. After the user picks, the Ambiguous rows that resolved promote into the ✨ Proposed list and the rest drop out.

**Resolve Field-name collisions next.** Any row marked 🛑 Field-name collision in Stage 2g (the auto-generated `<target_singular>_id` already exists on `from_table`) is also batched into the same `AskUserQuestion` call. Options: provide an alternative field name (the runtime's "Other" slot accepts free text) or skip the row. Unresolved-source rows are also surfaced here for the user to fix the model via the analyst skill before this stage retries.

**Then approve the Proposed list.**

- **0 proposals**, skip this section entirely; nothing to ask.
- **1–3 proposals**, present inline with one combined confirmation: *"Apply these N cross-model link suggestions? [yes / review each / skip all]"*. Default branch on `yes` is "apply all".
- **4 or more proposals**, call `AskUserQuestion`:

  - **question**: `"Found N cross-model link suggestions whose target is in the catalog. How should I handle them?"`
  - **header**: `"Cross-model links"`
  - **multiSelect**: `false`
  - **options** (in this order, recommended first):
    1. label `"Apply all (recommended)"`, description `"Add every proposed FK in one pass. Each is an additive optional column on this model's tables, reversible later by dropping the field. This is the default for a connected catalog."`
    2. label `"Review each one"`, description `"Walk through each proposal individually. Use when the catalog is unfamiliar or when one of the suggestions touches a sensitive shared table."`
    3. label `"Skip all"`, description `"Land the in-module changes now and skip every link proposal. The proposals will re-surface on the next deploy unless removed from the model's §6."`

**On `Apply all`**, Stage 4h executes every Proposed row without further prompts.

**On `Review each one`**, fall back to one batched `AskUserQuestion` with one question per proposal (yes / skip), then Stage 4h executes only the accepted ones.

**On `Skip all`**, Stage 4h is a no-op. The dormant rows and the explicitly-skipped ones are noted in the verification summary so the user knows nothing was wired up.

This flow is **distinct from the 🛑 ambiguity protocol below for entity name collisions**. Entity-name ambiguity gates are blockers; the deploy cannot proceed until the user picks merge / rename / etc. Link proposals are not blockers; skipping them lets the deploy proceed unchanged. Keep the two flows separate.

### Ambiguity decisions (required when any 🛑 was raised)

**Every 🛑 decision must be taken via the `AskUserQuestion` tool**, not via prose options the user has to type back ("a or b"). Structured widgets remove the letter-mapping friction, survive multi-decision flows cleanly, and match how the `semantic-model-analyst` skill handles its own big decision. Never propose a default silently.

**The protocol for each 🛑:**

1. **Print the comparison block first as prose**, so the user has the facts in front of them before the widget appears. Comparison blocks carry information; the tool carries only the choice.
2. **Then call `AskUserQuestion`** with the decision as a single question. Use 4 explicit options; the runtime auto-adds an "Other" slot you can use for free-text renames or to type a custom answer outside the four prepared paths.
3. **Batch multiple 🛑 gates into one `AskUserQuestion` call** with one question per gate. Never drip decisions one turn at a time. Never squash two decisions into the same prose paragraph (the screenshot of "(a or b) and (yes/no)" is exactly the failure mode this directive prevents).

**Example, comparison block (prose, shown first):**

```
⚠️ Ambiguity: `contracts`

  Incoming (this model → module `saas_expense_tracker`):
    Purpose: A signed commercial agreement for a SaaS subscription
    Label column: contract_number
    Fields: contract_number, signed_date, total_contract_value,
            renewal_notice_days, vendor_id (→ vendors), signatory_user_id (→ users)

  Existing (module `facility_management`, created 2026-01-14):
    Purpose: Lease and service agreements for physical properties
    Label column: contract_number
    Fields: contract_number, effective_date, termination_date,
            landlord_id (→ landlords), property_id (→ properties),
            monthly_rent

  Overlap: both share `contract_number` (string). Other fields are disjoint;
  the entities model different concepts that happen to share an English word.
```

**Example, the matching `AskUserQuestion` call** (concepts genuinely differ, so `(Recommended)` lands on rename — not on promote):

- **question**: `"How should I resolve the name collision on `contracts`?"`
- **header**: `"Ambiguity: contracts"`
- **multiSelect**: `false`
- **options** (4; the runtime appends Other):
  1. label `"Promote contracts to shared module"`, description `"Both modules would read the same contracts table. Not the right call here — the comparison block shows two genuinely different concepts (SaaS subscriptions vs facility leases) with disjoint fields. Promote is correct only when both sides really mean the same thing."`
  2. label `"Rename new contracts to saas_contracts (Recommended)"`, description `"Keep concepts isolated. Each module owns its own contracts table. Loses cross-module reporting, but that's correct when the two represent different business concepts."`
  3. label `"Use existing facility_management.contracts directly"`, description `"Requires manual permission review afterwards. SaaS users would need explicit grants to read facility_management's table, and facility_management would become the gatekeeper for any future schema changes contracts needs."`
  4. label `"Abort the deploy"`, description `"Stop now, fix the model file via the analyst skill, re-run."`

**Counter-example, same widget when the cluster hint says `organization` and the comparison shows substantial overlap** (e.g. ATS's `departments` vs HRIS's `departments`): `(Recommended)` moves to option 1 and the host suggestion is `organization`. Options 2 and 3 keep their warning-style descriptions (silo / gatekeeper) so the user understands why they're not the recommended path.

The auto-"Other" slot handles: the user wants a custom rename qualifier, or insists on rename-existing / rename-both despite their being dropped from the surfaced options (the mechanics under "Merge / rename rules" still apply if they type one in).

When option 1 (promote) is picked, follow-up 1 (host module) and follow-up 2 (manage decision) batch into the same `AskUserQuestion` call. See Stage 2d-branch-b for prompt shapes. For Branch A (incoming matches an entity already in a master module), the binary manage prompt fires alone (no host-module follow-up); see Stage 2d-branch-a.

### If multiple 🛑 were raised

Send them all in **one** `AskUserQuestion` call as separate questions in the `questions` array. The comparison blocks print as prose in order above the tool call; the widgets appear as independent choices. Do not chain one-question calls across turns, that's exactly the pattern that produced the confusing "(a or b) and (yes/no)" UX.

### For similar-name flags

Use the same protocol; phrase the question to make clear the match is a *heuristic*, not a verdict (e.g. `"Does `lease_contracts` in this model refer to the same concept as the existing `contracts`?"`). Include the heuristic that matched (prefix/suffix/synonym/qualifier) in the comparison block so the user can judge whether it's a real collision or a coincidence.

### Fallback: when `AskUserQuestion` isn't available

If the tool is not available in the harness, fall back to labeled prose options with the same content, but present **exactly one decision per turn**, not multiple. Use clearly labeled choices ("A", "B", "C", "D", "Other, specify") and wait for the user's reply before moving to the next decision. Never combine multiple decisions into one prose prompt.

### Merge / rename rules

**Merge (a):**

- Do a field-by-field mapping. For each incoming field, either point it at an existing field with the same meaning, or add it as a new field on the existing entity.
- **Format mismatch on a conceptually-same field is a hard block only when the primitives differ.** Same-primitive mismatches (`text` vs `multiline`, both `TEXT`) can be reconciled with an `update_field` to align formats before the merge proceeds. Cross-primitive mismatches (one side `text`, the other `date`) cannot be reconciled; fall back to rename.
- The merged entity stays in its current module (keeps existing records and FKs intact). The incoming model's module just references it.

**Rename incoming (b):**

- Pick a qualifier from the model's domain (`saas_`, `hr_`, `billing_`) and propose it. The user may override.
- **Rewrite every reference in the plan before any Stage 4 writes.** Purely in-memory, no live data exists yet for the incoming entity, so this is safe as long as it's *complete*:
  - The entity's `table_name` in the plan
  - **Every field in this model where `reference_table` equals the old name.** Fields in *other entities in this same model* that point at the renamed entity (e.g. `license_assignments.subscription_id → subscriptions` when renaming `subscriptions` → `saas_subscriptions`) silently break if this step is missed, they'd end up pointing at a non-existent table.
  - Relationship prose in the plan summary
  - Mermaid diagram node + edge names
- The source `.md` file is left unchanged unless the user explicitly asks the analyst skill to update it.

**Rename existing (c):**

- **High-risk.** Confirm twice. The data-modeling reference calls `table_name` immutable, so `update_entity` may reject the rename outright. If it does, stop immediately and offer option (a) merge or (d) rename-both as fallback. Never attempt DDL directly.
- **No catalog-side FK fix-up is needed.** Semantius propagates renames automatically, every `reference_table` in the catalog that pointed at the old name is updated by the platform as part of the rename. Do not scan, do not issue `update_field` calls for existing FKs. Your only job is to request the rename and confirm it succeeded.
- Incoming fields in *this* model that point at the renamed entity must still use the new name, that's an in-memory plan rewrite (same mechanic as option (b)) and happens before Stage 4 writes.

**Rename both (d):**

- Apply (b) to the incoming entity, then (c) to the existing one. Only the (b) half needs a `reference_table` rewrite (in-memory, across this model). The (c) half's catalog-side FKs are repointed by the platform automatically.

Do not proceed to Stage 4 until every 🛑 has a recorded decision. Restate the resolved plan once before executing.

**Exception:** If there are zero built-in overlaps, zero cross-module collisions, zero similar-name flags, and the module doesn't exist yet, proceed immediately: "No existing model found and no catalog collisions, creating everything from scratch now."

**Clean re-run fast-path.** If the module already exists but every diff is all-green — no removed enum values, no cross-primitive format changes, no field deletions, no `edit_permission` tier flips, no cross-module collisions, no §6 ambiguities — print the delta summary inline and proceed without a confirmation prompt. Example: *"Re-run against existing `saas_expense_tracker` module: 0 entities to create, 3 entities to update (7 fields drifted, all safe). Applying now."* The user still sees exactly what changed; they just don't have to click through a gate that has nothing risky in it. Any single 🛑 (enum removal, cross-primitive format, removed field, tier flip, collision) cancels the fast-path and routes back to the normal Stage 3 dialog.

---

## Stage 4: Execute

Follow the use-semantius mandatory creation order exactly:

```
Module → Permissions → Entities → Fields (per entity, in model order)
```

Refer to `use-semantius/references/data-modeling.md` for the exact CLI syntax for each operation. **Before executing, apply every ambiguity decision from Stage 3** to the in-memory plan, renames propagate to every `reference_table` and relationship reference in the model. The sequence:

**4a. Module**, If missing, `create_module` with `module_name: "<system_name>"`, `module_slug: "<system_slug>"`, `description: "<system_description>"`, `module_type: "<frontmatter_module_type>"` (defaulting to `"domain"`). If it already exists, `update_module` to refresh `module_name`, `description`, and (if missing) `module_slug` from the model. **Never flip `module_type`** on a re-deploy of a domain module — promotion is the explicit Stage 2d Branch B flow, not an inferred update. Never create a duplicate module with the same `module_slug`. The `alias` field is gone, do not pass it.

**Master-model branch.** When frontmatter `module_type: master`, 4a takes the master-model resolution from Stage 2a (exact-slug match → entity-overlap match → create-new). For the exact-slug-match branch with a slug rename approved by the user, also run the rename cascade in 4b-rename below. For entity-overlap consolidation of multiple sibling masters, the per-source consolidate decisions feed into 4c-merge-master.

**Scaffold pass.** After 4a's module create-or-update, run the standard scaffold (Stage 2a-scaffold steps 2–5): create permissions per tier (idempotent), create the hierarchy chain tagged `origin = "model"` (domain) or `"model_master"` (master), create default roles per tier with stable slugs and `origin` tagged matching the module type, attach `role_permissions`, and populate the six module-record FK / column references. Each step is idempotent on re-run. Surface the three-permission upgrade case as `✨ <slug>:admin / <slug>_admin role` plan lines.

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

**4b. Permissions and hierarchy.** Permission creation itself is owned by the Stage 2a-scaffold pass (run as part of 4a's create-or-update): it iterates the §2 Permissions summary index in table order and creates every missing row, passing the §2 `Description` cell verbatim — baseline tiers (`<slug>:read`, `<slug>:manage`, `<slug>:admin`) and workflow tiers alike. **Do not restate or override those descriptions here.** 4b's responsibility is the **permission hierarchy chain** plus the re-run reconciliation that follows.

Then ensure the **permission hierarchy chain** exists via `create_permission_hierarchy` so higher tiers transitively grant lower ones (see use-semantius `references/rbac.md` § "Set Up Permission Hierarchy"):

- For three-permission models: `parent_permission_id` = `<slug>:admin`, `child_permission_id` = `<slug>:manage`; AND `parent_permission_id` = `<slug>:manage`, `child_permission_id` = `<slug>:read`.
- For two-permission models: `parent_permission_id` = `<slug>:manage`, `child_permission_id` = `<slug>:read`.

`read_permission_hierarchy` first with `parent_permission_id=eq.<parent_id>&child_permission_id=eq.<child_id>` to check whether the row already exists (re-runs are idempotent). Create only missing rows. **Never invert direction** (child including parent breaks RBAC).

**Re-run reconciliation.** When the module already exists with the legacy two-permission baseline but the current model has been upgraded to need three (any §3 entity now carries `**Edit permission:** admin`), the deploy adds the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row additively. Surface this in the Stage 3 plan as `✨ saas_expense_tracker:admin` and `✨ admin → manage` so the user can see the upgrade. Never delete or rename existing permissions or hierarchy rows.

**4b-rename: master-model rename cascade.** When a master-model deploy resolved Stage 2a via exact-slug or entity-overlap match AND the user opted to rename the existing master to the model's `system_slug` (e.g. `vendors` → `vendor_management`), coordinate the cascade. Platform behavior (confirmed):

- `modules.module_slug` rename works on populated modules.
- Permission codes whose names embed the slug (`vendors:read`) do not auto-rename. The deployer explicitly calls `update_permission`.
- Default-role slugs (`vendors_viewer`) do not auto-rename. The deployer explicitly calls `update_role`. (Permitted by `system_role_slug_immutable` v3.0+: only `origin = "system"` slugs are locked; `model` / `model_master` are deployer-rewritable.)
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
- 🟢 Shared-master match (Branch A) → skip `create_entity`. The target is the existing entity in the master module. Field diffs on the master entity are applied additively in 4d as usual. JSON arrays (`computed_fields`, `validation_rules`) are merged with `source_module` tagging per 4e-merge instead of wholesale-replaced. The cross-module wire-up happens in 4i.
- ♻️ Same-module match → skip `create_entity`. If the model's `**Audit log:**`, `**Edit permission:**`-derived `edit_permission`, `singular_label`, `plural_label`, `description`, **`computed_fields`**, or **`validation_rules`** differ from the live entity, call `update_entity` to sync. **Behavior depends on the host module's `module_type`:** for `module_type = "domain"`, `computed_fields` and `validation_rules` are **wholesale replacements** (existing behavior, see 4e); for `module_type = "master"`, they are **merged by `source_module` tag** (see 4e-merge). For `edit_permission` specifically: read the live entity's current `edit_permission` first, and only `update_entity` when the resolved permission name (e.g. `<slug>:admin` vs `<slug>:manage`) differs; surface the change to the user in the Stage 3 plan as a tier flip so they can sanity-check (a tier flip is a real RBAC change). Then fall through to 4d (field diff).
- ✨ New → `create_entity`. Pass `audit_log` from the §3 `**Audit log:**` line (default `false` when the line is missing or says `no`). Pass `view_permission: "<system_slug>:read"` and `edit_permission` derived from the §3 `**Edit permission:**` line: `"<system_slug>:admin"` when the line says `admin`, `"<system_slug>:manage"` otherwise (default, or when the line is absent in a pre-v1.10 file). Pass `computed_fields` and `validation_rules` from the §3 sub-blocks (default `[]` when absent). For a master-module deploy (`module_type: master`), each `computed_fields` / `validation_rules` entry is tagged with `source_module = "<system_slug>"` before send. After creation, correct the `label_column` field title if needed with `update_field`.
- 🛑 Resolved as **merge** → skip `create_entity`. The target is the existing entity in the other module. Record the mapping; the merge is realized in 4d by adding the non-overlapping fields additively to the existing entity.
- 🛑 Resolved as **rename incoming** → `create_entity` using the new name. (Plan-level rewrite of `reference_table` values has already happened before this stage.)
- 🛑 Resolved as **rename existing** → attempt `update_entity` on the existing entity's `table_name` first, before any new creates. If the platform rejects the rename, stop and return to Stage 3, never continue silently. Once the rename succeeds, Semantius repoints every catalog-side `reference_table` automatically; no follow-up `update_field` pass is needed.
- 🛑 Resolved as **rename both** → do the existing-rename first, then `create_entity` for the incoming under its new name.
- 🛑 Resolved as **promote to shared master** (Branch B, option 1 of the four-option widget) → run 4c-promote (below). Plan line `📥 Promoting <entity> → <master>`.
- 🛑 Resolved as **abort** → stop Stage 4 entirely; tell the user to iterate on the model with the analyst skill.

**4c-promote: Branch B promotion.** When the user picked "Promote to shared master module" at Stage 2d-branch-b, the follow-up answers carry the host-module decision (existing master to join OR new master to create) and the manage option (1–4). 4c-promote orchestrates the move:

1. **Ensure the master module exists.** If the user picked "create new master," issue `create_module` with `module_type: "master"` and the chosen slug / name (`<system_name>` defaults to the slug humanized, e.g. `parties` → `Parties`). Then run the scaffold pass (Stage 2a-scaffold steps 2–5) so the master has its three permissions, three default roles, and six module-record references. If the user picked an existing master, capture its id and skip create; if its scaffold has gaps (a master created in a prior tenant lifecycle before scaffolding was standard), the scaffold pass fills them now. Plan line: `🆕 Master module created: <slug>` for new masters, omitted for existing.
2. **Move the entity.** `update_entity` setting `module_id` to the master module's id. The platform repoints every catalog-side FK that references this `table_name` automatically. **Confirmed:** `update_entity` accepts `module_id` change on a populated table; no DDL needed, FKs survive.
3. **Tag JSON arrays with source.** For each entry in the moved entity's `computed_fields` and `validation_rules`, set `source_module = "<original_module_slug>"` so re-runs of either module can merge correctly (see 4e-merge). Done via `update_entity` setting the arrays.
4. **Cross-module wire-up** runs in 4i (every consumer gets its read inclusion, plus manage inclusion per the picked option).
5. **Seed master manager role** runs in 4j (snapshot copy of `<original>_manager` members into `<master>_manager`).

**4c-merge-master: master-vs-master consolidation (Path 2 cleanup).** When a master-model deploy resolved Stage 2a via entity-overlap match AND multiple source masters host the model's declared entities, the per-source consolidate decisions from Stage 2a feed in here. For each source master the user opted to consolidate:

1. **Move each affected entity.** `update_entity` to change `module_id` to the target master.
2. **Re-point consumer cross-module bridges.** For every cross-module `permission_hierarchy` row `(parent, child)` whose child is one of the source master's read/manage permissions (`<source_master>:read` or `<source_master>:manage`) AND whose parent is in a *different* module (i.e. an outside consumer, not the source master's own internal chain), check whether the equivalent target-master bridge already exists. If it does (e.g. the consumer was already wired to the target master via a prior merge or a Branch A wire-up), **leave the source bridge alone** — it now points at the orphan source-master permission, which is harmless because the source master is itself an orphan, and the deployer never deletes catalog rows. If the target bridge does not yet exist, call `update_permission_hierarchy` to set the child to the corresponding target-master permission (the row's id stays the same). Result: the consumer ends up with exactly one live bridge per tier to the target master, and any duplicate source-side bridges are left as inert orphans referencing the orphan source master.
   The source master's **internal** chain rows (`<source_master>:manage → <source_master>:read` tagged `origin = "model_master"`) are also left alone — they point at orphan permissions inside an orphan module, no functional effect.
3. **Leave source masters alone.** The deployer never deletes the now-empty source master, its permissions, its default roles, its `role_permissions`, or its intra-master hierarchy rows. They remain as quiet orphans in the catalog (see "No auto-deletion" rule below). An admin who notices may drop them manually; the verification report does not flag them.

Plan line: `📥 Merging master modules:` block listing each source → target pair. With universal Path-1 lifecycles (every 3.0 model carries reviewed cluster hints, see analyst v3.0), Path 2 should approach zero in practice; this branch exists for the rare misauthored or pre-3.0 case.

**4d. Fields**, For each entity, create missing fields in model order with `create_field`. Skip auto-generated ones (`id`, `label`, `created_at`, `updated_at`, and the `label_column` field). Always include `width: "default"` and `input_type: "default"`. For FK fields whose `reference_table` is a built-in (`users`, `roles`, …) or a merged existing entity, point directly at that `table_name`, the platform doesn't care whose module owns it.

**Computed-field columns are deployed as `input_type: "readonly"`.** Before issuing each `create_field`, check whether its `field_name` appears in the parent entity's `computed_fields[].name` list. If yes, override `input_type` to `"readonly"` instead of `"default"`, regardless of anything else the model says about that field's input_type. The platform silently overwrites caller-supplied values for any column listed in `computed_fields` (see use-semantius `references/data-modeling.md` § "Evaluation semantics" — *"Caller-supplied values for a computed field are silently overwritten"*), so the UI hint must match the semantics — otherwise the auto-generated form lets users type into a field whose value will be clobbered on save. This is a deployer-enforced consistency rule between two model declarations the user has already made consistent in intent; the JsonLogic stays verbatim and the model file is not modified.

For ♻️ same-module matches and 🛑 merges, do not just create the missing fields and stop — walk every model field against its live counterpart and emit `update_field` for each property that has drifted. The diff is essentially free: one `read_field` per entity (filter `table_name=eq.<table>`) already returns every property in a single round-trip, and local comparison is microseconds. Skipping the diff is the reason changed descriptions, title corrections, enum extensions, and same-primitive format adjustments fail to land on re-runs.

For each model field on this entity:

- **Field absent live** → `create_field` as before (auto-generated fields `id`, `label`, `created_at`, `updated_at`, and the entity's `label_column` are still skipped).
- **Field present live** → compute the property delta against the model and emit **one** `update_field` carrying every changed key. Issue one call per drifted field (not one per property) so the audit log records a coherent change set per column. Properties to compare:
  - `title`, `description` — sync to model value.
  - `required`, `searchable`, `width`, `input_type` — sync to model value.
  - `format` — sync to the model value and let the platform decide. Same-primitive changes are accepted by Semantius (TEXT family: `text`/`multiline`/`html`/`json`/`email`; numeric: `integer`/`number`; temporal: `date`/`datetime`). Cross-primitive changes return a primitive-change error — quote the error back verbatim and route the user to the analyst skill for a model-level rethink. The deployer doesn't keep its own primitive taxonomy; Semantius is authoritative.
  - `enum_values` — only sync **additive** extensions (model values the live row doesn't have). Removals (live values the model omits) are unsafe — existing rows may carry the removed value and the constraint tightening will fail at write time. Removals are caught in Stage 2 and surfaced as a 🛑 in Stage 3, never silently applied here.
  - `reference_table`, `reference_delete_mode`, `relationship_label`, `is_unique` (FK metadata) — sync to model value.

The readonly rule from Stage 4d's create path also applies on re-runs: for every existing field whose name appears in `computed_fields[].name`, if its live `input_type` is anything other than `"readonly"`, include `input_type: "readonly"` in the same `update_field` call. This catches both newly-introduced computed fields (the column existed first, then the model added it to `computed_fields`) and corrections to live data where someone manually toggled input_type away from readonly.

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

**4f. Apply read-side rules (select_rule, input_type_rule).** Analyst v2.2+. Read-side rules sit one layer up from write-side rules: `select_rule` filters per-row visibility (an entity-level RLS policy), and `input_type_rule` overrides each field's UI mode per-record at form render. Same prerequisite as 4e — every field referenced inside either rule's JsonLogic must already exist — so 4f runs **after** 4d (field diff) and **after** 4e (write-side rules) so error messages stay attributable to the right rule type.

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
`https://tests.semantius.app/<module_slug>/<table_name>` (URLs use the lowercase `module_slug`, never the display `module_name`).

**4h. Cross-model link suggestions.** After all in-module creates and built-in extensions are done, walk the Proposed list from Stage 3 and execute each confirmed row as an additive `create_field` call.

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
`https://tests.semantius.app/<from_module_slug>/<from_table>` (URL uses the source module's lowercase `module_slug`).

**Skip silently** for any Stage-3 confirmed proposal the platform rejects (e.g. the resolved target was renamed between Stage 2g inspection and 4h write). Surface the failure in the verification summary; do not retry. Skipped, ambiguous-and-skipped, dormant, and resolved-but-declined rows are listed in the verification summary so the user can see how many §6 hints landed and how many parked.

**Stale rows in the model.** §6 rows whose target is dormant today may resolve on a later deploy of any model. The user can refresh by re-running this skill against any model whose §6 references the newly-arrived target; nothing is persisted on module metadata, so the redeploy is the trigger.

**4i. Cross-module permission inclusions.** After in-module hierarchy is set up (4b), and after any master-promotion entity moves (4c-promote, 4c-merge-master), wire up the cross-module `permission_hierarchy` rows that bridge consumers to masters. The shape:

- **Read inclusion (always).** For every consumer module of a master entity: a row with `parent_permission_id = <consumer>:read.id`, `child_permission_id = <master>:read.id`, `origin = "model_master"`. Created at Branch B promotion (for both `<original>` and `<incoming>`) and at every Branch A wire-up (one per new consumer). Without this row, consumers can't see the shared entity through their own module's read permission.
- **Manage inclusion (conditional, per consumer).** A row with `parent_permission_id = <consumer>:manage.id`, `child_permission_id = <master>:manage.id`, `origin = "model_master"`. Created only when this consumer's manage answer (Stage 2d-branch-a binary prompt, or Stage 2d-branch-b option 2/3/4) opts the consumer into write access via hierarchy rather than role membership. Branch A never modifies prior consumers' inclusions — each consumer's decision is recorded independently.

Idempotency: `read_permission_hierarchy` filtered by `(parent_permission_id, child_permission_id)` first; create only on exit 1. Rows tagged `origin = "user"` are never touched (admin's manual additions are sovereign). Rows tagged `origin = "model_master"` may be updated by the deployer (parent / child FK adjustments during master-rename via 4b-rename or master-merge via 4c-merge-master) but **never deleted by the deployer** (see "No auto-deletion" below).

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

**No auto-deletion of catalog records (load-bearing safety rule).** The deployer never deletes roles, permissions, `role_permissions`, `permission_hierarchy` rows, or modules, regardless of `origin`. This is symmetric across every catalog-record kind the deployer can write. Even `model_master` rows the deployer wrote in a previous run are off-limits for deletion in subsequent runs. The only legal mutation on them is FK adjustment (parent / child ids) during master operations.

Specifically:
- **Master-merge** (4c-merge-master): leaves source masters and their unused permissions, default roles, `role_permissions`, and intra-master hierarchy rows in place as quiet orphans. The deployer does not actively detect or report these as orphans either.
- **Master-rename** (4b-rename): updates slugs and names; no deletions, no orphans (rename is in-place updates).
- **Any reduction in the model file** (entity removed, permission removed, role removed): treated as a no-op against the live catalog. The model file shrinking is not a signal to delete; it might be a typo, a refactor in progress, or the author thinking the entity is now obsolete but other consumers still depend on it.

The deployer does not maintain an orphan registry, does not detect orphans in re-runs, and does not surface orphan candidates in the verification report. The rule is a safety boundary against accidentally destroying admin work, not a feature for catalog hygiene.

---

## Stage 5: Verify

After all creates are done, emit a **structured verification report** with explicit counts and FK consistency checks, not a single ✓. The report groups facts by category so any drift between intended and actual deploy is visible at a glance.

### Per-area checks

1. **Module scaffold integrity (every module touched).**
   - `module.view_permission` (text) equals `<slug>:read` and resolves to a live permission with that `permission_name`.
   - `module.manage_permission_id` resolves to `<slug>:manage`.
   - `module.admin_permission_id` is null OR resolves to `<slug>:admin`.
   - `module.default_viewer_role_id` resolves to a role with `origin ∈ {"model", "model_master"}` matching the module's type, slug `<slug>_viewer`, carrying exactly `<slug>:read`.
   - Same for manager and admin roles.
   - If any FK is null where the model expected a value, surface as 🛑.

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
   - `read_field` per entity, confirm field count matches the model (minus auto-generated).
   - Spot-check that `reference_table` targets exist for FK fields (including any that point at built-ins like `users`).

5a. **Text-fidelity round-trip (every entity and every field this deploy touched).** For each entity, compare live `description`, `singular_label`, `plural_label` against the parsed model values **byte-for-byte**. For each field declared in the model, compare live `description` and `title` against the model byte-for-byte. Any mismatch is a Stage 5 defect — surface the entity / field, quote both strings with their byte counts, and recommend re-issuing the offending `create_*` / `update_*` with the model-sourced text. Catches every failure mode the "Data fidelity" section enumerates: truncation (live byte-count shorter than model), normalization (live missing backticks / apostrophes / Unicode the model carried), and empty-string-clobber on `update_field` (live empty where model is non-empty). Equivalent round-trip applies to permission `description` against the §2 Permissions summary `Description` cell. The check is cheap (every relevant column is already in the `read_entity` / `read_field` / `read_permission` response from earlier verification steps) and is the single load-bearing assertion that catches data-mutation regressions before the user does.

6. **Read-side rules round-trip**: for every entity whose model carried a `Select rule` block, `read_entity` and confirm the live `select_rule` equals the model's parsed object. For every field whose model carried an `Input type rules` entry, `read_field` and confirm the live `input_type_rule` equals the entry's `jsonlogic`. A round-trip mismatch is a Stage 5 defect — quote the diff to the user and offer a retry of the offending `update_*` call. The platform's constraint checks usually surface the failure at Stage 4f instead, so a Stage 5 catch here is rare; when it does fire, it's almost always a transient/concurrency issue worth a single retry before escalating.

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

**Compact summary line** (still emitted, for backwards-compatibility with existing logs): *"✅ Done. Created 1 module, 3 permissions, 2 hierarchy rows, 5 entities (2 admin-tier, 3 operational), 47 fields. Reused built-ins: users. Additive fields on built-ins: 2. Applied 2 `select_rule`(s) and 7 `input_type_rule`(s)."*

When the model is on the two-permission fallback (no admin-tier entities), the summary reads "2 permissions, 1 hierarchy row, N entities (all operational)". The admin-tier breakdown is omitted when there are no admin-tier entities. The read-side-rule counts are omitted when both totals are zero (the common case for models that don't use the v2.2 read-side surfaces).

**Read-visibility callout (mandatory when any `select_rule` was created or modified).** Any Stage 4f write that created, changed, or removed an entity's `select_rule` deserves its own one-line callout in the verification summary, separate from the bulk counts: *"⚠️ Applied `select_rule` on `<table_name>` — callers will now see only rows where `<short-description-of-rule>`. Confirm rollout is the intent."* This mirrors how `edit_permission` tier flips get their own callout (a real RBAC change); read-visibility changes have the same "user noticing 'why can't I see X anymore'" failure mode and benefit from being named in the summary the user reads.

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

The final assistant message of a deployment session is a **call-to-action**, not a recap. It must contain exactly three things, in this order, and nothing else:

1. One status line: `The <System Name> model is live in Semantius ✅`
2. **Open in UI:** `https://tests.semantius.app/<module_slug>`, module landing page, on its own line, prominent (use a markdown link so it's clickable, e.g. `[Open <System Name> in Semantius →](https://tests.semantius.app/<module_slug>)`). The URL path is the lowercase `module_slug` (e.g. `crm`); the link text uses the human display `system_name` (e.g. `CRM`).
3. The Stage 6 sample-data offer.

Everything else, what was created, what was skipped, why built-ins were reused, counts, per-entity links, caveats, justifications, belongs in the Stage 5 verification summary **before** this closing block, separated by a horizontal rule (`---`). Do not mix the two. The closing must not contain reasoning, parentheticals, or "by the way" notes; those dilute the call to action.

This block is **sticky**: if a follow-up turn (audit, "did I miss anything?", fix-up, clarification) interrupts before the user has answered the sample-data question, **re-emit the same three lines at the end of the follow-up reply**. Treat them as a footer that re-attaches itself until the user accepts sample data, declines it, or explicitly closes the session ("we're done", "thanks, that's all"). Before sending any assistant message that comes after Stage 4 writes have started, scan the draft: if it does not contain both the module landing-page link and the sample-data question, append the closing block.

---

## Stage 6: Sample Data

After verification, the closing message asks:

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](https://tests.semantius.app/<module_slug>)
>
> Would you like me to generate 10 realistic sample records for each newly-created entity?

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
- If the model has a `status` / `is_active` / similar field on users, seed to an inactive/test value so the rows can't be mistaken for real accounts.
- Never assign roles to sample users (no `user_roles` inserts, that's the absolute-never bucket below).
- Surface the override in the final summary: *"Created N sample users per your explicit request, none of them can log in."*

**Other built-in tables stay absolute, no override.** `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`. These control RBAC, integrations, and the platform's own schema; seeding fake rows corrupts real users' access and the platform itself. Decline every request, even confirmed ones.

### FK fields that point at ineligible tables

A new entity often has FKs to built-ins or existing entities (e.g. `subscriptions.business_owner_id → users`, `subscriptions.primary_department_id → departments` when `departments` is pre-existing). For those fields:

- **Read existing records** from the target table (e.g. `GET /users?select=id&limit=20`) and **pick real IDs at random** to use as FK values.
- Never insert synthetic target records to satisfy the FK. If the target table has zero rows and seeding would require inventing one, skip the FK (leave it null if nullable) or skip the sample record entirely.
- For FKs into **other newly-created entities** in the same run, capture the inserted IDs from those earlier POSTs (see script pattern below) and reference them normally.

Create records in dependency order (entities with no parent FKs first, junction tables last, the model §4 order is usually correct), restricted to the eligible set defined above.

**Generate a single shell script** for all sample data rather than making individual CLI calls. This avoids context bloat from dozens of sequential tool invocations. Write the script to a tempfile path (`$(mktemp -t deploy-XXXXXX.sh)` on Unix / Git Bash, `Join-Path $env:TEMP "deploy-$(Get-Random).sh"` on PowerShell), run it once, check the output, and delete it. **Never write generated scripts into the skill folder or the working directory.** They are ephemeral one-shots, persisting them across runs accumulates as catalog drift, mixes throw-away artifacts with skill source, and survives session boundaries. See the "Generated artifacts" section above for the full rule.

The script should consist of sequential `semantius call crud postgrestRequest` calls, one per record, capturing inserted IDs directly from the POST response for use in FK fields.

### postgrestRequest response envelope

`postgrestRequest` always wraps its result in `{"request":{...},"response":{"status":201,"data":[{...}]}}`. The inserted record is at `response.data[0]`, **not** at the top level. Always use this extractor:

```bash
# Correct — navigate the envelope
ID=$(semantius call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")

# WRONG — treats response as a bare array, always fails with KeyError
ID=$(... | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
```

The same envelope applies to GET, use `d['response']['data']` to access the array:

```bash
COUNT=$(semantius call crud postgrestRequest '{"method":"GET","path":"/campaigns?select=id"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['response']['data']))")
```

### Script pattern

```bash
#!/usr/bin/env bash
set -e

PG='semantius call crud postgrestRequest'

echo "=== Seeding campaigns ==="
C_SPRING=$($PG '{"method":"POST","path":"/campaigns","body":{"campaign_name":"Spring Launch","status":"active"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")
C_FALL=$($PG '{"method":"POST","path":"/campaigns","body":{"campaign_name":"Fall Promo","status":"draft"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['data'][0]['id'])")
echo "  spring=$C_SPRING fall=$C_FALL"

echo "=== Seeding leads ==="
# Use captured IDs for FK fields — never assume sequential IDs
$PG "{\"method\":\"POST\",\"path\":\"/leads\",\"body\":{\"lead_name\":\"Jane Smith\",\"campaign_id\":$C_SPRING}}" > /dev/null
# ... etc ...
```

**Important for FK fields:** Capture IDs directly from each POST response, do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?campaign_name=eq.Spring Launch`) require URL encoding; capturing from the POST response avoids this entirely.

**Enum safety, read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not, using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**String safety, ASCII only in seed data:** Do not use Unicode punctuation (em dash `—`, smart quotes `""`/`''`, ellipsis `…`) in seed strings. These characters break bash argument parsing when the script is executed. Use plain ASCII alternatives: `-` instead of `—`, `"` instead of `""`, etc.

Generate realistic data:
- Real-sounding names and emails (not "Test User 1")
- Enums: cycle through all valid model §5 values for that specific field so every value appears at least once
- Dates: realistic mix of past and future
- Numbers: plausible domain ranges
- Booleans: realistic mix

Run the complete script in one bash call and report the final output summary.

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
| Field is referenced by `computed_fields[].name` but its `input_type` is not `readonly` (either on create or on a re-run) | ✅ Low | Auto-set `input_type: "readonly"` — on create via the `create_field` payload (Stage 4d), on re-run via `update_field`. The column is semantically read-only: every caller value is clobbered by the compute pass at trigger time, so the UI hint is just being aligned with platform behavior. The model and its JsonLogic are not modified. |
| Model carries `validation_rules` with a duplicate `code` within the entity | 🛑 High | Reject at parse time. Send the user back to the analyst skill to fix; the deployer will not silently rename. |
| Model declares `computed_fields` / `validation_rules` on a Semantius built-in (`users`, `roles`, …) | 🛑 High | Refuse. Built-ins run platform logic; model-driven rules would conflict. The model is buggy, escalate to the analyst skill. |
| Model's `validation_rules` JsonLogic invokes `{"require_permission": "<code>"}` for a `<code>` that is not a row in the §2 Permissions summary table | 🛑 High | Reject at parse time, before any write. The platform will throw at rule-evaluation time on every write that hits the gate because the permission doesn't exist; that's a runtime failure mode the analyst's audit should have caught. Surface the offending rule's entity + `code` and the missing permission to the user, ask them to re-run the analyst skill's audit on the file. Do not call `create_permission` ad hoc, an undeclared permission usually signals the model is missing the matching hierarchy row and entity-tier wiring too. |
| Model declares a workflow row in the §2 Permissions summary (e.g. `<slug>:approve_<noun>`) that no `validation_rules` JsonLogic invokes via `require_permission` | ⚠️ Medium | Surface to the user as an "orphan workflow permission" finding in Stage 3 plan. The deployer can still create the permission (it does no harm), but the model is likely buggy, either a `require_permission` call was dropped or the permission was declared speculatively. Ask the user whether to create it anyway or send the file back to the analyst. |
| Live module has workflow permissions (`<slug>:approve_<noun>` etc.) that the model's §2 Permissions summary no longer lists | ✅ Low | **No-op per the no-auto-deletion rule (Stage 4 / plan §7.5a).** The deployer never deletes permissions of any origin, even ones it created itself in a previous run, even on user confirmation. A live permission absent from the current model is treated as a deliberate keep — the model file shrinking is not a signal to delete. If the user genuinely wants the permission removed, that's a manual SQL operation through the §10.3 platform escape hatch, out of band of any deploy. Surface in Stage 3 plan as a 🟡 note ("`<slug>:approve_foo` is live but no longer declared in the model — left in place") so the user is aware, but never propose a delete. |
| Model's §2 Permissions summary table has a `Type: workflow` (elevated) row whose `Hierarchy parent` cell is `<slug>:manage` (rolling an elevated workflow permission up under the baseline manage tier) | 🛑 High | Reject before any write. This row auto-grants every `<slug>:manage` holder the gated authority, defeating the conditional `require_permission` check the workflow permission was created for. The analyst's audit should have caught this. Surface the offending row to the user and route back to the analyst skill; the fix is either to change the `Hierarchy parent` to `<slug>:admin` (promoting the model to three-permission baseline if needed) or to set it to `—` so the workflow permission is granted directly. |
| Model's §2 Permissions summary table has a `Type: workflow-narrow` row whose `Hierarchy parent` cell is `—` or is `<slug>:admin` in a model where `admin` does not transitively include `manage`) | 🛑 High | Reject before any write. The narrow tier's intent is that holders of `<slug>:manage` transitively pass the narrow check; a rollup that excludes `manage` from the chain inverts that intent. Surface the offending row and route back to the analyst skill; the fix is to set `Hierarchy parent` to `<slug>:manage` (the default) or to ensure the baseline chain includes `manage → admin`. |
| Model carries `**Edit permission:** <narrow_suffix>` but the §2 Permissions summary has no `Type: workflow-narrow` row for `<slug>:<narrow_suffix>`) | 🛑 High | Reject before any write — the entity binds to an undeclared narrow tier. Surface the offending entity and route back to the analyst skill to declare the row, or change the annotation back to `manage`/`admin`. |
| Live entity's `edit_permission` is `<slug>:<narrow_suffix>` but model annotates it as `manage` (or vice versa)) | ⚠️ Medium | Surface as a tier flip in Stage 3 plan, same posture as the `manage ↔ admin` flip — this is a real RBAC change (different population of users gains or loses write access on this entity). `update_entity` only after explicit user confirmation. |
| Model's §2 Permissions summary table is missing entirely (file is v1.x or analyst v2.0 skipped the section) | 🛑 High | Reject at Stage 1. v2.0 files require the section; v1.x files are a major-mismatch. Route the user back to analyst Mode D Rebuild to materialize the v2 file from the existing content. Do not attempt to synthesize the table from §8 step 1 and per-entity `Edit permission:` annotations, the v2 contract requires the analyst to produce the table as a deliberate authoring step, not a deployer-side inference. |
| Model carries `**Edit permission:** admin` annotations but the live module is on the legacy two-permission baseline (only `<slug>:read` and `<slug>:manage`) | ✅ Low | Additive upgrade. Stage 4b creates the missing `<slug>:admin` permission and the missing `admin → manage` hierarchy row; Stage 4c sets `edit_permission` on the admin-tier entities. Surface in Stage 3 plan as `✨` rows so the user can confirm. |
| Model carries no `**Edit permission:**` annotations (pre-v1.10 file) but the live module has all three permissions and admin-tier entities | ✅ Low | Leave alone. Older analyst minors didn't author tier annotations; do not flip live entities' `edit_permission` from `<slug>:admin` back to `<slug>:manage` based on the absence of an annotation. To sync, the user runs the analyst's Mode B audit first (which proposes annotations + the three-permission §8 step 1) and redeploys against the updated file. |
| Live entity's `edit_permission` is `<slug>:admin` but model annotates it as `manage` (or vice versa) | ⚠️ Medium | Surface as a tier flip in Stage 3 plan. `update_entity` only after explicit user confirmation, this is a real RBAC change; everyone with the old tier loses or gains edit access on that entity. Do not silently switch. |
| Re-run on a module whose live hierarchy has the inclusion direction inverted (e.g. `read includes manage`) | 🛑 High | Stop. An inverted row breaks RBAC; the deployer never authored this. Surface to the user and ask whether to delete the inverted row and recreate it the right way around. Never `update` a hierarchy row silently. |
| Model-side `select_rule` differs from live entity (♻️ same-module match)) | ⚠️ Medium | `update_entity` with the model's object verbatim. The platform regenerates the `FOR SELECT` RLS policy function; existing reads are filtered from the next query onward. **Always warn the user before applying a `select_rule` create or modification** — rows that callers used to see disappear (medium-risk visibility change). The Stage 5 verification summary names the entity so the change is visible alongside permission flips. |
| Model omits `Select rule` heading but live entity carries a non-empty `select_rule`) | ⚠️ Medium | Ambiguous: the analyst might mean "leave as-is" or "I dropped it". Do not silently clear. Surface the live rule to the user and ask whether to keep it (the optimizer would round-trip an existing rule, so absence after a round-trip means deliberate removal) or pass `{}` to drop the RLS policy. Removing widens visibility (every row becomes visible to anyone with `view_permission`); confirm before applying. |
| Model carries `Select rule` JsonLogic referencing a column that does not exist on the entity) | 🛑 High | Reject at parse time. `select_rule` runs per-row inside the platform's RLS policy and can only reference columns on this entity; cross-row lookups and FK traversal are out of scope and the platform would throw at evaluation time. Surface the offending column name and the entity to the user, send back to the analyst skill. |
| Model's `Select rule` sub-block `description` (or any §3 prose about that entity's visibility) names a permission code as a "bypass" / "elevated" / "override" / "see every row" path BUT the JsonLogic body does NOT reference that permission) critical defect) | 🛑 High | Reject at parse time. This is the canonical v2.2 defect: the prose promises a bypass the platform cannot honor (there is no documented permission-check operator in the SELECT context, and the JsonLogic is the only thing the platform evaluates per row). Deploying the rule would ship dangerous-looking but broken RBAC — the prose says one thing, the per-row filter does another, and access decisions land based on the rule, not the prose. The analyst skill's Stage 12.5 audit should have caught this. Surface the offending entity, the prose claim, and the JsonLogic body to the user, and route back to the analyst's Mode B audit to resolve (either delete the prose claim, or convert it to an explicit §7 architectural-decision entry naming a documented broadening mechanism — separate cube view, Postgres `BYPASSRLS` role attribute, etc.). |
| Model declares `select_rule` on a Semantius built-in (`users`, `roles`, …)) | 🛑 High | Refuse. Built-ins have their own platform-level visibility rules; a model-driven `select_rule` would conflict. The model is buggy, escalate to the analyst skill. |
| Model-side `input_type_rule` for a field differs from live (♻️ same-module match)) | ✅ Low | `update_field` with the model's object verbatim. Pure UI override, no data impact; the platform's per-render fallback covers malformed returns. Stage 5 lists the field in the per-entity summary. |
| Model omits the `Input type rules` entry for a field but live field carries a non-empty `input_type_rule`) | ⚠️ Medium | Ambiguous, same posture as the entity-level `Select rule` ambiguity. Do not silently clear. Surface the live rule + the field to the user and ask whether to keep or pass `{}` to remove. |
| Model carries an `Input type rules` entry whose `field` doesn't appear in this entity's §3 field table) | 🛑 High | Reject at parse time. Typo or stale entry; cannot map to a live field. Surface the offending `field` name and the entity, send back to the analyst skill. |
| Model declares `input_type_rule` entries on a Semantius built-in's fields) | 🛑 High | Refuse. Built-in field UI shapes are platform-governed; model-driven overrides would conflict and may not survive platform upgrades. Escalate to the analyst skill. |
