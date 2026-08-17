*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 1: Capture the system

> **🛑 The deliverable is always a semantic-blueprint markdown file.** Once this skill is invoked, your job is to produce a `*-semantic-blueprint.md` file, full stop. Do **not** propose alternatives to modeling: no off-the-shelf SaaS products, no "just use a spreadsheet / Markdown checklist", no "keep it simple and skip the model". The user has already decided they want a data model; treat that as settled and move on to Stage 1. Stage 2's vendor-template question is the **only** place vendor names appear in the flow, and even there it's about *schema naming*, not about recommending the user buy that product. If the user explicitly asks whether they should use a SaaS product instead, answer briefly and then return to the modeling track, evaluating external products is a different skill.

Ask the user what system they want to model. Two shapes are common:

1. **Named category only**, "I need a CRM", "a helpdesk", "an HRIS", "an LMS". The user has no detailed requirements and expects you to bring the domain knowledge.
2. **Detailed requirements**, the user describes what the system must do, what they track, maybe sketches a few entities. Extract the domain from their description; do not ask them to restate it as a category.

If the category is unclear (e.g., the user says "a system for my coaches"), ask one clarifying question to narrow it down. Otherwise proceed.

Identify the **domain category** (CRM, ITSM/helpdesk, HRIS, LMS, ERP, PIM, CMS, Project Management, Field Service, Subscription Billing, etc.). The next stage depends on this.

**Capture the initial request verbatim.** Record the user's opening ask (e.g. *"I need a basic lead tracker"*, *"spec out an HRIS for a 200-person company"*) exactly as they said it, no rewording, no tidying. This goes into the `initial_request` front-matter key in Stage 11 and is **never** modified afterwards; it's the historical record of what kicked the model off. If the user started with several messages before committing to a system, use the first message that clearly names the system they want. If a clarifying question in this stage changed the category, still keep the original wording, don't fold the clarification into it.

**Capture `system_name` and a rough scope line.** `system_name` is the display name (and the module name); elicit it here. Then capture a **one-line scope statement** in the user's own words (e.g. *"everything a small team needs to hire, in one lightweight package"*). This line is working input, not marketing copy: it constrains the Stage 3 entity proposal (lean scope → lean entity list) and seeds the `tagline` draft in Stage 13. Do NOT elicit the polished catalog-surface strings here — `tagline`, `module_kind`, and the publish-only keys (`description`, `license`) are settled in Stage 13 ("Finalize the catalog surface"), once the entity list they describe actually exists. Asking the user to write buyer-facing copy about a system whose contents haven't been decided yet produces copy that has to be rewritten.

The §1 Overview remains a **single analyst-voice block**: terse, scope-explicit (what's IN, what's OUT, upgrade path). Do NOT split §1 into sub-sections; do NOT mix marketing-voice into §1. The marketing surfaces live in frontmatter (`tagline`, plus `description` on publish-ready blueprints).
