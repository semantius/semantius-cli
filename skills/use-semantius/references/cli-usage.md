# semantius Usage Reference

## Installation

Full guide — what the CLI is and how to install it: **https://www.semantius.com/docs/cli/use-semantius/**

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex
```

The Windows installer places `semantius.exe` in `%LOCALAPPDATA%\Programs\Semantius` and adds it to your user PATH automatically (open a new terminal after install so the updated PATH is picked up). Verify with `semantius --version`.

## Credentials Setup

The CLI needs a **host** and a **credential**.

### How a person connects: `semantius use`

```bash
semantius use acme.semantius.cloud      # signs in if there is no session yet, then pins the host
semantius use semantius.example.com     # a self-hosted instance
```

`semantius use <host>` is the normal way to point a machine at a host. It signs in when no session is stored for that host, then makes it the **current host** for every later invocation in every directory. The current host outranks `SEMANTIUS_HOST` / `SEMANTIUS_ORG` and every `.env`; only `--host` and `--token` beat it. Prefer it over an API key: a session is OAuth, refreshes itself, is stored per host and is revoked by `logout`, where a key is a long-lived secret that has to be provisioned on the platform and then sits on disk. API keys belong to automation and CI, where nobody can complete an interactive sign-in.

`use` changes machine-global state that outlives the task. An agent runs it only after the user names the host; it never runs it unprompted (see "Commands" below).

### Host, first match wins

`semantius whoami` prints the winner as `host_source`:

| Rung | Source | `host_source` |
|---|---|---|
| 1 | `--host <hostname>`, this invocation only | `flag` |
| 2 | the org of `--token` / `--token-file` | `token` |
| 3 | the current host set by `semantius use` | `current` |
| 4 | `SEMANTIUS_HOST`, else `SEMANTIUS_ORG`: the shell, then the project `.env`, then the global `.env` (host before org inside each; an `org:` prefix on the API key or JWT counts as an org) | `env` / `dotenv:<path>` for a host, `org` for an org |

A host under `.semantius.cloud` is the managed cloud; any other `hostname[:port]` is a self-hosted instance. `<org>.semantius.app` (the web app) is mapped to `<org>.semantius.cloud`. With no host at all, a command exits `1` with `MISSING_ENV_VAR` naming `SEMANTIUS_ORG` and the remedies (`SEMANTIUS_ORG`, `--host`, or `semantius use <host>`).

### Credential, first match wins

1. `--token <org:jwt | ->` / `--token-file <path>`: a JWT for this one invocation, bound to `<org>.semantius.cloud`. The only credential an agent can be handed without touching global state. Pass `-` (stdin) or the file form; a literal lands in shell history. Not combinable with `--host`.
2. `SEMANTIUS_JWT`: a static token, sent as-is (no exchange, no cache, no refresh).
3. `SEMANTIUS_API_KEY`: exchanged for a short-lived token, cached.
4. The session stored for this host by `semantius use` / `semantius login`.

Without one, commands that talk to the platform exit `5` with "Authentication required". `--auth jwt|apikey|oauth` picks one source explicitly. `whoami` prints the credential in use as `auth_method`.

**The order has a trap in each direction, and neither one warns:**

- **Host pinned** (`current`, or `--host`): only the session stored for that host is used. An API key, JWT or org in the environment is ignored, silently. Setting `SEMANTIUS_API_KEY` after running `use` has no effect. (`--token` is the exception: it is a credential for this invocation.) To pair a host with an API key instead, set `SEMANTIUS_HOST` next to the key, or keep several pairs with `--env <prefix>`.
- **Host not pinned** (`env`, `dotenv:…`, `org`): an API key in the environment outranks a stored session. A user who has just signed in still sees `auth_method: apikey`, and the new session is never reached. Signing in again appears to work and changes nothing; the fix is `semantius use <host>` (pin it) or `--auth oauth` (force it).

So "connected" means naming the host, its `host_source` and the `auth_method`, not just a zero exit code.

### Sessions: `login` and `logout`

`semantius login` signs in and stores a session for the host it resolves to; it never changes the current host. The session is sealed into a file under the CLI's secrets directory with a per-host key held in the OS keyring (on headless Linux, which has no keyring, the file is written unsealed). The access token refreshes itself for as long as the login stays valid. `semantius logout` revokes the session where the provider publishes a revocation endpoint, deletes it, clears the current host if it was this one, and stops every background daemon.

`--login-flow auto|browser|device` (also `SEMANTIUS_LOGIN_FLOW`) picks the grant a sign-in uses. `auto` uses the browser when the machine has one, the **device code grant** (a code the user enters on another device) when it does not and the host offers it, fails in about a second with exit `5` otherwise, and refuses in CI. **On Windows and macOS `auto` always assumes a browser**, so over SSH or on Server Core `--login-flow device` is the only way to reach the device grant:

```bash
semantius login --host acme.semantius.app --login-flow device
```

The device grant prints a user code and a verification URL, then waits for the user to finish on the other device. That wait is not a hang.

Agents never run `login` or `logout` themselves (see "Commands" below). Self-hosted instances support login too: they configure it by serving `/.well-known/semantius.json` (which names their OAuth client id — not necessarily `semantius-cli` — their identity provider and their API audience), or, on an instance that serves no such document, through the older `/.well-known/oauth-protected-resource` chain with the `semantius-cli` client registered.

### API keys (automation and CI)

```bash
# Option 1: Export in shell
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name       # or SEMANTIUS_HOST=<host>, or an "org:" prefix on the key

