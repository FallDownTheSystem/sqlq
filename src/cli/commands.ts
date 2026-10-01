import { Command } from 'commander';
import { readFileSync } from 'fs';
import type { BaseTool } from '../tools/base.js';
import type { ConnectionManager } from '../connection-manager.js';
import { ErrorHandler } from '../errors.js';
import { spinner, outputJson, outputError, type OutputMode } from './output.js';
import {
	formatConnectionTest,
	formatDatabases,
	formatTables,
	formatViews,
	formatDescribe,
	formatQuery,
	formatForeignKeys,
	formatServerInfo,
	formatTableStats,
	formatRoutines,
	formatFind,
	formatIndexes,
	formatDefinition,
} from './formatters.js';
import { FIND_KINDS } from '../tools/find-objects.js';

export interface CliContext {
	tools: Map<string, BaseTool>;
	connectionManager: ConnectionManager;
	database?: string | undefined;
	mode: OutputMode;
}

type ContextGetter = () => CliContext;

async function runTool(
	getContext: ContextGetter,
	toolName: string,
	params: Record<string, unknown>,
	formatter: (data: any, mode: OutputMode) => void,
	spinnerText: string,
): Promise<void> {
	const ctx = getContext();
	const tool = ctx.tools.get(toolName);
	if (!tool) {
		throw new Error(`Tool not found: ${toolName}`);
	}

	if (ctx.database) {
		params.database = ctx.database;
	}

	const s = ctx.mode === 'rich' ? spinner(spinnerText).start() : null;

	try {
		const result = await tool.execute(params);

		if (ctx.mode === 'json') {
			s?.success();
			outputJson(result);
		} else {
			s?.success();
			formatter(result, ctx.mode);
		}
	} catch (error) {
		const handled = ErrorHandler.handleSqlServerError(error);
		const userError = ErrorHandler.formatErrorForUser(handled);
		s?.error(userError.error);
		outputError(userError, ctx.mode);
		process.exitCode = 1;
	}
}

