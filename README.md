# semantius

The official CLI for the [Semantius](https://semantius.com) platform. Connect to your Semantius organization's MCP servers to interact with your data, tools, and APIs directly from the command line or AI agents.

## Features

- 🪶 **Lightweight** - Minimal dependencies, fast startup
- 🔧 **Shell-Friendly** - JSON output for call, pipes with `jq`, chaining support
- 🤖 **Agent-Optimized** - Designed for AI coding agents (Gemini CLI, Claude Code, etc.)
- 🔌 **Semantius Platform** - Connects to your Semantius organization's `crud` and `cube` MCP servers
- ⚡ **Connection Pooling** - Lazy-spawn daemon keeps connections warm (60s idle timeout)
- 🔑 **Zero Config** - Works out of the box with `SEMANTIUS_API_KEY` and `SEMANTIUS_ORG` set
- 💡 **Actionable Errors** - Structured error messages with available servers and recovery suggestions

## Quick Start

### 1. Installation

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex
```

The Windows installer places `semantius.exe` in `%LOCALAPPDATA%\Programs\Semantius` and adds it to your user PATH automatically.

### 2. Set up credentials

Set your Semantius credentials. The CLI looks for a `.env` file next to the executable (Windows), in the current directory, or you can export them in your shell:

```bash
# Option 1: Export in shell
export SEMANTIUS_API_KEY=your-api-key
export SEMANTIUS_ORG=your-org-name

# Option 2: .env file (place next to the executable or in current directory)
# SEMANTIUS_API_KEY=your-api-key
# SEMANTIUS_ORG=your-org-name
```

The CLI automatically connects to your Semantius MCP servers (`crud` and `cube`) — no config file needed.

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

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIUS_API_KEY` | API key for Semantius (**required**) | (none) |
| `SEMANTIUS_ORG` | Organization name for Semantius (**required**) | (none) |
| `MCP_CONFIG_PATH` | Path to config file | (none) |
| `MCP_DEBUG` | Enable debug output | `false` |
| `MCP_TIMEOUT` | Request timeout (seconds) | `1800` (30 min) |
| `MCP_CONCURRENCY` | Servers processed in parallel (not a limit on total) | `5` |
| `MCP_MAX_RETRIES` | Retry attempts for transient errors (0 = disable) | `3` |
| `MCP_RETRY_DELAY` | Base retry delay (milliseconds) | `1000` |
| `MCP_STRICT_ENV` | Error on missing `${VAR}` in config | `true` |
| `MCP_NO_DAEMON` | Disable connection caching (force fresh connections) | `false` |
| `MCP_DAEMON_TIMEOUT` | Idle timeout for cached connections (seconds) | `60` |

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

## Architecture

### Connection Pooling (Daemon)

By default, the CLI uses **lazy-spawn connection pooling** to avoid repeated MCP server startup latency:

```
┌────────────────────────────────────────────────────────────────────┐
│                        First CLI Call                              │
│   $ semantius info server                                            │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Check: /tmp/semantius-{uid}/server.sock exists?                      │
└────────────────────────────────────────────────────────────────────┘
         │                                    │
         │ NO                                 │ YES
         ▼                                    ▼
┌─────────────────────────┐      ┌───────────────────────────────────┐
│ Fork background daemon  │      │ Connect to existing socket        │
│ ├─ Connect to MCP server│      │ ├─ Send request via IPC           │
│ ├─ Create Unix socket   │      │ ├─ Receive response               │
│ └─ Start 60s idle timer │      │ └─ Daemon resets idle timer       │
└─────────────────────────┘      └───────────────────────────────────┘
         │                                    │
         └────────────────┬───────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│ On idle timeout (60s): Daemon self-terminates, cleans up files    │
└────────────────────────────────────────────────────────────────────┘
```

**Key features:**
- **Automatic**: No manual start/stop needed
- **Per-server**: Each MCP server gets its own daemon
- **Stale detection**: Config changes trigger re-spawn
- **Fast fallback**: 5s spawn timeout, then direct connection

**Control via environment:**
```bash
MCP_NO_DAEMON=1 semantius info      # Force fresh connection
MCP_DAEMON_TIMEOUT=120 semantius    # 2 minute idle timeout
MCP_DEBUG=1 semantius info          # See daemon debug output
```

### Connection Model (Direct)

When daemon is disabled (`MCP_NO_DAEMON=1`), the CLI uses a **lazy, on-demand connection strategy**. Server connections are only established when needed and closed immediately after use.

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER REQUEST                            │
└─────────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │   semantius info  │ │ semantius grep    │ │ semantius call    │
    │   (list all)    │ │   "*pattern*"   │ │  server tool {} │
    └─────────────────┘ └─────────────────┘ └─────────────────┘
              │                 │                 │
              ▼                 ▼                 ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │  Connect to ALL │ │  Connect to ALL │ │  Connect to ONE │
    │  servers (N)    │ │  servers (N)    │ │  server only    │
    └─────────────────┘ └─────────────────┘ └─────────────────┘
              │                 │                 │
              ▼                 ▼                 ▼
         List tools       Search tools       Execute tool
              │                 │                 │
              ▼                 ▼                 ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                    CLOSE CONNECTIONS                        │
    └─────────────────────────────────────────────────────────────┘
```

**When are servers connected?**

| Command | Servers Connected |
|---------|-------------------|
| `semantius info` | All N servers in parallel |
| `semantius grep "*pattern*"` | All N servers in parallel |
| `semantius info <server>` | Only the specified server |
| `semantius info <server> <tool>` | Only the specified server |
| `semantius call <server> <tool> '{}'` | Only the specified server |


### Error Handling & Retry

The CLI includes **automatic retry with exponential backoff** for transient failures.

**Transient errors (auto-retried):**
- Network: `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`
- HTTP: `502`, `503`, `504`, `429`

**Non-transient errors (fail immediately):**
- Config: Invalid JSON, missing fields
- Auth: `401`, `403`
- Tool: Validation errors, not found


## Development

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0

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

### Local Testing

Test the CLI locally without compiling by using `bun link`:

```bash
# Link the package globally (run once)
bun link

# Now you can use 'semantius' anywhere
semantius --help
semantius info crud

# Or run directly during development
bun run dev --help
bun run dev info crud
```

To unlink when done:

```bash
bun unlink
```

### Releasing

Releases are automated via GitHub Actions. Use the release script:

```bash
./scripts/release.sh 0.2.0
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