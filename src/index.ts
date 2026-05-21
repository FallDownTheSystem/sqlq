#!/usr/bin/env node

import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });

import { createRequire } from 'module';
import { Command } from 'commander';
import { ConnectionConfigSchema } from './types.js';
import { ConnectionManager } from './connection-manager.js';
import {
	ListDatabasesTool,
	ListTablesTool,
	ListViewsTool,
	DescribeTableTool,
	ExecuteQueryTool,
	GetForeignKeysTool,
	GetServerInfoTool,
	GetTableStatsTool,
	TestConnectionTool,
} from './tools/index.js';
import { registerCommands, type CliContext } from './cli/commands.js';
import { getOutputMode, outputError, outputJson, outputPlain, heading, field } from './cli/output.js';
import type { BaseTool } from './tools/base.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

let connectionManager: ConnectionManager | undefined;
let context: CliContext | undefined;

function buildConfig(opts: GlobalOptions): Record<string, unknown> {
	return {
		server: opts.host ?? process.env.SQLSERVER_HOST ?? 'localhost',
		database: opts.database ?? process.env.SQLSERVER_DATABASE,
		user: opts.user ?? process.env.SQLSERVER_USER ?? '',
		password: opts.password ?? process.env.SQLSERVER_PASSWORD ?? '',
		port: opts.port ?? parseInt(process.env.SQLSERVER_PORT || '1433'),
		encrypt: opts.encrypt ?? (process.env.SQLSERVER_ENCRYPT !== 'false'),
		trustServerCertificate: opts.trustCert ?? (process.env.SQLSERVER_TRUST_CERT !== 'false'),
		connectionTimeout: opts.timeout ?? parseInt(process.env.SQLSERVER_CONNECTION_TIMEOUT || '30000'),
		requestTimeout: parseInt(process.env.SQLSERVER_REQUEST_TIMEOUT || '60000'),
		maxRows: opts.maxRows ?? parseInt(process.env.SQLSERVER_MAX_ROWS || '1000'),
	};
}

function initializeTools(cm: ConnectionManager, maxRows: number): Map<string, BaseTool> {
	const tools = new Map<string, BaseTool>();
	const toolClasses = [
		TestConnectionTool,
		ListDatabasesTool,
		ListTablesTool,
		ListViewsTool,
		DescribeTableTool,
		ExecuteQueryTool,
		GetForeignKeysTool,
		GetServerInfoTool,
		GetTableStatsTool,
	];

	for (const ToolClass of toolClasses) {
		const tool = new ToolClass(cm, maxRows);
		tools.set(tool.getName(), tool);
	}

	return tools;
}

interface GlobalOptions {
	json?: boolean;
	plain?: boolean;
	database?: string;
	host?: string;
	user?: string;
	password?: string;
	port?: number;
	encrypt?: boolean;
	trustCert?: boolean;
	timeout?: number;
	maxRows?: number;
	passwordStdin?: boolean;
}

async function readPasswordFromStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk: string) => { data += chunk; });
		process.stdin.on('end', () => resolve(data.trim().split('\n')[0]));
		process.stdin.on('error', reject);
	});
}

function buildConnectionString(config: Record<string, unknown>): string {
	const parts = [
		`Server=${config.server},${config.port}`,
		config.database ? `Database=${config.database}` : null,
		`User Id=${config.user}`,
		`Password=${config.password || ''}`,
		`Encrypt=${config.encrypt ? 'yes' : 'no'}`,
		`TrustServerCertificate=${config.trustServerCertificate ? 'yes' : 'no'}`,
		`Connection Timeout=${Math.floor(Number(config.connectionTimeout) / 1000)}`,
	];
	return parts.filter(Boolean).join(';');
}

function buildSqlcmdArgs(config: Record<string, unknown>): string {
	const parts = [
		'sqlcmd',
		`-S "${config.server},${config.port}"`,
		config.database ? `-d "${config.database}"` : null,
		`-U "${config.user}"`,
		`-P "${config.password || ''}"`,
		config.trustServerCertificate ? '-C' : null,
		config.encrypt ? '-N' : null,
		`-l ${Math.floor(Number(config.connectionTimeout) / 1000)}`,
	];
	return parts.filter(Boolean).join(' ');
}

