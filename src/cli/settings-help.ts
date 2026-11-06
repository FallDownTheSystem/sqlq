import { dirname, join, resolve } from 'path';
import { SETTING_KEYS, variableName, type SettingKey } from '../environment.js';

const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
	HOST: 'Server hostname (default: localhost)',
	USER: 'Username (required for SQL logins; Entra account with entra-mfa)',
	PASSWORD: 'Password (required for SQL logins)',
	DATABASE: 'Default database (default: the login\'s default)',
	PORT: 'Port (default: 1433)',
	ENCRYPT: 'TLS encryption; "false" disables it (default: true)',
	TRUST_CERT: 'Trust the server certificate; "false" disables it (default: true)',
	CONNECTION_TIMEOUT: 'Connection timeout in ms (default: 30000)',
	REQUEST_TIMEOUT: 'Query timeout in ms (default: 60000)',
	MAX_ROWS: 'Maximum rows per query (default: 1000)',
	AUTH: '"sql" (default) or "entra-mfa" for Microsoft Entra MFA',
	TENANT_ID: 'Entra tenant ID or domain (default: the account\'s home tenant)',
	CLIENT_ID: 'Entra app (client) ID for sign-in (default: the Azure CLI app)',
};

/** Rendered at help time so the paths match the directory and machine it runs on. */
export function settingsHelp(globalFile: string): string {
	const width = Math.max(...SETTING_KEYS.map(key => variableName(key).length));
	const keys = SETTING_KEYS
		.map(key => `    ${variableName(key).padEnd(width)}  ${SETTING_DESCRIPTIONS[key]}`)
		.join('\n');

	return `
Connection settings:
  sqlq takes each setting from the first of these sources that sets it:
    1. Project file    ${resolve('.env')}
                       With -e <name>: ${resolve('.env.<name>')}
    2. Shell environment variables
    3. With -e <name>: ${join(dirname(globalFile), '.env.<name>')}
    4. Global file     ${globalFile}
  CLI flags (--host, --user, ...) override all of these sources.

  OS keychain:
    When no source sets a password, sqlq reads it from the OS keychain
    (macOS Keychain, Windows Credential Manager, Linux Secret Service).
    Entries use the service "sqlq" and the account user@host:port of the
    resolved login, for example reader@prod.example.com:1433.
    "sqlq auth set" prompts for the password and stores it;
    "sqlq auth clear" removes it. Add -e <name> to pick the login.

  Microsoft Entra MFA (SQLSERVER_AUTH=entra-mfa or --auth entra-mfa):
    The same sign-in as "Microsoft Entra MFA" in SSMS. The first command
    opens the browser to sign in; set SQLSERVER_USER to your Entra account
    (user@example.com) to pre-fill it and pick it from several. No password
    is used. Sign-ins are cached in
    ${join(dirname(globalFile), 'entra-token-cache.json')},
    encrypted with a key kept in the OS keychain, and refreshed silently
    until the tenant asks for MFA again.
    "sqlq auth set" signs in again; "sqlq auth clear" signs out.

  The files use dotenv format: one KEY=value per line, "#" starts a comment,
  and values with spaces or "#" go in quotes. Create the global file and its
  folder yourself if they do not exist.

  Keys:
${keys}

  Named environments (-e <name>):
    <name> may contain letters, digits, "-" and "_".
    .env.<name>, in the project or next to the global file, uses the keys
    above unchanged.
    Shell variables and the global file add the name after SQLSERVER_, in
    upper case with "-" as "_": -e prod-eu reads SQLSERVER_PROD_EU_HOST.
    A named environment never reads the keys of the default environment.

  Example global file holding the default and a "prod" environment:
    SQLSERVER_HOST=localhost
    SQLSERVER_USER=sa
    SQLSERVER_PASSWORD=secret

    SQLSERVER_PROD_HOST=prod.example.com
    SQLSERVER_PROD_USER=reader
    SQLSERVER_PROD_PASSWORD=secret
    SQLSERVER_PROD_TRUST_CERT=false

  Run "sqlq config" (or "sqlq -e <name> config") to see which files exist
  and which sources supplied the settings.`;
}