# Option 2: .env file, same variables
# Searched in the current directory, the config file's directory, then next to the executable
# (the first one found is loaded); <user config dir>/.env fills in whatever is still unset.
# The shell environment always wins over any .env.
```

Remember the first trap above: on a machine with a current host, these variables do nothing. Run `semantius use --clear` to fall back to them.

---

## All Commands

```bash
semantius [options]                             # List all servers and tools
semantius [options] info <server>               # Show server tools and parameters
semantius [options] info <server> <tool>        # Show tool schema
semantius [options] grep <pattern>              # Search tools by glob pattern
semantius [options] call <server> <tool>        # Call tool (reads JSON from stdin)
semantius [options] call <server> <tool> <json> # Call tool with inline JSON args
semantius [options] whoami                      # Resolved host, where it came from, identity, credential in use
semantius [options] ping [-n [count]]           # One getCurrentUser round trip; -n N reports min/max/avg latency
semantius [options] hosts [--json]              # Every host with a stored session or the current mark
semantius use <host>                            # Sign in if needed, then make <host> the current host
semantius use --clear                           # Unset the current host (session kept)
semantius [options] login                       # Sign in and store a session for the resolved host
semantius [options] logout                      # Revoke and delete the session; clears the current host if it was this one
```

Both `info <server> <tool>` and `info <server>/<tool>` work interchangeably. There is no `list`, `help` or `version` subcommand: `list` is rejected with `UNKNOWN_SUBCOMMAND`, and `help` / `version` are read as server names (`SERVER_NOT_FOUND`). Use `-h` / `-v`.

The ten forms fall into three tiers:

| Tier | Commands | Agent rule |
|---|---|---|
| **Working set** | (bare), `info`, `grep`, `call` | Use freely. |
| **Diagnostics** (read-only) | `whoami`, `ping`, `hosts` | Use freely, and reach for them first when unsure which host, org or identity is in play. |
| **Changes this machine's state** | `use`, `login`, `logout` | `use` only after the user names the host; `login` and `logout` never. |

- **`whoami`** answers "which host and identity am I on", for diagnosis. It prints `host`, `host_source` (which rung won, see Credentials Setup), the user and roles, and `auth_method`. It is **not** where you read values you then act on: read `ui_baseurl` and the rest from `semantius call crud getCurrentUser '{}'`.
- **`ping`** proves the host answers and the credential works, with nothing else attached. `-n` alone means 5 pings.
- **`hosts`** prints host, mode, org, whether a session is stored and its expiry, a `*` on the current host, and a trailing `current: <host> (<source>)` line. It works even with nothing configured.
- **`use`**: see Credentials Setup. Run it when the user has named the host; never on your own initiative, because it outlives the task.
- **`login`**: needs a human to complete the sign-in, in a browser or on another device. The subcommand has no terminal check of its own, so do not run it; tell the human which host needs a session and the exact command (`semantius login --host <host>`, adding `--login-flow device` over SSH).
- **`logout`**: revokes and deletes the session, clears the current host if it was this one, and stops every daemon. Every later invocation in every directory loses that host until a human signs in again. Never run it.

### Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `-d, --with-descriptions` | Include tool descriptions in listing |
| `-md, --markdown` | Dump full documentation as markdown (README, then every server's tools) |
| `-n [count]` | (`ping` only) Run N pings and report min/max/avg; `-n` alone means 5 |
| `--json` | (`hosts` only) Machine-readable output |
| `--clear` | (`use` only) Unset the current host: `semantius use --clear` |
| `--single` | (`call` only) Expect exactly one row: bare object on stdout, exit 1 on 0 rows, exit 2 on 2+ rows. **Rejected (exit 1, `SINGLE_ARRAY_INPUT`) for bulk calls** — an array in `data` / `body` / `id` / `table_name` always answers with an array of records. |
| `--diag` | (`call`) Print the full `{request, response}` envelope instead of just `response.data` |
| `--stream` | (`call crud postgrestRequest` only) Print PostgREST's response body unchanged — compact JSON, or CSV with `"accept":"text/csv"`; fastest for large reads. Errors: `Error: (<code>) <message>`, exit 5 for 401/403, 3 for 5xx/network, 4 otherwise. Not with `--single`, `--diag`, `--crud-mcp` (exit 1) |
| `--host <host>` | Semantius host for this invocation; uses only the session stored for it (see Credentials Setup) |
| `--auth <source>` | Force one credential source: `jwt`, `apikey` or `oauth`. Not with `--host` for `jwt`/`apikey` (exit 1) |
| `--token <org:jwt \| ->` | A JWT for this invocation, bound to `<org>.semantius.cloud`; `-` reads it from stdin. Not with `--host`, `--auth apikey`/`oauth` or `--login` |
| `--token-file <path>` | Same as `--token`, read from a file (`org:jwt`, trimmed) |
| `--login` | Sign in first, then run the command with that session (interactive terminal, unless `--login-flow` is given). Not for agents |
| `--login-flow <mode>` | Grant a sign-in uses: `auto` (default), `browser` or `device` (see Credentials Setup). Also `SEMANTIUS_LOGIN_FLOW` |
| `--env <prefix>` | Read `<PREFIX>_API_KEY`, `<PREFIX>_ORG`, … instead of `SEMANTIUS_*` |
| `--crud-mcp` | Run the `crud` tools on the Semantius cloud MCP server instead of inside the CLI (cloud only). Needed for `sqlToRest` |
| `--disable-jwt-cache` | Skip the token cache; re-authenticate on every request. Also `SEMANTIUS_DISABLE_JWT_CACHE=1` |
| `--reset-cache` | Drop the cached token and host lookup before running (alias `--reset-jwt-cache`) |

---

## Example Command Output

### List Servers
```bash
$ semantius
crud
  • create_entity
  • read_entity
  • update_entity
