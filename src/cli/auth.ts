import { Command } from 'commander';
import { deleteKeychainPassword, storeKeychainPassword } from '../keychain.js';
import { getOutputMode, outputError, outputJson, outputPlain, pc, type OutputMode } from './output.js';

export interface AuthContext {
	/** The `user@host:port` keychain account of the resolved login. */
	account: string;
	/** Password given with --password or --password-stdin; prompt when undefined. */
	password: string | undefined;
	/** Why a stored password would not be used, when another source sets one. */
	shadowedBy: string | undefined;
}

type AuthContextGetter = () => Promise<AuthContext>;

/** A problem with the password input rather than with the credential store. */
class InputError extends Error {}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		return Promise.reject(new InputError('No terminal to prompt for the password; pipe it in with --password-stdin'));
	}

	return new Promise((resolve, reject) => {
		let value = '';
		const finish = (error?: Error) => {
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write('\n');
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') return finish();
				if (char === '\u0003') return finish(new InputError('Cancelled'));
				if (char === '\u007f' || char === '\b') {
					value = Array.from(value).slice(0, -1).join('');
				} else {
					value += char;
				}
			}
		};

		process.stderr.write(question);
		stdin.setEncoding('utf-8');
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on('data', onData);
	});
}

function report(mode: OutputMode, data: Record<string, unknown>, message: string): void {
	if (mode === 'json') outputJson(data);
	else outputPlain(message);
}

async function run(
	program: Command,
	getContext: AuthContextGetter,
	action: (ctx: AuthContext, mode: OutputMode) => Promise<void>,
): Promise<void> {
	const mode = getOutputMode(program.opts());
	let ctx: AuthContext;
	try {
		ctx = await getContext();
	} catch (error) {
		outputError({
			error: error instanceof Error ? error.message : String(error),
			code: 'VALIDATION_ERROR',
			suggestions: ['Set SQLSERVER_USER (and SQLSERVER_HOST, SQLSERVER_PORT) or use --user, --host, --port'],
		}, mode);
		process.exitCode = 1;
		return;
	}

	try {
		await action(ctx, mode);
	} catch (error) {
		outputError(error instanceof InputError
			? { error: error.message, code: 'VALIDATION_ERROR' }
			: {
				error: `OS keychain: ${error instanceof Error ? error.message : String(error)}`,
				code: 'KEYCHAIN_ERROR',
				suggestions: [
					'Check that the OS credential store is available and unlocked',
					'On Linux this needs a Secret Service provider such as GNOME Keyring or KWallet',
				],
			}, mode);
		process.exitCode = 1;
	}
}

export function registerAuthCommands(program: Command, getContext: AuthContextGetter): void {
	const auth = program
		.command('auth')
		.description('Manage the password stored in the OS keychain for the resolved user@host:port login');

	auth
		.command('set')
		.description('Prompt for the password and store it in the OS keychain')
		.action(() => run(program, getContext, async (ctx, mode) => {
			const password = ctx.password ?? await promptHidden(`Password for ${ctx.account}: `);
			if (!password) {
				throw new InputError('Password is empty; nothing stored');
			}
			await storeKeychainPassword(ctx.account, password);
			if (ctx.shadowedBy) {
				process.stderr.write(`${pc.yellow('Warning:')} ${ctx.shadowedBy}\n`);
			}
			report(mode, { stored: true, account: ctx.account }, `Stored the password for ${ctx.account} in the OS keychain`);
		}));

	auth
		.command('clear')
		.description('Remove the stored password from the OS keychain')
		.action(() => run(program, getContext, async (ctx, mode) => {
			const deleted = await deleteKeychainPassword(ctx.account);
			report(
				mode,
				{ deleted, account: ctx.account },
				deleted
					? `Removed the password for ${ctx.account} from the OS keychain`
					: `No password stored for ${ctx.account}`,
			);
		}));
}
