# Shared Preflight

Single source of truth for the environment checks every Semantius skill runs before doing work. The `semantius-admin` orchestrator runs this once at the top of an orchestrated run; each sub-skill (`semantius-architect`, `semantius-analyst`, `semantius-modeler`) runs it when invoked **standalone**, and **skips** it when invoked **inline by the admin**.

This file is referenced (never copied) by all four SKILLs. Fix a preflight rule here and every skill picks it up.

---

## When to run vs. skip

Look at your input for a `Run context:` block (the admin states it in the conversation immediately before entering a sub-skill, see `semantius-admin/SKILL.md` Step 7.3):

```
Run context: run_id=run-...
Customizations file: /abs/path/.../semantius/<org>/customizations.yaml
...
```

- **Orchestrated (a `Run context:` block is present):** the admin has already run this preflight (CLI installed + authenticated, toolchain present, `adenin` guard passed, customizations path resolved). **Do NOT re-run the checks.** Read `Customizations file:` from the header and proceed. (Re-running is harmless but redundant; skip it.)
- **Standalone (no `Run context:` block):** run all four checks below yourself, in order.

The modeler never consults the customizations file (specs already carry every decision), so when the modeler runs this standalone it executes checks 1-3 and ignores the check-4 output. Bun is the tool the modeler critically needs (its deploy and sample-data scripts run with `bun run`).

---

## Output discipline

- **Orchestrated by admin:** produce **no chat output** for these checks; the admin owns all narration and keeps the machinery invisible.
- **Standalone:** keep it quiet too. The only user-facing output is a halt message (the active org is `adenin`, or a required tool could not be installed) or a setup action the user must see (installing a tool, or supplying their API key). A single brief line on the customizations file (check 4) is acceptable standalone. On all-pass with everything already installed and authenticated, say nothing.

---

## Check 1: Stay in the repo root

Never `cd`. The `semantius` CLI reads `.env` from the current working directory, so changing into a sibling project loads a different `.env` with different credentials pointing at a different instance, and every subsequent call lands on the wrong tenant. Run every `semantius` command from the session's repo root, full stop. If verifying something requires a different directory's config, ask the user to run it and paste the output.

---

## Check 2: Install the supporting toolchain (Bun, jq, yq)

Besides the `semantius` CLI, these skills need three general-purpose tools on PATH:

- **Bun** — the mandated runtime. The modeler writes and runs its deploy and sample-data scripts with `bun run` (its only write path); the architect / analyst run `consistency-check.ts` with `bun`. Python is forbidden across these skills.
- **jq** — parses `semantius` JSON output, both in this preflight (check 3 reads `org` and `ui_baseurl` with `jq`) and throughout the architect / analyst bash flows.
- **yq** — Mike Farah's Go yq v4+, the engine behind the surgical `customizations.yaml` writes (admin Step 7) that preserve hand-edits and provenance line-comments.

Install any that are missing, no prompt, one plain line per tool actually installed (e.g. *"Installing jq..."*). **This check runs before check 3**, because the CLI probe there parses JSON with `jq`, so `jq` must already be on PATH. After installing, if `command -v <tool>` still fails the PATH update has not reached this shell: ask the user to restart the shell (or open a new terminal) and re-run.

For each missing tool, prefer the platform's package manager; fall back to the project's static release binary when no package manager is present. Detect the platform and use the matching cell:

| Tool | Windows | macOS | Linux | Static-binary fallback (no package manager) |
|---|---|---|---|---|
| **Bun** | `powershell -c "irm bun.sh/install.ps1 | iex"` | `curl -fsSL https://bun.sh/install | bash` | `curl -fsSL https://bun.sh/install | bash` | installer above is already a direct download — see https://bun.sh/install |
| **jq** | `winget install -e --id jqlang.jq` (or `scoop install jq`, `choco install jq`) | `brew install jq` | `sudo apt-get install -y jq` / `sudo dnf install -y jq` / `sudo apk add jq` | download from https://github.com/jqlang/jq/releases/latest (`jq-windows-amd64.exe`, `jq-macos-arm64`/`-amd64`, `jq-linux-amd64`), `chmod +x`, place on PATH |
| **yq** | `winget install -e --id MikeFarah.yq` (or `scoop install yq`, `choco install yq`) | `brew install yq` | `sudo snap install yq` or `brew install yq` (NOT `apt install yq` — see footgun below) | download `yq_<os>_<arch>` from https://github.com/mikefarah/yq/releases/latest (e.g. `yq_linux_amd64`, `yq_darwin_arm64`, `yq_windows_amd64.exe`), `chmod +x`, place on PATH |

Reference flow (per tool: check, then install via the matching cell, then re-check):

```bash
for tool in bun jq yq; do
  command -v "$tool" >/dev/null 2>&1 && continue
  # install via the platform cell above (package manager first, static binary fallback),
  # then re-check: command -v "$tool"  (if still missing, restart shell so PATH refreshes)
done
```

**yq footgun (Linux especially).** The distro package named `yq` is frequently the *Python* yq (kislyuk/yq), whose syntax is incompatible and would break every `yq -i` write the customizations layer makes. Whether yq was already present or just installed, verify the right build is the one on PATH:

```bash
yq --version    # must report the mikefarah build, e.g. "yq (https://github.com/mikefarah/yq/) version v4.x"
```

