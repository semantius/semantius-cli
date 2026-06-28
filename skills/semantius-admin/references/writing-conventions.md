# Writing conventions (shared across Semantius skills)

*Canonical copy. The `semantius-analyst` SKILL.md keeps a brief bans summary plus the Pre-emit check and Narration restraint verbatim (the brief is a load-bearing in-context token set for its Pre-emit check). Keep the brief, those two rules, and this note in sync when changing any convention.*

## Writing conventions (apply to every output this skill produces)

These rules apply to chat output, spec markdown files, audit reports, and anything else this skill writes for the user to read. They are not optional style preferences; treat violations as authoring bugs to fix before save. They do **not** apply to data passing through to Semantius — model text (entity descriptions, field descriptions, JsonLogic, enum values) is the user's data and travels byte-for-byte.

**1. US English spellings, always.** Never British English. Concrete examples: optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), customize (not `customise`), recognize (not `recognise`), labeled (not `labelled`), materialize (not `materialise`), organization (not `organisation`), summarize (not `summarise`), categorize (not `categorise`), normalize (not `normalise`), analyze (not `analyse`). When in doubt, pick `-ize` / `-or` / `-er`.

**2. No em-dashes (`—`, U+2014) in chat output or files.** Replace with: `X — Y` parenthetical → `X (Y)` or `X, Y`; `X — but Y` contrast → `X. But Y.`; `A — B — C` triplet → split into two sentences. En-dash (`–`) and hyphen (`-`) are fine in number ranges and compound words; the ban is on `—` as punctuation. Scan every file before save and convert each instance.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?"; "Sounds right?" not "Sound right?"; "Make sense?" not "Makes sense?". Use the form that agrees with the singular implicit subject.

**4. Semantius entity-label symmetry.** When proposing or auditing `singular_label` / `plural_label`: `singular_label` is the bare singular noun matching `plural_label`. ✅ `Product` / `Products`. ❌ `Product Name` / `Products` (asymmetric, bug). Field-level titles like "Product Name" belong on the auto-created `label` field's `title`, not on the entity's `singular_label`.

**5. No historic / decision-log prose anywhere in a written spec.** The spec is a status-quo snapshot, not a changelog. Git tracks the spec's evolution; the file describes what to deploy *today*. The §1 Overview, the §8.1 Permissions catalog `description` column, every entity's §3 prose, every §3 field Description cell, every JsonLogic `description` field, §6 prose annotations, and §7 questions — all bans the same historic prose. Banned phrases (case-insensitive, flag verbatim and paraphrases): *"restore the v2.0 behavior"*, *"the previous version"*, *"used to"*, *"previously"*, *"no longer"*, *"formerly"*, *"originally"*, *"historically"*, *"degrade to"*, *"fall back to"*, *"authoritative on writes but not on reads"*, *"this used to include"*, *"X was folded into Y"*, *"see §X for the platform-level mechanism that would restore"*. Present-tense statements of current behavior, forward-looking §7 questions, and domain narrative about how the modeled records behave are allowed. If you find yourself writing how the spec *used to be shaped*, rewrite for the current shape or delete the sentence.

**6. No identifier leakage in user-facing prose.** No backticks around any identifier or value in user-facing prose (entity `singular_label`/`plural_label`/`Description`; field `Label`/`Description`; permission `Description`; the `description` keys inside `Computed fields` / `Validation rules` / `Input type rules` / `Select rule`; §6 prose annotations; §7 question bodies). No `table_name` references to other entities — use the **Singular Label** or **Plural Label** (or plain English, lowercased: *"a feature"* / *"the features"*). No `field_name` references — use the **Label**. No raw permission codes (`<slug>:approve_offer`) — describe the action in English (*"approve offers"*). Narrow exceptions: enum values quoted in inline `code` style **inside the §3 field-row Description cell** to mark them as data (*"Null until Match Status reaches `auto_matched` or `manual_matched`"*); enum values inside the §3 field-row **Reference / Notes cell** as part of the `enum_values:` annotation (`` enum_values: `a`, `b`, `c` ``); external identifiers and value examples (`6420-SAAS`, `Q2 2026`).

**7. No DDL anywhere in the spec file.** The spec is platform-agnostic; raw DDL (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `DROP`, `REFERENCES`, `ON DELETE CASCADE` as SQL) MUST NOT appear in any prose surface, any sub-block `description`, or any §7 / §8 entry. The deployer reads structured cells (format, reference table, delete mode, JsonLogic) and never executes DDL the analyst writes; a DDL string in the file is dead weight that misleads humans. When the underlying need is real but the platform doesn't currently model it (multi-column uniqueness, partial indexes, custom constraints, triggers), the entry belongs in §7.2 Future considerations as a forward-looking question, not as a DDL fragment. Pre-save: DDL scan blocks save.

**8. Plain language in every user-facing surface.** Anything the user reads — `AskUserQuestion` widgets (question, header, option labels, option descriptions), chat status updates, progress narration, plan summaries, peek-and-verify reports, close-out messages — is written for someone who has never opened a spec file and doesn't know the blueprint vocabulary. The user is a domain expert (HR director, ATS administrator, operations lead), not a data modeler.

This convention covers **two surfaces** equally:

