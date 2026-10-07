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
- **Standalone:** keep it quiet too. The only user-facing output is a halt message (the active org is `adenin`, or a required tool could not be installed) or a setup action the user must see (installing a tool, getting the CLI on PATH, naming the host, or opening the sign-in link). A single brief line on the customizations file (check 4) is acceptable standalone. On all-pass with everything already installed and authenticated, say nothing.

---

## Check 1: Stay in the repo root

Never `cd`. The `semantius` CLI reads `./.env` from the current working directory (no parent search; only when there is none does it read the `.env` next to the executable), and Bun loads `.env.local` / `.env.<NODE_ENV>` from there too. So changing into a sibling project loads a different `.env` with different credentials pointing at a different instance, and every subsequent call lands on the wrong tenant. Run every `semantius` command from the session's repo root, full stop. If verifying something requires a different directory's config, ask the user to run it and paste the output. The global `.env` (`%APPDATA%\semantius\cli\.env` / `~/.config/semantius/cli/.env`) applies in every directory and fills whatever is still unset, so staying put does not escape it. Full order: use-semantius `references/cli-usage.md` § "Where `.env` files are read from".

This covers scripts as much as bare commands. The Bun helpers these skills stage under `.tmp_deploy/`, `.tmp_import/`, and `.tmp_admin/` spawn `semantius call …` as child processes, and a child inherits the shell's cwd — so a script run from inside its scratch folder never reads the repo's `.env`. Its calls then either fail with an auth error that reads like a CLI bug, or, worse, succeed with whatever the global `.env` or the current host supplies. Run every such script **from the repo root by path** (`bun run .tmp_import/run-<ts>/import.ts …`, `bun run .tmp_deploy/deploy_<slug>.ts`); the scripts resolve their inputs and outputs relative to their own file, so the working directory never needs to change. When a scratch folder needs a dependency install, use `bun add --cwd <folder> <pkg>` instead of `cd`. Never copy or symlink `.env` into a scratch folder to make a `cd` "work": those folders are gitignored scratch and must not carry credentials.

---

## Check 2: Install the supporting toolchain (Bun, jq, yq)

Besides the `semantius` CLI, these skills need three general-purpose tools on PATH:

- **Bun** — the mandated runtime. The modeler writes and runs its deploy and sample-data scripts with `bun run` (its only write path); the architect / analyst run `consistency-check.ts` with `bun`. Python is forbidden across these skills.
- **jq** — parses `semantius` JSON output, both in this preflight (check 3 reads `org` and `ui_baseurl` with `jq`) and throughout the architect / analyst bash flows.
- **yq** — Mike Farah's Go yq v4+, the engine behind the surgical `customizations.yaml` writes (admin Step 7 / `references/customizations-protocol.md`) that preserve hand-edits and provenance line-comments.

Install any that are missing, no prompt, one plain line per tool actually installed (e.g. *"Installing jq..."*). **This check runs before check 3**, because the CLI probe there parses JSON with `jq`, so `jq` must already be on PATH. After installing, if the tool is still not found (`command -v <tool>` on POSIX, `Get-Command <tool>` on Windows PowerShell), it is installed but not on the agent's PATH yet: a PATH change reaches only programs started afterwards. Do not stop. Look in the folder its installer uses:

| Installer | Folder |
|---|---|
| Bun installer | `~/.bun/bin` (Windows: `%USERPROFILE%\.bun\bin`) |
| winget | `%LOCALAPPDATA%\Microsoft\WinGet\Links` |
| scoop | `%USERPROFILE%\scoop\shims` |
| choco | `%ProgramData%\chocolatey\bin` |
| brew, apt / dnf / apk, snap | `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/snap/bin` (normally on PATH already) |

If it is there, call it by its full path for the rest of the run, and put that folder on PATH in the same command as any script that calls the tool by name (use-semantius `references/cli-usage.md` § "Installing from an agent" shows the form per shell). Tell the user once, in one line, how to get it on PATH for good: on Windows, restart VS Code or the agent app (a new terminal tab inside it is not enough); on Linux / macOS, open a new shell, or add the line the installer printed to the shell profile.

For each missing tool, prefer the platform's package manager; fall back to the project's static release binary when no package manager is present. Detect the platform and use the matching cell:

