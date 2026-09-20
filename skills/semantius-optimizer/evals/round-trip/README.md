# Round-trip conformance eval (semantius-optimizer)

Offline check that the extractor (`../../references/spec-extract-lib.ts`) and the analyst's spec template (`../../../semantius-analyst/references/semantic-spec-template.md`) agree on the emitted surface, and that the extractor's output stays byte-stable.

```bash
bun evals/round-trip/check.ts            # from the semantius-optimizer skill folder; exit 0 = green
bun evals/round-trip/check.ts --update   # regenerate expected-*.md after an intentional extractor change, then review the diff
```

What it asserts:

1. **Goldens.** Every `fixture-*.json` (a JSON snapshot of the live reads: `mod`, `ownedRaw`, `fieldsByTable`, `related`, `perms`, `allHierarchy`, `roles`, `processes`, `relatedModules`; the `LiveData` shape in the extractor) renders via `--from-fixture` byte-identical to its `expected-*.md`.
   - `fixture-basic.json`: an `access_scope: basic` module with a catalog entity, a workflow entity, a junction **without** a label column, a `users` built-in reference, an enum, and a related module version.
   - `fixture-full.json`: an `access_scope: full` module exercising the §8.1 tier heuristic (narrow / override / workflow-gate (rule) / workflow-gate (lifecycle)), the admin hierarchy closure for `included in :admin?`, a Processes catalog, the optional §3 lines (`Order column`, `Edit mode`, `Cube mode`, `Icon URL`, `Label parent`), and all four §3 JSON sub-blocks.
2. **Checker.** Each render passes `consistency-check.ts` (the analyst's pre-save gate / the modeler's pre-deploy gate) and contains no em-dash.
3. **Template lint.** Inside the template's "Skeleton starts below this line" … "Skeleton ends above this line" block: zero em-dashes (U+2014); every `#`/`##`/`###` heading (placeholder prefix stripped) and every table header row the optimizer is expected to emit appears as a literal in `spec-extract-lib.ts`. Table headers the optimizer deliberately never emits (§6 tables, §8.2, the RACI tables, §9.2) are listed in `NOT_EMITTED_BY_OPTIMIZER` inside `check.ts`, so the contract is explicit.

No Semantius instance is needed. The fixtures are hand-built; keep them minimal and add a row only when a new extractor branch needs covering.
