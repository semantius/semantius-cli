*Reference for `semantius-architect`. Read at the mandatory "Before presenting" step of Stage 3 (and the matching step of Extend C3 and Rebuild D2), before the entity list goes to the user.*

> **Terms used here.** A **base** is the entity others share a key with; an **`is_a` entity** is a kind of its base (fixed at creation); a **`has_a` entity** is something a base record can also be.
> Either one is a **based entity**; a base plus its based entities is a **family**. A **type enum** is one entity with an enum field choosing the kind.
> Full vocabulary and the platform facts: [`../../use-semantius/references/entity-families.md`](../../use-semantius/references/entity-families.md). Never say any of these words to the user (Writing Convention 8).

# Keep each fact once

The architect normalizes by default and silently. The user only ever answers business-fact questions in plain words. This file covers the **entity level** only: which entities exist and how they share a key. Where each field goes is the analyst's job (its Stage 4 N-checks).

## The one test

**"If this fact changed, would it need changing in more than one place?"** Always check a candidate against one example of each kind:

- **Fails:** a customer's phone number copied onto every order. When it changes, every order is stale. Drop the copy; the order reaches the phone through its customer.
- **Passes:** the billing address printed on an invoice. It is a **snapshot**: the invoice must keep the address it was sent to, even after the customer moves. A snapshot is kept, and described "as of <event>" ("the billing address as of issue").

## Filters (run these before the decision table)

Each filter settles a candidate before the table is needed. Stop at the first one that matches.

| Situation | Outcome | Example | Not this |
|---|---|---|---|
| Data that repeats per organizational level | A child entity with a `parent` link | A customer's terms per sales area → `customer_sales_areas` | A family of "sales-area customers" |
| Entities that only share field names | Nothing: each keeps its own fields | Projects and tasks both have a name and a due date | A shared "work item" base |
| A list inside a record | A child entity, or a junction for many-to-many | `phone_1`, `phone_2` → `contact_phones`; a comma-separated tag list → a tags junction | Numbered fields |
| Stages of one process | The §7 lifecycle (`workflow_state`) | Lead → qualified → customer; draft → approved | A type enum or a family |
| A snapshot of another record's data | Keep it on the record, described "as of <event>" | Price at sale on an order line | Dropping it as a copy |

## The decision table

Use it when two or more candidate entities are **kinds of one real-world thing**, or when one entity is a wide record whose kinds use different fields. Ask the questions **in this order** and stop at the first "yes". Answer from the conversation and domain knowledge. Ask the user only as described under "Asking" below.

| # | Question | If yes | Why | Example | Not this |
|---|---|---|---|---|---|
| Q1 | Can one record be two of these at the same time? | `has_a` family | One company must not be entered twice to be both | A distributor's suppliers also buy from it → `business_partners` base; `customers` and `suppliers` are `has_a` | Leads and customers: a record is one at a time |
| Q2 | Exactly one at a time, but it can switch? (only after Q1 said no) | Type enum | An `is_a` record's type never changes; an enum value can | Tickets re-triaged from incident to problem → `tickets.ticket_type` | `is_a` incidents and problems |
| Q3 | Do the kinds differ by 3 fields or fewer, with no relationships or lifecycle of their own? | Type enum, plus a rule that blocks changing the type after creation (the analyst writes it) | Fields left empty for some kinds are not duplication; a family adds entities, locked keys, and platform limits for nothing | Mileage vs receipt expenses (1-2 fields apart) → `expenses` with a type enum; ticket channels (email, phone, chat) → a `channel` enum | An `is_a` family of expense kinds |
| Q4 | Fixed at creation, and people want one combined list? | `is_a` family | Each kind keeps its own fields and relationships, and the base lists them all | Calls, emails and meetings on one timeline (meetings have attendees) → `activities` base; `calls`, `emails`, `meetings` are `is_a` | A type enum with a dozen fields that only some kinds use |
| - | Otherwise | Separate entities | Different things, or nobody needs them together | Contracts and invoices | Any family |

**Fields left empty for some kinds are not duplication; only the same fact stored twice is.** A type enum with per-kind fields passes the one test.

**A type enum holds exactly one kind per record.** Once Q1 is yes (one company can be a customer and a vendor at the same time), a type enum is wrong: it would force a second record for the same company. Never answer a "both at once" entity with the "Each <Singular> is one of: …" sentence; the outcome is a `has_a` family.

**Parallel entities for one real-world thing.** Two candidates that describe the same thing with the same identifying facts (customers and vendors, each with a name, an address, and a tax id) fail the one test: a company that is both is entered twice. Run the table on them. The usual outcome is Q1: one base holding the shared facts (`business_partners`), with a `has_a` entity per role. When the base belongs in a shared master (parties), declare it with the existing §3 `role` rules: `embedded_master` with `mastered in` naming the owner, or `contributor` when the owner module exists. A `contributor` / `consumer` base gets no Key types row; the analyst checks its key type against the live catalog.

**A family counts as one concept** in Stage 3's 6-15 entity guidance.

## What to write in the blueprint

