import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEFAULT_CLIENT_ID, EntraLogin } from '../entra.js';

// The real MSAL client and cache plugin, with the OS keychain replaced so the test never touches it.
jest.mock('../keychain.js', () => {
	const key = Buffer.alloc(32, 7).toString('base64');
	return {
		readKeychainPassword: async () => key,
		storeKeychainPassword: async () => undefined,
		deleteKeychainPassword: async () => true,
	};
});

const HOME = '11111111-1111-1111-1111-111111111111';
const GUEST_A = 'f88fbc21-f940-428d-b0cf-724caf714df2';
const GUEST_B = '244cab79-fafb-44db-8e0a-d1bf2e82905d';
const USER = 'ann@contoso.com';

/** An MSAL cache as left by browser sign-ins to these tenants: one account entry and access token per tenant, one refresh token. */
function signedInCache(tenants: string[]): string {
	const now = Math.floor(Date.now() / 1000);
	const hid = `uid.${HOME}`;
	const env = 'login.microsoftonline.com';
	const idToken = (tid: string) => [
		'{"alg":"none"}',
		JSON.stringify({ preferred_username: USER, oid: `oid-${tid}`, tid, aud: DEFAULT_CLIENT_ID, iss: `https://${env}/${tid}/v2.0`, exp: now + 3600 }),
	].map(part => Buffer.from(part).toString('base64url')).join('.') + '.sig';
	const cache: Record<string, Record<string, object>> = {
		Account: {},
		IdToken: {},
		AccessToken: {},
		RefreshToken: {
			[`${hid}-${env}-refreshtoken-${DEFAULT_CLIENT_ID}--`]: {
				home_account_id: hid, environment: env, credential_type: 'RefreshToken', client_id: DEFAULT_CLIENT_ID, secret: 'rt',
			},
		},
		AppMetadata: {},
	};
	for (const tid of tenants) {
		cache.Account![`${hid}-${env}-${tid}`] = {
			home_account_id: hid, environment: env, realm: tid, local_account_id: `oid-${tid}`, username: USER, authority_type: 'MSSTS',
			client_info: Buffer.from(JSON.stringify({ uid: 'uid', utid: HOME })).toString('base64url'),
		};
		cache.IdToken![`${hid}-${env}-idtoken-${DEFAULT_CLIENT_ID}-${tid}-`] = {
			home_account_id: hid, environment: env, credential_type: 'IdToken', client_id: DEFAULT_CLIENT_ID, realm: tid, secret: idToken(tid),
		};
		cache.AccessToken![`${hid}-${env}-accesstoken-${DEFAULT_CLIENT_ID}-${tid}-https://database.windows.net/.default`] = {
			home_account_id: hid, environment: env, credential_type: 'AccessToken', client_id: DEFAULT_CLIENT_ID, secret: `token-${tid}`,
			realm: tid, target: 'https://database.windows.net/.default', cached_at: String(now),
			expires_on: String(now + 3600), extended_expires_on: String(now + 7200), token_type: 'Bearer',
		};
	}
	return JSON.stringify(cache);
}

describe('Entra silent sign-in from the cache', () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sqlq-entra-silent-')); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	async function loginWith(tenants: string[], tenantId?: string) {
		const login = new EntraLogin({ user: '', tenantId, clientId: undefined, cacheFile: join(dir, 'cache.json') });
		const app = await (login as unknown as { client(): Promise<{ getTokenCache(): { deserialize(c: string): void } }> }).client();
		app.getTokenCache().deserialize(signedInCache(tenants));
		const interactive = jest.spyOn(login, 'signIn');
		return { login, interactive };
	}

	// 6.1.1 skipped the silent path whenever MSAL listed more than one account,
	// which it does once the user has signed in to two tenants.
	it('should serve each server-named tenant from the cache when two tenants are signed in, in any order', async () => {
		const { login, interactive } = await loginWith([GUEST_A, GUEST_B]);
		const credential = (tenant: string) => login.credential(() => tenant).getToken('https://database.windows.net/.default');

		expect((await credential(GUEST_A)).token).toBe(`token-${GUEST_A}`);
		expect((await credential(GUEST_B)).token).toBe(`token-${GUEST_B}`);
		expect((await credential(GUEST_A)).token).toBe(`token-${GUEST_A}`);
		expect(interactive).not.toHaveBeenCalled();
	});

	it('should pick the right tenant entry next to the home tenant', async () => {
		const { login } = await loginWith([HOME, GUEST_B, GUEST_A]);

		expect((await login.silentToken(GUEST_A))?.token).toBe(`token-${GUEST_A}`);
		expect((await login.silentToken(undefined))?.token).toBe(`token-${HOME}`);
	});

	it('should use the configured tenant over the one the server names', async () => {
		const { login, interactive } = await loginWith([GUEST_A, GUEST_B], GUEST_B);

		const token = await login.credential(() => GUEST_A).getToken('https://database.windows.net/.default');

		expect(token.token).toBe(`token-${GUEST_B}`);
		expect(interactive).not.toHaveBeenCalled();
	});
});
