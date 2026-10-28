import type { AsyncEntry } from '@napi-rs/keyring';

/** Every sqlq entry in the OS credential store uses this service name. */
export const KEYCHAIN_SERVICE = 'sqlq';

/**
 * Passwords are stored per login, not per environment name, so a stored
 * password is only ever sent to the server it was saved for. The host is
 * lower-cased and the port always included, so `SQL01` and `sql01:1433`
 * share one entry. Changing this format orphans every stored password.
 */
export function keychainAccount(user: string, host: string, port: number): string {
	return `${user}@${host.toLowerCase()}:${port}`;
}

/**
 * Loaded on first use so commands that never touch the keychain skip the
 * native module, and a platform without a prebuilt binary only fails here.
 */
async function entry(account: string): Promise<AsyncEntry> {
	const { AsyncEntry } = await import('@napi-rs/keyring');
	return new AsyncEntry(KEYCHAIN_SERVICE, account);
}

/** Resolves undefined when no password is stored; rejects when the store cannot be read. */
export async function readKeychainPassword(account: string): Promise<string | undefined> {
	return (await (await entry(account)).getPassword()) ?? undefined;
}

export async function storeKeychainPassword(account: string, password: string): Promise<void> {
	await (await entry(account)).setPassword(password);
}

/** Resolves false when there was nothing to delete. */
export async function deleteKeychainPassword(account: string): Promise<boolean> {
	return (await entry(account)).deletePassword();
}
