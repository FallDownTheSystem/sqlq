import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { AccountInfo, ICachePlugin, PublicClientApplication, TokenCacheContext } from '@azure/msal-node';
import { globalConfigFile } from './environment.js';
import { readKeychainPassword, storeKeychainPassword } from './keychain.js';

/** Azure SQL and SQL Server with Entra accept tokens for this resource. */
export const SQL_SCOPE = 'https://database.windows.net/.default';

/**
 * The public client that @azure/identity and the Azure CLI sign in with. It
 * allows http://localhost redirects, which the browser flow needs. Set
 * SQLSERVER_CLIENT_ID when a tenant only allows its own app registration.
 */
export const DEFAULT_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

/** The keychain entry holding the key that encrypts the token cache file. */
export const CACHE_KEY_ACCOUNT = 'entra-token-cache-key';

/** Next to the global settings file, for example ~/.config/sqlq/entra-token-cache.json. */
export function entraCacheFile(): string {
	return join(dirname(globalConfigFile()), 'entra-token-cache.json');
}

export interface EntraOptions {
	/** Login hint and cached-account filter; any account when empty. */
	user: string;
	/** Set by the user; wins over the tenant the server asks for. */
	tenantId: string | undefined;
	clientId: string | undefined;
	cacheFile: string;
}

/** The shape tedious' `token-credential` authentication calls. */
export interface SqlTokenCredential {
	getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number }>;
}

/**
 * AES-256-GCM so a cache file copied off the machine, or edited, is useless
 * without the key in the OS keychain. Any file that does not decrypt is
 * treated as empty, which only means signing in again.
 */
export function encryptCache(key: Buffer, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return JSON.stringify({
		v: 1,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64'),
	});
}

export function decryptCache(key: Buffer, stored: string): string | undefined {
	try {
		const { v, iv, tag, data } = JSON.parse(stored) as Record<string, unknown>;
		if (v !== 1 || typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') {
			return undefined;
		}
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
		decipher.setAuthTag(Buffer.from(tag, 'base64'));
		return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
	} catch {
		return undefined;
	}
}

export function encryptedFileCachePlugin(path: string, key: Buffer): ICachePlugin {
	return {
		async beforeCacheAccess(context: TokenCacheContext) {
			let stored: string;
			try {
				stored = readFileSync(path, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
				throw error;
			}
			const cache = decryptCache(key, stored);
			if (cache !== undefined) {
				context.tokenCache.deserialize(cache);
			}
		},
		async afterCacheAccess(context: TokenCacheContext) {
			if (!context.cacheHasChanged) return;
			mkdirSync(dirname(path), { recursive: true });
			// Write then rename, so a parallel sqlq never reads half a file.
			const temp = `${path}.${process.pid}.tmp`;
			writeFileSync(temp, encryptCache(key, context.tokenCache.serialize()), { mode: 0o600 });
			renameSync(temp, path);
		},
	};
}

/** Created on first use and kept in the keychain, never on disk. */
async function cacheKey(): Promise<Buffer> {
	const stored = await readKeychainPassword(CACHE_KEY_ACCOUNT);
	if (stored) {
		const key = Buffer.from(stored, 'base64');
		if (key.length === 32) return key;
	}
	const key = randomBytes(32);
	await storeKeychainPassword(CACHE_KEY_ACCOUNT, key.toString('base64'));
	return key;
}

/** The cached accounts this login may use: the one named by the user setting, or all of them. */
export function matchAccounts(accounts: AccountInfo[], user: string): AccountInfo[] {
	if (!user) return accounts;
	const wanted = user.toLowerCase();
	return accounts.filter(account => account.username.toLowerCase() === wanted);
}

/**
 * The cached account to refresh silently for a tenant. MSAL lists one
 * account per tenant the user signed in to, all sharing a home account ID
 * and one refresh token, so several entries can be the same person. Prefers
 * the entry for the tenant, then the home tenant's. Resolves undefined when
 * the entries belong to different people and no user setting picks one.
 */
export function pickAccount(accounts: AccountInfo[], tenant: string | undefined): AccountInfo | undefined {
	const people = new Set(accounts.map(account => account.homeAccountId));
	if (people.size !== 1) return undefined;
	const wanted = tenant?.toLowerCase();
	return accounts.find(account => wanted !== undefined && account.tenantId.toLowerCase() === wanted)
		?? accounts.find(account => account.homeAccountId.toLowerCase().endsWith(`.${account.tenantId.toLowerCase()}`))
		?? accounts[0];
}

const TENANT_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i;

/**
 * The tenant in the STSURL an Azure SQL server sends in its FEDAUTHINFO
 * login token, for example https://login.windows.net/<tenant-id>. That is
 * the tenant of the server's Entra admin, the only one whose tokens it takes.
 */
export function tenantFromStsUrl(stsurl: string | undefined): string | undefined {
	if (!stsurl) return undefined;
	let url: URL;
	try {
		url = new URL(stsurl);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || !/^login\.(windows\.net|microsoftonline\.com)$/i.test(url.hostname)) {
		return undefined;
	}
	const tenant = url.pathname.split('/').filter(Boolean)[0];
	return tenant && TENANT_PATTERN.test(tenant) ? tenant.toLowerCase() : undefined;
}

/**
 * tedious reads FEDAUTHINFO but passes only the scope to the credential, so
 * the STSURL is taken from its public token debug output. Resolves
 * undefined for every other debug line.
 */
export function stsUrlFromDebug(text: string): string | undefined {
	const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
	if (!plain.startsWith('FedAuthInfoToken')) return undefined;
	return /stsurl: '([^']*)'/.exec(plain)?.[1];
}

