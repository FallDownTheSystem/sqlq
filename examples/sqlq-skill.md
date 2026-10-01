---
name: sqlq
description: "SQL Server explorer (sqlq CLI) for schema, tables, columns, foreign keys, indexes, and read-only queries."
argument-hint: "[find <term>|describe <object>|fk <table>|definition <object>|indexes <table>|query <SQL>|tables|databases|test]"
allowed-tools: Bash(sqlq *)
effort: medium
disable-model-invocation: false
---

# SQL Server Database Explorer (sqlq)

Explore MS SQL Server databases using the `sqlq` CLI tool. Read-only — never modify data or schema.

## Connection

`sqlq` reads connection config from environment variables or a `.env` file in the current working directory.

Required env vars:
```
SQLSERVER_HOST=your-server
SQLSERVER_USER=your-username
SQLSERVER_PASSWORD=your-password
```

Optional:
```
SQLSERVER_DATABASE=your-database
SQLSERVER_PORT=1433
SQLSERVER_ENCRYPT=true
SQLSERVER_TRUST_CERT=true
```

CLI flags override env vars: `sqlq --host myserver --user sa --password secret tables`

For secure password input: `sqlq --password-stdin tables`

### Multiple servers (`-e, --env <name>`)

A project can hold one `.env.<name>` file per server, for example `.env.test`, `.env.release`, `.env.production`. Select one with `-e/--env`:

```bash
sqlq -e test tables
sqlq --env production query "SELECT TOP 10 * FROM dbo.Orders"
sqlq -e release config      # Show the loaded env file (envFile) and resolved settings
```

- With `--env`, `sqlq` reads only `.env.<name>`. It does not fall back to `.env` for missing keys.
- The named file overrides `SQLSERVER_*` vars already set in the shell. CLI flags override both.
- A missing file or a name with characters other than letters, digits, `-`, `_` is an error.
- Without `--env`, `sqlq` reads `.env` as before.

Before the first command, check for `.env.*` files in the working directory. If several exist and the user did not name one, ask which environment to use. Pass the same `-e <name>` on every command in the session. Treat `production` (or any live environment) with extra care: keep queries small with `TOP N` and filters.

## Schema Awareness

Databases often have multiple schemas (dbo, spm, hr, etc.). Commands that take an object accept `name`, `schema.name`, or `database.schema.name`, with `[...]` quoting for names with spaces or dots.

- Without a schema, `sqlq` searches every schema. It does not assume `dbo`.
- If the name exists in several schemas, the command fails and lists each qualified name. Pick the right one, or ask the user if the choice is unclear.
- If the name does not exist, the command fails and lists close matches and a `find` command. Read the suggestions before you try another name.
- Use the schema-qualified name in every query you write.

## Exploring a database

Use this sequence. Do not write `INFORMATION_SCHEMA` or `sys.*` queries for information that these commands give.

1. `sqlq find <term>`: find tables, views, routines, and columns whose names contain the term.
2. `sqlq describe <object>`: get the columns, types, nullability, primary key, identity, defaults, computed columns, and foreign key targets.
3. `sqlq fk <table>`: get the foreign keys from the table and the foreign keys of other tables that point to it. Use these to write joins.
4. `sqlq definition <view|procedure|function>`: read the SQL source to see what a view or procedure actually computes.
5. `sqlq indexes <table>`: see which columns are indexed before you filter or join a large table.
6. `sqlq stats <table>`: check the row count before you query a large table.
7. `sqlq query "..."`: query the data, with `TOP N` and filters.

Use `--plain` for compact output with one line per item.

## Commands

Route based on $ARGUMENTS or determine intent from natural language.

### `test` — Test Connection

```bash
sqlq test
sqlq test --json
```

### `databases` — List Databases

```bash
sqlq databases
sqlq databases --json
```

### `tables` — List Tables

```bash
sqlq tables
sqlq tables --schema dbo
sqlq tables -d OtherDB
sqlq tables --json
```

### `views` — List Views

```bash
sqlq views
sqlq views --schema dbo
```

### `routines` — List Procedures and Functions

```bash
sqlq routines
sqlq procs --schema dbo
```

### `find <pattern>` — Find Objects and Columns by Name

Matches the text anywhere in a name (`_` is literal). Use `*` and `?` for a wildcard pattern instead. Exact and prefix matches come first, then objects before columns.

