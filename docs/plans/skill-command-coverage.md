# Plan: make `use-semantius` aware of the full CLI command surface

Status: open. Raised 2026-09-20 after an audit of the documented command set against
`src/index.ts`; reviewed the same day by two independent passes (a skill review and a plan
review), every finding verified against the source before it was folded in. Scope is the
**skill tree only** (`skills/`) plus the doc regressions that commit `762c21b` introduced. CLI
behaviour changes are listed under "Out of scope" and need their own plan.

Every step ends with a "done when" line. Line references were verified on `762c21b` plus the
uncommitted `MCP_` fix described in Step 0; they drift by a line or two as `src/index.ts`
changes.

---

## 1. Why

`skills/use-semantius` documents six CLI forms. The CLI has ten. An agent driving the CLI
therefore has no guidance on six subcommands — including three that are actively dangerous to
run unattended.

The silence protects nothing: `semantius --help`, `README.md:133-149` and `semantius -md`
(which dumps `README.md` verbatim, `src/commands/markdown.ts:212`) all list `use`, `login`,
`logout` and `hosts`, and the skill itself advertises `-md` in its options table. So an agent
already meets the full command set — it just meets it unguarded. The question is only whether
the first mention it sees is ours or the README's.

### The real command surface

`SUBCOMMANDS` (`src/index.ts:117-127`) plus the bare invocation:

```
(bare)   info   grep   call   ping   whoami   login   logout   hosts   use
```

`list` and `markdown` appear in the command union type but are not typeable — they are the
internal names for the bare invocation and for `-md`. `semantius list` is rejected with
`UNKNOWN_SUBCOMMAND`.

### What the skill currently says

| Location | Content |
|---|---|
| `skills/use-semantius/SKILL.md:153-163` | "Core CLI Commands" — 6 forms |
| `skills/use-semantius/SKILL.md:119-129` | "Environment Setup" — STOP unless `SEMANTIUS_API_KEY` and `SEMANTIUS_ORG` are set (wrong; Step 2) |
| `skills/use-semantius/SKILL.md:18` | "two servers: `crud` and `cube`" — the built-in `utils` server is the third (`src/config.ts:80`) |
| `skills/use-semantius/references/cli-usage.md:36-47` | "All Commands" — the same 6 forms |
| `skills/use-semantius/references/cli-usage.md:49-58` | Options table — 6 rows (was 13 before `762c21b`) |

