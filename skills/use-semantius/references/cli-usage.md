# semantius Usage Reference

## Installation

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex
```

The Windows installer places `semantius.exe` in `%LOCALAPPDATA%\Programs\Semantius` and adds it to your user PATH automatically.

## Credentials Setup

```bash
# Option 1: Export in shell
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name

# Option 2: .env file
# On Windows: place next to the executable
# On Linux/macOS: place in current working directory
# Contents:
# SEMANTIUS_API_KEY=your-api-key
# SEMANTIUS_ORG=your-org-name
```

---

## All Commands

```bash
semantius [options]                             # List all servers and tools
semantius [options] info <server>               # Show server tools and parameters
semantius [options] info <server> <tool>        # Show tool schema
semantius [options] grep <pattern>              # Search tools by glob pattern
semantius [options] call <server> <tool>        # Call tool (reads JSON from stdin)
semantius [options] call <server> <tool> <json> # Call tool with inline JSON args
```

Both `info <server> <tool>` and `info <server>/<tool>` work interchangeably.

### Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `-d, --with-descriptions` | Include tool descriptions in listing |
| `-md, --markdown` | Dump full documentation as markdown (README, SKILL, all tools) |

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
    Creates a new entity record in the entities table
    Parameters:
      • data (object, required) - Data object containing fields for the new entity
  read_entity
    ...

# Both formats work:
$ semantius info crud create_entity
$ semantius info crud/create_entity

Tool: create_entity
Server: crud
Description:
  Creates a new entity record in the entities table
Input Schema:
  {
    "type": "object",
    "properties": {
      "data": { "type": "object", "description": "Data object..." }
    },
    "required": ["data"]
  }
```

### Output Streams

| Stream | Content |
|--------|---------|
| **stdout** | Tool results and human-readable info |
| **stderr** | Errors and diagnostics |

---

## Workflow Pattern

Always follow this order:

1. **Discover** — `semantius info` to see available servers
2. **Explore** — `semantius info <server>` to see tools + parameters
3. **Inspect** — `semantius info <server> <tool>` to get the full JSON schema
4. **Execute** — `semantius call <server> <tool> '<json>'`

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

# Heredoc — no '-' needed with call subcommand
semantius call crud create_field <<EOF
{
  "data": {
    "table_name": "products",
    "field_name": "price",
    "title": "Price",
    "format": "float",
    "width": "auto",
    "input_type": "default"
  }
}
EOF

# From a file
cat args.json | semantius call crud create_entity
```

**Why stdin?** Shell interpretation of `{}`, quotes, and special characters requires careful escaping. Stdin bypasses shell parsing entirely.

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

# 4. Conditional execution: check entity exists before adding a field
semantius call crud read_entity '{"filters": "table_name=eq.products"}' \
  | jq -e '.[0]' \
  && semantius call crud create_field '{"data": {"table_name": "products", "field_name": "sku", "title": "SKU", "format": "string", "width": "auto", "input_type": "default"}}'

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

## Connection Pooling (Daemon)

By default the CLI uses a lazy-spawn background daemon to avoid MCP server startup latency on every call.

- Each MCP server gets its own daemon process
- 60-second idle timeout — auto-terminates when idle
- Stale-detection: config changes trigger re-spawn

**Control via environment:**
```bash
MCP_NO_DAEMON=1 semantius info      # Force fresh connection every time
MCP_DAEMON_TIMEOUT=120 semantius    # 2-minute idle timeout
MCP_DEBUG=1 semantius info          # Show daemon debug output
```

### Other Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEMANTIUS_API_KEY` | (required) | API key |
| `SEMANTIUS_ORG` | (required) | Organization name |
| `MCP_TIMEOUT` | `1800` (30 min) | Request timeout in seconds |
| `MCP_CONCURRENCY` | `5` | Servers processed in parallel |
| `MCP_MAX_RETRIES` | `3` | Retry attempts for transient errors |
| `MCP_RETRY_DELAY` | `1000` | Base retry delay in milliseconds |
| `MCP_STRICT_ENV` | `true` | Error on missing `${VAR}` in config |

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

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Client error (bad args, missing config) |
| `2` | Server error (tool failed) |
| `3` | Network error |

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
