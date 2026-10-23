import { resolve } from 'path';
import { SETTING_KEYS, variableName, type SettingKey } from '../environment.js';

const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
	HOST: 'Server hostname (default: localhost)',
	USER: 'Username (required)',
	PASSWORD: 'Password (required)',
	DATABASE: 'Default database (default: the login\'s default)',
	PORT: 'Port (default: 1433)',
	ENCRYPT: 'TLS encryption; "false" disables it (default: true)',
	TRUST_CERT: 'Trust the server certificate; "false" disables it (default: true)',
	CONNECTION_TIMEOUT: 'Connection timeout in ms (default: 30000)',
	REQUEST_TIMEOUT: 'Query timeout in ms (default: 60000)',
	MAX_ROWS: 'Maximum rows per query (default: 1000)',
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
    3. Global file     ${globalFile}
  CLI flags (--host, --user, ...) override all three sources.

  The files use dotenv format: one KEY=value per line, "#" starts a comment,
  and values with spaces or "#" go in quotes. Create the global file and its
  folder yourself if they do not exist.

  Keys:
${keys}

  Named environments (-e <name>):
    <name> may contain letters, digits, "-" and "_".
    .env.<name> uses the keys above unchanged.
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
