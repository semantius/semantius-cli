# Customizations protocol — yq-path registry, consultation pattern, and what is NOT written

The authoritative detail for how the admin and sub-skills share standing policy across runs. The conceptual frame stays in `semantius-admin/SKILL.md` Step 7: why every answer is policy (7.1), the file location and creation (7.2), and the run-context block (7.3). This file holds the parts the architect and analyst cite by row and rule: the yq-path registry (7.4), the consultation pattern (7.5), and what is NOT written (7.6).

---

## 7.4 Decision-key → yq path registry

Every Stage 3 / authoring-stage widget reads and writes one path in `$CUSTOMIZATIONS_FILE`. This table is the single source of truth — the architect and analyst SKILLs cite specific rows but never invent new paths.

| Source | Decision | yq path | Shape |
|---|---|---|---|
| Analyst (access-control scope) | Basic vs full RBAC, per module | `.access_scopes.<slug>` | scalar (`basic` \| `full`) |
| Architect authoring | Vendor-template choice | `.naming.mode` | scalar |
| Architect authoring | Slug-collision strategy | `.naming.on_slug_collision` | scalar |
| Architect authoring | Module display-name override | `.module_display_names.<slug>` | scalar |
| Architect authoring | Embedded-master rename | `.aliases.<old_slug>` | object (slug, singular_label, plural_label) |
| Analyst Stage 3a | Optional entity verdict | `.optionals_decided.<slug>` | scalar (`included` \| `excluded`) |
| Analyst Stage 3b.0 | Catalog-owner adoption gate | `.adoption_consent` | scalar (`auto-confirm` \| `prompt-each-time`) |
| Analyst Stage 3b.0 | Adoption event record | `.adoptions.<entity>` | scalar (date; audit log) |
| Analyst Stage 3b.1 / 3b.2 | Master-vs-master outcome | `.collisions.<entity>.outcome` | scalar (`share` \| `silo` \| `claim`) |
| Analyst Stage 3b.1 / 3b.2 | Share host module | `.collisions.<entity>.host_module` | scalar (when outcome=share) |
| Analyst Stage 3b.2 | Silo rename target | `.collisions.<entity>.rename_to` | scalar (when outcome=silo) |
| Analyst Stage 3b.2 | Claim new owner module | `.collisions.<entity>.new_owner` | scalar (when outcome=claim) |
| Analyst Stage 3b.2 sub | Shared-master manager scope | `.shared_master_managers` | scalar |
| Analyst Stage 3c | Similar-name → reuse / rename | `.aliases.<incoming_slug>` | object (slug, singular_label, plural_label) |
| Analyst Stage 3d | Missing-owner default | `.on_missing_owner` | scalar (`embed_locally` \| `skip`). Legacy `wait` entries are coerced to `embed_locally` at consult time. |
| Analyst Stage 3d sub | Slug-collision local naming | `.slug_collision_naming` | scalar (`context-prefix` \| `module-prefix` \| `reuse-existing`) |
| Analyst Stage 3e | Cross-scope link target | `.links.<blueprint_slug>.<field_name>` | scalar |
| Analyst Stage 3f.1 | Field-name drift | `.drift.field_name.<entity>.<field>` | scalar |
| Analyst Stage 3f.2 | Enum drift | `.drift.enum.<entity>.<field>` | scalar |
| Analyst Stage 3f.3 | Permission drift | `.drift.permission.<entity>.edit_permission` | scalar |
| Analyst Stage 3f.4 | Format drift | `.drift.format.<entity>.<field>` | scalar |
| Modeler pre-execute | y/n consent | not cached | n/a (always asks per item) |

When extending: prefer fewer, broader keys. The whole point is to deduplicate; over-specific keys defeat that. The cross-scope link path (`.links.<blueprint>.<field>`) is the deliberate exception — link targets often don't generalize across blueprints, so they're keyed by blueprint+field naturally.

## 7.5 Consultation pattern (sub-skill side)

Before any `AskUserQuestion` call site that maps to a row above, the sub-skill consults `$CUSTOMIZATIONS_FILE`. After a cache miss, it writes the answer back atomically with a provenance comment, BEFORE proceeding with the spec / catalog change.

