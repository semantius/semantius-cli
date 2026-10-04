# semantius

The official CLI for the [Semantius](https://semantius.com) platform. Connect to your Semantius organization's MCP servers to interact with your data, tools, and APIs directly from the command line or AI agents.

## Quick Start

> **Setting up through an AI agent?** Read
> [Setting up through an AI agent](#setting-up-through-an-ai-agent), below
> the steps, first.

### 1. Install the CLI

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
```

The installer puts `semantius` in `$INSTALL_DIR` if you set it, else in
`/usr/local/bin` if you can write there (as root, and on many Intel Macs),
otherwise in `~/.local/bin`. It does not change your PATH: if the directory it
installed into is not on it, it prints the line that adds that directory to
your shell's startup file. macOS never has `~/.local/bin` on the PATH; many
Linux distributions add it at your next login. If another `semantius` comes
earlier on your PATH, the installer warns and names both files: typing
`semantius` would start that one, not the one just installed.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex
```

The installer puts `semantius.exe` in `%LOCALAPPDATA%\Programs\Semantius` and
adds that folder to your user PATH, which only programs started afterwards
see: open a new terminal, and restart VS Code or any other app whose terminals
or agents should find `semantius`. Use this installer from Git Bash too —
`install.sh` does not support Windows; run there, it stops with
`Unsupported OS` and prints the PowerShell command to use instead.

Until your PATH has it, run the binary by the path on the installer's
`Location:` line.

### 2. Install the agent skills

```bash
npx skills add semantius/semantius-cli -g
```

This installs the Semantius skills (`use-semantius`, `semantius-architect`,
`semantius-admin`, …) from this repository's [`skills/`](skills/) folder for
your coding agents, for your user account. **Keep `-g`:** without it they land
in `.claude/skills/` (or your agent's equivalent) of whatever directory you run
it in. It asks which agents to install into only if it cannot detect one.
Requires Node.js 22.20 or later, and git. Your agent may need a new session to
pick the skills up.

### 3. Sign up or sign in

Sign up for a Semantius data platform, or sign in to yours, at
**https://app.semantius.com/**. Once your instance is provisioned, the
dashboard's Get Started card shows its address,
`https://<your-org>.semantius.app`. Already have an instance? Go straight to
step 4.

### 4. Connect the CLI to your instance

```bash
semantius use https://<your-org>.semantius.app
```

Use the address from step 3 as it is (a path after the host is not accepted).
Unless a usable session for it is already stored, `use` opens your browser to
sign in (it waits up to 5 minutes), then makes the instance your **current
host** in every directory.

- **Not sitting at this machine?** On a server, in a container or an SSH
  session, on a remote VM, or for an always-on agent, add
  `--login-flow device`: it prints a URL and a code to enter on your phone or
  laptop instead. See
  [Signing in on a headless or always-on machine](#signing-in-on-a-headless-or-always-on-machine).
- From now on the CLI — and any agent using it — acts **as you**, with your
  permissions. For narrower access you can revoke on its own, use an API key
  instead: see [Delegated vs. dedicated access](#delegated-vs-dedicated-access).
- A self-hosted instance works the same way:
  `semantius use https://semantius.example.com`.

### 5. Verify the connection

```bash
semantius whoami
```

It calls your instance and shows the host (as
`<your-org>.semantius.cloud (current)`), where that host came from, your user
and roles, `auth_method  oauth`, and when the session's access token expires.
If the instance cannot be reached — a network failure, a timeout or a 5xx,
while connecting or during the call — it exits `3`, and trying again later can
work; without a usable credential it exits `5`.

### Setting up through an AI agent

Notes for an agent that follows the steps above for its user:

- **Step 1.** On Windows, use `install.ps1` from any shell:
  `powershell -NoProfile -Command "irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex"`.
  Your shell does not see the new PATH (and on Linux/macOS there is none), so
  call the binary by its full path: PowerShell
  `& "$env:LOCALAPPDATA\Programs\Semantius\semantius.exe"`, Git Bash
  `"$LOCALAPPDATA/Programs/Semantius/semantius.exe"`, Linux/macOS the path on
  the installer's `Location:` line. Tell the user to restart the agent app
  (Windows) or to add the PATH line the installer printed (Linux/macOS);
  otherwise the skills will not find `semantius` in the next session.
- **Step 2.** Inside Claude Code, `npx -y skills add semantius/semantius-cli -g`
  runs without prompting. Elsewhere add `-a <agent> -y` (e.g.
  `-a claude-code`). Without Node.js or git, copy each folder under
  [`skills/`](skills/) into the agent's skills folder (`~/.claude/skills/` for
  Claude Code).
- **Step 4.** Start `semantius use <address>` as a **background** command,
  read its output and give the user the sign-in URL; on Windows and macOS a
  browser tab opens on this machine as well. Whenever the user is not at this
  machine's screen — a cloud or always-on agent, a remote or SSH session, a
  container, headless Linux — add `--login-flow device` and give the user the
  URL and code it prints; it waits up to 10 minutes. Don't run it in the
  foreground: you can show the user nothing until it ends, and a tool timeout
  can kill the sign-in. If a usable session is already stored, it finishes at
  once, without a browser.
- **Step 5.** `semantius whoami`.
- **Fully non-interactive:** an API key, in the global `.env` or the `.env`
  next to the executable, and no `semantius use` (a current host makes the CLI
  ignore API keys). See
  [Credentials](#credentials-sources-and-evaluation-order).

API keys, `.env` files, static JWTs and `--token` — for scripts and CI — are
covered in [Credentials](#credentials-sources-and-evaluation-order); everyday
use in [Usage](#usage). No config file is needed: the `crud` tools run inside
the CLI against your organization's PostgREST API, and `cube` (analytics) is
reached as a Semantius MCP server. `--crud-mcp` sends the `crud` tools through
the Semantius cloud MCP server instead (the only way to use `sqlToRest`).

## Usage

```
semantius [options]                             List all servers and tools
semantius [options] info <server>               Show server tools and parameters
semantius [options] info <server> <tool>        Show tool schema
semantius [options] grep <pattern>              Search tools by glob pattern
semantius [options] call <server> <tool>        Call tool (reads JSON from stdin if no args)
semantius [options] call <server> <tool> <json> Call tool with JSON arguments
semantius [options] ping [-n [count]]           Check connectivity & latency: crud/getCurrentUser (one PostgREST round trip; the cloud MCP server with --crud-mcp)
semantius [options] whoami                      Show current user (email, org, roles) and the resolved host
semantius [options] login                       Sign in with the browser; stores the session for the host
semantius [options] logout                      Revoke and delete the stored session for the host
semantius [options] hosts [--json]              List every host this machine has a session or is current for
semantius use <host>                            Make <host> the current host (signs in first unless a usable session is stored)
semantius use --clear                           Unset the current host (session and hosts entry untouched)
```

**Both formats work:** `info <server> <tool>` or `info <server>/<tool>`

> [!TIP]
> Add `-d` to any command to include descriptions.

### Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help message |
| `-v, --version` | Show version number |
| `-d, --with-descriptions` | Include tool descriptions |
| `-md, --markdown` | Dump full documentation as markdown: this README, then every server's tools |
| `-n [count]` | (ping only) Run N pings and report per-request latency + min/max/avg. `-n` without a value defaults to 5 |
| `--json` | (`hosts` only) Machine-readable output instead of the table |
| `--clear` | (`use` only) Unset the current host instead of setting one: `semantius use --clear` |
| `--env <prefix>` | Env var prefix (default `SEMANTIUS`), e.g. `--env PROD` reads `PROD_API_KEY` / `PROD_ORG` |
| `-c, --config <path>` | Path to `mcp_servers.json`, instead of searching `./mcp_servers.json`, `~/.mcp_servers.json` and `~/.config/mcp/mcp_servers.json`. A `.env` beside it fills unset variables, but never the host or credential ones (see [Where variables come from](#where-variables-come-from)). Also `SEMANTIUS_CONFIG_PATH` |
| `--host <hostname>` | Semantius host to talk to, `hostname[:port]` (see [Hosts](#hosts-managed-cloud-and-self-hosted)). Also `SEMANTIUS_HOST`. Not combinable with `--token`/`--token-file` |
| `--auth <source>` | Use exactly one credential source: `jwt`, `apikey` or `oauth` (the stored browser session). Not combinable with `--host` for `jwt`/`apikey` |
| `--token <org:jwt \| ->` | A JWT for just this invocation, binding it to `<org>.semantius.cloud` — wins over the current host and any `SEMANTIUS_HOST`/`SEMANTIUS_ORG` from the environment or `.env`. `-` reads it from stdin; a literal value is visible in the shell history and process list, so prefer `-` or `--token-file`. Not combinable with `--host`, `--auth apikey`/`oauth`, or `--login` |
| `--token-file <path>` | Same as `--token`, read from a file (`org:jwt`, trimmed) |
| `--login` | Sign in with the browser first, then run the command with that session (needs an interactive terminal). On `cube` and with `--crud-mcp`, an API key or JWT from the environment still takes precedence over the session |
| `--login-flow <mode>` | How an interactive sign-in happens: `auto` (default), `browser` or `device` (a URL and a code to enter on another device). Use `device` whenever the person signing in is not at this machine — see [Signing in on a headless or always-on machine](#signing-in-on-a-headless-or-always-on-machine). Also `SEMANTIUS_LOGIN_FLOW` |
| `--crud-mcp` | Route the `crud` server through the Semantius cloud MCP server instead of the local PostgREST layer (cloud only). Also `SEMANTIUS_CRUD_MCP=1` |
| `--stream` | (`call crud postgrestRequest` only) Pipe the PostgREST response body to stdout unchanged — see [Streaming large reads](#streaming-large-reads---stream). Also `SEMANTIUS_STREAM=1` |
| `--disable-jwt-cache` | Skip the token cache and re-authenticate on every request (see [Token cache](#token-cache)) |
| `--reset-cache` | Delete the cached token for the current API key and the cached host lookup before running (alias: `--reset-jwt-cache`) |


### Output

| Stream | Content |
|--------|---------|
| **stdout** | Tool results and human-readable info |
| **stderr** | Errors and diagnostics |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Client error: bad arguments, config or JSON, an invalid host name, an organization the control plane does not know — or, with `--single`, 0 rows |
| `2` | `--single`: 2+ rows |
| `3` | Network or transport failure, transient: no answer, a timeout, a 5xx or a 429. Includes a session refresh the token endpoint could not serve (the session is kept), and `use`, `login`, `logout` or `whoami` running into any of these. Trying again later can work |
| `4` | The tool failed: RLS, a duplicate key, schema errors |
| `5` | Authentication: no credentials, an API key or token refused (401/403), a session the token endpoint refuses to refresh, or a sign-in that cannot happen here |

### Commands

#### List Servers

```bash
# Basic listing
$ semantius
github
  • search_repositories
  • get_file_contents
  • create_or_update_file
filesystem
  • read_file
  • write_file
  • list_directory

# With descriptions
$ semantius --with-descriptions
github
  • search_repositories - Search for GitHub repositories
  • get_file_contents - Get contents of a file or directory
filesystem
  • read_file - Read the contents of a file
  • write_file - Write content to a file
```

#### Search Tools

```bash
# Find file-related tools across all servers
$ semantius grep "*file*"
github/get_file_contents
github/create_or_update_file
filesystem/read_file
filesystem/write_file

# Search with descriptions
$ semantius grep "*search*" -d
github/search_repositories - Search for GitHub repositories
```

#### View Server Details

```bash
$ semantius info github
Server: github
Transport: stdio
Command: npx -y @modelcontextprotocol/server-github

Tools (12):
  search_repositories
    Search for GitHub repositories
    Parameters:
      • query (string, required) - Search query
      • page (number, optional) - Page number
  ...
```

#### View Tool Schema

```bash
# Both formats work:
$ semantius info github search_repositories
$ semantius info github/search_repositories

Tool: search_repositories
Server: github

Description:
  Search for GitHub repositories

Input Schema:
  {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "page": { "type": "number" }
    },
    "required": ["query"]
  }
```

#### Call a Tool

```bash
# With inline JSON
$ semantius call github search_repositories '{"query": "mcp server", "per_page": 5}'

# JSON output is default for call command
$ semantius call github search_repositories '{"query": "mcp"}' | jq '.content[0].text'

# Read JSON from stdin (no '-' needed!)
$ echo '{"path": "./README.md"}' | semantius call filesystem read_file

```

#### Complex Commands

For JSON arguments containing single quotes, special characters, or long text, use **stdin** to avoid shell escaping issues:

```bash
# Using a heredoc (no '-' needed with call subcommand)
semantius call server tool <<EOF
{"content": "Text with 'single quotes' and \"double quotes\""}
EOF

# From a file
cat args.json | semantius call server tool

# Using jq to build complex JSON
jq -n '{query: "mcp", filters: ["active", "starred"]}' | semantius call github search
```

**Why stdin?** Shell interpretation of `{}`, quotes, and special characters requires careful escaping. Stdin bypasses shell parsing entirely.

#### Streaming large reads (`--stream`)

`call crud postgrestRequest --stream` sends the same request as without the
flag but pipes PostgREST's response body straight to stdout — no JSON
parsing, no MCP envelope, no pretty-printing — which is the fastest way to
pull large result sets:

```bash
semantius call crud postgrestRequest --stream '{"method":"GET","path":"/orders?limit=10000"}' | jq length

# CSV export (only possible with --stream)
semantius call crud postgrestRequest --stream '{"method":"GET","path":"/orders","accept":"text/csv"}' > orders.csv
```

- The output is exactly what PostgREST returns: **compact** JSON, or CSV with
  `"accept": "text/csv"`. Consumers that parse JSON (`jq`) keep working;
  anything that diffs the pretty-printed output of a normal call does not.
- Errors print `Error: (<code>) <message>` to stderr. Exit codes: 401/403 → 5,
  5xx or network failure → 3, any other non-2xx → 4.
- Not combinable with `--single`, `--diag` or `--crud-mcp`, and only for
  `postgrestRequest` (exit 1 otherwise). JSON arguments from stdin work as usual.
- `SEMANTIUS_STREAM=1` turns it on for every call where it is valid and is
  ignored for all others.

#### Advanced Chaining Examples

Chain multiple MCP calls together using pipes and shell tools:

```bash
# 1. Search and read: Find files matching pattern, then read the first one
semantius call filesystem search_files '{"path": "src/", "pattern": "*.ts"}' \
  | jq -r '.content[0].text | split("\n")[0]' \
  | xargs -I {} semantius call filesystem read_file '{"path": "{}"}'

# 2. Process multiple results: Read all matching files
semantius call filesystem search_files '{"path": ".", "pattern": "*.md"}' \
  | jq -r '.content[0].text | split("\n")[]' \
  | while read file; do
      echo "=== $file ==="
      semantius call filesystem read_file "{\"path\": \"$file\"}" | jq -r '.content[0].text'
    done

# 3. Extract and transform: Get repo info, extract URLs
semantius call github search_repositories '{"query": "mcp server", "per_page": 5}' \
  | jq -r '.content[0].text | fromjson | .items[].html_url'

# 4. Conditional execution: Check file exists before reading
semantius call filesystem list_directory '{"path": "."}' \
  | jq -e '.content[0].text | contains("README.md")' \
  && semantius call filesystem read_file '{"path": "./README.md"}'

# 5. Save output to file
semantius call github get_file_contents '{"owner": "user", "repo": "project", "path": "src/main.ts"}' \
  | jq -r '.content[0].text' > main.ts

# 6. Error handling in scripts
if result=$(semantius call filesystem read_file '{"path": "./config.json"}' 2>/dev/null); then
  echo "$result" | jq '.content[0].text | fromjson'
else
  echo "File not found, using defaults"
fi

# 7. Aggregate results from multiple servers
{
  semantius call github search_repositories '{"query": "mcp", "per_page": 3}'
  semantius call filesystem list_directory '{"path": "./src"}'
} | jq -s '.'
```

**Tips for chaining:**
- Use `jq -r` for raw output (no quotes)
- Use `jq -e` for conditional checks (exit code 1 if false)
- Use `2>/dev/null` to suppress errors when testing
- Use `| jq -s '.'` to combine multiple JSON outputs


## Configuration

### Credentials: sources and evaluation order

There are four ways to authenticate:

| Credential | How you set it | Typical use |
|---|---|---|
| Browser session | `semantius use <host>`, or `semantius login` | Working as yourself (see [Quick Start](#quick-start)) |
| API key | `SEMANTIUS_API_KEY`, with `SEMANTIUS_ORG` or an `org:` prefix | Scripts, CI, unattended agents |
| Static JWT | `SEMANTIUS_JWT` | A token obtained elsewhere, sent as-is |
| One-off token | `--token -`, `--token-file <path>`, `--token <org:jwt>` | A single invocation, without any `.env` |

```bash
# An API key and its organization, exported in the shell (or put in a .env, see below)
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name

# The same in one value: an "org:" prefix names the key's organization
export SEMANTIUS_API_KEY=your-org-name:your-api-key

# A static JWT: sent directly, with no token exchange and no token cache;
# it takes the "org:" prefix too
export SEMANTIUS_JWT=your-org-name:eyJhbGciOi...

# A token for just this one invocation
echo your-org-name:eyJhbGciOi... | semantius --token - whoami   # from stdin (preferred)
semantius --token-file ./token.txt whoami                        # from a file
semantius --token your-org-name:eyJhbGciOi... whoami              # literal (shell history!)
```

API keys are created under **API Keys** at
`https://<your-org>.semantius.app/settings`, which the dashboard at
https://app.semantius.com/dashboard links to.

#### Where variables come from

Variables are read from these places, in this order. A place never overrides a
variable an earlier one already set — not even one exported as empty:

1. **Your shell environment.**
2. **The project `.env`:** a `.env` in the current directory (only that
   directory; parent directories are not searched) or, when there is none,
   the `.env` next to the executable. Only one of the two is read.
3. **The global `.env`** in your user config directory, always read, last.

Credentials meant for the whole machine can go in either of two files:

| File | Location | Read when | Applies to |
|---|---|---|---|
| The `.env` next to the executable | The install folder: `%LOCALAPPDATA%\Programs\Semantius\.env` on Windows; `~/.local/bin/.env` or `/usr/local/bin/.env` on Linux/macOS | Only when the current directory has no `.env` | Everyone who runs that binary |
| The global `.env` | `%APPDATA%\semantius\cli\.env` on Windows; `~/.config/semantius/cli/.env` on Linux/macOS | Always, filling whatever is still unset | Your user account |

The installer creates neither file: create the one you want. Two more
sources, for completeness. Bun itself loads `.env.local` and
`.env.<NODE_ENV>` (`.env.production`, `.env.development` or `.env.test`) from
the current directory before the CLI starts, and the CLI treats what they set
as shell variables. And a `.env` beside the config file in use — one passed
with `-c` / `SEMANTIUS_CONFIG_PATH`, or one found on its own
(`./mcp_servers.json`, `~/.mcp_servers.json`, `~/.config/mcp/mcp_servers.json`)
— is read after the host and its credential have been chosen. It fills the
variables that are still unset, such as a `${VAR}` the config file refers to,
but never `SEMANTIUS_HOST`, `SEMANTIUS_ORG`, `SEMANTIUS_API_KEY` or
`SEMANTIUS_JWT` (nor their `--env <prefix>` forms): set those in one of the
three places above.

#### Which host

One host per invocation, first match wins: `--host`, then `--token`'s
organization, then the current host set by `semantius use`, then
`SEMANTIUS_HOST` / `SEMANTIUS_ORG` from the shell, the project `.env` and the
global `.env`, in that order. The details are in
[Hosts](#hosts-managed-cloud-and-self-hosted).

#### Which credential

First match wins:

1. `--token` / `--token-file`: a JWT for this invocation only.
2. **If the host came from `--host` or from the current host (`semantius use`),
   only the browser session stored for that host is used.** An API key, JWT
   or organization from the environment or any `.env` is then ignored —
   silently, not an error — so it is never sent to a host it was not set up
   for. If no session is stored, the command exits `5` saying so, with the
   two ways out: on the current host, `semantius use <host>` to sign in or
   `semantius use --clear` to use the key; with `--host`,
   `semantius login --host <host>`, or drop `--host` and set `SEMANTIUS_HOST`
   next to the key.
3. `SEMANTIUS_JWT`: sent as-is, with no exchange and no cache.
4. `SEMANTIUS_API_KEY`: exchanged for a short-lived token at the host's token
   endpoint, and cached per host (see [Token cache](#token-cache)).
5. The browser session stored for this host (see [Browser login](#browser-login)).

Without any of them, commands that call the platform exit `5` with
"Authentication required". `--auth jwt|apikey|oauth` picks one of 3–5
explicitly; `--login` signs in first and then uses the session.

To use an API key with a particular host, set `SEMANTIUS_HOST` next to it and
have no current host (`semantius use --clear`), or keep several pairs side by
side with `--env <prefix>` (`<PREFIX>_HOST`, `<PREFIX>_API_KEY`): the current
host is stored per prefix.

On `cube`, and with `--crud-mcp`, the CLI talks to the Semantius cloud MCP
server, which takes credentials slightly differently: an API key or JWT that
applies always wins there over the session (`--auth` and `--login` don't
change that), and the API key is exchanged through the MCP server rather than
the host's token endpoint.

#### Credentials that name their organization

An `org:` prefix on `SEMANTIUS_API_KEY` or `SEMANTIUS_JWT` makes it a **bound
credential**: it names its organization, and with it the host
`<org>.semantius.cloud`, the way `SEMANTIUS_ORG` would. A bound credential
belongs to the place it is set in — the shell, the project `.env`, or the
global `.env`:

- A `SEMANTIUS_HOST` or a plain `SEMANTIUS_ORG` **in the same place** that
  names a different host is an error (`HOST_CONFLICT`) naming both.
- If something earlier — `--host`, `--token`, the current host, or an earlier
  place — already decided the host, the bound credential is not used at all,
  rather than sent to a host it was not issued for.

A credential *without* the prefix belongs to no place: a plain
`SEMANTIUS_API_KEY` in the global `.env` is also used for a `SEMANTIUS_HOST`
set in a project `.env`.

#### Delegated vs. dedicated access

- **`semantius use` and `semantius login` delegate your account.** The CLI, and
  any agent or script driving it, acts as you, with every permission your
  roles give you. That lasts as long as the session can be renewed;
  `semantius logout` ends it.
- **An API key is a separate credential**, created, labelled and revoked on
  its own at `https://<your-org>.semantius.app/settings`. A personal key
  (prefix `uk-`) still acts as you. An admin can also create a key for another
  user (prefix `sk-`), for example a dedicated service user with a narrower
  role: an agent or CI job then gets only that user's permissions, and its
  access can be revoked without touching your own sign-in.

Use your own session for interactive work, and a dedicated user's key for
unattended agents and CI. Keep keys out of version control: in the global
`.env`, the `.env` next to the executable, or a CI secret — not in a project
`.env` you commit.

#### Examples

| Setup | Host | Credential used |
|---|---|---|
| Project `.env`: `SEMANTIUS_HOST=x.example.com` and `SEMANTIUS_API_KEY=k` | `x.example.com` | The API key |
| A `.env` with only `SEMANTIUS_API_KEY=acme:k` | `acme.semantius.cloud` | The API key |
| `semantius use b.semantius.cloud` was run; project `.env` has `SEMANTIUS_API_KEY=k` | `b.semantius.cloud` | The session stored for it; the key is ignored |
| Project `.env`: `SEMANTIUS_HOST=x.example.com`; global `.env`: `SEMANTIUS_API_KEY=k` | `x.example.com` | The API key from the global `.env` |
| Shell: `SEMANTIUS_ORG=acme`; project `.env`: `SEMANTIUS_API_KEY=other:k` | `acme.semantius.cloud` | The session stored for it, if any; the key is bound to `other` and never reached |
| `semantius --token acme:eyJ… whoami` | `acme.semantius.cloud` | That token |

### Environment Variables

All env vars use a configurable prefix (default `SEMANTIUS_`). Pass
`--env <prefix>` to switch — e.g. `--env PROD` reads `PROD_API_KEY`,
`PROD_TIMEOUT`, `PROD_LOG_FILE`, etc., so you can keep separate DEV/STAGE/PROD
configurations side by side in the same `.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIUS_ORG` | Organization on the managed cloud; names the host `<org>.semantius.cloud`. Not needed when something else names the host: `SEMANTIUS_HOST`, `--host`, `--token`, the current host, or an `org:` prefix on the API key or JWT (see [Hosts](#hosts-managed-cloud-and-self-hosted)) | (none) |
| `SEMANTIUS_HOST` | Hostname, same as `--host` (see [Hosts](#hosts-managed-cloud-and-self-hosted)) | `${SEMANTIUS_ORG}.semantius.cloud` |
| `SEMANTIUS_API_KEY` | API key (see [Credentials](#credentials-sources-and-evaluation-order)). Value may be `org:key`: the prefix names the host like `SEMANTIUS_ORG`, and a `SEMANTIUS_ORG` or `SEMANTIUS_HOST` in the same place that disagrees is a `HOST_CONFLICT` | (none) |
| `SEMANTIUS_JWT` | Static JWT sent as `Authorization: Bearer` directly — skips the token exchange and the token cache entirely. Value may be `org:jwt`, bound the same way as the API key; it is tried before the API key | (none) |
| `SEMANTIUS_LOGIN_FLOW` | `auto`, `browser` or `device`: same as `--login-flow`. Set it to `device` in the global `.env` (or the one next to the executable) of a machine nobody sits at | `auto` |
| `SEMANTIUS_CRUD_MCP` | `1` = same as `--crud-mcp` | `false` |
| `SEMANTIUS_STREAM` | `1` = `--stream` for every `call crud postgrestRequest` where it is valid (no `--single`/`--diag`/`--crud-mcp`); ignored for other calls | `false` |
| `SEMANTIUS_SIDE_EFFECT_TIMEOUT` | On the managed cloud, creating/updating/deleting entities or fields asks the cloud MCP server to refresh the PostgREST schema cache; the CLI waits up to this many seconds for that before exiting | `10` |
| `SEMANTIUS_CONFIG_PATH` | Path to config file, same as `-c` / `--config` | (none) |
| `SEMANTIUS_DEBUG` | Enable debug output | `false` |
| `SEMANTIUS_TIMEOUT` | Request timeout (seconds) | `1800` (30 min) |
| `SEMANTIUS_CONCURRENCY` | Servers processed in parallel (not a limit on total) | `5` |
| `SEMANTIUS_MAX_RETRIES` | Retry attempts for transient errors (0 = disable) | `3` |
| `SEMANTIUS_RETRY_DELAY` | Base retry delay (milliseconds) | `1000` |
| `SEMANTIUS_STRICT_ENV` | Error on missing `${VAR}` in config | `true` |
| `SEMANTIUS_NO_DAEMON` | Disable connection caching; open a fresh connection per call (Linux/macOS only — no-op on Windows) | `false` |
| `SEMANTIUS_DAEMON_TIMEOUT` | How long a cached connection stays open after last use (seconds, Linux/macOS only) | `300` |
| `SEMANTIUS_DISABLE_JWT_CACHE` | Disable the encrypted token cache; re-authenticate on every request | `false` |
| `SEMANTIUS_LOG_FILE` | Append one JSONL line per invocation to this path. Bare filename is written next to the loaded `.env` (or in the user config dir); absolute/relative paths are used as-is. Daemon lifecycle transitions are also logged (at any level) as `log_type: "event"` lines: `daemon_start` when a CLI invocation spawns a daemon, and `daemon_stop` (with `reason` — `idle_timeout`, `sigterm`, `sigint`, or `close_request` — and `uptime_ms`) when it shuts down. | (none) |
| `SEMANTIUS_LOG_LEVELS` | Comma-separated subset of `{all, error, slow, jwt}` that filters which invocations are logged. `error` = exit code != 0; `slow` = wall time > 1000 ms; `jwt` = error mentions "JWT" (also adds a structured `jwt` field with the token value and appends one JSONL line per JWT-retry attempt). Multiple values OR-combine (e.g. `error,slow`). Unknown/empty falls back to `all`. | `all` |

### Hosts: managed cloud and self-hosted

The CLI talks to one Semantius host per invocation, taken from the first of:

1. `--host <hostname>` — this invocation only
2. `--token` / `--token-file`'s own organization (see
   [Credentials](#credentials-sources-and-evaluation-order)) — can't be combined with `--host`
3. The **current host**, set by `semantius use <host>` — see below
4. `SEMANTIUS_HOST`, else `SEMANTIUS_ORG` — checked in the shell environment,
   then the project `.env`, then the global `.env` (see
   [Where variables come from](#where-variables-come-from)); host
   is checked before org *within* each of those three, and the walk only
   moves on to the next one when neither is set there. An `"org:"`-prefixed
   `SEMANTIUS_API_KEY` / `SEMANTIUS_JWT` (a **bound credential**) supplies the
   org the same way a bare `SEMANTIUS_ORG` would, for wherever its own
   variable happens to be set. A `SEMANTIUS_HOST` or a plain `SEMANTIUS_ORG`
   set *alongside* a bound credential in that same place (the same shell, or
   the same `.env` file) that names a *different* host or org is a
   `HOST_CONFLICT` error naming both; a bound credential whose place the walk
   never reaches — because an earlier place already resolved a host — is
   never consulted at all, and is ignored as a credential too, not just
   skipped for the conflict check, so it can never be silently sent to a
   host it wasn't issued for.

A host is a hostname with an optional port (`acme.semantius.cloud`,
`semantius.example.com:8443`); a leading `https://` or `http://` is ignored.
The CLI always connects over HTTPS, except to `localhost` / `127.x.x.x`, which
use plain HTTP (local development servers).

A host under `.semantius.cloud` (e.g. `--host acme.semantius.cloud`) is the
**managed cloud**: its first label is the organization (and overrides
`SEMANTIUS_ORG`), and the tenant's PostgREST URL is looked up once on the
Semantius control plane and cached for 24 hours in
`<user config dir>/hosts/`. The other per-org cloud names —
`<org>.semantius.app` (web app), `<org>.semantius.ai` (MCP server),
`<org>.semantius.io` (analytics) — are mapped to `<org>.semantius.cloud`, so
pasting the web app's address works. Any other host (`--host semantius.example.com`)
is **self-hosted**: PostgREST is expected at `https://<host>/rest`, the token
exchange at `https://<host>/api/auth/token`, and there is no `cube` (analytics)
server and no cloud MCP server, so `--crud-mcp` is not available. Those paths are
fixed, so resolving a self-hosted host needs no network at all. What a browser
login needs on top of them — the OAuth client id, the audience, the identity
provider — comes from `https://<host>/.well-known/semantius.json`, which is read
only when a login or a token refresh actually happens (see
[Browser login](#browser-login)).

With `--host`, or on the current host (see below), only the browser session
stored for that host is used; an API key or JWT from the environment is
ignored. See [Which credential](#which-credential).

#### The current host, and `semantius hosts` / `semantius use`

`semantius use <host>` makes `<host>` your **current host**: it applies in
every directory, ahead of `SEMANTIUS_HOST` / `SEMANTIUS_ORG` — whether from
your shell or a project's own `.env` — until you run `use` again or clear it.
If there's no session stored for `<host>`, or the stored one can no longer
be renewed, `use` signs you in first (the same flow as
`semantius login --host <host>`), then records the session and makes the host
current. A stored session is checked the way the next command would use it:
one whose access token is still fresh costs no network, and one that is due
is renewed once. If that renewal fails for a reason that says nothing about
the session — the network, or a server error — `use` reports the error,
exits `3` and leaves your current host as it was. So does any other network
failure, timeout, 5xx or 429 while it resolves the host or signs you in; a
host name that is wrong (invalid, or an organization the control plane does
not know) exits `1`, and a sign-in that cannot happen here exits `5`.
`login` and `logout` exit `3` the same way when the network or a server fails
them. `semantius login` on its own
never touches the current host; it only ever stores a session for whatever
host it resolves to. `semantius use` is the one command that decides what
your host is.

**Outranking a project's own `.env` is deliberate, not a bug:** once you run
`use`, it is meant to be the answer to "which host?" until you explicitly
change it — an explicit decision should not be silently overridden by
whatever a project's `.env` happens to contain, especially since that `.env`
was likely written before you ever ran `use`. A project's `.env` therefore cannot
change the host while a current host is set. To reach another host anyway,
pass `--host` or `--token` for one invocation, or use a different
`--env <prefix>`: the current host is stored per prefix, so a prefix with no
current host of its own falls through to its `<PREFIX>_HOST` /
`<PREFIX>_API_KEY` variables. `semantius whoami`'s `host_source` row always tells you which one
actually won.

```bash
semantius hosts                        # every host this machine has a session or is current for
semantius hosts --json                 # the same, machine-readable
semantius use acme.semantius.cloud     # sign in if needed, then make it current
semantius use --clear                  # unset the current host (the session and hosts entry are kept)
```

`semantius hosts` prints a table — host, mode, org, whether a session is
stored, its expiry — with `*` on the current host and a trailing `current:
<host> (<source>)` line showing what this directory actually resolves to right
now (`--host` or `--token` still override it for one invocation). It works
even with nothing configured at all, or with a conflicting setup, since it —
and `use` — are exactly how you inspect and fix that.

`semantius logout` on the current host clears it too (with a hint to run `use`
again) and stops any running background connection daemon, so a revoked
session can't linger in a cached connection (Linux/macOS only; no daemon on
Windows).

### Browser login

You can sign in instead of managing keys:

```bash
semantius login                              # the environment's host
semantius login --host acme.semantius.app    # a specific organization
semantius login --host semantius.example.com # a self-hosted instance
semantius whoami                             # auth_method: oauth
semantius logout                             # revokes and deletes the session
```

`logout` deletes the session locally, and revokes it at the provider first
where the provider publishes a revocation endpoint — some, including Microsoft
Entra, publish none, and there the session is simply deleted.

`login` opens your browser (OAuth 2.0 authorization code with PKCE) and
receives the response on `127.0.0.1`; on a machine nobody is sitting at, use
the device flow instead (see
[Signing in on a headless or always-on machine](#signing-in-on-a-headless-or-always-on-machine)).
The session is stored as an encrypted `0600` file under
`%LOCALAPPDATA%\semantius\cli\sessions\` on Windows and
`~/.config/semantius/cli/sessions/` on Linux/macOS; your OS keyring (Keychain,
Windows Credential Manager, libsecret) holds only the key that opens it. Where
there is no keyring — a headless Linux box, for example — the file is written
unencrypted, still `0600`, and the CLI says so.

The login is verified against the host you named. The identity provider's
metadata must be served over HTTPS (or loopback, for local development), and it
must send the browser to an authorization endpoint on the same origin as the
issuer it declares; the issuer on the browser's response must then match that
issuer exactly (RFC 9207). A mismatch fails the login and stores nothing.

One session per host and `--env` prefix: `semantius login --host b.semantius.cloud`
leaves the session for `a.semantius.cloud` untouched, and each command uses the session of
the host it talks to. The access token is refreshed automatically, about
hourly, for as long as the login stays valid. A refresh the token endpoint
refuses — the session expired or was revoked — exits `5`: the session "could
not be refreshed", and the message says to run `semantius login` again. A
refresh it cannot serve right now — it does not answer, answers 5xx, 408 or
429, or reports `server_error` / `temporarily_unavailable`, whatever the
status — exits `3` with `SESSION_REFRESH_FAILED`: the session is kept, so
try again rather than signing in.

`--login` signs in first and then runs the command with that session, even when
an API key or JWT is configured (except on `cube` and with `--crud-mcp`, where
an API key or JWT still wins); it needs an interactive terminal. Besides
`login` and `use` (see [Hosts](#hosts-managed-cloud-and-self-hosted)), nothing
else opens a browser on its own: without credentials a command exits `5`.

**Self-hosted instances.** An instance configures the CLI by serving
`https://<host>/.well-known/semantius.json`:

```json
{
  "version": 1,
  "idp_well_known": "/.well-known/openid-configuration",
  "client_id_cli": "semantius-cli",
  "redirect_uris": ["http://127.0.0.1:53682/callback"],
  "scope": "",
  "audience": "semantius://api"
}
```

`idp_well_known` is fetched as given (relative URLs resolve against the document
itself), and is the only discovery hop — it names the issuer and every endpoint.
`client_id_cli` is the OAuth client the browser is sent with, so an instance
backed by an external identity provider can name that provider's own client id.
`audience` is the RFC 8707 resource indicator the CLI asks its tokens for, and an
empty `scope` means "whatever the provider advertises".

The redirect URIs must be registered for `http://127.0.0.1`, **not**
`http://localhost`: the CLI receives the callback on `127.0.0.1` and cannot send
any other address. (Microsoft Entra's portal offers `localhost` on its
desktop-platform form; `127.0.0.1` reply URLs are added by editing the app
manifest.) A document listing only `localhost` fails the login with that
explanation rather than an opaque error from the provider. Listing no redirect
URIs at all means the CLI uses
`http://127.0.0.1:{53682,53683,53684,18682,28682}/callback`, the first free one
in that order. Register all five: on Windows, WinNAT/Hyper-V can reserve the
whole 5368x block, and then only 18682 or 28682 is left.

An instance that serves no such document — it answers 404, or its web app
catches the path — falls back to the legacy chain:
`https://<host>/.well-known/oauth-protected-resource` names the authorization
server, whose own `/.well-known/oauth-authorization-server` metadata the CLI
reads next, and the CLI must be registered there as the public native client
`semantius-cli` with those three redirect URIs. A *failure* to fetch the
document — a timeout, a 5xx — is not that fallback: it fails the login naming
the document, because guessing would mean signing in with the wrong client.

Either way, an API key or a static JWT works without any of it.

#### Signing in on a headless or always-on machine

**If the person signing in is not at this machine's screen, use the device
flow:**

```bash
semantius use <host> --login-flow device      # or: semantius login --login-flow device
```

That covers always-on agents, servers, containers, SSH sessions, remote VMs
and CI-like runners. The CLI prints a URL and a short code (on stderr); open
the URL on any device — your phone, your laptop — enter the code and sign in.
It waits up to 10 minutes. To make it the default on such a machine, put
`SEMANTIUS_LOGIN_FLOW=device` in its global `.env` or in the `.env` next to
the executable.

Automatic mode (`--login-flow auto`, the default) is not enough there:

- On Windows and macOS it always opens a browser on the machine itself, even
  when nobody is in front of it.
- On Linux it picks the device flow only when there is no display *and* a
  terminal to show the code on; under an agent or a service, whose output is
  not a terminal, it refuses instead.
- In CI it refuses outright; when the host offers the device grant, the
  refusal names `--login-flow device`. A forced `device` (or `browser`)
  skips that check.

The host must offer the device grant: the managed cloud does, and a
self-hosted instance does if its identity provider does — otherwise the CLI
says so. When nobody will be around to sign in again once the session can no
longer be renewed, use a dedicated user's API key instead (see
[Delegated vs. dedicated access](#delegated-vs-dedicated-access)).

### Token cache

By default, the CLI exchanges your API key for a short-lived token on
first use and caches it for subsequent requests, so every call after the
first is significantly faster. The token is refreshed automatically
before it expires.

The cache lives in your OS temp directory (`/tmp` on Linux/macOS, `%TEMP%`
on Windows) and is encrypted with a key derived from your API key secret —
a cache file alone, without the API key, cannot be used to authenticate.

To disable the cache and re-authenticate on every call, pass
`--disable-jwt-cache` or set `SEMANTIUS_DISABLE_JWT_CACHE=1`. Disabling
degrades performance and should only be used when your threat model
forbids any credential-derived material on disk, or when running in a
read-only container where the cache file cannot be written anyway.

A static `SEMANTIUS_JWT` bypasses the cache entirely — the token is never
read from or written to disk, and no token exchange takes place.

## Using with AI Agents

`semantius` gives AI coding agents direct access to your Semantius platform's tools and data through the MCP protocol. The CLI approach is token-efficient — schemas are only fetched on demand.

### Why CLI?

- **On-demand loading**: Only fetch schemas when needed
- **Token efficient**: Minimal context overhead
- **Shell composable**: Chain with `jq`, pipes, and scripts
- **Scriptable**: AI can write shell scripts for complex workflows

### Option 1: System Prompt Integration

Add this to your AI agent's system prompt for direct CLI access:

````xml
## Semantius Platform

You have access to the Semantius platform via the `semantius` CLI.

Commands:

```bash
semantius info                        # List all servers
semantius info <server>               # Show server tools  
semantius info <server> <tool>        # Get tool schema
semantius grep "<pattern>"            # Search tools
semantius call <server> <tool>        # Call tool (stdin auto-detected)
semantius call <server> <tool> '{}'   # Call with JSON args
```

**Both formats work:** `info <server> <tool>` or `info <server>/<tool>`

Workflow:

1. **Discover**: `semantius info` to see available servers
2. **Inspect**: `semantius info <server> <tool>` to get the schema
3. **Execute**: `semantius call <server> <tool> '{}'` with arguments

### Examples

```bash
# List available tools
semantius info crud

# Call with inline JSON
semantius call crud list_records '{}'

# Pipe from stdin (no '-' needed)
echo '{"id": "123"}' | semantius call crud get_record

# Heredoc for complex JSON
semantius call crud create_record <<EOF
{"name": "My Record", "data": "value"}
EOF
```

### Common Errors

| Wrong | Error | Fix |
|-------|-------|-----|
| `semantius server tool` | AMBIGUOUS | Use `call server tool` |
| `semantius run server tool` | UNKNOWN_SUBCOMMAND | Use `call` |
| `semantius list` | UNKNOWN_SUBCOMMAND | Use `info` |
````

### Option 2: Agents Skill

For coding agents that support Agent Skills, like Claude Code, Gemini CLI or
OpenCode, install the Semantius skills from this repository's
[`skills/`](skills/) folder: see [Quick Start, step 2](#2-install-the-agent-skills).

## Development

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0

Bun is the only supported package manager and script runner (`bun.lock`,
CI and releases all use it). Do not use `npm`, `pnpm` or `yarn`: e.g.
`pnpm <script>` runs its own `pnpm install` first, which fails and leaves
`pnpm-lock.yaml` / `pnpm-workspace.yaml` behind.

### Setup

```bash
git clone https://github.com/semantius/semantius-cli.git
cd semantius
bun install
```

### Commands

```bash
# Run in development
bun run dev

# Type checking
bun run typecheck

# Linting
bun run lint
bun run lint:fix

# Run all tests (unit + integration)
bun test

# Run only unit tests (fast)
bun test tests/config.test.ts tests/output.test.ts tests/client.test.ts

# Run integration tests (requires MCP server, ~35s)
bun test tests/integration/

# Build single executable
bun run build

# Build for all platforms
bun run build:all
```

### Local Testing & Debugging

There are three ways to run the CLI while iterating on a change — pick
whichever matches what you're trying to verify.

#### 1. `bun run dev` — fastest feedback loop

`bun run dev` runs `src/index.ts` directly via Bun; no build step, no link.
Just pass the same args you'd give the installed binary:

```bash
# Basic commands
bun run dev --help
bun run dev info crud
bun run dev whoami
bun run dev ping
bun run dev ping -n            # 5 pings + min/max/avg
bun run dev ping -n 20         # 20 pings + min/max/avg
bun run dev grep "*record*"
bun run dev call crud getCurrentUser '{}'

# Pipe JSON in via stdin
echo '{}' | bun run dev call crud getCurrentUser
```

Credentials and the host come from the same places as for the installed binary
(see [Where variables come from](#where-variables-come-from)): your shell, a
`.env` in the current directory, then the global `.env`. Under `bun run dev`
the executable is `bun` itself, so "the `.env` next to the executable" means
one next to the `bun` binary.
Use `--env <prefix>` to test a different credential set (e.g.
`--env STAGING` reads `STAGING_API_KEY` / `STAGING_ORG` / `STAGING_JWT`).

#### 2. Verbose / debug output

```bash
# Bash / macOS / Linux
SEMANTIUS_DEBUG=1 bun run dev ping

# PowerShell
$env:SEMANTIUS_DEBUG=1; bun run dev ping
```

Debug mode prints daemon spawn decisions, MCP transport activity, and
underlying error messages that are normally hidden behind the friendly
`Error [CODE]: …` output.

To bypass the connection cache and see raw per-call latency (also the
default on Windows):

```bash
SEMANTIUS_NO_DAEMON=1 bun run dev ping -n 5
```

#### 3. Step-through debugging with the Bun inspector

```bash
bun --inspect-brk src/index.ts ping
```

Bun prints a `chrome-devtools://…` URL on startup. Open it in Chrome, or
attach VS Code's built-in **Bun: Attach** launch config. Set breakpoints
in [src/commands/identity.ts](src/commands/identity.ts) (for `ping` /
`whoami`), [src/commands/call.ts](src/commands/call.ts), or
[src/client.ts](src/client.ts) to step through transport handling.

#### 4. As the installed binary (`bun link`)

To test the exact UX the user gets — including how Bun resolves the
shebang and how PATH lookup works — link the package globally:

```bash
# Link once; now `semantius` resolves to your working tree
bun link

semantius --help
semantius ping -n 10

# Unlink when done
bun unlink
```

#### 5. Automated tests

```bash
# All tests (unit + integration; integration hits real MCP servers ~35s)
bun test

# Fast unit-only loop
bun test tests/config.test.ts tests/output.test.ts tests/client.test.ts

# Integration only
bun test tests/integration/
```

Integration tests need valid `SEMANTIUS_API_KEY` / `SEMANTIUS_ORG` and a
reachable platform; they skip automatically when the server is
unreachable.

### Vendored crud tools (`postgrest-mcp`)

The crud tools the CLI runs in-process are owned by the
[`postgrest-mcp`](https://github.com/semantius/postgrest-mcp) repo and copied
unchanged into [src/vendor/postgrest-mcp/](src/vendor/postgrest-mcp/). Never
edit that tree by hand: change the code upstream, commit it there, then
re-sync here.

```bash
# Copy/update the tools from upstream, then commit the result
bun run sync-mcp-tools

# Check only: fail if the vendored copy differs from upstream (writes nothing)
bun run sync-mcp-tools:check
```

- The upstream checkout is expected at `../postgrest-mcp` (next to this repo);
  set `POSTGREST_MCP_DIR` to point elsewhere.
- It must be a clean git checkout. Files are read from its `HEAD` commit, so
  uncommitted upstream edits are not picked up.
- The synced commit is recorded in
  [src/vendor/postgrest-mcp/UPSTREAM](src/vendor/postgrest-mcp/UPSTREAM).
- `src/vendor/postgrest-mcp/src/utils/resetSchemaCache.ts` is the CLI's own
  replacement and is never overwritten.
- The release script runs `sync-mcp-tools:check`, so a stale copy blocks a
  release.

Details (what is copied, excluded and generated) are in the header of
[scripts/sync-postgrest-mcp.ts](scripts/sync-postgrest-mcp.ts).

### Releasing

Releases are automated via GitHub Actions. Use the release script at the
repository root (`v0.2.0` or `0.2.0`; pre-releases like `v0.3.0-rc.1`):

```bash
./release.sh v0.2.0
```

### Error Messages

All errors include actionable recovery suggestions, optimized for both humans and AI agents:

```
Error [AMBIGUOUS_COMMAND]: Ambiguous command: did you mean to call a tool or view info?
  Details: Received: semantius filesystem read_file
  Suggestion: Use 'semantius call filesystem read_file' to execute, or 'semantius info filesystem read_file' to view schema

Error [UNKNOWN_SUBCOMMAND]: Unknown subcommand: "run"
  Details: Valid subcommands: info, grep, call
  Suggestion: Did you mean 'semantius call'?

Error [SERVER_NOT_FOUND]: Server "github" not found in config
  Details: Available servers: filesystem, sqlite
  Suggestion: Use one of: semantius info filesystem, semantius info sqlite

Error [TOOL_NOT_FOUND]: Tool "search" not found in server "filesystem"
  Details: Available tools: read_file, write_file, list_directory (+5 more)
  Suggestion: Run 'semantius info filesystem' to see all available tools

Error [INVALID_JSON_ARGUMENTS]: Invalid JSON in tool arguments
  Details: Parse error: Unexpected identifier "test"
  Suggestion: Arguments must be valid JSON. Use single quotes: '{"key": "value"}'
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.