| Tool | Windows | macOS | Linux | Static-binary fallback (no package manager) |
|---|---|---|---|---|
| **Bun** | `powershell -c "irm bun.sh/install.ps1 | iex"` | `curl -fsSL https://bun.sh/install | bash` | `curl -fsSL https://bun.sh/install | bash` | installer above is already a direct download — see https://bun.sh/install |
| **jq** | `winget install -e --id jqlang.jq` (or `scoop install jq`, `choco install jq`) | `brew install jq` | `sudo apt-get install -y jq` / `sudo dnf install -y jq` / `sudo apk add jq` | download from https://github.com/jqlang/jq/releases/latest (`jq-windows-amd64.exe`, `jq-macos-arm64`/`-amd64`, `jq-linux-amd64`), `chmod +x`, place on PATH |
| **yq** | `winget install -e --id MikeFarah.yq` (or `scoop install yq`, `choco install yq`) | `brew install yq` | `sudo snap install yq` or `brew install yq` (NOT `apt install yq` — see footgun below) | download `yq_<os>_<arch>` from https://github.com/mikefarah/yq/releases/latest (e.g. `yq_linux_amd64`, `yq_darwin_arm64`, `yq_windows_amd64.exe`), `chmod +x`, place on PATH |

Reference flow (per tool: check, then install via the matching cell, then re-check). Use the block for the shell you are running in:

**Linux / macOS (bash/zsh):**
```bash
for tool in bun jq yq; do
  command -v "$tool" >/dev/null 2>&1 && continue
  # install via the platform cell above (package manager first, static binary fallback),
  # then re-check: command -v "$tool"  (if still missing, look in the installer's folder above and use the full path)
done
```

**Windows (PowerShell):**
```powershell
foreach ($tool in 'bun','jq','yq') {
  if (Get-Command $tool -ErrorAction SilentlyContinue) { continue }
  # install via the Windows cell above (winget/scoop/choco first, static-binary fallback),
  # then re-check: Get-Command $tool  (if still missing, look in the installer's folder above and use the full path)
}
```

**yq footgun (Linux especially).** The distro package named `yq` is frequently the *Python* yq (kislyuk/yq), whose syntax is incompatible and would break every `yq -i` write the customizations layer makes. Whether yq was already present or just installed, verify the right build is the one on PATH:

```bash
yq --version    # must report the mikefarah build, e.g. "yq (https://github.com/mikefarah/yq/) version v4.x"
```

If `yq --version` shows anything else (the Python yq, or a version below v4), install Mike Farah's Go binary explicitly via the static-binary fallback above, place it on PATH ahead of the wrong one, and re-check. Do not proceed with a non-mikefarah yq.

If any install fails, surface the verbatim error plus the tool's download page and stop. Do not limp on without a required tool — a missing `jq` silently breaks the org probe and the `adenin` guard in check 3, and a missing or wrong `yq` breaks every customizations write.

---

## Check 3: Ensure the `semantius` CLI is installed and authenticated, then halt if the active org is `adenin`

This is the front door for every Semantius call, so it self-heals a missing binary and routes a missing host or credential to the user instead of letting a raw CLI error surface later. One probe (`getCurrentUser`) folds the install check, the auth check, and the org/UI-base read into a single call. Probe once at the top of every invocation.

### 3a. Is the CLI on PATH? Install it if not (no prompt)

The `semantius` CLI ships as a **native installer, NOT an npm package**, so there is no base URL to ask for and no `npx` form. Detect it with `command -v semantius` (bash/zsh, Git Bash) or `Get-Command semantius -ErrorAction SilentlyContinue` (PowerShell). If it is missing from PATH, look in its install locations first, since a binary installed earlier in this session is not on the agent's PATH yet. Only if it is not there either, run the installer for this shell immediately (do not ask first), then look again. Install commands, install locations, and how to call the binary by its full path for the rest of the run (Bun scripts included): use-semantius `references/cli-usage.md` § "Installation" and § "Installing from an agent".

This is one of the places check 3 may speak to the user: at most one plain line, e.g. *"Installing the Semantius CLI..."*, and, when the binary is installed but not on PATH, one line on how to get it on PATH for good.

**If auto-install is not possible** — the install command fails, or the client sandbox forbids running it — do NOT limp on. Direct the user to install it themselves and stop until they confirm:

> "The Semantius CLI is required but I couldn't install it automatically. See **https://www.semantius.com/docs/cli/use-semantius/** for what it is and how to install it (Linux/macOS: `curl -fsSL …/install.sh | bash`; Windows PowerShell: `irm …/install.ps1 | iex`), then re-run."

### 3b. Probe once; this folds the auth check and reads org + UI base

