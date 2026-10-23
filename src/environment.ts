import { parse } from 'dotenv';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export const SETTING_KEYS = [
	'HOST',
	'USER',
	'PASSWORD',
	'DATABASE',
	'PORT',
	'ENCRYPT',
	'TRUST_CERT',
	'CONNECTION_TIMEOUT',
	'REQUEST_TIMEOUT',
	'MAX_ROWS',
] as const;

export type SettingKey = typeof SETTING_KEYS[number];
export type Settings = Partial<Record<SettingKey, string>>;

export interface SettingsFile {
	path: string;
	exists: boolean;
}

export interface ResolvedEnvironment {
	name: string | undefined;
	settings: Settings;
	/** Sources that supplied at least one setting, highest priority first. */
	sources: string[];
	projectFile: SettingsFile;
	globalFile: SettingsFile;
}

export interface EnvironmentOptions {
	cwd: string;
	variables: NodeJS.ProcessEnv;
	globalFile: string;
}

const ENV_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Shell variables and the global file are shared by every environment, so a
 * named environment's keys carry its name: `-e prod-eu` reads
 * `SQLSERVER_PROD_EU_HOST`. Files dedicated to one environment use the plain
 * `SQLSERVER_HOST` form.
 */
export function variableName(key: SettingKey, envName?: string): string {
	return `${variablePrefix(envName)}${key}`;
}

export function variablePrefix(envName?: string): string {
	if (envName === undefined) {
		return 'SQLSERVER_';
	}
	return `SQLSERVER_${envName.toUpperCase().replace(/-/g, '_')}_`;
}

export function projectFileName(envName?: string): string {
	return envName === undefined ? '.env' : `.env.${envName}`;
}

export function globalConfigFile(
	platform: NodeJS.Platform = process.platform,
	variables: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const base = platform === 'win32'
		? variables.APPDATA || join(home, 'AppData', 'Roaming')
		: variables.XDG_CONFIG_HOME || join(home, '.config');
	return join(base, 'sqlq', '.env');
}

function readEnvFile(path: string): Record<string, string> | undefined {
	try {
		return parse(readFileSync(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

function pick(values: Record<string, string | undefined>, envName: string | undefined): Settings {
	const settings: Settings = {};
	for (const key of SETTING_KEYS) {
		const value = values[variableName(key, envName)];
		if (value !== undefined && value !== '') {
			settings[key] = value;
		}
	}
	return settings;
}

/**
 * Layers settings by key, highest priority first: the project file (`.env` or
 * `.env.<name>`), then shell variables, then the global file. A named
 * environment reads only that environment's keys in every source and never
 * the default ones. Layering them would let a key missing from `.env.test`
 * silently fall back to whatever server the defaults point at, which may be
 * production.
 */
export function resolveEnvironment(envName: string | undefined, options: EnvironmentOptions): ResolvedEnvironment {
	if (envName !== undefined && !ENV_NAME_PATTERN.test(envName)) {
		throw new Error(`Invalid environment name "${envName}": use letters, digits, "-" or "_"`);
	}

	const localPath = resolve(options.cwd, projectFileName(envName));
	const localValues = readEnvFile(localPath);
	const globalValues = readEnvFile(options.globalFile);

	const layers: Array<{ source: string; settings: Settings }> = [
		{ source: localPath, settings: localValues ? pick(localValues, undefined) : {} },
		{ source: 'environment variables', settings: pick(options.variables, envName) },
		{ source: options.globalFile, settings: globalValues ? pick(globalValues, envName) : {} },
	];

	const settings: Settings = {};
	const sources: string[] = [];
	for (const layer of layers) {
		if (Object.keys(layer.settings).length === 0) continue;
		sources.push(layer.source);
		for (const key of SETTING_KEYS) {
			const value = layer.settings[key];
			if (settings[key] === undefined && value !== undefined) {
				settings[key] = value;
			}
		}
	}

	if (envName !== undefined && sources.length === 0) {
		throw new Error(
			`Environment "${envName}" not found: no settings in ${localPath}, `
			+ `no ${variableName('HOST', envName)}-style environment variables, `
			+ `and none in ${options.globalFile}`,
		);
	}

	return {
		name: envName,
		settings,
		sources,
		projectFile: { path: localPath, exists: localValues !== undefined },
		globalFile: { path: options.globalFile, exists: globalValues !== undefined },
	};
}
