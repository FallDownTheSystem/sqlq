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

/**
 * The cached accounts this login may use: the one named by the user setting,
 * or, without one, any account as long as there is only one to pick from.
 */
export function matchAccounts(accounts: AccountInfo[], options: Pick<EntraOptions, 'user' | 'tenantId'>): AccountInfo[] {
	const inTenant = options.tenantId
		? accounts.filter(account => account.tenantId.toLowerCase() === options.tenantId!.toLowerCase())
		: accounts;
	if (!options.user) return inTenant;
	const user = options.user.toLowerCase();
	return inTenant.filter(account => account.username.toLowerCase() === user);
}

const SUCCESS_PAGE = '<!doctype html><title>sqlq</title><p>Signed in to sqlq. You can close this tab.</p>';

export class EntraLogin {
	private app: Promise<PublicClientApplication> | undefined;
	private token: { token: string; expiresOnTimestamp: number } | undefined;
	/** Set when the token cache could not be persisted, so sign-ins are not remembered. */
	persistenceError: string | undefined;

	constructor(private readonly options: EntraOptions) {}

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
					authority: `https://login.microsoftonline.com/${this.options.tenantId ?? 'organizations'}`,
				},
				...(cachePlugin ? { cache: { cachePlugin } } : {}),
			});
		})();
		return this.app;
	}

	private async cachedAccounts(): Promise<AccountInfo[]> {
		const app = await this.client();
		return matchAccounts(await app.getTokenCache().getAllAccounts(), this.options);
	}

	/** Opens the browser for sign-in and MFA, as SSMS's "Microsoft Entra MFA" does. */
	async signIn(selectAccount = false): Promise<AccountInfo> {
		const app = await this.client();
		const { default: open } = await import('open');
		const result = await app.acquireTokenInteractive({
			scopes: [SQL_SCOPE],
			...(this.options.user ? { loginHint: this.options.user } : {}),
			...(selectAccount ? { prompt: 'select_account' } : {}),
			successTemplate: SUCCESS_PAGE,
			openBrowser: async (url) => {
				process.stderr.write(`Opening the browser for Microsoft Entra sign-in. If it does not open, go to:\n${url}\n`);
				await open(url).catch(() => undefined);
			},
		});
		if (!result.account) {
			throw new Error('Microsoft Entra sign-in returned no account');
		}
		this.remember(result.accessToken, result.expiresOn);
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
		this.token = undefined;
		return accounts.map(account => account.username);
	}

	private remember(token: string, expiresOn: Date | null): void {
		this.token = { token, expiresOnTimestamp: expiresOn?.getTime() ?? Date.now() + 5 * 60_000 };
	}

	/**
	 * Uses a cached sign-in when one matches and only opens the browser when
	 * it cannot be refreshed silently. Call it before connecting: tedious'
	 * connect timeout would otherwise expire during an MFA prompt.
	 */
	credential(): SqlTokenCredential {
		return {
			getToken: async () => {
				if (this.token && this.token.expiresOnTimestamp - Date.now() > 2 * 60_000) {
					return this.token;
				}
				const app = await this.client();
				const accounts = await this.cachedAccounts();
				if (accounts.length === 1) {
					try {
						const result = await app.acquireTokenSilent({ account: accounts[0]!, scopes: [SQL_SCOPE] });
						this.remember(result.accessToken, result.expiresOn);
						return this.token!;
					} catch {
						// Expired or revoked refresh token, or MFA required again: sign in below.
					}
				}
				await this.signIn(accounts.length > 1);
				return this.token!;
			},
		};
	}
}

const logins = new Map<string, EntraLogin>();

/** One login per user, tenant and client, so every pool shares one sign-in. */
export function entraLogin(options: EntraOptions): EntraLogin {
	const key = JSON.stringify([options.user.toLowerCase(), options.tenantId, options.clientId, options.cacheFile]);
	let login = logins.get(key);
	if (!login) {
		login = new EntraLogin(options);
		logins.set(key, login);
	}
	return login;
}