```bash
# Inputs: $CUSTOMIZATIONS_FILE (path), $DECISION_PATH (yq path from 7.4),
#         $BLUEPRINT_SLUG (the current blueprint's system_slug)

# 1. Policy lookup
if [ -f "$CUSTOMIZATIONS_FILE" ]; then
  policy_match=$(yq -r "$DECISION_PATH" "$CUSTOMIZATIONS_FILE" 2>/dev/null)
  if [ -n "$policy_match" ] && [ "$policy_match" != "null" ]; then
    CHOICE_VALUE="$policy_match"
    # Narrate one plain-English line ("Using your rule: ..."), skip AskUserQuestion.
    return
  fi
fi

# 2. Cache miss → fire AskUserQuestion as today. Receive $CHOICE_VALUE.
#    If the user picked an explicit cancel option, return without writing.

# 3. Atomic write-on-answer. Create the file if absent.
mkdir -p "$(dirname "$CUSTOMIZATIONS_FILE")"
[ -f "$CUSTOMIZATIONS_FILE" ] || printf 'version: "1.0"\n' > "$CUSTOMIZATIONS_FILE"

# 4. Write with provenance comment. Shape depends on the row in 7.4:
DATE=$(date +%Y-%m-%d)
PROV="decided ${DATE} during ${BLUEPRINT_SLUG} deploy"

# 4a. Scalar (mastership.host_module, naming.mode, on_missing_owner, ...):
yq -i "${DECISION_PATH} = \"${CHOICE_VALUE}\" | ${DECISION_PATH} lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"

# 4b. List append (none in 7.4 currently, but reserved):
# yq -i ".some_list += [\"${CHOICE_VALUE}\"] | .some_list[-1] lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"

# 4c. Nested object (aliases.<slug>, collisions.<entity>): yq drops lineComment
#     on a mapping, so use headComment — the comment renders ABOVE the first
#     child key. This is yq v4's design, not a bug.
yq -i ".aliases.${OLD_SLUG}.slug = \"${NEW_SLUG}\" \
      | .aliases.${OLD_SLUG}.singular_label = \"${SINGULAR}\" \
      | .aliases.${OLD_SLUG}.plural_label = \"${PLURAL}\" \
      | .aliases.${OLD_SLUG} headComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"
```

**yq footguns** (verified during plan prep — do not work around with creative chaining):

- `lineComment` on a mapping node is silently dropped. Use `headComment` for nested-object entries.
- Chaining `del(... | headComment) | ...lineComment = ...` is destructive (clobbers values). Don't try to migrate a comment from one node to another — write fresh.
- Re-writing the same scalar without a `lineComment` clause preserves the existing trailing comment. So accidental re-writes don't clobber provenance.

**Cache-hit narration:** when policy auto-resolves a decision, narrate exactly one plain-English line:

> *Using your rule for the vendors collision: share via the Parties master module.*

Not a paragraph. Not a section header. One line. The user sees that policy resolved a decision and what it was; they don't need the full rationale repeated.

**Write-on-ask discipline:** the skill that fires the prompt is the skill that writes the policy entry. No admin-side post-processing of `AskUserQuestion` results. Each sub-skill owns its decisions.

**Tool-call description discipline:** the Bash tool `description` field is user-visible. Use plain language ("Saving your choice", "Checking earlier choices"), never internal vocabulary ("Append to customizations.yaml", "yq insert at .collisions").

## 7.6 What is NOT written to the file

- **Modeler's pre-execute `y/n`.** The modeler always asks before writing. Policy does not change this.
- **Free-text "Other" answers** that the user typed in. The slug-collision-naming widget (3d sub) has an "Other" option; when picked, use the value for the current decision but do NOT write to `.slug_collision_naming` — the next collision should re-ask. The user's typed value is a one-off, not a standing rule.
- **Explicit-cancel selections.** Master-vs-master option 4 ("Stop, I want to think about it") and any other cancel-style choice halts the run without writing.
- **Decisions inside the modeler.** The modeler consumes specs only; the spec already carries every decision by the time the modeler runs.