cube
  • discover
  • load
  • chart

$ semantius --with-descriptions
crud
  • create_entity - Creates a new entity record in the entities table
  • read_entity - Reads and queries entities from the entities table
cube
  • discover - MANDATORY FIRST CALL. Returns cubes, query language reference, date filtering guide
```

### Search Tools
```bash
$ semantius grep "*entity*"
crud/create_entity
crud/read_entity
crud/update_entity
crud/delete_entity

$ semantius grep "*entity*" -d
crud/create_entity - Creates a new entity record in the entities table
crud/read_entity - Reads and queries entities from the entities table
```

### View Server / Tool Details
```bash
$ semantius info crud
Server: crud
Tools:
  create_entity
    Creates a new entity record in the entities table … Accepts a single object or an array of objects (bulk insert)
    Parameters:
      • data (object | object[], required) - Data object containing fields for the new entity, or a non-empty array of such objects …
  read_entity
    ...

# Both formats work:
$ semantius info crud create_entity
$ semantius info crud/create_entity

Tool: create_entity
Server: crud
Description:
  Creates a new entity record in the entities table … Accepts a single object or an array of objects (bulk insert in one request); the response is always an array of created records.
Input Schema:
  {
    "type": "object",
    "properties": {
      "data": {
        "anyOf": [
          { "type": "object", "properties": { ... } },
          { "type": "array", "minItems": 1, "items": { "type": "object", "properties": { ... } } }
        ],
        "description": "Data object ... or a non-empty array of such objects to create several entity records in one request ..."
      },
      "accept": { "type": "string", "description": "..." }
    },
    "required": ["data"]
  }
