# Round-trip conformance eval (semantius-optimizer)

Offline check that the extractor (`../../references/spec-extract-lib.ts`) and the analyst's spec template (`../../../semantius-analyst/references/semantic-spec-template.md`) agree on the emitted surface, and that the extractor's output stays byte-stable.

```bash
bun evals/round-trip/check.ts            # from the semantius-optimizer skill folder; exit 0 = green
bun evals/round-trip/check.ts --update   # regenerate expected-*.md after an intentional extractor change, then review the diff
```

What it asserts:

1. **Goldens.** Every `fixture-*.json` (a JSON snapshot of the live reads: `mod`, `ownedRaw`, `fieldsByTable`, `related`, `perms`, `allHierarchy`, `roles`, `processes`, `relatedModules`; the `LiveData` shape in the extractor) renders via `--from-fixture` byte-identical to its `expected-*.md`.
   - `fixture-basic.json`: an `access_scope: basic` module with a catalog entity, a workflow entity, a junction **without** a label column, a `users` built-in reference, an enum, and a related module version.
   - `fixture-full.json`: an `access_scope: full` module exercising the §8.1 tier heuristic (narrow / override / workflow-gate (rule) / workflow-gate (lifecycle)), the admin hierarchy closure for `included in :admin?`, a Processes catalog, the optional §3 lines (`Order column`, `Key type` (`typeid` with `Key prefix`, and `uuid` without), `Edit mode`, `Cube mode`, `Icon URL`, `Label parent`), and all four §3 JSON sub-blocks.
   - `fixture-family.json`: entity families and enum labels: two `typeid` bases, a `has_a` and an `is_a` entity on them (no label column / label parent lines, `**Based on:**`, the family relationship sentence, dotted §2 edges), a `has_a` entity on a base owned by another module (a `reuse-from crm.organizations` block, and the family edit grant `partners:manage → crm:manage` kept in §9.1 while an unrelated cross-module row is dropped), and an enum with a `{value, label}` entry (Notes values only, a `` - `kam` - Key account `` bullet in §5).
2. **Checker.** Each render passes `consistency-check.ts` (the analyst's pre-save gate / the modeler's pre-deploy gate) and contains no em-dash.
3. **Template lint.** Inside the template's "Skeleton starts below this line" … "Skeleton ends above this line" block: zero em-dashes (U+2014); every `#`/`##`/`###` heading (placeholder prefix stripped) and every table header row the optimizer is expected to emit appears as a literal in `spec-extract-lib.ts`. Table headers the optimizer deliberately never emits (§6 tables, §8.2, the RACI tables, §9.2) are listed in `NOT_EMITTED_BY_OPTIMIZER` inside `check.ts`, so the contract is explicit.

No Semantius instance is needed. The fixtures are hand-built; keep them minimal and add a row only when a new extractor branch needs covering.
