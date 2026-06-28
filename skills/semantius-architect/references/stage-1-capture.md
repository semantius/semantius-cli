*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 1: Capture the system

> **🛑 The deliverable is always a semantic-blueprint markdown file.** Once this skill is invoked, your job is to produce a `*-semantic-blueprint.md` file, full stop. Do **not** propose alternatives to modeling: no off-the-shelf SaaS products, no "just use a spreadsheet / Markdown checklist", no "keep it simple and skip the model". The user has already decided they want a data model; treat that as settled and move on to Stage 1. Stage 2's vendor-template question is the **only** place vendor names appear in the flow, and even there it's about *schema naming*, not about recommending the user buy that product. If the user explicitly asks whether they should use a SaaS product instead, answer briefly and then return to the modeling track, evaluating external products is a different skill.

Ask the user what system they want to model. Two shapes are common:

1. **Named category only**, "I need a CRM", "a helpdesk", "an HRIS", "an LMS". The user has no detailed requirements and expects you to bring the domain knowledge.
2. **Detailed requirements**, the user describes what the system must do, what they track, maybe sketches a few entities. Extract the domain from their description; do not ask them to restate it as a category.

If the category is unclear (e.g., the user says "a system for my coaches"), ask one clarifying question to narrow it down. Otherwise proceed.

Identify the **domain category** (CRM, ITSM/helpdesk, HRIS, LMS, ERP, PIM, CMS, Project Management, Field Service, Subscription Billing, etc.). The next stage depends on this.

**Capture the initial request verbatim.** Record the user's opening ask (e.g. *"I need a basic lead tracker"*, *"spec out an HRIS for a 200-person company"*) exactly as they said it, no rewording, no tidying. This goes into the `initial_request` front-matter key in Stage 11 and is **never** modified afterwards; it's the historical record of what kicked the model off. If the user started with several messages before committing to a system, use the first message that clearly names the system they want. If a clarifying question in this stage changed the category, still keep the original wording, don't fold the clarification into it.

**Capture the catalog-surface text.** Before moving on to Stage 2, elicit the frontmatter strings that drive marketing / catalog surfaces. `system_name` is the display name (and the module name); the strings below cover the buyer-facing surfaces, and `tagline` doubles as the module record's short description (`modules.description`):

- **`tagline`** — one-line marketing-voice line for the catalog card AND the module record's short description (`modules.description`, shown beside the name in the selector). The elevator pitch. Ask: *"In one line, what's the buyer-facing pitch for this system?"* Aim for ≤80 chars and keep it readable in the selector chip. Example from `hiring-starter`: *"Everything a small team needs to hire, in one lightweight package."*
- **`description`** — longer marketing-voice prose for the catalog page (1–3 paragraphs). Ask: *"How would you describe this to a buyer browsing the catalog?"* Multi-line is fine; write as a YAML block string in the frontmatter. Example from `hiring-starter`: *"A starter bundle covering the core hiring path (postings, candidates, applications, interviews, and offers) without the breadth of the full module set. Stand up hiring quickly, then grow into the full modules as your volume increases; your data moves with you when you do."*
- **`license`** — catalog metadata. Default `MIT` unless the customer's project / org has a standing rule. Ask only when the customer's project has no obvious default.

The §1 Overview remains a **single analyst-voice block**: terse, scope-explicit (what's IN, what's OUT, upgrade path). Do NOT split §1 into sub-sections; do NOT mix marketing-voice into §1. The marketing surfaces live in frontmatter (`tagline`, `description`).

**Capture `module_kind` (informational label).** Ask the customer (or pick a default) for the kind label that goes on the module record. Defaults: `domain` for normal modules, `master` for shared / canonical-owner modules (carrying mostly `master` rows in §3), `starter` for thin, single-deployable bundles (carrying mostly `embedded_master` rows in §3). `module_kind` is NOT a behavior switch — the analyst and deployer treat it as informational metadata only. The behavioral rule that handles "starter" shapes is the entity-owning-module rule (see Writing Convention 10), and it fires the same way for every blueprint shape regardless of `module_kind`.
