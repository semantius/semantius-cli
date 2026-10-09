*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 5: Build the Mermaid entity-relationship diagram

The §2 Entity summary includes a Mermaid **flowchart** that visualises every entity and every relationship in the model. Draft the relationships (the §5 edges) and the diagram from the confirmed entity list; the user confirms them, together with the lifecycles, at the end of this stage:

- Use ```` ```mermaid\nflowchart LR ```` as the opening (top-down `flowchart TB` is fine if the graph is wider than tall, but `LR` is the default).
- **Every** entity in the §2 summary table must appear as a node.
- **Every** §5 edge (§5.1 intra-scope, §5.2 built-in) must appear as an edge with matching cardinality and direction.
- Cardinality convention: **arrows `-->` mean "many"**, **flat connectors `---` mean "one"**. The arrow/connector points from the parent to the related side. So 1:N `accounts → contacts` is `accounts --> contacts` ("an account has many contacts"); 1:1 `users → user_profiles` is `users --- user_profiles` ("a user has one profile").
- For M:N junctions, draw the junction entity explicitly with two `-->` edges in from its parents (e.g. `contacts --> campaign_members` and `campaigns --> campaign_members`). Never draw a direct edge between two parents of an M:N relationship.
- Use the full conventions table in `semantic-blueprint-template.md`.
- **Every edge gets a labeled verb, copied verbatim from the §5 `verb` column** — `A -->|verb| B` or `A ---|verb| B` (e.g. `accounts -->|owns| opportunities`). The verb is **read straight from the §5 `verb` value** for that edge; this stage just renders what's already there. **Never invent a verb that doesn't appear in §5, and never paraphrase, shorten, or "polish" the §5 verb when copying it into the diagram** — `|owns|` stays `|owns|`, not `|has_one_or_more|`. Unlabeled edges mean a missing §5 `verb` and the audit will flag them as 🟡 (or 🔴 if the endpoint names alone are too generic to disambiguate).
- The §2 Mermaid edge label and the §5 `verb` column must agree byte-for-byte. The deployer persists the §5 verb as the FK's `relationship_label`; the optimizer reads it back from live state when it regenerates the model. A diagram label that disagrees with §5 will not survive the round-trip.
- **Visually distinguish shared / external entities.** Two classes of entity belong in green-family styling so a reader sees at a glance which entities are not solely owned by this module:
  - `class <table_name> builtin;` — entities that will be dedup'd against a Semantius platform built-in at deploy time (`users`, `roles`, `permissions`, etc.). The deployer skips `create_entity` for these and reuses the built-in as the FK target.
  - `class <table_name> master;` — entities carrying a `**Shared master cluster:** <cluster>` annotation in §3. Created here by default; the deployer may offer to host them in a shared master module so other domain modules can FK to the same row.

  Define both `classDef` directives near the top of the Mermaid block (immediately after `flowchart LR`) and apply them with explicit `class <table_name> {builtin|master};` lines after the edges. **Always use the `class <table> <class>;` line form — never the inline `<table>:::<class>` shortcut.** Both render identically in Mermaid, but the audit checklist and downstream tooling key off the line form for consistency across model files.

  ```mermaid
  flowchart LR
    classDef builtin fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#1a4d2e;
    classDef master fill:#d4f4dd,stroke:#27ae60,color:#1a4d2e;
    %% … edges …
    class users builtin;
    class vendors master;
    %% all other entities render with default styling
  ```

  Omit each `classDef` and its `class` tags entirely when no entity in the model qualifies (most domain models won't have any built-in dedup targets; many won't have any master-cluster candidates either). Keep `classDef builtin` and `classDef master` exactly as written above so reviewers across model files see consistent shades.

**Build-then-verify procedure (mandatory):**

1. **Build the diagram mechanically.** Walk the §5 edges in order; for each, emit one edge whose label is the literal `verb` value from §5. No paraphrase, no synthesis, no "let me pick a clearer verb."
2. **Self-verify before showing the user.** After the block is drafted, walk every edge in the rendered Mermaid and confirm two things for each:
   - the source/target node names match a real §5 edge whose endpoints resolve to §3 entities (no orphan edges from invented relationships)
   - the edge label, if present, equals the §5 `verb` of that edge byte-for-byte (no hallucinated, paraphrased, or "improved" verbs)
   If any mismatch is found, fix the diagram (or fix the §5 `verb` if the §5 value is the wrong one) and run the check again. Do not show the user a diagram that fails this check.

**Draft the lifecycles here.** For each entity that moves through steps, draft its lifecycle (the states, which one it starts in, which ones end it). Stages 7, 9 and 10 read it, and Stage 13 writes it to §7. An entity without steps (reference data, a plain record) gets none.

**Show the relationships, the diagram and the lifecycles in one message, and confirm.** Required in guided and expert flow. It is its own turn; never combine it with another stage's confirmation. In plain language (Convention 8):

- each relationship, one per line, saying whether it is required and what happens on delete (e.g. *"A product contains many components; deleting a product deletes its components."*);
- the diagram, rendered inline;
- each lifecycle as plain-word steps with one line on why (e.g. *"Release: planned, in progress, released, canceled. Releases follow a fixed path to shipping."*).

End with *"Does this look right?"* and loop on the user's feedback until they confirm. The build-then-verify procedure above is your own check and is not shown. If the user changes entities or relationships later in any stage, regenerate the diagram; never carry forward a stale one.

> **Fast flow, after the go-ahead:** don't show the message and don't ask; accept the relationships and lifecycles as drafted and log one line ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 4).