/**
 * Explains a login failure for a token the server would not take; the
 * driver reports it as a generic login failure (error 18456).
 */
export function describeRejectedToken(
	message: string,
	usedTenant: string | undefined,
	serverTenant: string | undefined,
): string | undefined {
	if (!/token-identified principal|not currently configured to accept this token/i.test(message)) {
		return undefined;
	}
	const used = usedTenant ?? 'your home tenant';
	const asked = serverTenant ? `tenant ${serverTenant}` : 'a tenant it did not name';
	return `The server rejected the Microsoft Entra token: sqlq signed in to ${used}, but the server trusts ${asked}.`;
}

/** Thrown by the credential when only a browser sign-in can produce a token for the tenant. */
export class SignInRequired extends Error {
	constructor(readonly tenant: string | undefined) {
		super(`Microsoft Entra sign-in required for ${tenant ?? 'the home tenant'}`);
		this.name = 'SignInRequired';
	}
}

function authority(tenant: string | undefined): string {
	return `https://login.microsoftonline.com/${tenant ?? 'organizations'}`;
}

const SUCCESS_PAGE = '<!doctype html><title>sqlq</title><p>Signed in to sqlq. You can close this tab.</p>';

interface CachedToken { token: string; expiresOnTimestamp: number }

export class EntraLogin {
	private app: Promise<PublicClientApplication> | undefined;
	/** Access tokens by tenant ('' for the home tenant). */
	private tokens = new Map<string, CachedToken>();
	/** Set when the token cache could not be persisted, so sign-ins are not remembered. */
	persistenceError: string | undefined;

	constructor(private readonly options: EntraOptions) {}

	/** The tenant to sign in to: the configured one, else the one the server asked for. */
	tenantFor(serverTenant: string | undefined): string | undefined {
		return this.options.tenantId ?? serverTenant;
	}

	private client(): Promise<PublicClientApplication> {
		this.app ??= (async () => {
			const { PublicClientApplication } = await import('@azure/msal-node');
			let cachePlugin: ICachePlugin | undefined;
			try {
				cachePlugin = encryptedFileCachePlugin(this.options.cacheFile, await cacheKey());
			} catch (error) {
				this.persistenceError = error instanceof Error ? error.message : String(error);
			}
			return new PublicClientApplication({
				auth: {
					clientId: this.options.clientId ?? DEFAULT_CLIENT_ID,
					authority: authority(undefined),
				},
				...(cachePlugin ? { cache: { cachePlugin } } : {}),
			});
		})();
		return this.app;
	}

