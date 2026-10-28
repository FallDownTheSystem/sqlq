import { keychainAccount } from '../keychain.js';

describe('keychainAccount', () => {
	// Stored passwords are found by this exact string; a format change orphans them.
	it('should name the login as user@host:port with the host lower-cased', () => {
		expect(keychainAccount('Reader', 'SQL01.Corp.Local', 1433)).toBe('Reader@sql01.corp.local:1433');
		expect(keychainAccount('reader', 'sql01', 14330)).toBe('reader@sql01:14330');
	});
});
