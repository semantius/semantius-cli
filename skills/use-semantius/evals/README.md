# Evals for use-semantius skill

## What these are

Each eval is a realistic multi-step user request that exercises the skill's ability to
orchestrate **sequences** of CLI commands. The prompts are deliberately complex because
that's where the skill earns its value.

| ID | Name | What it tests |
|----|------|---------------|
| 1 | `build-crm-module-from-scratch` | ~20 ordered CLI calls: module → permissions → 3 entities → fields → RBAC |
| 2 | `import-large-csv-via-webhook` | Bun webhook import script: HMAC signing, progress, rate limiting, error handling |
| 3 | `seed-records-sequential-cli-calls` | Capturing IDs from create responses with jq, using them in subsequent calls |
| 4 | `bulk-update-via-postgrest-direct` | When to use postgrestRequest instead of typed tools for bulk operations |
| 5 | `shell-script-create-entity-and-fields` | Bash script with ID capture, auto-generated field awareness, UI link |
| 6 | `m2m-junction-table-full-setup-and-seed` | M:N junction table + seeding 6 records with captured IDs |
| 7 | `diagnose-and-fix-permission-denied` | RBAC diagnosis chain: user → roles → permissions → hierarchy → fix |
| 8 | `cube-total-vs-trend-correct-pattern` | Totals (inDateRange in filters) vs trends (timeDimensions + granularity) |

---

## How to run on Claude.ai (no tooling needed)

1. Start a **fresh conversation** (important — no prior Semantius context)
2. Paste the `prompt` from an eval
3. Check the response against its `assertions` list — mark each pass/fail
4. Key question: does Claude read the right reference file and produce the **full
   command sequence**, not just one or two commands?

---

## How to install the skill in Claude Code (VS Code)

The `.skill` file you downloaded is just a zip archive containing the skill folder.
Claude Code uses a **plugin + marketplace system**, not `.skill` files directly.
The simplest way to install is manually:

### Option A: Manual install (simplest)

Unzip the `.skill` file directly into your personal Claude Code skills folder:

```bash
# On macOS/Linux
unzip use-semantius.skill -d ~/.claude/skills/

# On Windows (PowerShell)
Expand-Archive use-semantius.skill -DestinationPath "$env:USERPROFILE\.claude\skills\"
```

Verify it landed correctly — you should see:
```
~/.claude/skills/
└── use-semantius/
    ├── SKILL.md
    └── references/
        ├── cli-usage.md
        ├── crud-tools.md
        └── ...
```

Then in VS Code, type `/reload-plugins` in the Claude Code prompt box (or restart
Claude Code). The skill is now active — Claude will use it automatically when you
ask about Semantius.

### Option B: Via plugin marketplace (for teams)

If you want to distribute this skill to a team, host the skill folder in a git repo
and add it as a marketplace. See the
[Claude Code plugin marketplace docs](https://code.claude.com/docs/en/plugin-marketplaces)
for details.

---

## How to run the evals automatically (Claude Code CLI required)

The eval runner is part of the `skill-creator` skill and uses `claude -p` (the
Claude Code CLI in non-interactive mode). It requires:

1. **Claude Code CLI installed** (`claude --version` works in your terminal)
2. **skill-creator skill installed** (same unzip process as above)

### Step 1: Check you have the Claude Code CLI

The VS Code extension includes the CLI, but you need to confirm it's on your PATH:

```bash
# In VS Code's integrated terminal (Ctrl+` to open it):
claude --version
```

If not found, install it:
```bash
npm install -g @anthropic-ai/claude-code
```

### Step 2: Install the skill-creator skill

Get `skill-creator.skill` from the Claude.ai skill library (same place you got
`use-semantius.skill`), then:

```bash
unzip skill-creator.skill -d ~/.claude/skills/
```

### Step 3: Run the evals

```bash
bash skills/use-semantius/evals/run-evals.sh
```

This spawns a `claude -p` subprocess per eval (with-skill vs without-skill in
parallel), grades responses against the assertions, and opens an HTML report in
your browser.

> **Why run from ~/.claude/skills/skill-creator?**
> The scripts use relative imports (`from scripts.utils import ...`) so Python needs
> to be run from that directory for the imports to resolve.

> **Note on evals/ not being in the installed skill:**
> The `evals/` folder is excluded from the packaged `.skill` file by design — evals
> are development tools, not something end users need. They only exist in your
> working copy of the skill source (i.e. what you're reading now after unzipping).

### Step 4: Optimize the skill description (optional)

Once evals look good, run the description optimizer to maximize trigger accuracy:

```bash
cd ~/.claude/skills/skill-creator

python -m scripts.run_loop \
  --skill-path ~/.claude/skills/use-semantius \
  --eval-set ~/.claude/skills/use-semantius/evals/evals.json \
  --model claude-sonnet-4-20250514 \
  --max-iterations 5
```

This tests the current description, proposes improvements, re-tests, and returns
the best-scoring version to replace the frontmatter `description:` with.

---

## Adding more evals

Good candidates:
- Import from Excel (Bun + xlsx package)
- `sqlToRest` conversion for a complex SQL query
- `refresh_schema_cache` after adding a field
- `compareDateRange` period-over-period comparison in cube
- Funnel or retention analysis
- Safe entity evolution (adding new fields, warning on risky changes)
