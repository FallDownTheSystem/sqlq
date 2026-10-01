# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`sqlq` is a read-only command-line client for Microsoft SQL Server. It explores databases, inspects schemas, and runs queries from the terminal. All queries are validated to be read-only (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN only).

## Commands

```bash
npm run build          # TypeScript compile (tsc) → dist/
npm run dev            # Run with tsx (no build needed)
npm start              # Run compiled output (dist/index.js)
npm run lint           # ESLint on src/**/*.ts
npm test               # Jest
```

## Architecture

**ESM project** — uses `"type": "module"` with `.js` extensions in imports. TypeScript targets ES2022 with ESNext modules.

### Entry Point

`src/index.ts` — Commander-based CLI. Reads connection config from environment variables (via `dotenv`) or CLI flags, validates with Zod, creates a `ConnectionManager`, and registers commands. Connection to SQL Server is deferred until the first command actually runs (handled by `preAction` / `postAction` hooks).

### Tool System

The original MCP server's "tools" remain as reusable query handlers under `src/tools/`. Each one extends `BaseTool` (`src/tools/base.ts`) which provides:
- `executeQuery()` — validates via `QueryValidator`, sanitizes, adds TOP row limit, runs query
- `executeSafeQuery()` — wraps `executeQuery` with lazy connection and error handling

Each tool implements four abstract methods: `getName()`, `getDescription()`, `getInputSchema()`, `execute()`. The CLI invokes them through `src/cli/commands.ts`, which maps Commander subcommands to tool invocations and renders results through formatters in `src/cli/formatters.ts`.

To add a new command: create a tool in `src/tools/`, extend `BaseTool`, export from `src/tools/index.ts`, register it in `initializeTools()` in `src/index.ts`, then add a Commander subcommand in `src/cli/commands.ts`.

### Security Layers

1. **QueryValidator** (`src/security.ts`) — Whitelist of allowed statement prefixes, blacklist of forbidden keywords (INSERT/UPDATE/DELETE/DROP/EXEC etc.), SQL injection pattern detection, query sanitization, automatic TOP clause injection
2. **ParameterValidator** (`src/validation.ts`) — Zod schemas for identifiers (schema/table/column/database names), bracket-escaping via `escapeIdentifier()`, reserved word rejection
3. **Error hierarchy** (`src/errors.ts`) — `SqlqError` base with typed subclasses (`ConnectionError`, `SecurityError`, `ValidationError`, `QueryError`, `TimeoutError`, `PermissionError`). `ErrorHandler` maps SQL Server error codes to these types with user-facing suggestions.

### Output

`src/cli/output.ts` handles three output modes — `rich` (default in TTY: colored tables and spinners), `plain` (`--plain` or piped: tab-separated text), and `json` (`--json`: raw JSON). All diagnostics go to stderr; data goes to stdout.

### Key Types

`src/types.ts` — `ConnectionConfigSchema` (Zod), `ConnectionConfig`, and interfaces for all SQL Server metadata shapes (`TableInfo`, `ColumnInfo`, `ForeignKeyInfo`, `ViewInfo`, `DatabaseInfo`, `ServerInfo`, `QueryResult`, `TableStats`).

## Environment Variables

Required: `SQLSERVER_HOST`, `SQLSERVER_USER`, `SQLSERVER_PASSWORD`
Optional: `SQLSERVER_DATABASE`, `SQLSERVER_PORT` (1433), `SQLSERVER_ENCRYPT` (true), `SQLSERVER_TRUST_CERT` (true), `SQLSERVER_CONNECTION_TIMEOUT` (30000), `SQLSERVER_REQUEST_TIMEOUT` (60000), `SQLSERVER_MAX_ROWS` (1000)

Any of these can be overridden by CLI flags (`--host`, `--user`, `--password`, `-d/--database`, `--port`, etc.).

## Conventions

- Strict TypeScript (`noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`, `noImplicitReturns`)
- Tool names use snake_case (`list_tables`, `execute_query`) — these are the keys in the tool map, not user-facing names
- Tools that take an object name parse it with `ParameterValidator.parseObjectName()` (`name`, `schema.name`, `db.schema.name`) and resolve it with `BaseTool.resolveObject()` (`src/tools/objects.ts`), which searches all schemas and throws errors that list alternatives and close matches. Metadata queries then filter by `object_id` against `sys.*` catalog views
- Object and schema names are always bound as query parameters, so validation only checks length; never interpolate them
- Identifiers are bracket-escaped (`[name]`) before interpolation into SQL
