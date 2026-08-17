*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 13 — Write the semantic-blueprint file

Use the template at `semantic-blueprint-template.md` for the exact section order, front-matter shape, and rendering conventions. The blueprint must be self-contained: a downstream agent should be able to read it without any prior conversation context.

**Entity order (canonical).** Emit entities everywhere (the §2 table, §2 Mermaid nodes, and the §3 catalog) in the order defined by the template's §2 "Entity order (canonical)" note: `entity_type` tier, then `data_object` A->Z within each tier (`catalog` first, then operational / computed, then `junction`, then platform built-ins last). This is the order the analyst preserves in the spec and `semantius-optimizer` reproduces from live state.

**Finalize the catalog surface (before writing).** Stage 1 deliberately captured only `system_name` and a rough scope line; the catalog-surface frontmatter is settled here, now that the entity list it describes exists:

- **`tagline`** (required) — propose a draft from the Stage 1 scope line, tightened against the final entity list; the user confirms or edits. One marketing-voice line for the catalog card AND the module record's short description (`modules.description`, shown beside the name in the selector) — keep it readable in the selector chip. Example from `hiring-starter`: *"Everything a small team needs to hire, in one lightweight package."*
- **`module_kind`** (required) — propose a derived default from the §3 role composition instead of cold-asking: mostly `master` rows → `master`, mostly `embedded_master` rows → `starter`, otherwise `domain`. The user confirms. Still an informational label, NOT a behavior switch — the analyst and deployer treat it as metadata only; the behavioral rule that handles "starter" shapes is the entity-owning-module rule (see Writing Convention 10), and it fires the same way for every blueprint shape regardless of `module_kind`.
- **The publish question** — ask once: is this blueprint headed for the catalog (published for others to browse), or internal-only?
  - **Publishing** → elicit **`description`** (1–3 paragraphs of buyer-facing marketing prose for the catalog page; the entity list is now available to enumerate, e.g. *"covering the core hiring path (postings, candidates, applications, interviews, and offers)"*) and **`license`** (default `MIT` unless the org has a standing rule; only ask when there's no obvious default).
  - **Internal-only** → **omit both keys entirely.** No empty stubs, no `description: ""`. Downstream skills carry them as null when absent.

**Two source modes, one artifact type.** Both greenfield and catalog-clone files carry `artifact: semantic-blueprint`. The discriminator is `naming_mode`:

| Mode | `naming_mode` in frontmatter | Source |
|---|---|---|
| **Greenfield** | Present (`template:<vendor>` or `agent-optimized`) | Architect built from a direct conversation with the user. Tailored. |
| **Catalog-Clone** | Absent | Sourced from a curated catalog blueprint (the "uber-map" library). Inherits generic structure. |

The presence or absence of `naming_mode` is the canonical signal for downstream skills and audits.

**Frontmatter (required keys), both modes:**

- `artifact: semantic-blueprint` (fixed)
- `blueprint_version: "3.0"`
- `version: "<CURRENT_VERSION>"` (currently `"5.2"`)
- `system_name`, `system_slug`, `icon_name` (icon-set handle, not a URL)
- `tagline` (one-line marketing-voice line; also feeds `modules.description`)
- `domain_modules` (typically `[<system_slug>]`)
- `domain_code` (uppercase TLA, e.g. `ATS`, `HCM`, `CRM`)
- `persona` (auto-populated from §9.1 RACI actors)
- `module_kind` (informational label: `domain` / `master` / `starter` / etc.)
- `created_at` (today, `YYYY-MM-DD`)
- `initial_request` (verbatim Stage 1 opening, YAML literal block, immutable)

**Publish-only frontmatter (both modes; present only when the publish question above was answered "publishing" — otherwise omit both keys entirely):**

- `description` (longer marketing-voice prose for the catalog page; YAML literal block fine)
- `license` (catalog metadata; e.g. `MIT`)

**Mode-specific frontmatter:**

- **Greenfield only**: `naming_mode` (`template:<vendor>` or `agent-optimized`). `related_modules` is now an advisory integration hint and CAN appear in greenfield files when the customer named related neighbors during Stage 6; `departments` / `industries` remain catalog-discovery tags omitted from greenfield.
- **Catalog-Clone only**: `related_modules` (inherited from source; advisory hint, never a prerequisite), `departments` and `industries` (when populated in source). **Do not emit `naming_mode`** — catalog blueprints don't carry it.

**Keep-with-placeholder rule (both modes).** Every canonical top-level / numbered section is **always present**. When a section has no real content, **keep its heading** and write the canonical empty-section placeholder `_(none: <short reason>)_` (lowercase `none`, **colon not em-dash**; bare `_(none)_` allowed when a reason adds nothing). **Apply this rule uniformly**: omitting a canonical section, leaving a bare empty heading, or writing an old-form free-text stub (`_(no cross-scope edges declared in greenfield mode...)_`) is forbidden. The **only** omit-when-empty exception is the §3 per-entity sub-blocks (Computed fields / Validation rules / Input-type rules / Select rule), which are not numbered navigation anchors.

Concrete table of empty-when-trimmed sections (always kept; placeholder when empty):

| Section | Greenfield default | Catalog-Clone default |
|---|---|---|
| §4 Aliases | Keep; `_(none: …)_` placeholder unless the user supplied vendor / industry aliases | Inherit; trim rows the user dropped; keep the heading with `_(none: …)_` if empty after trim |
| §5.3 Cross-scope edges | Keep; `_(none: …)_` placeholder (no cross-scope edges to declare) | Inherit; trim; keep the heading with `_(none: …)_` if empty after trim |
| §6.1 Master consumers | Keep; `_(none: …)_` | Inherit; trim; keep with `_(none: …)_` if empty |
| §6.2 Outbound handoffs | Keep; `_(none: …)_` | Inherit; trim; keep with `_(none: …)_` if empty |
| §6.3 Inbound handoffs | Keep; `_(none: …)_` | Inherit; trim; keep with `_(none: …)_` if empty |
| §6.4 Master providers | Keep; `_(none: …)_` | Inherit; trim; keep with `_(none: …)_` if empty |
| §6 parent heading | Keep; the four sub-blocks each carry `_(none: …)_` when empty | Keep; sub-blocks carry `_(none: …)_` when empty |

**Always-present sections** (structural anchors; require real content — empty is a 🔴 blocker, not a placeholder case): §1 Overview, §2 Entity summary + Mermaid, §3 Entities catalog, §5.1 Intra-scope edges, §7 Lifecycle states (per master), §8.1 Permissions. §5.2 Built-in edges and §8.2 Business rules are **also always present** but keep-with-placeholder: write `_(none: <short reason>)_` when §5.2 has no built-in `users` / `roles` edges or §8.2 has no flag-derived rules.

**No old-form stub strings.** Phrases like `_(no cross-scope edges declared in greenfield mode...)_`, `_(no cross-domain context...)_`, `_(no industry-scoped aliases...)_` MUST NOT appear — they are replaced by the canonical `_(none: <short reason>)_` placeholder, never by an omitted heading. A missing canonical section and a bare empty heading are both hard violations the pre-save verification catches.

**Discovery tag casing** (when emitted): `entities` is lowercase snake_case (matches Semantius `table_name`). `domain` / `related_modules` / `departments` / `industries` use Title-case / acronym form (`Sales`, `IT`, `HR`, `Healthcare`, `SaaS`, `Financial Services`).