| Outcome | §3 rows | `**Key types:**` rows | §2 diagram | §5.1 edges | §7 lifecycle |
|---|---|---|---|---|---|
| `has_a` family | The base (role per the rules above) and each `has_a` entity (`master`) | Base: `typeid` \| `<prefix>` \| `-` (when provisioned here). Each `has_a` entity: `has_a` \| `-` \| `` `<base>` `` | One dotted edge per `has_a` entity: `customers -.->\|"extends"\| business_partners` | Relationships shared by every kind: **one row from the base**. A kind's own relationships: rows from that kind | On the base when every kind shares it; otherwise on the kinds. **Never on both**: the state field name would repeat |
| `is_a` family | The base and each `is_a` entity (`master`) | Base: `typeid` \| `<prefix>` \| `-`. Each `is_a` entity: `is_a` \| `<own prefix>` \| `` `<base>` `` (a deeper level names its `is_a` parent) | One dotted edge per `is_a` entity: `emails -.->\|"is a kind of"\| activities` | As above: `business_partners -->\|"logs"\| activities`, never one row per kind | As above |
| Type enum | One entity | none for the kinds | nothing extra | as usual | as usual |
| Separate entities | as usual | as usual | as usual | as usual | as usual |

Rules that apply to every family:

- The dotted edges are **not** §5 rows; `consistency-check.ts` compares them with the `**Key types:**` rows (and `--emit-mermaid` prints them).
- A §5 edge whose foreign key sits on an `is_a` entity never uses `cascade`; write `restrict` or `clear`.
- A based entity never gets a `**Key types:**` row without a `based on`, and a base is never a platform built-in (reference `users` instead).
- **Type-enum handoff.** Write this fixed sentence in the entity's §2 Description: **"Each <Singular> is one of: A, B, or C."** (two kinds: "A or B"). The analyst's Stage 4 detects it and makes the enum. Example: *"Each Expense is one of: mileage or receipt."*

## Scope

- **Entity level only.** Field placement (copies, numbered repeats, junction fields about one side) is the analyst's N-checks.
- **Never guess at the live catalog.** Whether a live entity already holds these companies is the analyst's question (its shared-base step). Normalize inside the blueprint only.
- **Clone, Customize and Extend normalize only entities the user adds or changes.** Inherited structure is left as it is; Audit flags it (see `audit-checklist.md`).

## Presenting

- **Exactly one aside per family**, in plain words, in the entity-list message. Templates:
  - `has_a`: *"Each company is kept once as a business partner; being a customer or a supplier is something it can also be."*
  - `is_a`: *"Calls, emails and meetings are kept as kinds of activity, so they share one timeline."*
  - Type enum: *"Each expense has a type, mileage or receipt, that decides which details are asked."*
- Never *"I normalized…"*, and never a word from the Writing Convention 8 ban list (normalization, subtype, inheritance, `is_a`, `has_a`, base entity, "derived" for a based entity, "role" for a `has_a` entity).

## Asking

**Ask only when the outcome is `is_a` or `has_a` and the user hasn't stated the deciding fact.** Settle a type enum, separate entities, or a stated fact silently, and mention it in the aside.

The request states the fact more often than not. No question in these cases, only the aside:

| The user said | It answers | So |
|---|---|---|
| "many of our suppliers also buy from us", "a partner can also be a customer" | Q1: yes | `has_a` family, no question |
| "a customer is never also a supplier", "they are different companies" | Q1: no | continue the table silently |
| "one timeline of calls, emails and meetings", "see all activities together" | Q4: yes | `is_a` family, no question |
| "we look at calls and emails separately" | Q4: no | separate entities |

Ask only when nothing in the request or the conversation settles it ("we track customers and suppliers" alone says nothing about overlap).

- The family questions are standalone questions (not ledger tasks). They go **first** in the same `AskUserQuestion` call as Stage 3's "Also track" multiSelect, at most 4 question objects per call; overflow goes to the next call, after the answers arrive.
- One question per family, never more.
- **Rebuild** re-asks each family question, with the existing Key types choice listed first as the default (the Rebuild rule "the prior choice is the default").
- **Yolo mode** (a yolo run): don't ask; take the "(Recommended)" answer and name the result in the go-ahead summary's entity table.

**Q1 widget** (`has_a` or not), with the user's own nouns:

- **question**: `"Can the same company be both a customer and a supplier at the same time?"`
- **header**: `"Both at once"`
- **multiSelect**: `false`
- **options**:
  1. label `"Yes, it can be both (Recommended)"`, description `"Each company is kept once, and being a customer or a supplier is something it can also be."` (put "(Recommended)" on whichever answer the domain makes likely)
  2. label `"No, always one or the other"`, description `"Customers and suppliers stay separate lists."`

On "Yes": `has_a` family. On "No": continue with Q2 to Q4.

**Q4 widget** (`is_a` or not):

- **question**: `"Do people need one list of all calls, emails and meetings together, for example one timeline per customer?"`
- **header**: `"One list"`
- **multiSelect**: `false`
- **options**:
  1. label `"Yes, one combined list (Recommended)"`, description `"Calls, emails and meetings are kept as kinds of activity, each with its own details."`
  2. label `"No, they're used separately"`, description `"Calls, emails and meetings stay separate lists."`

On "Yes": `is_a` family. On "No": separate entities.