Across all seven skills, `logout`, `semantius login`, `semantius hosts`, `semantius use` and
`--host` appear **zero** times. `whoami` appears twice (`skills/semantius-modeler/SKILL.md:400`
and that skill's CHANGELOG), only as a prohibition ("do NOT read `ui_baseurl` off `whoami`").

---

## 2. The `762c21b` regression

Confirmed, not a hypothesis: `git rev-parse 762c21b:skills/use-semantius/references/cli-usage.md`
is the blob of `22e281d` (2026-08-17, "skills update"). The commit ("Add semantic models and
fixtures for Demo Ops and Demo Ops Pro") dropped a five-week-old copy of the file into the
tree, undoing the eight commits that had touched it between 2026-09-11 and 09-18 (`9ac9574`,
`3e16fd7`, `64ea99b`, `619fb77`, `e655241`, `cd3e954`, `5dcda63`, `3bb2e01`) — among them the
`MCP_` → `SEMANTIUS_` fix (`9ac9574`) and the transfer-tools section (`3bb2e01`).

Of the 68 skill files the commit touched, a blob comparison against every earlier version of
each file finds two whole-file reverts: `cli-usage.md`, and
`skills/use-semantius/evals/README.md` (back to `c4c2f40`, 2026-06-17). Every other file
carries new content — but one of them, `crud-tools.md`, is a *partial* revert that the blob
test cannot see (Step 1b). So the method is: **for every file `762c21b` touched under
`skills/use-semantius`, diff against `762c21b^` and keep only the intended changes.**

Dropped from `cli-usage.md` (the full inventory; the first draft of this plan listed less than
half of it):

- the Credentials Setup block: host order, credential order JWT → API key → stored session,
  the exit-5 "Authentication required" rule, what `--auth` selects, and "with `--host`, only
  credentials stored for that host are used"
- the `semantius login` / `semantius logout` paragraph, including "Agents should not run
  `login` themselves: it needs a human at an interactive terminal"
- seven options rows: `--stream`, `--host`, `--auth`, `--login`, `--env`, `--crud-mcp`,
  `--reset-cache` (13 rows → 6)
- the whole **"Moving Entities and Modules Between Hosts"** section — the transfer tools that
  `CLAUDE.md` treats as first-class
- five env rows — `SEMANTIUS_HOST`, `SEMANTIUS_JWT`, the browser-session row,
  `SEMANTIUS_CRUD_MCP`, `SEMANTIUS_STREAM` — plus the "(required unless …)" qualifiers on the
  API key and org rows
- the daemon paragraph: `crud` runs in-process, the daemon exists on Linux/macOS only, Windows
  opens a fresh connection per call — and the idle timeout went from the correct 300 s to 60 s
- the exit-5 row wording ("no credentials, invalid `SEMANTIUS_API_KEY`, `401`, `403`")

Introduced by the same revert: the eight `MCP_*` env names in `cli-usage.md`. The two in the
modeler files predate `762c21b` — they were written dead in `22e281d`.

---

## 3. Steps

### Step 0 — `MCP_` → `SEMANTIUS_` env prefix *(done, uncommitted)*

All operational vars read through `getPrefixedEnv()` (`src/config.ts:335-337`), whose prefix
defaults to `SEMANTIUS` (`src/config.ts:211`). The `MCP_*` names were dead: verified
`MCP_DEBUG=1` → 0 debug lines, `SEMANTIUS_DEBUG=1` → 14.

Rewrote 10 occurrences (name-scoped, so prose about MCP servers is untouched):

- `skills/use-semantius/references/cli-usage.md` — 8 (daemon block + env table). **Superseded
  by Step 1:** the `762c21b^` copy already has the `SEMANTIUS_` names.
- `skills/semantius-modeler/references/deploy-script-template.md:26` — stays.
- `skills/semantius-modeler/CHANGELOG.md:110` — **revert this hunk.** The changelog is written
  history; the entry describes what was added at the time. Add a new dated entry instead,
  noting the env-name correction in `deploy-script-template.md:26`.

**Done when:** `grep -rn "MCP_[A-Z_]\+" skills/` returns nothing, and the changelog hunk is
reverted with a new entry in its place.

### Step 1 — restore `cli-usage.md` from `762c21b^`, then adapt what went stale

Start from `git show 762c21b^:skills/use-semantius/references/cli-usage.md`. That copy carries
every item in §2 and the 300 s daemon figure (the former Step 3), so the restore is one
command. Then apply exactly these adaptations — the text went stale between 2026-09-11 and
09-18, and a verbatim restore would contradict what Step 2 adds in the same file:

1. **Host order** (`src/host.ts:425-441`): `--host` → `--token`'s org → the current host set by
   `semantius use` → `SEMANTIUS_HOST` / `SEMANTIUS_ORG`, per layer (shell, local `.env`, global
   `.env`). The old line skips the middle two, which outrank a project's `.env`.
2. **"With `--host`, only credentials stored for that host are used"** now holds for the current
   host too (`src/auth/token.ts:53-66`, `:125-132`): on either, an API key or JWT in the
   environment is ignored.
3. **Credential order** gains `--token <org:jwt | ->` / `--token-file <path>` at the top
   (`src/index.ts:366-388`): a JWT for this one invocation, bound to `<org>.semantius.cloud`,
   the one credential an agent can be handed without touching global state. Prefer `-` (stdin)
   or the file form; a literal lands in shell history.
4. **Session storage** is not "in the OS keyring": since `01ffb8c` (2026-09-17) the session is
   sealed into a file under the secrets dir (`src/auth/envelope.ts`) and the keyring holds only
   the per-host key; headless Linux writes the file in the clear (`CLAUDE.md`).
   `README.md:518-522` and `--help` still say keyring — decide the wording once; the README
   side is Out of scope.
5. **"(required unless …)" qualifiers** on the `SEMANTIUS_API_KEY` / `SEMANTIUS_ORG` rows: also
   unless `--token`, or a current host.
6. **`-md` description**: "(README, SKILL, all tools)" → "(README, then every server's tools)".
   `src/commands/markdown.ts:212-230` prints README then the tools; no SKILL file is involved.

**Done when:** `diff <(git show 762c21b^:skills/use-semantius/references/cli-usage.md) skills/use-semantius/references/cli-usage.md`
shows only the six adaptations above plus Step 2's additions; the transfer section is present;
the login/logout paragraph is present with the "agents should not run `login`" rule intact;
the daemon block says 300 s.

### Step 1b — the other two regressed files

- **`skills/use-semantius/references/crud-tools.md`** (partial revert, 8+/12−). Restore from
  `762c21b^`: the `sqlToRest` qualifier "(with `--crud-mcp` only)" at line 20, the "Cloud only,
  and only with `--crud-mcp`" paragraph and the `--crud-mcp` in the example at line 133 (the
  built-in `crud` server has no `sqlToRest`; the plain call fails with `TOOL_NOT_FOUND`); and
  the `refresh_schema_cache` section at lines 136-139, which now reads "*(deno server only)*"
  with `semantius call deno refresh_schema_cache` — no `deno` server exists in `src/`,
  `README.md` or `tests/`; the `762c21b^` text (`semantius call crud refresh_schema_cache '{}'`,
  "the cache refreshes automatically after structural changes, do not call this routinely") is
  the correct one. The two dropped `alias`-is-removed warnings in `data-modeling.md` can stay
  dropped (no `alias` in the vendored schemas).
- **`skills/use-semantius/evals/README.md`**: whole-file revert to June. Restore `762c21b^`
  (it carries the `refresh_schema_cache` guidance at line 149 from `9ac9574`).

**Done when:** `git diff 762c21b^ -- skills/use-semantius/` shows only Step 1's adaptations
and Step 2's additions.

### Step 2 — document all ten commands, in three tiers

Not a flat list. The tiers carry the guidance; the completeness is incidental.

**Working set** — `(bare)`, `info`, `grep`, `call`. Already documented; no change.

**Diagnostics — safe, read-only, worth recommending**: `whoami`, `ping`, `hosts`. These are
what an agent should reach for when it is confused about which host, org or identity it is on.
`whoami` prints `host_source` and `auth_method` (`src/commands/identity.ts:290`, `:326`) — the
rows that say which host won and which credential is in use. `ping` is one `getCurrentUser`
round trip, `-n [count]` for latency. `hosts` lists every host with a stored session or the
current mark, `--json` for scripts.

> One boundary must ship with `whoami`: `skills/semantius-modeler/SKILL.md:400` already fights
> agents reading `ui_baseurl` off `whoami` instead of `crud/getCurrentUser`. Document `whoami`
> as *"which host and identity am I on, for diagnosis"* and `getCurrentUser` as *"where you
> read values you then act on"*. Documenting `whoami` without that line would manufacture the
> exact confusion modeler spends a paragraph on.

**Never run unattended** — `login`, `logout`, `use`. Documented as prohibitions, with the
reasons:

- `login` — opens a browser and waits up to 5 min for a loopback callback. The subcommand has
  **no TTY guard** (`src/index.ts:1333` → `src/commands/auth.ts:18`); only the `--login` flag
  checks `process.stdin.isTTY` (`src/index.ts:1270`). Headless it prints the URL and stalls —
  see "Out of scope". Never run it; tell the human which host needs a session.
- `use <host>` — sets the machine-global **current host**, which outranks `SEMANTIUS_HOST` /
  `SEMANTIUS_ORG` and every project `.env` for every later invocation in every directory, and
  **runs the browser login first when no session is stored** (`src/commands/hosts.ts:222`) —
  the same headless stall as `login`, on top of the global mutation. With a current host set,
  an API key or JWT in the environment is ignored for it. An agent wanting a different host for
  one call uses `--host` (stored session only) or `--token` / `--token-file`.
- `logout` — revokes the session where the provider publishes a revocation endpoint, deletes
  it, **clears the current host if it was this one, and stops every daemon**
  (`src/commands/auth.ts:34-51`). Every later invocation in every directory loses its host.
  Only a human at a browser can restore it.

**The always-loaded setup rule is wrong and changes with this step.**
`skills/use-semantius/SKILL.md:119-129` tells the agent to STOP unless `SEMANTIUS_API_KEY` and
`SEMANTIUS_ORG` are both set, and quotes a "Missing required environment variables" message the
CLI never prints. The facts: `getRequiredEnvVarNames()` is `ORG` / `HOST` only
(`src/config.ts:326-328`); `getMissingRequiredEnvVars()` returns nothing once any source
resolves a host, the current host included (`:384-391`); the real message is
`Error [MISSING_ENV_VAR]: Required environment variable not set: SEMANTIUS_ORG (set SEMANTIUS_ORG or --host, or run "semantius use <host>")`
(`src/index.ts:892`); a missing credential is exit 5 at auth time; and on a `--host` / current
host an API key does nothing. So the rule stops an agent on a machine correctly set up with
`semantius use`, and the remedy it prescribes is a no-op there. Rewrite the block around
`semantius whoami`: success → note host, `host_source`, `auth_method`, continue; exit 5 → quote
the error (it names the host and the remedy) and ask the human to set `SEMANTIUS_API_KEY` +
`SEMANTIUS_ORG` / `SEMANTIUS_HOST`, or to run `use` / `login` themselves — never run those.
While there: `SKILL.md:18` ("two servers") → three, the built-in `utils` server included;
`SKILL.md:145` (`.env` placement) → the loader searches cwd, the config dir, the executable dir,
then the user config dir, on every platform (`src/config.ts:772-797`).

Placement:

- `SKILL.md` (always loaded) — the rewritten setup block, the working-set block, and a two-line
  pointer to the diagnostics and the do-not-run list. Cheap.
- `cli-usage.md` (pulled when stuck) — the full three-tier table, with `--token` /
  `--token-file` documented as the agent's per-invocation credential.

**Done when:** all ten commands appear in `cli-usage.md` with a tier; the three prohibitions
are stated with their reasons; `SKILL.md`'s setup block probes with `whoami` and no longer
requires the API key variable; `SKILL.md` grows by no more than a few lines net.

### Step 3 — *(folded into Step 1)*

The 300 s figure (`src/config.ts:824`, `DEFAULT_DAEMON_TIMEOUT_SECONDS = 300`) comes back
with the restore; Step 1's done-when checks it.

### Step 4 — verify against the binary, in both directions

Re-derive the command list from `SUBCOMMANDS` and the options list from the `parseArgs` switch
rather than from `--help`, then spot-check each documented env var resolves to something `src/`
actually reads. The `MCP_*` bug survived because nobody checked the names against the source.

Check **both directions**: everything documented maps to `src/`, and everything in `src/` is
documented or on the allowlist below. A one-way check passes with the restored 13 rows while
`parseArgs` has 20. Counts on `762c21b`:

| Surface | `src/` | `README.md` | `cli-usage.md` now | `762c21b^` copy |
|---|---|---|---|---|
| Subcommands + bare | 10 | 10 | 6 | 6 |
| Options, distinct (`src/index.ts:268-412`) | 20 | 17 | 6 | 13 |
| Env vars (`getPrefixedEnv` sites + `ORG` / `HOST`) | 21 | 19 | 10 | 14 |

- Options to add beyond the restored 13: `--token`, `--token-file`, `-n [count]` (`ping`),
  `--json` (`hosts`), `--clear` (`use`), `--disable-jwt-cache`. README lacks `--diag` and
  `--single`, which the skill has — README's gap, not ours.
- Env vars to add beyond the restored 14: `SEMANTIUS_DISABLE_JWT_CACHE`, `SEMANTIUS_CONFIG_PATH`.
- Allowlist, deliberately undocumented in the skill: `-c` / `--config` (deferred, see Out of
  scope); `SEMANTIUS_CONNECT_TIMEOUT`, `SEMANTIUS_STDIN_GRACE_MS`, `SEMANTIUS_LOG_FILE`,
  `SEMANTIUS_LOG_LEVELS`, `SEMANTIUS_SIDE_EFFECT_TIMEOUT` (internals; add one only when a recipe
  needs it).
- Nothing in `tests/` or `scripts/` references the skill docs, which is why `762c21b` went
  unnoticed. Consider a small check that parses the "All Commands" block of `cli-usage.md` and
  compares it with `SUBCOMMANDS`, run from `release.sh`'s local gates.

**Done when:** every command, option and env var in `cli-usage.md` maps to a line in `src/`,
and every entry in `SUBCOMMANDS`, the `parseArgs` switch and the `getPrefixedEnv` call sites
is either documented or on the allowlist.

### Step 5 — cover the transfer tools: `export_entities`, `export_module`, `import_entities`, `import_module`

These are new (`3bb2e01`, 2026-09-18, first shipped in v0.8.9) and no skill covers them:
outside the importer's unrelated `fix_id_sequence` notes,
`grep -rn "export_module\|import_module\|export_entities\|import_entities" skills/` is empty.
Step 1 only brings back the mechanics paragraph in `cli-usage.md`; a reference file is read
when an agent is already stuck, and routing happens in the descriptions. By the descriptions
alone, the requests these tools serve land wrong today:

| Request | Lands on | Result |
|---|---|---|
| "export the CRM module from staging and import it into prod" | `semantius-optimizer` ("extract / export / … / snapshot … a spec from a live module", `SKILL.md:11-13`) | a markdown spec; no records, no grants, wrong host |
| "clone these two tables with their data to the test host" | `semantius-admin` clone-and-deploy (`SKILL.md:9-10`, `:117`) → architect → analyst → modeler | no records move; deploys to the current host |
| "back up module X to a file" | `semantius-admin` Backup 5.2 (`references/admin-operations.md:26-47`) | a hand-rolled dump in pseudo-code, no restore path |
| "restore this JSON export" | nowhere; falls to `use-semantius` or the importer, which asks for a CSV | dead end |

**Decision: a new skill, `skills/semantius-transfer/`, owns all four tools and the workflow
around them.** One feature, one file format, one owner — not split by direction. Not
`semantius-importer`: that is one CSV, one entity, insert-only, with an interactive mapping and
a question ledger; the transfer is many entities plus roles and grants, an upsert that
overwrites rows by id, and it touches `users` — each of those contradicts a line of the
importer's own "This skill never" list (`SKILL.md:228-235`), and the shared verb "import" is
exactly the confusion to avoid. Not `semantius-admin`: it declares itself "not a wrapper on
Semantius calls" (`SKILL.md:17-18`), its never-list says "Backup is read-only" (`:703`), its
preflight probes one host, and it is 731 lines; it already delegates file-shaped work (`:693`
routes CSV to the importer) and delegates this the same way. The alternative — host the
workflow inside `semantius-admin` as an `export_module`-based 5.2 plus a gated 5.6 restore —
needs that read-only invariant amended; take it only if an eighth skill is vetoed.

**5a. `skills/semantius-transfer/SKILL.md`** — target under 200 lines; the tool descriptions
already carry the semantics, the skill adds the choreography.

- *Description*: what it does, and the triggers — "export module X to a file", "back up /
  snapshot module X", "restore this export / backup", "copy / clone / move / migrate / promote
  module X or tables A,B (with their data) to <host>", "seed test from prod". Do NOT trigger:
  CSV or xlsx loading (`semantius-importer`), a spec from a live module
  (`semantius-optimizer`), deploying blueprints or specs (`semantius-admin`).
- *Preflight*: `semantius info utils` lists `export_module` (CLI ≥ 0.8.9; else re-run the
  installer). Resolve hosts: the source is the environment's host unless named; the target is
  always named. `semantius hosts`, then `semantius --host <h> whoami` for every named host —
  exit 5 means no session for that host: stop, quote the error, ask the human to run
  `semantius login --host <h>`; never run `login` or `use` (Step 2). With `--host` only that
  host's stored session is used (`src/auth/token.ts:53-66`). Refuse to import until `whoami`
  shows source and target as two different hosts.
- *Stages*: (1) scope — a module, or a comma-separated table list; schema and records, schema
  only (`exclude_data`), or records only (`exclude_schema`, tables only). (2) Export, then read
  the result back: the path, and fields and records per entity. (3) One `AskUserQuestion` gate
  naming the target host, the entities with their record counts, and what the import does —
  records upsert by id and overwrite target rows with the same id; roles, grants and
  permission-hierarchy rows are written, and hierarchy rows into other modules need those
  permissions present on the target; users match by `external_id`, an unknown one is an error;
  nothing is deleted; there is no transaction across requests; the target needs
  `fix_id_sequence` (`PGRST202` = database not rebuilt; the import stops before any record).
  (4) Import: `semantius --host <target> call utils/import_module '{"path":…}'` (or
  `import_entities`). (5) Verify: run the same import again — it writes nothing once converged
  — and spot-read counts on the target with `postgrestRequest`. (6) Report, with the UI link
  from `getCurrentUser` on the target host (`--host`), never the source's.
- *Backup and restore* are the one-host case: export to `<module_slug>-<YYYYMMDD-HHMMSS>.json`
  in the cwd; "all modules" is one `read_module` sweep and one `export_module` per module
  (there is no export-all tool); restore is the import on the same host. Webhook receivers are
  not carried (`src/local-tools/transfer/format.ts:56`); the report says so.
- *Resident invariants* (`CLAUDE.md`): metadata by name, never host ids; every read paged;
  `fix_id_sequence` on the target. Plus the tool caveats: an export is not a snapshot;
  `--crud-mcp` and a `crud.postgrest` override do not apply
  (`src/local-tools/transfer/index.ts:7`); an auth failure inside the tool exits 4, not 5 —
  which is why `whoami` probes first; a static `SEMANTIUS_JWT` can expire during a long run.
- *Evals*: `evals/trigger-eval.json` — 8 should-trigger (formal, casual, none naming a tool)
  and 8 near-miss should-not (CSV, spec extraction, blueprint deploy, webhook receiver,
  "export the orders table to CSV").

**5b. `semantius-admin`** — remove "back up the catalog" / "snapshot the module" from the
description (`SKILL.md:11-12`), the Step 0 row (`:120`) and the Step 5 table (`:339`); replace
`references/admin-operations.md` 5.2 with a pointer to `semantius-transfer`; add to the routing
list (`:685-693`): "moving, backing up or restoring modules or tables, with or without their
data, is a transfer: route to `semantius-transfer`"; add under the clone trigger: "copying
tables or a module *with their data* to another host is a transfer, not a clone-and-deploy".

**5c. `semantius-optimizer`** — one exclusion in the description: "moving a module with its
data between hosts, or backing it up as a restorable file, is `semantius-transfer`; this skill
produces a markdown spec".

**5d. `semantius-importer`** — put "CSV" in every trigger phrase of the description and add the
exclusion "JSON transfer files (from `export_entities` / `export_module`), moves between hosts,
backups and restores → `semantius-transfer`"; retitle "Exporting back out" (`SKILL.md:217-226`)
to "Download as CSV" and add one line pointing at `export_entities` for anything that must be
re-importable; add three should-not-trigger evals ("export the crm module from staging and
import it into prod", "restore crm.json into the test host", "export the orders table to
another host") and keep "export the orders table to CSV" as a positive; correct the premise that
`fix_id_sequence` does not exist yet (`SKILL.md:134`, `README.md:40-66`,
`references/schema-mapping.md:161`) — the CLI's own import calls it
(`src/local-tools/transfer/import.ts`); re-planning id preservation is a separate item.

**5e. `use-semantius`** — a row in the Reference Files table and in the Quick Decision Guide
(`SKILL.md:51-100`): "Moving entities or a module to another host, backing one up, restoring
an export?" → `semantius-transfer` for the workflow, `cli-usage.md` § "Moving Entities and
Modules Between Hosts" for the mechanics; in that section (Step 1) add the line "with
`--host`, only a stored session for that host is used — `semantius --host <h> whoami` tells
you whether one exists".

**Done when:** the four requests in the table above route to `semantius-transfer` by
description alone (trigger evals in the transfer, importer and admin skills pass);
`grep -rn "export_module" skills/` hits the transfer skill, `cli-usage.md` and the importer
pointer only; `admin-operations.md` 5.2 is a pointer; a dry walkthrough of a module transfer
between two hosts of a test org completes with a converged second import.

### Commit plan

1. **"skills: revert the collateral of 762c21b"** — Step 0's modeler edit and changelog entry,
   Step 1, Step 1b.
2. Step 2 — the tiers in `cli-usage.md` and the `SKILL.md` setup rewrite.
3. Step 4 — the bidirectional pass, and the guard check if added.
4. Step 5 — the transfer skill and its four companion edits, one commit.

---

## 4. Out of scope (do not lose these)

- **`-c` / `--config <path>`** is parsed (`src/index.ts:389`), works, and is documented in
  neither `--help` nor `README.md` — only the `SEMANTIUS_CONFIG_PATH` env equivalent is.
  Deliberately deferred 2026-09-20.
- **`semantius help` / `semantius version` are not commands.** Only the `-h` / `-v` flags
  exist; the bare words fall through to the "unknown first arg = server name" path and produce
  a misleading `SERVER_NOT_FOUND: Server "version" not found in config`. `isPossibleSubcommand`
  (`src/index.ts:140-156`) catches `list`, `ls`, `run`, `get`, `show` … but not `help`,
  `version`, `status` or `test`, so near-misses get the wrong error. CLI change, not a skill
  change.
- **Headless login stalls for 5 minutes.** `openBrowser` (`src/auth/session.ts:799-811`)
  spawns `xdg-open` with `stdout`/`stderr` ignored, no exit-code check, and a missing binary
  caught into `debug()`. The CLI claims "Opening the browser to sign in", waits on a loopback
  callback (`127.0.0.1`, ports 53682/53683/53684, `src/auth/session.ts:49-51`) for
  `LOGIN_TIMEOUT_MS` = 5 min (`src/auth/session.ts:54`), then blames the browser. Pasting the
  printed URL only completes the flow when the browser shares localhost with the CLI (same
  machine, WSL, or `ssh -L`). The real fix is RFC 8628 device code — **`cli-auth` already
  implements it** (`strategy: "device-code"`); the call site pins
  `createCliAuth<'authorization-code'>` (`src/auth/session.ts:65`), and
  `src/auth/provider.ts:129-143` does not capture `device_authorization_endpoint`. Select on
  that advertised capability, never on `idp_type` (`CLAUDE.md`). **Planned in
  `headless-login-device-code.md`** (2026-09-20), which also records that Entra and Google both
  advertise the endpoint and that `semantius-idp` already ships the Better Auth code to do so.
- **`-md` dumps the README's Development section** (`README.md:695-768`: `bun run dev whoami`,
  `bun run dev call crud …`) verbatim to agents — the only place an agent ever sees the CLI
  invoked as anything but `semantius`. Either the dump skips that section or the README moves
  it out. The skills themselves are clean: every helper spawns `["semantius", …]`
  (`deploy-lib.ts`, `scaffold-lib.ts`, `create-fields.ts`, `import.template.ts`,
  `spec-extract-lib.ts`), and `bun run` there only runs the skills' own generated scripts
  (verified 2026-09-20).
- **`--help` and `README.md:163` describe `-md` as "README, SKILL, all tools"**; it prints
  README then the tools (`src/commands/markdown.ts:212-230`). Step 1 fixes the skill's copy.
- **`README.md:518-522` and `--help` still say the session is stored "in the OS keyring"**;
  since `01ffb8c` the keyring holds only the key (`CLAUDE.md`). Step 1 fixes the skill's copy.
- **The admin skill carries the same stale credential model.**
  `skills/semantius-admin/references/preflight.md:149-155` answers exit 5 by asking for an API
  key and writing it to `.env` — a no-op on a `--host` / current host, where only a stored
  session applies (`src/auth/token.ts:53-66`). Its health probes (`skills/semantius-admin/SKILL.md:355`,
  `references/admin-operations.md:71`) pass a `slug` key that `read_entity` does not accept, so
  they read every entity and prove nothing; `semantius ping` is the probe. An admin-skill pass,
  not this plan.