If `yq --version` shows anything else (the Python yq, or a version below v4), install Mike Farah's Go binary explicitly via the static-binary fallback above, place it on PATH ahead of the wrong one, and re-check. Do not proceed with a non-mikefarah yq.

If any install fails, surface the verbatim error plus the tool's download page and stop. Do not limp on without a required tool — a missing `jq` silently breaks the org probe and the `adenin` guard in check 3, and a missing or wrong `yq` breaks every customizations write.

---

## Check 3: Ensure the `semantius` CLI is installed and authenticated, then halt if the active org is `adenin`

This is the front door for every Semantius call, so it self-heals a missing binary and a missing/invalid `.env` instead of letting a raw CLI error surface later. One probe (`getCurrentUser`) folds the install check, the auth check, and the org/UI-base read into a single call. Probe once at the top of every invocation.

### 3a. Is the CLI on PATH? Install it if not (no prompt)

The `semantius` CLI ships as a **native installer, NOT an npm package**, so there is no base URL to ask for and no `npx` form. If the binary is missing, run the platform one-liner immediately (do not ask first), then have the user restart the shell if PATH was just updated, and re-probe.

```bash
if ! command -v semantius >/dev/null 2>&1; then
  # Windows (PowerShell):
  #   irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex
  # Linux / macOS:
  #   curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
  # Guide: https://github.com/semantius/semantius-cli#1-installation
  : # run the one-liner for the detected platform, then re-check `command -v semantius`
fi
```

This is one of the places check 3 may speak to the user: say at most one plain line, e.g. *"Installing the Semantius CLI..."*, run it, and if the install itself fails surface the verbatim error plus the guide link above. If `command -v semantius` still fails after the install, the PATH update has not reached this shell: ask the user to restart the shell (or open a new terminal) and re-run, then continue.

### 3b. Probe once; this folds the auth check and reads org + UI base

```bash
# One probe, three values. Read the web UI base from the SAME getCurrentUser call so any
# close-out can build a clickable "Open in Semantius" link. Remember the value for the rest
# of the run (as you do the org) and reuse it.
# Never hardcode the org host: the UI host (e.g. tests.semantius.app) differs from the API
# host (tests.semantius.ai), and only getCurrentUser knows the right one.
me=$(semantius call crud getCurrentUser 2>&1) && rc=0 || rc=$?
org=$(printf '%s' "$me" | jq -r .semantius_org 2>/dev/null)
ui_baseurl=$(printf '%s' "$me" | jq -r .ui_baseurl 2>/dev/null)   # e.g. https://tests.semantius.app
```

If the probe fails (non-zero exit, or no `semantius_org` in the response), classify by the error and act. This mirrors the `use-it-ops-starter` bootstrap exit handling; never invent a connection or onboarding option beyond these:

| Probe result | What you DO | What you SAY (shape) |
|---|---|---|
| `command not found` / `not recognized` / ENOENT (binary missing despite 3a) | The install in 3a did not take or PATH did not refresh. Re-run the install one-liner, then ask the user to restart the shell and re-run. | *"Installing the Semantius CLI..."* (then, if needed) *"Please restart your shell so the CLI is on PATH, then re-run."* |
| Auth failure (401, expired token, missing or invalid `.env`) | Ask the user for their API key, write `SEMANTIUS_API_KEY=<key>` to the `.env` the CLI reads (repo root / cwd), then re-run the probe. Do NOT ask for a base URL or offer to provision anything. | *"I need your Semantius API key to connect. Generate one at https://app.semantius.com/dashboard (Settings > API Keys), paste it here, and I'll save it and continue."* |
| JWT-audience error (`required audience not found, received [...]`) | Surface the error verbatim and wait; do not retry in a loop. | *(show the exact error, then)* *"This looks like a server-side auth-scope issue. Could you check the API key's audience?"* |

Re-probe after the install or after saving the key; only continue once `getCurrentUser` returns a user object with `semantius_org`. Write the resolved `.env` with `SEMANTIUS_API_KEY=<key>` (append or update the line; preserve any other keys already in the file). All of this stays out of chat except the single install line or the API-key request above.

### 3c. Halt if `org` is `adenin`

Once the probe succeeds, if `org` is `adenin`, stop immediately. Do not classify the request, do not inspect the workspace, do not dispatch any sub-skill. Tell the user: *"This workspace is pointed at the `adenin` instance. Switch workspace before continuing."* The check is purely operational — writes against `adenin` fail with permission errors that read like CLI bugs and waste debugging time; halting up front avoids the noise.

---

## Check 4: Compute the customizations file path

(The modeler skips this; it does not consult the customizations file.) After the adenin halt passes, derive the per-org file location and export it for every downstream call. The folder name is the org; never duplicate the org inside the file body.

```bash
CUSTOMIZATIONS_FILE="semantius/${org}/customizations.yaml"
mkdir -p "$(dirname "$CUSTOMIZATIONS_FILE")"
export CUSTOMIZATIONS_FILE
```

If the file does not exist yet, that is fine: treat as "no policies set." The first widget answer creates it. (`yq`, used for the surgical writes to this file, is guaranteed by check 2.)

---

## Outputs

After a successful preflight these values are resolved and reused for the rest of the run:

- `org` — the active Semantius org (already confirmed not `adenin`).
- `ui_baseurl` — the web UI base for building deep-links.
- `CUSTOMIZATIONS_FILE` — per-org customizations path (unused by the modeler).