```bash
sqlq find portfolio
sqlq find "Contract*Report"
sqlq find customer -k column            # Kinds: table, view, routine, trigger, synonym, column
sqlq find report -k table,view -s rpt
sqlq search portfolio                   # Alias
```

Plain output: `schema.object<TAB>type`, or `schema.object.column<TAB>column (table|view)<TAB>type`.

### `describe <object>` — Columns of a Table, View, or Table Function

Aliases: `columns`, `cols`, `desc`.

```bash
sqlq describe Users
sqlq columns sales.Orders
sqlq describe Orders --schema sales
sqlq describe OtherDB.dbo.Users
sqlq describe Users --json
```

Plain output, one line per column: `name<TAB>type<TAB>NULL|NOT NULL<TAB>flags`. The flags can be `PK`, `PK(n)` for composite keys, `IDENTITY`, `AS <expr>` for computed columns, `DEFAULT <expr>`, and `-> schema.table.column` for foreign keys.

### `indexes <table>` — Indexes of a Table or Indexed View

```bash
sqlq indexes sales.Orders
sqlq idx Orders
```

Plain output: `name<TAB>type<TAB>key columns<TAB>INCLUDE (...)<TAB>WHERE <filter>`.

### `definition <object>` — SQL Source of a View, Procedure, Function, or Trigger

Aliases: `def`, `source`.

```bash
sqlq definition rpt.ContractPortfolioReport
sqlq def dbo.GetOrders
```

### `query <sql>` — Execute Read-Only Query

```bash
sqlq query "SELECT TOP 10 * FROM Users"
sqlq query "SELECT * FROM Orders" --limit 50
sqlq query --file query.sql
echo "SELECT 1" | sqlq query -
sqlq query "SELECT TOP 5 * FROM sys.tables" --json
```

### `foreign-keys [table]` — Foreign Key Relationships

With a table, shows foreign keys in both directions: from the table, and from other tables to it. Without a table, shows all foreign keys (`-s` filters by the referencing schema).

```bash
sqlq foreign-keys
sqlq foreign-keys sales.Orders
sqlq fk Users
sqlq fk --schema sales
```

### `server-info` — Server Version and Edition

```bash
sqlq server-info
sqlq info
```

### `stats [table]` — Table Statistics

```bash
sqlq stats
sqlq stats Users
sqlq stats sales.Orders
sqlq stats --schema sales
```

### `schema` — Full Schema Discovery

Run `tables` then `describe` for each table. If >20 tables, ask user for full schema or subset.

## Output Modes

- Rich (default in TTY): colored tables, spinners
- Plain (`--plain` or piped): tab-separated, no color
- JSON (`--json`): raw JSON to stdout only

All diagnostics (spinners, errors) go to stderr. Data goes to stdout.

For piping: `sqlq tables --json | jq '.[] | .table_name'`

## Global Options

| Flag | Description |
|------|-------------|
| `-e, --env <name>` | Load settings from `.env.<name>` instead of `.env` |
| `--json` | Output raw JSON to stdout |
| `--plain` | Plain text, no tables/colors |
| `-d, --database <name>` | Target database override |
| `--host <host>` | Server hostname |
| `--user <user>` | Username |
| `--password <pw>` | Password (discouraged, use env or --password-stdin) |
| `--port <port>` | Port number |
| `--encrypt` / `--no-encrypt` | Encryption toggle |
| `--trust-cert` / `--no-trust-cert` | Certificate trust toggle |
| `--timeout <ms>` | Connection timeout |
| `--max-rows <n>` | Row limit |

## Safety Rules

Strictly read-only. `sqlq` validates all queries — only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN allowed. INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/EXEC and other modifying statements are rejected.

If user asks to modify data, explain read-only constraint.

## Errors

| Error | Cause |
|-------|-------|
| Authentication failed | Wrong credentials or no access |
| Server not found | Wrong hostname, SQL Server not running, firewall |
| SSL/Certificate error | Set `SQLSERVER_TRUST_CERT=true` or `--trust-cert` |
| Timeout | Add `--limit`, `TOP N`, or `WHERE` clause |
| Permission denied | Contact DBA for SELECT access |
| No tables ... named X | Object not found; read the "Did you mean" suggestions or run `sqlq find X` |
| "X" exists in N schemas | Name is ambiguous; use one of the listed `schema.name` forms |
| X is a procedure; "describe" works on ... | Wrong command for the object type; run the suggested command |
| Environment file not found | No `.env.<name>` in the working directory; list `.env.*` and check the name |
