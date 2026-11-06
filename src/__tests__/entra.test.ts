import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AccountInfo, TokenCacheContext } from '@azure/msal-node';
import {
	decryptCache,
	describeRejectedToken,
	encryptCache,
	encryptedFileCachePlugin,
	EntraLogin,
	matchAccounts,
	stsUrlFromDebug,
	tenantFromStsUrl,
} from '../entra.js';

const account = (username: string, tenantId: string) => ({ username, tenantId } as AccountInfo);

/** The part of MSAL's cache context the plugin uses. */
function context(serialized: string, cacheHasChanged: boolean) {
	const state = { deserialized: undefined as string | undefined };
	const ctx = {
		cacheHasChanged,
		tokenCache: {
			serialize: () => serialized,
			deserialize: (value: string) => { state.deserialized = value; },
		},
	} as unknown as TokenCacheContext;
	return { ctx, state };
}

describe('entra token cache', () => {
	const key = randomBytes(32);
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sqlq-entra-')); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it('should decrypt only with the key it was encrypted with', () => {
		const stored = encryptCache(key, '{"RefreshToken":{"secret":"r1"}}');

		expect(stored).not.toContain('r1');
		expect(decryptCache(key, stored)).toBe('{"RefreshToken":{"secret":"r1"}}');
		expect(decryptCache(randomBytes(32), stored)).toBeUndefined();
	});

	it('should treat a tampered or foreign file as an empty cache', () => {
		const stored = JSON.parse(encryptCache(key, 'cache')) as { data: string };
		const flipped = Buffer.from(stored.data, 'base64');
		flipped[0]! ^= 1;

		expect(decryptCache(key, JSON.stringify({ ...stored, data: flipped.toString('base64') }))).toBeUndefined();
		expect(decryptCache(key, '{"Account":{}}')).toBeUndefined();
		expect(decryptCache(key, 'not json')).toBeUndefined();
	});

	it('should persist the cache encrypted and load it back in a later process', async () => {
		const path = join(dir, 'nested', 'entra-token-cache.json');
		const plugin = encryptedFileCachePlugin(path, key);

		const unchanged = context('ignored', false);
		await plugin.beforeCacheAccess(unchanged.ctx);
		await plugin.afterCacheAccess(unchanged.ctx);
		expect(unchanged.state.deserialized).toBeUndefined();
		expect(() => readFileSync(path)).toThrow();

		await plugin.afterCacheAccess(context('{"secret":"token-1"}', true).ctx);
		expect(readFileSync(path, 'utf8')).not.toContain('token-1');

		const next = context('', false);
		await encryptedFileCachePlugin(path, key).beforeCacheAccess(next.ctx);
		expect(next.state.deserialized).toBe('{"secret":"token-1"}');

		writeFileSync(path, 'garbage');
		const corrupt = context('', false);
		await plugin.beforeCacheAccess(corrupt.ctx);
		expect(corrupt.state.deserialized).toBeUndefined();
	});
});

describe('matchAccounts', () => {
	const home = account('Ann@Contoso.com', 'tenant-a');
	const other = account('bob@contoso.com', 'tenant-a');

	it('should pick the configured user case-insensitively, whatever tenant the server asks for', () => {
		expect(matchAccounts([home, other], 'ANN@contoso.com')).toEqual([home]);
		expect(matchAccounts([home, other], 'carol@contoso.com')).toEqual([]);
		expect(matchAccounts([home, other], '')).toEqual([home, other]);
	});
});

describe('server tenant', () => {
	const guid = 'f88fbc21-f940-428d-b0cf-724caf714df2';

	it('should take the tenant from the STSURL on either login host', () => {
		expect(tenantFromStsUrl('https://login.windows.net/F88FBC21-F940-428D-B0CF-724CAF714DF2')).toBe(guid);
		expect(tenantFromStsUrl(`https://login.microsoftonline.com/${guid}/`)).toBe(guid);
		expect(tenantFromStsUrl('https://login.windows.net/contoso.onmicrosoft.com//')).toBe('contoso.onmicrosoft.com');
	});

	it('should ignore missing, malformed and foreign authorities', () => {
		for (const value of [undefined, '', 'not a url', `http://login.windows.net/${guid}`, `https://evil.example/${guid}`,
			'https://login.windows.net/', 'https://login.windows.net/common', 'https://login.windows.net/a b']) {
			expect(tenantFromStsUrl(value)).toBeUndefined();
		}
	});

	it('should read the STSURL from tedious token debug output only', () => {
		// util.inspect output of tedious' FedAuthInfoToken, colors included, as the driver emits it.
		const line = "FedAuthInfoToken {\n  name: \u001b[32m'FEDAUTHINFO'\u001b[39m,\n  handlerName: \u001b[32m'onFedAuthInfo'\u001b[39m,\n  spn: \u001b[32m'https://database.windows.net/'\u001b[39m,\n  stsurl: \u001b[32m'https://login.windows.net/F88FBC21-F940-428D-B0CF-724CAF714DF2'\u001b[39m\n}";
		expect(stsUrlFromDebug(line)).toBe('https://login.windows.net/F88FBC21-F940-428D-B0CF-724CAF714DF2');
		expect(stsUrlFromDebug("RowToken { stsurl: 'https://login.windows.net/x' }")).toBeUndefined();
		expect(stsUrlFromDebug('State change: SentLogin7WithFedauth -> LoggedIn')).toBeUndefined();
	});

	it('should prefer the configured tenant over the server\'s', () => {
		const options = { user: '', clientId: undefined, cacheFile: '/nonexistent' };
		expect(new EntraLogin({ ...options, tenantId: 'mine' }).tenantFor(guid)).toBe('mine');
		expect(new EntraLogin({ ...options, tenantId: undefined }).tenantFor(guid)).toBe(guid);
		expect(new EntraLogin({ ...options, tenantId: undefined }).tenantFor(undefined)).toBeUndefined();
	});

	it('should explain a token the server rejects, naming both tenants', () => {
		const message = "Login failed for user '<token-identified principal>'. The server is not currently configured to accept this token.";
		expect(describeRejectedToken(message, 'wrong-tenant', guid))
			.toBe(`The server rejected the Microsoft Entra token: sqlq signed in to wrong-tenant, but the server trusts tenant ${guid}.`);
		expect(describeRejectedToken("Login failed for user '<token-identified principal>'.", undefined, undefined))
			.toContain('signed in to your home tenant');
		expect(describeRejectedToken("Login failed for user 'sa'.", 'x', guid)).toBeUndefined();
	});
});