- **Surface A: `AskUserQuestion` fields** — question, header, option labels, option descriptions.
- **Surface B: every other thing the user sees in chat** — status updates ("Let me read the existing entities..."), progress reports ("Skill Profiles already exists in another module..."), plan summaries, the closing message after a write.

Both surfaces follow the same ban list and the same "required" list below.

**Banned in any user-facing surface:**

- Section references: `§7.1`, `§3`, `§5/§6`, `§6.4`, "section N", "the spec's §...". Describe what the section *is* instead — *"the entities catalog"* (not §3), *"the open questions list"* (not §7), *"the cross-domain section"* (not §6).
- Reconciliation annotation values as words: `reuse-from`, `rename-incoming-from`, `promote-to-master`, `dropped`, `create-new`. Phrases like "annotate as reuse-from", "flag in §7.1".
- File-format / pipeline terms: `spec`, `blueprint`, `frontmatter`, `manifest`, `annotation`, `reconciliation`, `reconcile`, `the spec will own`, `the analyst will`, `the modeler will deploy`. Where naming the artifact is unavoidable in a status message, use plain English ("the file" / "this design" / "the design document"). *"Reconciliation"* in particular is the internal name for what this skill *does* — never narrate it back to the user using that word; say *"check against what's deployed"* / *"figure out what to reuse"* / *"set up"* / *"deploy"* instead.
- Architectural jargon: `gatekeeper`, `data silo`, `silo`, `embedded master`, `consumer role`, `contributor role`, `mastered_in`, `master cluster`, `module_type`, `classDef`, `platform_builtin` (the diagram class).
- Raw identifiers when a display name exists: `skill_profiles` when the blueprint carries `singular_label: "Skill Profile"`, `lms-skills` when the catalog knows the module's display name as "LMS Skills". Backticked snake_case tokens are a leak even in status messages.

**Required in any user-facing surface:**

- Entity Singular / Plural Labels from the blueprint (`Skill Profile`, `Skill Profiles`, `Candidates`). Never the raw `table_name`.
- Module display names if knowable (`LMS Skills`, `Talent & Succession`); fall back to the bare slug in plain prose only when no display name is available.
- Plain verbs: *use*, *share*, *copy*, *skip*, *wait for*, *connect to*, *keep our own*, *create here*.
- Plain consequences: *records can't be combined in reports*, *you'll have two separate copies*, *this module won't deploy until that other one is in place*, *we'll create a duplicate*.

The internal annotation value (`reuse-from <X>.<Y>`, `promote-to-master <host>.<entity>`, etc.) still gets stamped on the spec file by Stage 11 — only chat and prompt text are plain. Map a user's choice to an annotation *after* they pick, not in the option label.

**Translation table for common terms:**

| Internal | User-facing |
|---|---|
| `reuse-from <module>.<entity>` | "Use the existing <Plural Label> from <Module Display Name>" |
| `rename-incoming-from <X> as <Y>` | "Keep our own separate <Plural Label> (called <Y>)" |
| `promote-to-master <host>.<entity>` | "Share one copy of <Plural Label> across both modules" |
| `dropped (optional, user declined)` | "Skip <Plural Label>" |
| "flag a §7.1 🔴 blocker" | "this module won't deploy until <Module Display Name> is in place" |
| "data silo" | "duplicate records that can't be combined in reports" |
| "gatekeeper" | "<Module Display Name>'s owners need to approve future shape changes" |
| "the catalog" / "the live catalog" | "your semantic model" / "your live semantic model" |
| "master / consumer / contributor / embedded role" | (translate per case; usually doesn't need naming) |

**Pre-emit check** (mandatory): before sending any chat message or firing any `AskUserQuestion`, scan the assembled text for any banned token. Rewrite before sending.

**Narration restraint.** Plain language is necessary but not sufficient. Volume matters too. The user did not ask for a narrated walkthrough of the skill's internal work; they asked for a reconciled spec. Hard rules:

- **Do not announce what you're about to do** before doing it. No *"Let me load the use-semantius reference..."*, no *"Let me classify each entity..."*, no *"Let me check this against the live catalog..."*. Just do the work; the tool-call lines in the transcript are enough.
- **Do not narrate self-corrections** mid-flight; fix them silently.
- **The verification phase is one plain-language line, not a blow-by-blow.** The pre-save checks (the consistency gate, the banned-token / spelling / em-dash scans, the rule-block validation) are internal mechanics. Narrate the whole phase as **at most one** business-language status line (e.g. *"Double-checking the design holds together before saving..."*), then go quiet. Never a per-check trail, never an enumerated pass count on success (*"9 of 9 rule blocks valid, every entity and label agrees"* is banned, that is a result only a data modeler reads), and never the machinery by name (`consistency check`, `banned-token scan`, `rule blocks`, `prose conventions`, `argv`, the checker's filename). On a real failure, surface in plain language only what the user must decide or fix. (This one consolidated status line is the sole exception to the announce-before rule above; the per-step *"Let me check..."* announcements stay banned.)
- **Do not list per-bucket counts and stage-by-stage progress** after each step. One concise plan summary at Stage 3 (the reconciliation decisions) and one close-out line after writing is plenty.
- **Do not announce the next skill in the pipeline as boilerplate.** A one-clause hint at the close-out is fine; a separate "Next step:" paragraph is not.

A useful test: *"if I deleted this chat message before sending, would the user notice anything was missing?"* If the answer is "no, the work still got done", delete the message.