```

The `anyOf` is how every bulk-capable parameter appears: `data` on `create_*` is `object | object[]`, `id` on `update_*` / `delete_*` (and `table_name` on the entity tools) is `<scalar> | <scalar>[]`. Newer CLIs render that union as `object | object[]` in the parameter listing; older ones print `any` — read the schema, the capability is server-side either way.

### Output Streams

| Stream | Content |
|--------|---------|
| **stdout** | Tool results and human-readable info |
| **stderr** | Errors and diagnostics |

---

## Workflow Pattern

Always follow this order:

1. **Discover**, `semantius info` to see available servers
2. **Explore**, `semantius info <server>` to see tools + parameters
3. **Inspect**, `semantius info <server> <tool>` to get the full JSON schema
4. **Execute**, `semantius call <server> <tool> '<json>'`

---

## Passing Arguments

### Inline JSON (simple cases)
```bash
semantius call crud read_entity '{"filters": "table_name=eq.products"}'
```

### Stdin (preferred for complex or multi-line JSON)
```bash
# Pipe
echo '{"data": {"name": "My Record"}}' | semantius call crud create_entity

# Heredoc — no '-' needed with call subcommand. Several fields → ONE call: `data` is an array
# (items may carry different keys; the response is the array of created fields)
semantius call crud create_field <<EOF
{
  "data": [
    {
      "table_name": "products",
      "field_name": "price",
      "title": "Price",
      "format": "number",
      "precision": 2,
      "width": "default",
      "input_type": "default"
    },
    {
      "table_name": "products",
      "field_name": "status",
      "title": "Status",
      "format": "enum",
      "enum_values": ["active", {"value": "eol", "label": "End of life"}],
      "width": "default",
      "input_type": "default"
    }
  ]
}
EOF

