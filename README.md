# sqlq

A read-only Microsoft SQL Server CLI. Explore databases, inspect schemas, and run queries directly from your terminal.

> Forked from [`@bilims/mcp-sqlserver`](https://github.com/AhmedBilims/mcp-sqlserver) by Onur Keskin. The original project was an MCP server; this fork strips the MCP layer and keeps only the CLI on top of the same query engine and security layer.

## Install

```bash
npm install -g @falldownthesystem/sqlq
```

Or run it directly:

```bash
npx @falldownthesystem/sqlq
```

## Configure

Connection is configured through environment variables or CLI flags. At minimum you need a host, user, and password.

```bash
export SQLSERVER_HOST="your-server.database.windows.net"
export SQLSERVER_USER="your-username"
export SQLSERVER_PASSWORD="your-password"
export SQLSERVER_DATABASE="your-database"
```

You can also set these optional variables:

| Variable | Default | Description |
|---|---|---|
| `SQLSERVER_PORT` | `1433` | Port number |
| `SQLSERVER_ENCRYPT` | `true` | TLS encryption |
| `SQLSERVER_TRUST_CERT` | `true` | Trust the server certificate (set `false` for Azure) |
| `SQLSERVER_CONNECTION_TIMEOUT` | `30000` | Connection timeout (ms) |
| `SQLSERVER_REQUEST_TIMEOUT` | `60000` | Query timeout (ms) |
| `SQLSERVER_MAX_ROWS` | `1000` | Max rows returned per query |

`sqlq` also reads a `.env` file from the current working directory.

### Multiple servers

Put each server's settings in its own `.env.<name>` file and pick one with `-e/--env`:

```bash
# .env.test, .env.release, .env.production, ...
sqlq --env test tables
sqlq -e production query "SELECT TOP 10 * FROM dbo.Orders"
sqlq -e release config      # Show which file and settings were used
```

With `--env`, `sqlq` reads only `.env.<name>`. It does not fall back to `.env` for missing keys, so a partial file cannot quietly connect to the wrong server. Values in the named file take precedence over `SQLSERVER_*` variables already set in your shell. CLI flags still take precedence over both. If the file does not exist, `sqlq` exits with an error.

## Usage

```bash
# Connection uses the same SQLSERVER_* env vars, or you can override with flags
sqlq --host myserver --user sa --password secret -d mydb <command>
```

### Commands

```bash
sqlq databases              # List all databases (alias: dbs)
sqlq tables                 # List tables (-s to filter by schema)
sqlq views                  # List views (-s to filter by schema)
sqlq describe <table>       # Show column details for a table
sqlq foreign-keys [table]   # Show foreign key relationships (alias: fk)
sqlq stats [table]          # Row counts and table sizes
sqlq server-info            # Server version and edition (alias: info)
sqlq test                   # Test your connection
sqlq query "SELECT ..."     # Run a read-only query
sqlq query -f query.sql     # Run SQL from a file
sqlq config                 # Show resolved connection config
```

Every command accepts an optional `-d/--database` flag to target a specific database without changing your connection config.

### Output Formats

By default, `sqlq` renders colored tables in your terminal. You can change this:

```bash
sqlq tables --json          # Raw JSON (good for piping to jq)
sqlq tables --plain         # Tab-separated plain text (good for scripting)
```

When stdout isn't a TTY (piped or redirected), it automatically falls back to plain text.

### Global Flags

```
-e, --env <name>         Load settings from .env.<name> instead of .env
-d, --database <name>    Target database
--host <host>            Override SQLSERVER_HOST
--user <user>            Override SQLSERVER_USER
--password <password>    Override SQLSERVER_PASSWORD
--password-stdin         Read password from stdin
--port <port>            Override SQLSERVER_PORT
--encrypt / --no-encrypt Toggle TLS encryption
--trust-cert / --no-trust-cert  Toggle certificate trust
--timeout <ms>           Connection timeout
--max-rows <n>           Max rows returned
--json                   JSON output
--plain                  Plain text output
```

### Examples

```bash
# List tables in the dbo schema
sqlq -d AdventureWorks tables -s dbo

# Describe a table
sqlq -d AdventureWorks describe Product

# Run a query and pipe to jq
sqlq -d AdventureWorks query "SELECT TOP 5 Name, ListPrice FROM Production.Product" --json | jq '.rows'

# Pipe password securely
echo "$DB_PASSWORD" | sqlq --password-stdin databases

# Read SQL from a file
sqlq -d mydb query -f reports/monthly.sql
```

## As an Agent Skill

You can give a coding agent terminal-level SQL Server access by exposing `sqlq` through an [Agent Skill](https://agentskills.io). The repo includes a reference skill at [`examples/sqlq-skill.md`](examples/sqlq-skill.md) covering all commands, output modes, connection options, and error handling. Copy it into your project or global skills directory.

## Security

All queries go through multiple validation layers before reaching the database:

- Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed
- Dangerous keywords (INSERT, UPDATE, DELETE, DROP, EXEC, etc.) are blocked
- SQL injection patterns are detected and rejected
- A TOP clause is automatically added to queries that don't have one
- TLS encryption is on by default

The user account only needs `CONNECT` and `SELECT` permissions.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Run sqlq with tsx
npm run lint         # ESLint
npm test             # Jest
```

## Troubleshooting

If you can't connect, check these things first:

1. Verify the hostname and port are correct
2. Make sure your encryption settings match the server (Azure needs `SQLSERVER_ENCRYPT=true`, `SQLSERVER_TRUST_CERT=false`)
3. Confirm the user has `CONNECT` and `SELECT` permissions
4. Test with SQL Server Management Studio or `sqlcmd` to rule out network issues

## License

MIT