async function main(): Promise<void> {
	const program = new Command();

	program
		.name('sqlq')
		.description('Read-only SQL Server CLI - explore databases, tables, schemas, and run queries')
		.version(version)
		.option('--json', 'Output raw JSON to stdout')
		.option('--plain', 'Plain text output, no tables or colors')
		.option('-d, --database <name>', 'Target database')
		.option('--host <host>', 'SQL Server hostname (overrides SQLSERVER_HOST)')
		.option('--user <user>', 'Database username (overrides SQLSERVER_USER)')
		.option('--password <password>', 'Database password (overrides SQLSERVER_PASSWORD)')
		.option('--port <port>', 'Port number (overrides SQLSERVER_PORT)', parseInt)
		.option('--encrypt', 'Enable encryption')
		.option('--no-encrypt', 'Disable encryption')
		.option('--trust-cert', 'Trust server certificate')
		.option('--no-trust-cert', 'Do not trust server certificate')
		.option('--timeout <ms>', 'Connection timeout in milliseconds', parseInt)
		.option('--max-rows <n>', 'Maximum rows to return', parseInt)
		.option('--password-stdin', 'Read password from stdin');

	program.on('option:json', () => {
		const opts = program.opts();
		if (opts.plain) {
			process.stderr.write('Error: --json and --plain are mutually exclusive\n');
			process.exit(1);
		}
	});

	program.on('option:plain', () => {
		const opts = program.opts();
		if (opts.json) {
			process.stderr.write('Error: --json and --plain are mutually exclusive\n');
			process.exit(1);
		}
	});

	program
		.command('config')
		.description('Show resolved connection config and connection string')
		.action(async () => {
			const globalOpts = program.opts<GlobalOptions>();
			const rawConfig = buildConfig(globalOpts);
			const mode = getOutputMode(globalOpts);

			const configData = {
				server: rawConfig.server,
				port: rawConfig.port,
				database: rawConfig.database ?? '(default)',
				user: rawConfig.user,
				password: rawConfig.password || '',
				encrypt: rawConfig.encrypt,
				trustServerCertificate: rawConfig.trustServerCertificate,
				connectionTimeout: rawConfig.connectionTimeout,
				requestTimeout: rawConfig.requestTimeout,
				maxRows: rawConfig.maxRows,
			};

			const connStr = buildConnectionString(rawConfig);
			const sqlcmdArgs = buildSqlcmdArgs(rawConfig);

			if (mode === 'json') {
				outputJson({
					...configData,
					connectionString: connStr,
					sqlcmd: sqlcmdArgs,
				});
				return;
			}

			if (mode === 'plain') {
				for (const [key, value] of Object.entries(configData)) {
					outputPlain(`${key}=${value}`);
				}
				outputPlain(`connectionString=${connStr}`);
				outputPlain(`sqlcmd=${sqlcmdArgs}`);
				return;
			}

			heading('Connection Config');
			for (const [key, value] of Object.entries(configData)) {
				field(key, value);
			}
			heading('Connection String');
			outputPlain(`  ${connStr}`);
			heading('sqlcmd');
			outputPlain(`  ${sqlcmdArgs}`);
		});

	registerCommands(program, () => {
		if (!context) {
			throw new Error('CLI context not initialized');
		}
		return context;
	});

	program.hook('preAction', async (thisCommand, actionCommand) => {
		if (actionCommand.name() === 'config') return;
		const opts = thisCommand.opts<GlobalOptions>();

		if (opts.passwordStdin) {
			opts.password = await readPasswordFromStdin();
		}

		const rawConfig = buildConfig(opts);

		let config;
		try {
			config = ConnectionConfigSchema.parse(rawConfig);
		} catch (error) {
			const mode = getOutputMode(opts);
			outputError({
				error: `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
				code: 'VALIDATION_ERROR',
				suggestions: [
					'Set SQLSERVER_HOST, SQLSERVER_USER, SQLSERVER_PASSWORD environment variables',
					'Or use --host, --user, --password flags',
				],
			}, mode);
			process.exitCode = 1;
			throw error;
		}

		if (!config.user || !config.password) {
			const mode = getOutputMode(opts);
			outputError({
				error: 'Missing credentials: user and password are required',
				code: 'VALIDATION_ERROR',
				suggestions: [
					'Set SQLSERVER_USER and SQLSERVER_PASSWORD environment variables',
					'Or use --user and --password flags',
					'For secure password input, use --password-stdin',
				],
			}, mode);
			process.exitCode = 1;
			throw new Error('Missing credentials');
		}

		connectionManager = new ConnectionManager(config);
		const tools = initializeTools(connectionManager, config.maxRows);
		const mode = getOutputMode(opts);

		context = {
			tools,
			connectionManager,
			database: opts.database,
			mode,
		};
	});

	program.hook('postAction', async () => {
		if (connectionManager) {
			await connectionManager.closeAll();
			connectionManager = undefined;
		}
	});

	try {
		await program.parseAsync(process.argv);
	} catch {
		if (!process.exitCode) {
			process.exitCode = 1;
		}
	} finally {
		if (connectionManager) {
			await connectionManager.closeAll();
		}
	}
}

main().catch(() => {
	process.exitCode = 1;
});
