import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { globalConfigFile, resolveEnvironment, variableName } from '../environment.js';

describe('environment', () => {
	let root: string;
	let cwd: string;
	let globalFile: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'sqlq-env-'));
		cwd = join(root, 'project');
		mkdirSync(cwd);
		globalFile = join(root, 'config', 'sqlq', '.env');
		mkdirSync(join(root, 'config', 'sqlq'), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const resolveIn = (envName: string | undefined, variables: NodeJS.ProcessEnv = {}) =>
		resolveEnvironment(envName, { cwd, variables, globalFile });

	describe('variableName', () => {
		it('should use the plain key for the default environment', () => {
			expect(variableName('HOST')).toBe('SQLSERVER_HOST');
		});

		it('should insert the upper-cased environment name with dashes as underscores', () => {
			expect(variableName('TRUST_CERT', 'prod-eu')).toBe('SQLSERVER_PROD_EU_TRUST_CERT');
		});
	});

	describe('globalConfigFile', () => {
		it('should use APPDATA on Windows', () => {
			expect(globalConfigFile('win32', { APPDATA: 'C:\\Roaming' }, 'C:\\Home'))
				.toBe(join('C:\\Roaming', 'sqlq', '.env'));
		});

		it('should use XDG_CONFIG_HOME, then ~/.config, elsewhere', () => {
			expect(globalConfigFile('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(join('/xdg', 'sqlq', '.env'));
			expect(globalConfigFile('darwin', {}, '/home/u')).toBe(join('/home/u', '.config', 'sqlq', '.env'));
		});
	});

	describe('default environment', () => {
		it('should resolve nothing when no source has settings', () => {
			expect(resolveIn(undefined)).toEqual({
				name: undefined,
				settings: {},
				sources: [],
				projectFile: { path: join(cwd, '.env'), exists: false },
				globalFile: { path: globalFile, exists: false },
			});
		});

		it('should report files that exist even when they hold no settings', () => {
			writeFileSync(join(cwd, '.env'), '# empty\n');

			expect(resolveIn(undefined).projectFile).toEqual({ path: join(cwd, '.env'), exists: true });
		});

		it('should prefer .env over shell variables over the global file, key by key', () => {
			writeFileSync(join(cwd, '.env'), 'SQLSERVER_HOST=local\n');
			writeFileSync(globalFile, 'SQLSERVER_HOST=global\nSQLSERVER_USER=global\nSQLSERVER_PASSWORD=global\n');

			const result = resolveIn(undefined, { SQLSERVER_HOST: 'shell', SQLSERVER_USER: 'shell' });

			expect(result.settings).toEqual({ HOST: 'local', USER: 'shell', PASSWORD: 'global' });
			expect(result.sources).toEqual([join(cwd, '.env'), 'environment variables', globalFile]);
		});

		it('should ignore named-environment keys', () => {
			writeFileSync(globalFile, 'SQLSERVER_PROD_HOST=prod\n');

			expect(resolveIn(undefined, { SQLSERVER_PROD_USER: 'prod' }).settings).toEqual({});
		});

		it('should treat empty values as unset', () => {
			writeFileSync(join(cwd, '.env'), 'SQLSERVER_HOST=\n');

			expect(resolveIn(undefined, { SQLSERVER_HOST: 'shell' }).settings).toEqual({ HOST: 'shell' });
		});
	});

	describe('named environment', () => {
		it('should read plain keys from .env.<name> and prefixed keys from shared sources', () => {
			writeFileSync(join(cwd, '.env.prod'), 'SQLSERVER_HOST=local\n');
			writeFileSync(globalFile, 'SQLSERVER_PROD_HOST=global\nSQLSERVER_PROD_PASSWORD=global\n');

			const result = resolveIn('prod', { SQLSERVER_PROD_USER: 'shell' });

			expect(result.settings).toEqual({ HOST: 'local', USER: 'shell', PASSWORD: 'global' });
			expect(result.name).toBe('prod');
			expect(result.projectFile.path).toBe(join(cwd, '.env.prod'));
		});

		it('should resolve from shell variables alone', () => {
			const result = resolveIn('prod-eu', { SQLSERVER_PROD_EU_HOST: 'eu' });

			expect(result.settings).toEqual({ HOST: 'eu' });
			expect(result.sources).toEqual(['environment variables']);
		});

		it('should never fall back to default-environment keys', () => {
			writeFileSync(join(cwd, '.env'), 'SQLSERVER_PASSWORD=default\n');
			writeFileSync(join(cwd, '.env.test'), 'SQLSERVER_HOST=test\n');
			writeFileSync(globalFile, 'SQLSERVER_USER=default\n');

			const result = resolveIn('test', { SQLSERVER_DATABASE: 'default' });

			expect(result.settings).toEqual({ HOST: 'test' });
		});

		it('should ignore prefixed keys inside .env.<name>', () => {
			writeFileSync(join(cwd, '.env.prod'), 'SQLSERVER_PROD_HOST=wrong\nSQLSERVER_HOST=right\n');

			expect(resolveIn('prod').settings).toEqual({ HOST: 'right' });
		});

		it('should throw when no source defines the environment', () => {
			writeFileSync(join(cwd, '.env'), 'SQLSERVER_HOST=default\n');

			expect(() => resolveIn('missing')).toThrow('Environment "missing" not found');
		});

		it('should reject names with unsafe characters', () => {
			expect(() => resolveIn('../secrets')).toThrow('Invalid environment name');
		});
	});
});
