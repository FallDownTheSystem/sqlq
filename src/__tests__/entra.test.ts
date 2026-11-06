import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AccountInfo, TokenCacheContext } from '@azure/msal-node';
import { decryptCache, encryptCache, encryptedFileCachePlugin, matchAccounts } from '../entra.js';

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
	const work = account('Ann@Contoso.com', 'tenant-a');
	const guest = account('ann@contoso.com', 'tenant-b');
	const other = account('bob@contoso.com', 'tenant-a');

	it('should pick the configured user case-insensitively, within the tenant when one is set', () => {
		expect(matchAccounts([work, guest, other], { user: 'ANN@contoso.com', tenantId: undefined })).toEqual([work, guest]);
		expect(matchAccounts([work, guest, other], { user: 'ann@contoso.com', tenantId: 'TENANT-B' })).toEqual([guest]);
		expect(matchAccounts([work, other], { user: 'carol@contoso.com', tenantId: undefined })).toEqual([]);
	});

	it('should return every account in the tenant when no user is set', () => {
		expect(matchAccounts([work, guest, other], { user: '', tenantId: 'tenant-a' })).toEqual([work, other]);
	});
});