# From a file
cat args.json | semantius call crud create_entity
```

**Why stdin?** Shell interpretation of `{}`, quotes, and special characters requires careful escaping. Stdin bypasses shell parsing entirely — and a bulk payload (an array of records) is exactly the multi-line JSON stdin is for.

### Building a bulk payload in Bun

When the records come from data (a file, a previous read, a loop), assemble the array in a Bun script and pipe it over stdin — one call, one transaction:

```typescript
// bun run add-fields.ts
const rows = ["price", "cost", "margin"].map((name, i) => ({
  table_name: "products", field_name: name, title: name[0].toUpperCase() + name.slice(1),
  format: "number", precision: 2, width: "default", input_type: "default",   // no field_order: array order is display order
}));
const proc = Bun.spawn(["semantius", "call", "crud", "create_field"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
proc.stdin.write(JSON.stringify({ data: rows }));   // ONE create_field call for all rows
proc.stdin.end();
const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
if (code !== 0) throw new Error(`create_field failed (exit ${code}): ${err}`);   // nothing landed — one transaction
console.log(`${JSON.parse(out).length} field(s) created`);                       // the response is an array
```

Never `for (const r of rows) await call("create_field", { data: r })` — N calls where one array call would do is the failure the platform's batching rule names. Keep one call to roughly 100 rows; split larger sets into a few calls.

---

## Shell Chaining Patterns

```bash
# Get entity ID, then list its fields
semantius call crud read_entity '{"filters": "table_name=eq.products"}' \
  | jq -r '.[0].id'

# Search then read first result
semantius grep "*record*"

# Save output to file
semantius call cube load '{"query": {"measures": ["Sales.count"]}}' > results.json

# Aggregate from multiple servers
{
  semantius call crud read_entity '{}'
  semantius call cube discover '{}'
} | jq -s '.'

# Conditional execution
if result=$(semantius call crud read_module '{}' 2>/dev/null); then
  echo "$result" | jq '.[0].id'
else
  echo "No modules found"
fi
```

## Advanced Chaining Examples

```bash
# 1. Search and read: find files matching pattern, read the first one
semantius call crud read_entity '{"filters": "table_name=ilike.*product*"}' \
  | jq -r '.[0].table_name' \
  | xargs -I {} semantius call crud read_field '{"filters": "table_name=eq.{}"}'

# 2. Process multiple results: read fields for all matching entities
semantius call crud read_entity '{"filters": "module_id=eq.3"}' \
  | jq -r '.[].table_name' \
  | while read tbl; do
      echo "=== $tbl ==="
      semantius call crud read_field "{\"filters\": \"table_name=eq.$tbl\"}" | jq -r '.[].field_name'
    done

# 3. Extract and transform: get entity names, extract label columns
semantius call crud read_entity '{"limit": 10}' \
  | jq -r '.[] | "\(.table_name): \(.label_column)"'

# 4. Conditional execution: check entity exists before adding fields (all new fields in ONE call)
semantius call crud read_entity '{"filters": "table_name=eq.products"}' \
  | jq -e '.[0]' \
  && semantius call crud create_field '{"data": [{"table_name": "products", "field_name": "sku", "title": "SKU", "format": "string", "width": "default", "input_type": "default"}, {"table_name": "products", "field_name": "barcode", "title": "Barcode", "format": "string", "width": "default", "input_type": "default"}]}'

# 4b. Bulk create with the read-before-write sweep: ONE in.() read over every item, then ONE create, then ONE verify read
semantius call crud read_field '{"filters": "table_name=eq.products&field_name=in.(sku,barcode)", "select": "field_name"}'   # [] → both missing
semantius call crud create_field '{"data": [ ...the missing fields... ]}'                                                       # one call, one transaction
semantius call crud read_field '{"filters": "table_name=eq.products&field_name=in.(sku,barcode)", "select": "field_name"}' | jq 'length'   # verify: 2

# 5. Save output to file
semantius call cube load '{"query": {"measures": ["Sales.count"], "dimensions": ["Products.category"]}}' \
  | jq '.' > sales_by_category.json

# 6. Error handling in scripts
if result=$(semantius call crud read_entity '{"filters": "table_name=eq.config"}' 2>/dev/null); then
  echo "$result" | jq '.[0].id'
else
  echo "Entity not found, creating it..."
fi

# 7. Aggregate results from multiple servers
{
  semantius call crud read_entity '{"limit": 5}'
  semantius call cube discover '{}'
} | jq -s '.'
```

**Tips for chaining:**
- Use `jq -r` for raw output (no surrounding quotes)
- Use `jq -e` for conditional checks (exit code 1 if false/null)
- Use `2>/dev/null` to suppress errors when testing existence
- Use `| jq -s '.'` to combine multiple JSON outputs into an array
- Batch related writes: build the array first (a `jq` expression, a Bun script), then **one** `create_*` / `update_*` / `delete_*` call, then one `read_*` with `in.(...)` to verify — never a `while read` loop that issues one write per line

**jq availability check:** If `jq` may not be available (e.g., minimal containers), detect first:
```bash
if command -v jq >/dev/null 2>&1; then
    ID=$(echo "$response" | jq -r '.[0].id')
else
    # Python fallback (works on most systems)
    ID=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)[0].get('id',''))")
fi
```

---

## Moving Entities and Modules Between Hosts

The built-in `utils` server exports entities, or a whole module, from one host into a JSON file, and imports that file into another host as an upsert (stage → prod, prod → test). `--host` picks the host each side runs against. With `--host`, only a stored session for that host is used: `semantius --host <h> whoami` tells you whether one exists (exit `5` means none). The workflow around these tools (scoping, the confirmation gate, verification, backup and restore) is the `semantius-transfer` skill; this section is the mechanics.

```bash
semantius --host stage.example.com call utils/export_module '{"name":"CRM","path":"crm.json"}'
semantius --host prod.example.com  call utils/import_module '{"path":"crm.json"}'

