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
} from './formatters.js';

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
		.command('describe <table>')
		.description('Get detailed table schema')
		.option('-s, --schema <name>', 'Schema name (default: dbo)')
		.action(async (tableName: string, opts: { schema?: string }) => {
			const params: Record<string, unknown> = { table_name: tableName };
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'describe_table', params, formatDescribe, `Describing ${tableName}...`);
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
		.description('Get foreign key relationships')
		.option('-s, --schema <name>', 'Schema name (default: dbo)')
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
		.option('-s, --schema <name>', 'Schema name (default: dbo)')
		.action(async (tableName: string | undefined, opts: { schema?: string }) => {
			const params: Record<string, unknown> = {};
			if (tableName) params.table_name = tableName;
			if (opts.schema) params.schema = opts.schema;
			await runTool(getContext, 'get_table_stats', params, formatTableStats, 'Fetching table stats...');
		});
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