One probe, three values (exit status, `semantius_org`, `ui_baseurl`). Read the web UI base from the SAME `getCurrentUser` call so any close-out can build a clickable "Open in Semantius" link; remember it for the rest of the run (as you do the org) and reuse it. Never hardcode the org host: the UI host (e.g. `tests.semantius.app`) differs from the API host (`tests.semantius.ai`), and only `getCurrentUser` knows the right one. Use the block for your shell:

**Linux / macOS (bash, parses with `jq`):**
```bash
me=$(semantius call crud getCurrentUser 2>&1) && rc=0 || rc=$?
org=$(printf '%s' "$me" | jq -r .semantius_org 2>/dev/null)
ui_baseurl=$(printf '%s' "$me" | jq -r .ui_baseurl 2>/dev/null)   # e.g. https://tests.semantius.app
```

**Windows (PowerShell, parses with `ConvertFrom-Json` — no jq needed):**
```powershell
# Pass '{}' explicitly. A bare no-argument `semantius call` reads its payload
# from stdin; in a persistent PowerShell session that stdin pipe never reaches
# EOF, so the call hangs forever with no error and no timeout (not a
# network/auth problem — do not retry, add the explicit '{}' instead).
$me = (semantius call crud getCurrentUser '{}' 2>&1 | Out-String); $rc = $LASTEXITCODE
$obj = try { $me | ConvertFrom-Json } catch { $null }
$org = $obj.semantius_org
$ui_baseurl = $obj.ui_baseurl   # e.g. https://tests.semantius.app
```

**Parse the full `getCurrentUser` response — never pipe it through `head` / `tail` / `cut` before `jq`.** The blocks above capture the whole output into a variable and read `semantius_org` and `ui_baseurl` with independent `jq` / `ConvertFrom-Json` reads; do not truncate the JSON, or you silently drop `ui_baseurl` (a single-line response means even `head -1` is not safe to assume). Keep the capture-then-parse shape.

**A successful probe ends credential handling.** If `getCurrentUser` returns a user object with `semantius_org`, authentication is settled for the entire session, whatever supplied it (a sign-in, an API key, a JWT-preauthenticated environment, credentials injected by the harness). Do not inspect, create, or edit `.env`, and do not revisit credentials later in the run.

If the probe fails (non-zero exit, or no `semantius_org` in the response), follow use-semantius `references/cli-usage.md` § "Checking the connection", re-probe after each fix, and continue only once `getCurrentUser` returns a user object with `semantius_org`. In short:

- **CLI not found** (`command not found` / `not recognized` / ENOENT): back to 3a.
- **Exit `3`:** re-probe once. If it fails again, show the error verbatim and stop: *"The Semantius API isn't reachable right now. Please check connectivity and re-run."* It is not an auth failure; never touch credentials over it.
- **`MISSING_ENV_VAR` or exit `5`:** sign the user in with `semantius use <host>` as cli-usage § "Signing the user in" describes: in the background, relaying the link, with `--login-flow device` when the user is not at this machine's screen. Ask for the host unless `whoami` shows it as `current`: *"Which Semantius host should I connect to? (for example `acme.semantius.app`) No instance yet? Sign up at https://app.semantius.com to get yours and the steps to connect."*. Then: *"Open <url> to sign in"* (device grant: *"Open <url> and enter the code <code>"*). Exception: an error naming `SEMANTIUS_API_KEY` or `SEMANTIUS_JWT` in a deliberate key or token setup (CI, a JWT-preauthenticated agent): show it and stop.
- **Anything else**, including "required audience not found" (a server-side configuration problem): show the error verbatim and stop.

Never run `logout`, never pick a host yourself, never ask for a base URL or an API key, never write a key to a `.env`, never offer to provision anything. A user who wants an API key sets it up themselves (cli-usage § "API keys"). All of this stays out of chat except the install line, the PATH line, the host question and the sign-in link.

**If the setup uses an API key, never carry it forward inline.** The CLI reads `SEMANTIUS_API_KEY` from the environment or a `.env` on every call, so never hardcode it or re-emit it in an inline `export SEMANTIUS_API_KEY=...` in a later command. A key pasted into chat can carry invisible corruption — most commonly a literal `…` (U+2026 horizontal ellipsis) or `...` where a console truncated a long token for display, plus stray whitespace or smart quotes — and an inline copy bypasses the value the probe validated. If a probe ever fails with an auth error *after* a successful one, suspect a stale inline copy first.

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