# Single tables: schema and records, or either alone
semantius call utils/export_entities '{"names":"accounts,contacts","path":"accounts.json"}'
semantius call utils/export_entities '{"names":"accounts","exclude_schema":true,"path":"data.json"}'
semantius call utils/import_entities '{"path":"accounts.json"}'
```

- **What travels.** `export_module` writes the module, its permissions, permission hierarchy, roles and grants, then its entities with their fields and records. `export_entities` writes entities, fields and records. Metadata is keyed by name (`module_name`, role `slug`, `permission_name`), never by a host's ids. Metadata and system tables (`users`, `roles`, `entities`, …) cannot be exported.
- **Records keep their ids.** The import upserts by the entity's id column, so it overwrites any target row with the same id. References between exported tables keep their values; references to other tables keep their ids too, so their target rows must exist. References to `users` travel as `{"external_id": …}`: a user's numeric id differs between hosts, `external_id` does not. An unknown `external_id` is an error.
- **Re-runs are cheap.** Every step reads the target first and writes only what differs, so re-running a failed import resumes it, and re-importing unchanged data writes nothing. Nothing is ever deleted, and there is no transaction across requests.
- **`import_entities` also takes a module file**, importing only its entities (their module must exist on the target). `import_module` needs a module file.
- **The target needs the `fix_id_sequence` RPC**, which moves each table's id sequence past the imported ids. A target on 0.5.0-beta1 lacks it until it is rebuilt; the import then stops before writing any record.
- **Validation rules and `select_rule`** are written once the fields exist and **before any record**, so a first import and a re-import meet the same rules. A record that violates the exported rules fails the import instead of being written: a file exported from a host whose rules were added after its data may not import cleanly. That is intended, not transient: fix the data or the rule, don't retry.
- **`id_type`** (the entity's key type) and **`id_refentity`** are sent on create only; both are locked once the table exists, so a re-import onto an existing entity leaves them alone.
- **The file** is valid JSON with metadata pretty-printed and one record per line, so a committed file diffs record by record. A re-export of unchanged data is byte-identical.
- An export contains only the rows this user can see, and is not a snapshot of a source that is written to meanwhile. The tools always talk to the host's PostgREST directly: `--crud-mcp` and a `crud.postgrest` URL in the config file do not apply, and an authentication failure exits 4, not 5. A static `SEMANTIUS_JWT` is not refreshed, so it can expire during a long run.
- Records are compared as PostgREST prints them, so between hosts whose databases use different time zones every timestamp differs and every row is rewritten. A table with several hundred columns can exceed a proxy's URL limit (nginx: 8 KB), since reads and writes list every column.

---

## Connection Pooling (Daemon)

The `crud` tools run inside the CLI and call PostgREST directly, so there is no connection to keep open for them. For the other servers (`cube`, and `crud` under `--crud-mcp`), the CLI on Linux and macOS keeps each server's MCP connection open in a lazily spawned background daemon, so repeated calls skip the connect handshake. On Windows there is no daemon; every call opens a fresh connection.

- Each MCP server gets its own daemon process (a second instance of the `semantius` binary)
- 300-second idle timeout, auto-terminates when idle
- Stale-detection: config changes trigger re-spawn

**Control via environment:**
```bash
SEMANTIUS_NO_DAEMON=1 semantius info        # Force a fresh connection every time (Linux/macOS)
SEMANTIUS_DAEMON_TIMEOUT=120 semantius      # 2-minute idle timeout
SEMANTIUS_DEBUG=1 semantius info            # Show daemon spawn/reuse decisions on stderr
```

### Other Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEMANTIUS_API_KEY` | (required unless `SEMANTIUS_JWT`, `--token`, or a stored session) | API key; `org:key` also names the org. Ignored on a `--host` / current host |
| `SEMANTIUS_ORG` | (required unless `SEMANTIUS_HOST`, `--host`, `--token`, or a current host) | Organization name |
| `SEMANTIUS_HOST` | `https://<org>.semantius.cloud` | Host URL or hostname, same as `--host` |
| `SEMANTIUS_JWT` | (none) | Static token, used instead of the API key; `org:jwt` also names the org. Ignored on a `--host` / current host |
| (stored session) | (none) | Stored by `semantius use` / `login`, one per host, sealed under the CLI's secrets directory |
| `SEMANTIUS_LOGIN_FLOW` | `auto` | Same as `--login-flow` |
| `SEMANTIUS_CRUD_MCP` | `false` | `1` = same as `--crud-mcp` |
| `SEMANTIUS_STREAM` | `false` | `1` = `--stream` wherever it is valid |
| `SEMANTIUS_DISABLE_JWT_CACHE` | `false` | `1` = same as `--disable-jwt-cache` |
| `SEMANTIUS_CONFIG_PATH` | (none) | Path to a config file, overriding the default search |
| `SEMANTIUS_TIMEOUT` | `1800` (30 min) | Request timeout in seconds |
| `SEMANTIUS_CONCURRENCY` | `5` | Servers processed in parallel |
| `SEMANTIUS_MAX_RETRIES` | `3` | Retry attempts for transient errors |
| `SEMANTIUS_RETRY_DELAY` | `1000` | Base retry delay in milliseconds |
| `SEMANTIUS_STRICT_ENV` | `true` | Error on missing `${VAR}` in config |

