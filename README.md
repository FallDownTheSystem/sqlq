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

### Where settings come from

`sqlq` combines three sources, key by key. A source higher in this list wins:

1. The project file: `.env` in the current working directory
2. Shell environment variables
3. The global file: `%APPDATA%\sqlq\.env` on Windows, `$XDG_CONFIG_HOME/sqlq/.env` (default `~/.config/sqlq/.env`) elsewhere

CLI flags win over all three. Use the global file for servers you query from any directory, and a project file to pin a project to its own server.

`sqlq --help` prints the exact file paths on your machine, every key with its default, and an example file. `sqlq config` shows whether each file exists and which sources supplied the settings.

### Storing the password in the OS keychain

Instead of keeping the password in a file, store it in the OS keychain (macOS Keychain, Windows Credential Manager, or the Linux Secret Service):

```bash
sqlq auth set              # Prompts for the password of the resolved login
sqlq -e production auth set
sqlq auth clear            # Removes it again
```

Keep the host, user, and other settings in the sources above and leave out `SQLSERVER_PASSWORD`. The keychain is the last password source: `sqlq` reads it only when no flag, file, or shell variable sets a password.

Entries use the service `sqlq` and the account `user@host:port` of the resolved login, for example `reader@prod.example.com:1433`. The host is lower-cased and the port is always included. Because the entry belongs to a login rather than an environment name, a stored password is only sent to the server it was saved for, and environments that share a login share the entry. `sqlq config` shows which entry it checked; it never prints a password that came from the keychain.

`auth set` also accepts `--password-stdin`. On Linux it needs a running Secret Service provider such as GNOME Keyring or KWallet.

### Multiple servers

Select a named environment with `-e/--env`:

```bash
sqlq --env test tables
sqlq -e production query "SELECT TOP 10 * FROM dbo.Orders"
sqlq -e release config      # Show the sources and settings that were used
```

A named environment uses the same three sources:

1. The project file `.env.<name>`, with plain keys (`SQLSERVER_HOST`)
2. Shell variables with the name in the key: `-e prod-eu` reads `SQLSERVER_PROD_EU_HOST`, `SQLSERVER_PROD_EU_USER`, and so on
3. The global file, with the same named keys

The name is upper-cased and `-` becomes `_` in variable names. One global file can hold many environments:

```bash
# %APPDATA%\sqlq\.env
SQLSERVER_HOST=localhost
SQLSERVER_USER=sa
SQLSERVER_PASSWORD=...

SQLSERVER_PRODUCTION_HOST=prod.example.com
SQLSERVER_PRODUCTION_USER=reader
SQLSERVER_PRODUCTION_PASSWORD=...
```

A named environment never reads the default keys (`SQLSERVER_HOST`, ...) from any source. A key missing from `.env.test` therefore cannot fall back to the default server, which may be production. If no source defines the named environment, `sqlq` exits with an error.

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
sqlq routines               # List procedures and functions (alias: procs)
sqlq find <pattern>         # Find tables, views, routines and columns by name (alias: search)
sqlq describe <object>      # Columns: types, primary key, identity, defaults, references (aliases: columns, cols, desc)
sqlq indexes <table>        # Indexes with key and included columns (alias: idx)
sqlq definition <object>    # SQL source of a view, procedure, function or trigger (aliases: def, source)
sqlq foreign-keys [table]   # Foreign keys from and to a table, or all of them (alias: fk)
sqlq stats [table]          # Row counts and table sizes
sqlq server-info            # Server version and edition (alias: info)
sqlq test                   # Test your connection
sqlq query "SELECT ..."     # Run a read-only query
sqlq query -f query.sql     # Run SQL from a file
sqlq config                 # Show settings file locations and resolved connection config
```

Every command accepts an optional `-d/--database` flag to target a specific database without changing your connection config.

Commands that take an object accept `name`, `schema.name` or `database.schema.name`, with `[...]` quoting for unusual names. Without a schema, `sqlq` searches every schema. A name that exists in several schemas is an error that lists the qualified names. An unknown name is an error that lists close matches.

`find` matches the text anywhere in a name. Use `*` and `?` for a wildcard pattern instead, and `-k table,view,routine,trigger,synonym,column` to limit what it searches.

### Output Formats

By default, `sqlq` renders colored tables in your terminal. You can change this:

```bash
sqlq tables --json          # Raw JSON (good for piping to jq)
sqlq tables --plain         # Tab-separated plain text (good for scripting)
```

When stdout isn't a TTY (piped or redirected), it automatically falls back to plain text.

### Global Flags

```
-e, --env <name>         Use a named environment (.env.<name>, SQLSERVER_<NAME>_*)
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

# Find everything named like "product", then inspect it
sqlq -d AdventureWorks find product
sqlq -d AdventureWorks describe Production.Product
sqlq -d AdventureWorks fk Production.Product
sqlq -d AdventureWorks definition Production.vProductAndDescription

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