	private async cachedAccounts(): Promise<AccountInfo[]> {
		const app = await this.client();
		return matchAccounts(await app.getTokenCache().getAllAccounts(), this.options.user);
	}

	/**
	 * Opens the browser for sign-in and MFA, as SSMS's "Microsoft Entra MFA"
	 * does. When the browser already has a session that satisfies MFA, Entra
	 * redirects back at once without a prompt.
	 */
	async signIn(tenant: string | undefined, selectAccount = false): Promise<AccountInfo> {
		const app = await this.client();
		const { default: open } = await import('open');
		const result = await app.acquireTokenInteractive({
			scopes: [SQL_SCOPE],
			authority: authority(tenant),
			...(this.options.user ? { loginHint: this.options.user } : {}),
			...(selectAccount ? { prompt: 'select_account' } : {}),
			successTemplate: SUCCESS_PAGE,
			openBrowser: async (url) => {
				process.stderr.write(`Opening the browser for Microsoft Entra sign-in to ${tenant ?? 'your home tenant'}. If it does not open, go to:\n${url}\n`);
				await open(url).catch(() => undefined);
			},
		});
		if (!result.account) {
			throw new Error('Microsoft Entra sign-in returned no account');
		}
		this.remember(tenant, result.accessToken, result.expiresOn);
		if (this.persistenceError) {
			process.stderr.write(`Warning: the sign-in is not remembered, the OS keychain is unavailable: ${this.persistenceError}\n`);
		}
		return result.account;
	}

	/** Removes the cached sign-ins for this login; resolves the removed usernames. */
	async signOut(): Promise<string[]> {
		const app = await this.client();
		if (this.persistenceError) {
			throw new Error(`cannot open the token cache, the OS keychain is unavailable: ${this.persistenceError}`);
		}
		const accounts = await this.cachedAccounts();
		for (const account of accounts) {
			await app.getTokenCache().removeAccount(account);
		}
		this.tokens.clear();
		return accounts.map(account => account.username);
	}

	private remember(tenant: string | undefined, token: string, expiresOn: Date | null): void {
		this.tokens.set(tenant ?? '', { token, expiresOnTimestamp: expiresOn?.getTime() ?? Date.now() + 5 * 60_000 });
	}

	/** A token for the tenant from memory or the cache, refreshed silently; undefined when a browser sign-in is needed. */
	async silentToken(tenant: string | undefined): Promise<CachedToken | undefined> {
		const known = this.tokens.get(tenant ?? '');
		if (known && known.expiresOnTimestamp - Date.now() > 2 * 60_000) {
			return known;
		}
		const account = pickAccount(await this.cachedAccounts(), tenant);
		if (!account) return undefined;
		const app = await this.client();
		try {
			// One refresh token serves every tenant the account is a member or guest of.
			const result = await app.acquireTokenSilent({ account, scopes: [SQL_SCOPE], authority: authority(tenant) });
			this.remember(tenant, result.accessToken, result.expiresOn);
			return this.tokens.get(tenant ?? '');
		} catch {
			// Expired or revoked refresh token, or MFA required again.
			return undefined;
		}
	}

	/**
	 * The credential tedious calls during login, after the server has named
	 * its tenant. It never opens the browser: the login's connect timeout
	 * would run during MFA. It throws SignInRequired instead, and the caller
	 * signs in and connects again.
	 */
	credential(serverTenant: () => string | undefined): SqlTokenCredential {
		return {
			getToken: async () => {
				const tenant = this.tenantFor(serverTenant());
				const token = await this.silentToken(tenant);
				if (!token) throw new SignInRequired(tenant);
				return token;
			},
		};
	}
}

const logins = new Map<string, EntraLogin>();

/** One login per user and client, so every pool shares its sign-ins. */
export function entraLogin(options: EntraOptions): EntraLogin {
	const key = JSON.stringify([options.user.toLowerCase(), options.tenantId, options.clientId, options.cacheFile]);
	let login = logins.get(key);
	if (!login) {
		login = new EntraLogin(options);
		logins.set(key, login);
	}
	return login;
}