---

## Connection Model: Which Servers Connect

| Command | Servers Connected |
|---------|-------------------|
| `semantius info` | All N servers in parallel |
| `semantius grep "*pattern*"` | All N servers in parallel |
| `semantius info <server>` | Only the specified server |
| `semantius info <server> <tool>` | Only the specified server |
| `semantius call <server> <tool> '{}'` | Only the specified server |

---

## Auto-Retry

The CLI automatically retries transient failures with exponential backoff.

**Auto-retried (transient):** `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, HTTP `502/503/504/429`

**Fail immediately (non-transient):** Invalid JSON config, auth errors (`401/403`), tool validation errors

---

## Error Reference

| Error Code | Cause | Fix |
|------------|-------|-----|
| `AMBIGUOUS_COMMAND` | `semantius server tool` (missing subcommand) | Use `call server tool` or `info server tool` |
| `UNKNOWN_SUBCOMMAND` | Used `run`, `list`, etc. | Use `call` or `info` |
| `SERVER_NOT_FOUND` | Server name not in config | Check `semantius info` for available servers |
| `TOOL_NOT_FOUND` | Tool not in server | Run `semantius info <server>` to see all tools |
| `INVALID_JSON_ARGUMENTS` | Malformed JSON | Use valid JSON with double-quoted keys, pass via stdin to avoid shell escaping |
| `MISSING_ARGUMENT` | `semantius call server` (no tool) | Add tool name |
| `MISSING_ENV_VAR` | No host from any source (exit `1`) | Ask the user which host; then `semantius use <host>` (or `SEMANTIUS_ORG` / `SEMANTIUS_HOST` for automation) |
| `HOST_CONFLICT` | An `org:`-prefixed key or JWT names a different host than `SEMANTIUS_HOST` / `SEMANTIUS_ORG` set in the same place | Make the pair agree, or drop one |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Bad args / config / JSON (including `--single` combined with an array in `data` / `body` / `id` / `table_name` — `SINGLE_ARRAY_INPUT`, rejected before any network I/O), **or** `--single` returned zero rows (mutually exclusive flows) |
| `2` | `--single` returned two or more rows (also what an `in.(...)` filter that matches several rows produces under `--single` — use an array read for multi-key sweeps) |
| `3` | Network / transport failure (transient, retryable: `ECONNREFUSED`, `ETIMEDOUT`, `5xx`, `429` after retry exhaustion) |
| `4` | Tool execution failed (RLS denial, duplicate key, schema violation, validation rule) |
| `5` | Auth failure (no credentials, invalid `SEMANTIUS_API_KEY`, `401`, `403`) |

Notes:
- Exit `1` carries two meanings, but they cannot co-occur: a malformed
  request never reaches the server, so a zero-row `1` and a bad-args
  `1` are distinct branches in execution. Recipes treat exit `1` from
  a `--single` read as "not found" by convention; bad-args `1`
  indicates a recipe bug and is caught at development time.
- Exit `3` and `5` are split so recipes can branch on retry-ability
  without parsing stderr: `3` is transient (retry once or twice with
  backoff), `5` is permanent (abort and surface credential failure
  to the user). The CLI itself already auto-retries the common
  transient classes; a `3` reaching the script means retries were
  exhausted.
- Exit `4` is the bucket for any error returned by the tool itself
  (PostgREST rejection, RLS denial, unique-key violation, platform
  `validation_rules`). The response body on stderr carries the
  structured error; surface it verbatim. For a bulk call (array
  `data` / `id` / `body`) a `4` means the whole call was rolled back
  — nothing landed; fix the offending row the error names and
  re-issue the one call, never a loop of single-record calls.

---

## PostgREST Filter Operators (for `crud` read tools)

When building `filters` strings for `read_*` tools:

| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | Equals | `table_name=eq.products` |
| `neq` | Not equals | `status=neq.archived` |
| `ilike` | Case-insensitive match | `name=ilike.*smith*` |
| `in` | In list | `id=in.(1,2,3)` |
| `is` | Null check | `deleted_at=is.null` |
| `gt/gte/lt/lte` | Comparisons | `field_order=gte.5` |

Combine multiple filters with `&`: `"is_active=eq.true&module_id=eq.3"`
