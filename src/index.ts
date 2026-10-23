#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import { ConnectionConfigSchema } from './types.js';
import { ConnectionManager } from './connection-manager.js';
import {
	globalConfigFile,
	resolveEnvironment,
	variablePrefix,
	type ResolvedEnvironment,
	type Settings,
	type SettingsFile,
} from './environment.js';
import { settingsHelp } from './cli/settings-help.js';
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
	FindObjectsTool,
	GetIndexesTool,
	GetDefinitionTool,
	ListRoutinesTool,
} from './tools/index.js';
import { registerCommands, type CliContext } from './cli/commands.js';
import { getOutputMode, outputError, outputJson, outputPlain, heading, field } from './cli/output.js';
import type { BaseTool } from './tools/base.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

let connectionManager: ConnectionManager | undefined;
let context: CliContext | undefined;
let environment: ResolvedEnvironment | undefined;

/** CLI flags win over every settings source. */
function buildConfig(opts: GlobalOptions, settings: Settings): Record<string, unknown> {
	return {
		server: opts.host ?? settings.HOST ?? 'localhost',
		database: opts.database ?? settings.DATABASE,
		user: opts.user ?? settings.USER ?? '',
		password: opts.password ?? settings.PASSWORD ?? '',
		port: opts.port ?? parseInt(settings.PORT ?? '1433'),
		encrypt: opts.encrypt ?? (settings.ENCRYPT !== 'false'),
		trustServerCertificate: opts.trustCert ?? (settings.TRUST_CERT !== 'false'),
		connectionTimeout: opts.timeout ?? parseInt(settings.CONNECTION_TIMEOUT ?? '30000'),
		requestTimeout: parseInt(settings.REQUEST_TIMEOUT ?? '60000'),
		maxRows: opts.maxRows ?? parseInt(settings.MAX_ROWS ?? '1000'),
	};
}

function describeFile(file: SettingsFile): string {
	return file.exists ? file.path : `${file.path} (not found)`;
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
		FindObjectsTool,
		GetIndexesTool,
		GetDefinitionTool,
		ListRoutinesTool,
	];

	for (const ToolClass of toolClasses) {
		const tool = new ToolClass(cm, maxRows);
		tools.set(tool.getName(), tool);
	}

	return tools;
}

interface GlobalOptions {
	env?: string;
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
		.option('-e, --env <name>', 'Use the named environment: .env.<name> and SQLSERVER_<NAME>_* settings')
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
		.description('Show resolved connection config, settings file locations and connection string')
		.addHelpText('after', () => settingsHelp(globalConfigFile()))
		.action(async () => {
			if (!environment) {
				throw new Error('Connection settings not resolved');
			}
			const globalOpts = program.opts<GlobalOptions>();
			const rawConfig = buildConfig(globalOpts, environment.settings);
			const mode = getOutputMode(globalOpts);
			const { sources, projectFile, globalFile } = environment;

			const configData = {
				environment: environment.name ?? '(default)',
				projectFile: describeFile(projectFile),
				globalFile: describeFile(globalFile),
				variables: `${variablePrefix(environment.name)}*`,
				sources: sources.length > 0 ? sources.join('; ') : '(none)',
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
					projectFile,
					globalFile,
					sources,
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

	program.addHelpText('after', () => settingsHelp(globalConfigFile()));

	program.hook('preAction', async (thisCommand, actionCommand) => {
		const opts = thisCommand.opts<GlobalOptions>();

		try {
			environment = resolveEnvironment(opts.env, {
				cwd: process.cwd(),
				variables: process.env,
				globalFile: globalConfigFile(),
			});
		} catch (error) {
			outputError({
				error: error instanceof Error ? error.message : String(error),
				code: 'VALIDATION_ERROR',
				suggestions: [
					'Create the file .env.<name> in the current directory, for example .env.test',
					'Or set SQLSERVER_<NAME>_HOST, SQLSERVER_<NAME>_USER, ... in the shell or in the global file',
					'Run without --env to use the default settings',
				],
			}, getOutputMode(opts));
			process.exitCode = 1;
			throw error;
		}

		if (actionCommand.name() === 'config') return;

		if (opts.passwordStdin) {
			opts.password = await readPasswordFromStdin();
		}

		const rawConfig = buildConfig(opts, environment.settings);

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