export function registerCommands(program: Command, getContext: ContextGetter): void {
	program
		.command('test')
		.description('Test SQL Server connection and permissions')
		.action(async () => {
			await runTool(getContext, 'test_connection', {}, formatConnectionTest, 'Testing connection...');
		});

	program
		.command('databases')
		.alias('dbs')
		.description('List all databases on the server')
		.action(async () => {
			await runTool(getContext, 'list_databases', {}, formatDatabases, 'Listing databases...');
		});

	program
		.command('tables')
		.description('List all tables')
		.option('-s, --schema <name>', 'Filter by schema')
		.action(async (opts: { schema?: string }) => {
			const params: Record<string, unknown> = {};
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'list_tables', params, formatTables, 'Listing tables...');
		});

	program
		.command('views')
		.description('List all views')
		.option('-s, --schema <name>', 'Filter by schema')
		.action(async (opts: { schema?: string }) => {
			const params: Record<string, unknown> = {};
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'list_views', params, formatViews, 'Listing views...');
		});

	program
		.command('routines')
		.alias('procs')
		.description('List stored procedures and functions')
		.option('-s, --schema <name>', 'Filter by schema')
		.action(async (opts: { schema?: string }) => {
			const params: Record<string, unknown> = {};
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'list_routines', params, formatRoutines, 'Listing routines...');
		});

	program
		.command('find <pattern>')
		.alias('search')
		.description('Find tables, views, routines and columns by name (substring, or wildcards * and ?)')
		.option('-k, --kind <kinds>', `Only these kinds, comma-separated: ${FIND_KINDS.join(', ')}`)
		.option('-s, --schema <name>', 'Filter by schema')
		.action(async (pattern: string, opts: { kind?: string; schema?: string }) => {
			const params: Record<string, unknown> = { pattern };
			if (opts.kind) params.kinds = opts.kind.split(',');
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'find_objects', params, formatFind, `Searching for ${pattern}...`);
		});

	program
		.command('describe <object>')
		.aliases(['columns', 'cols', 'desc'])
		.description('Show the columns of a table, view or table function: types, keys, defaults, references')
		.option('-s, --schema <name>', 'Schema name (or write schema.object)')
		.action(async (objectName: string, opts: { schema?: string }) => {
			const params: Record<string, unknown> = { table_name: objectName };
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'describe_table', params, formatDescribe, `Describing ${objectName}...`);
		});

	program
		.command('indexes <table>')
		.alias('idx')
		.description('Show the indexes of a table or indexed view')
		.option('-s, --schema <name>', 'Schema name (or write schema.table)')
		.action(async (tableName: string, opts: { schema?: string }) => {
			const params: Record<string, unknown> = { table_name: tableName };
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'get_indexes', params, formatIndexes, `Fetching indexes of ${tableName}...`);
		});

	program
		.command('definition <object>')
		.aliases(['def', 'source'])
		.description('Show the SQL source of a view, procedure, function or trigger')
		.option('-s, --schema <name>', 'Schema name (or write schema.object)')
		.action(async (objectName: string, opts: { schema?: string }) => {
			const params: Record<string, unknown> = { object_name: objectName };
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'get_definition', params, formatDefinition, `Fetching definition of ${objectName}...`);
		});

	program
		.command('query [sql]')
		.description('Execute a read-only SQL query')
		.option('-l, --limit <n>', 'Maximum rows to return', parseInt)
		.option('-f, --file <path>', 'Read SQL from file instead')
		.action(async (sql: string | undefined, opts: { limit?: number; file?: string }) => {
			let query: string;

			if (opts.file) {
				try {
					query = readFileSync(opts.file, 'utf-8').trim();
				} catch (error) {
					const ctx = getContext();
					const msg = error instanceof Error ? error.message : String(error);
					outputError({ error: `Failed to read file: ${msg}`, code: 'VALIDATION_ERROR' }, ctx.mode);
					process.exitCode = 1;
					return;
				}
			} else if (sql === '-') {
				query = await readStdin();
			} else if (sql) {
				query = sql;
			} else {
				const ctx = getContext();
				outputError({
					error: 'No SQL query provided',
					code: 'VALIDATION_ERROR',
					suggestions: [
						'Provide SQL inline: sqlq query "SELECT 1"',
						'Read from file: sqlq query --file query.sql',
						'Read from stdin: echo "SELECT 1" | sqlq query -',
					],
				}, ctx.mode);
				process.exitCode = 1;
				return;
			}

			const params: Record<string, unknown> = { query };
			if (opts.limit) params.limit = opts.limit;
			await runTool(getContext, 'execute_query', params, formatQuery, 'Executing query...');
		});

	program
		.command('foreign-keys [table]')
		.alias('fk')
		.description('Show foreign keys of a table in both directions, or all foreign keys')
		.option('-s, --schema <name>', 'Schema name (or write schema.table); without a table, filter by schema')
		.action(async (tableName: string | undefined, opts: { schema?: string }) => {
			const params: Record<string, unknown> = {};
			if (tableName) params.table_name = tableName;
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'get_foreign_keys', params, formatForeignKeys, 'Fetching foreign keys...');
		});

	program
		.command('server-info')
		.alias('info')
		.description('Get SQL Server version and edition info')
		.action(async () => {
			await runTool(getContext, 'get_server_info', {}, formatServerInfo, 'Fetching server info...');
		});

	program
		.command('stats [table]')
		.description('Get table statistics and row counts')
		.option('-s, --schema <name>', 'Schema name (or write schema.table); without a table, filter by schema')
		.action(async (tableName: string | undefined, opts: { schema?: string }) => {
			const params: Record<string, unknown> = {};
			if (tableName) params.table_name = tableName;
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'get_table_stats', params, formatTableStats, 'Fetching table stats...');
		});

	program.addHelpText('after', `
Exploring a database:
  sqlq find portfolio              Find tables, views, routines and columns by name
  sqlq describe sales.Orders       Columns with types, primary key, defaults, references
  sqlq fk sales.Orders             Foreign keys from and to the table
  sqlq indexes sales.Orders        Indexes with key and included columns
  sqlq definition dbo.MyView       SQL source of a view, procedure, function or trigger
  sqlq query "SELECT TOP 10 * FROM sales.Orders"

Object names can be name, schema.name or database.schema.name. Without a
schema, all schemas are searched; an unknown name lists close matches.`);
}

function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk: string) => { data += chunk; });
		process.stdin.on('end', () => resolve(data.trim()));
		process.stdin.on('error', reject);
	});
}
