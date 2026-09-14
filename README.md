# semantius

The official CLI for the [Semantius](https://semantius.com) platform. Connect to your Semantius organization's MCP servers to interact with your data, tools, and APIs directly from the command line or AI agents.

## Features

- 🪶 **Lightweight** - Minimal dependencies, fast startup
- 🔧 **Shell-Friendly** - JSON output for call, pipes with `jq`, chaining support
- 🤖 **Agent-Optimized** - Designed for AI coding agents (Gemini CLI, Claude Code, etc.)
- 🔌 **Semantius Platform** - Runs the `crud` tools directly against your organization's PostgREST API and connects to the `cube` (analytics) MCP server
- ⚡ **Fast** - Connections and tokens are cached between calls, so repeated invocations stay responsive
- 🔑 **Zero Config** - Works out of the box with `SEMANTIUS_API_KEY` and `SEMANTIUS_ORG` set (or a single `SEMANTIUS_API_KEY=org:key`)
- 💡 **Actionable Errors** - Structured error messages with available servers and recovery suggestions

## Quick Start

### 1. Installation

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
```

The Linux/macOS installer places `semantius` in `/usr/local/bin` (if writable), otherwise `~/.local/bin`, and adds it to your PATH automatically.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex
```

The Windows installer places `semantius.exe` in `%LOCALAPPDATA%\Programs\Semantius` and adds it to your user PATH automatically.

### 2. Set up credentials

Set your Semantius credentials. The CLI looks for a `.env` file in the current directory, then next to the executable (Windows), or you can export them in your shell. Shell environment variables always take precedence over `.env` values.

```bash
# Option 1: Export in shell
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name

# Option 2: .env file (current directory first, then next to the executable)
# SEMANTIUS_API_KEY=your-api-key
# SEMANTIUS_ORG=your-org-name

# Option 3: single-value credential — an "org:" prefix on the API key
# replaces SEMANTIUS_ORG (the prefix wins if both are set)
export SEMANTIUS_API_KEY=your-org-name:your-api-key

# Option 4: bring your own token — a static JWT is sent directly
# (no token exchange, no token cache); also accepts the "org:" prefix
export SEMANTIUS_JWT=your-org-name:eyJhbGciOi...
```

```bash
# Option 5: no keys at all — sign in with the browser
semantius use acme.semantius.cloud           # signs in (if needed) and makes it your host
semantius use semantius.example.com          # a self-hosted instance
semantius login --host acme.semantius.app    # sign in only, without changing your host
```

```bash
# Option 6: a token for just this one invocation, without an .env at all
echo your-org-name:eyJhbGciOi... | semantius --token - whoami   # from stdin (preferred)
semantius --token-file ./token.txt whoami                        # from a file
semantius --token your-org-name:eyJhbGciOi... whoami              # literal (shell history!)
```

Credentials are tried in this order, first match wins:

1. `--token` / `--token-file` — a JWT for just this invocation (see below)
2. `SEMANTIUS_JWT` — a static token, sent as-is (no exchange, no cache)
3. `SEMANTIUS_API_KEY` — exchanged for a short-lived token at your host's token endpoint and cached (see [Token cache](#token-cache))
4. The session stored by `semantius login` for this host (see [Browser login](#browser-login))

Without any of them, commands that call the platform exit `5` with "Authentication required".
`--auth jwt|apikey|oauth` picks one source explicitly.
Which host the CLI talks to — including the **current host** `semantius use`
sets, which then applies in every directory until you change it — is covered
in [Hosts](#hosts-managed-cloud-and-self-hosted).

**A credential that names its own organization is bound to that host.** An
`"org:"` prefix on `SEMANTIUS_API_KEY` / `SEMANTIUS_JWT` binds it to
`<org>.semantius.cloud`, the same way a bare `SEMANTIUS_ORG` would. It's only
compared against `--host` / `SEMANTIUS_HOST` — or a plain `SEMANTIUS_ORG` —
when they're set in the *same* place (the same shell, or the same `.env`
file) — naming a *different* host or org there is an error (`HOST_CONFLICT`).
A host that's already settled by something with higher precedence (`--host`,
`--token`, or the current host — see [Hosts](#hosts-managed-cloud-and-self-hosted))
is never compared against the credential at all, and the credential is then
ignored rather than silently sent to a host it wasn't issued for. `--token` /
`--token-file` bind the invocation to `<org>.semantius.cloud` too, but can't
be combined with `--host` — the token already names its own host.

The environment's credentials belong to the environment's host. **With
`--host`, or on the current host (see below), only a stored browser session is
used:** the CLI ignores a leftover API key, JWT or org from the environment
(silently — not an error), so they are never sent to another host by mistake.
`--token` is the exception: it's a credential for *this* invocation, so it's
unaffected. One session is stored per host, by `semantius login --host <host>`
(or by `semantius use <host>`, which signs in for you first if there's no
session yet). To pair a host with an API key instead, set `SEMANTIUS_HOST`
next to it, or keep several pairs side by side with `--env <prefix>`
(`<PREFIX>_HOST`, `<PREFIX>_API_KEY`).

No config file is needed: the `crud` tools run inside the CLI against your
organization's PostgREST API, and `cube` (analytics) is reached as a Semantius
MCP server. `--crud-mcp` sends the `crud` tools through the Semantius cloud MCP
server instead (the only way to use `sqlToRest`).

### 3. Discover available tools

```bash
# List all servers and tools
semantius

# With descriptions
semantius -d
```

### 4. Call a tool

```bash
# View tool schema first
semantius info crud

# Call a tool
semantius call crud list_records '{}'
```

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
semantius use <host>                            Make <host> the current host (signs in with the browser first if needed)
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
| `-md, --markdown` | Dump full documentation as markdown (README, SKILL, all tools) |
| `-n [count]` | (ping only) Run N pings and report per-request latency + min/max/avg. `-n` without a value defaults to 5 |
| `--json` | (`hosts` only) Machine-readable output instead of the table |
| `--clear` | (`use` only) Unset the current host instead of setting one: `semantius use --clear` |
| `--env <prefix>` | Env var prefix (default `SEMANTIUS`), e.g. `--env PROD` reads `PROD_API_KEY` / `PROD_ORG` |
| `--host <hostname>` | Semantius host to talk to, `hostname[:port]` (see [Hosts](#hosts-managed-cloud-and-self-hosted)). Also `SEMANTIUS_HOST`. Not combinable with `--token`/`--token-file` |
| `--auth <source>` | Use exactly one credential source: `jwt`, `apikey` or `oauth` (the stored browser session). Not combinable with `--host` for `jwt`/`apikey` |
| `--token <org:jwt \| ->` | A JWT for just this invocation, binding it to `<org>.semantius.cloud` — wins over the current host and any `SEMANTIUS_HOST`/`SEMANTIUS_ORG` from the environment or `.env`. `-` reads it from stdin; a literal value is visible in the shell history and process list, so prefer `-` or `--token-file`. Not combinable with `--host`, `--auth apikey`/`oauth`, or `--login` |
| `--token-file <path>` | Same as `--token`, read from a file (`org:jwt`, trimmed) |
| `--login` | Sign in with the browser first, then run the command with that session (needs an interactive terminal) |
| `--crud-mcp` | Route the `crud` server through the Semantius cloud MCP server instead of the local PostgREST layer (cloud only). Also `SEMANTIUS_CRUD_MCP=1` |
| `--stream` | (`call crud postgrestRequest` only) Pipe the PostgREST response body to stdout unchanged — see [Streaming large reads](#streaming-large-reads---stream). Also `SEMANTIUS_STREAM=1` |
| `--disable-jwt-cache` | Skip the token cache and re-authenticate on every request (see [Token cache](#token-cache)) |
| `--reset-cache` | Delete the cached token for the current API key and the cached host lookup before running (alias: `--reset-jwt-cache`) |


### Output

| Stream | Content |
|--------|---------|
| **stdout** | Tool results and human-readable info |
| **stderr** | Errors and diagnostics |

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


### Environment Variables

All env vars use a configurable prefix (default `SEMANTIUS_`). Pass
`--env <prefix>` to switch — e.g. `--env PROD` reads `PROD_API_KEY`,
`PROD_TIMEOUT`, `PROD_LOG_FILE`, etc., so you can keep separate DEV/STAGE/PROD
configurations side by side in the same `.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIUS_ORG` | Organization on the managed cloud; the host defaults to `https://<org>.semantius.cloud`. **Required** unless `SEMANTIUS_HOST`, `--host`, `--token`, a bound credential, or the current host (see [Hosts](#hosts-managed-cloud-and-self-hosted)) names the host (an `org:` prefix on the API key or JWT also supplies it) | (none) |
| `SEMANTIUS_HOST` | Hostname, same as `--host` (see [Hosts](#hosts-managed-cloud-and-self-hosted)) | `${SEMANTIUS_ORG}.semantius.cloud` |
| `SEMANTIUS_API_KEY` | API key for Semantius (needed to call tools unless `SEMANTIUS_JWT` is set). Value may be `org:key` — the org prefix overrides `SEMANTIUS_ORG`. | (none) |
| `SEMANTIUS_JWT` | Static JWT sent as `Authorization: Bearer` directly — skips the token exchange and the token cache entirely. Value may be `org:jwt`; its org prefix overrides both `SEMANTIUS_ORG` and the API key's prefix. | (none) |
| `SEMANTIUS_CRUD_MCP` | `1` = same as `--crud-mcp` | `false` |
| `SEMANTIUS_STREAM` | `1` = `--stream` for every `call crud postgrestRequest` where it is valid (no `--single`/`--diag`/`--crud-mcp`); ignored for other calls | `false` |
| `SEMANTIUS_SIDE_EFFECT_TIMEOUT` | On the managed cloud, creating/updating/deleting entities or fields asks the cloud MCP server to refresh the PostgREST schema cache; the CLI waits up to this many seconds for that before exiting | `10` |
| `SEMANTIUS_CONFIG_PATH` | Path to config file | (none) |
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
   [Set up credentials](#2-set-up-credentials)) — can't be combined with `--host`
3. The **current host**, set by `semantius use <host>` — see below
4. `SEMANTIUS_HOST`, else `SEMANTIUS_ORG` — checked in the shell environment,
   then a project `.env`, then the global `.env` in the user config dir; host
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
server and no cloud MCP server, so `--crud-mcp` is not available.

With `--host`, or on the current host (see below), only credentials stored for
that host (a browser session) are used — see [Set up credentials](#2-set-up-credentials).
A bare `SEMANTIUS_API_KEY` / `SEMANTIUS_JWT` left over from a project `.env`
is then simply ignored (not an error): it was set for whatever host was
configured when it was written, not necessarily this one.

#### The current host, and `semantius hosts` / `semantius use`

`semantius use <host>` makes `<host>` your **current host**: it applies in
every directory, ahead of `SEMANTIUS_HOST` / `SEMANTIUS_ORG` — whether from
your shell or a project's own `.env` — until you run `use` again or clear it.
If there's no session stored for `<host>` yet, `use` signs you in with the
browser first (the same flow as `semantius login --host <host>`), then
records the session and makes the host current. `semantius login` on its own
never touches the current host; it only ever stores a session for whatever
host it resolves to. `semantius use` is the one command that decides what
your host is.

**Outranking a project's own `.env` is deliberate, not a bug:** once you run
`use`, it is meant to be the answer to "which host?" until you explicitly
change it — an explicit decision should not be silently overridden by
whatever a project's `.env` happens to contain, especially since that `.env`
was likely written before you ever ran `use`. If a specific project needs to
keep talking to its own host regardless of your current one, give it its own
`SEMANTIUS_HOST` in a `.env`, or point `--env <prefix>` at a separate pair of
variables via `--host` — both still outrank the current host for that
invocation. `semantius whoami`'s `host_source` row always tells you which one
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

`login` opens your browser (OAuth 2.0 authorization code with PKCE), receives
the response on `127.0.0.1`, and stores the session in your OS keyring
(Keychain, Windows Credential Manager, libsecret) under the host's name. Where
there is no keyring — a headless Linux box, for example — it falls back to a
`0600` file in `<user config dir>/sessions/` and says so.

The login is verified against the host you named: the authorization server's
metadata must declare the issuer the host's resource metadata points at, and
the issuer on the browser's response must match it exactly (RFC 9207). A
mismatch fails the login and stores nothing.

One session per host: `semantius login --host b.semantius.cloud` leaves the
session for `a.semantius.cloud` untouched, and each command uses the session of
the host it talks to. The access token is refreshed automatically, about
hourly, for as long as the login stays valid.

`--login` signs in first and then runs the command with that session, even when
an API key or JWT is configured; it needs an interactive terminal. Besides
`login` and `use` (see [Hosts](#hosts-managed-cloud-and-self-hosted)), nothing
else opens a browser on its own: without credentials a command exits `5`.

A self-hosted instance needs two things for this to work: it must serve
`https://<host>/.well-known/oauth-protected-resource` (naming its authorization
server, whose own `/.well-known/oauth-authorization-server` metadata the CLI
reads next), and it must have the CLI registered as the public native client
`semantius-cli` with the redirect URIs `http://127.0.0.1:{53682,53683,53684}/callback`.
Without either, `login` fails naming the document or the client; an API key or a
static JWT still works.

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

For Code Agents that support Agents Skills, like Gemini CLI, OpenCode or Claude Code, you can use the semantius skill. The Skill is available at [SKILL.md](./SKILL.md)

Create `semantius/SKILL.md` in your skills directory.

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

Required env vars (`SEMANTIUS_API_KEY`, `SEMANTIUS_ORG`) are picked up from
your shell or from a `.env` next to the binary / in the user config dir.
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