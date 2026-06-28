# Stage 3: Customizations consultation protocol

*Reference for `semantius-analyst`. Every Stage 3 widget consults this before firing (the "Policy path:" lines).*

### Customizations consultation (applies to every sub-stage below)

`$CUSTOMIZATIONS_FILE` is already computed at Preflight and set in memory at Stage 2c.5. Each sub-stage below declares a **Policy path** (the yq path into the file). Before firing each `AskUserQuestion`, consult that path:

```bash
# DECISION_PATH = the yq path declared by the sub-stage (e.g. ".collisions.vendors.outcome")
if [ -f "$CUSTOMIZATIONS_FILE" ]; then
  policy_match=$(yq -r "$DECISION_PATH" "$CUSTOMIZATIONS_FILE" 2>/dev/null)
  if [ -n "$policy_match" ] && [ "$policy_match" != "null" ]; then
    CHOICE_VALUE="$policy_match"
    # Narrate exactly one plain-English line, then proceed with $CHOICE_VALUE.
    # "Using your rule for <thing>: <plain-English summary>."
    # Skip AskUserQuestion entirely.
  fi
fi
```

On cache miss (or when the user picks an explicit cancel option), fire the widget. **If the user picked an answer (not cancel), write atomically back to the file BEFORE proceeding with the spec change.** Use the write form matching the row in `../../semantius-admin/references/customizations-protocol.md` 7.4 (scalar via `lineComment`, list via `[-1] lineComment`, nested object via `headComment`):

```bash
DATE=$(date +%Y-%m-%d)
PROV="decided ${DATE} during ${THIS_BLUEPRINT} deploy"
[ -f "$CUSTOMIZATIONS_FILE" ] || printf 'version: "1.0"\n' > "$CUSTOMIZATIONS_FILE"
# Scalar example (4.1):
yq -i "${DECISION_PATH} = \"${CHOICE_VALUE}\" | ${DECISION_PATH} lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"
```

When `$CUSTOMIZATIONS_FILE` is unset (a context that bypassed Preflight, which should not happen in normal use), fall back to firing every widget every time and skip the writes.

**Tool-call description discipline.** The Bash tool requires a `description` field that the harness renders as a header above the tool-call entry in chat ("Ran <description>"). Do NOT leak internal vocabulary there. The user sees this string even when the rest of the consultation is silent.

- ❌ Wrong: `"Record optionals decision in customizations.yaml"`, `"Append cross-module collision choice to .collisions"`, `"yq insert at .naming.mode"`.
- ✅ Right: `"Saving your choice"` (on a write), `"Checking earlier choices"` (on a read), or simply omit by batching the write into a later, single quiet step.

The same rule applies to any other Bash call you fire during Stage 3 (frontmatter peeks, slug lookups, similarity scans): the `description` is user-facing prose, hold it to Convention 8's plain-language bar.

The authoritative reference for the protocol, the full yq-path registry, and provenance-comment patterns is `../../semantius-admin/references/customizations-protocol.md` (overview in `../../semantius-admin/SKILL.md` Step 7).
