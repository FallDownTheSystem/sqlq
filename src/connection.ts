import sql from 'mssql';
import {
  describeRejectedToken,
  entraCacheFile,
  entraLogin,
  SignInRequired,
  stsUrlFromDebug,
  tenantFromStsUrl,
} from './entra.js';
import { SqlqError } from './errors.js';
import { ConnectionConfig, QueryParam } from './types.js';

export class SqlServerConnection {
  private static readonly TRANSIENT_ERRORS = new Set([
    'ETIMEOUT', 'ECONNCLOSED', 'ECONNRESET', 'ESOCKET', 'ECONNREFUSED'
  ]);

  private pool: sql.ConnectionPool | null = null;
  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return;
    }
    if (this.config.authentication === 'sql') {
      await this.openPool({ user: this.config.user, password: this.config.password });
      return;
    }

    const login = entraLogin({
      user: this.config.user,
      tenantId: this.config.tenantId,
      clientId: this.config.clientId,
      cacheFile: entraCacheFile(),
    });
    // Filled in from the server's FEDAUTHINFO during each login attempt.
    let serverTenant: string | undefined;
    const entraConfig: Partial<sql.config> = {
      authentication: { type: 'token-credential', options: { credential: login.credential(() => serverTenant) } },
      beforeConnect: (conn) => {
        const onDebug = (text: string) => {
          const stsurl = stsUrlFromDebug(text);
          if (stsurl !== undefined) serverTenant = tenantFromStsUrl(stsurl);
        };
        conn.on('debug', onDebug);
        // With no listener left, tedious stops formatting debug output, so queries pay nothing.
        conn.once('connect', () => conn.off('debug', onDebug));
      },
    };

    try {
      try {
        await this.openPool(entraConfig);
      } catch (error) {
        const signIn = findCause(error, (cause): cause is SignInRequired => cause instanceof SignInRequired);
        if (!signIn) throw error;
        // Outside the login, so the connect timeout does not run during MFA.
        await login.signIn(signIn.tenant);
        await this.openPool(entraConfig);
      }
    } catch (error) {
      const rejected = describeRejectedToken(messages(error), login.tenantFor(serverTenant), serverTenant);
      if (rejected) {
        throw new SqlqError(rejected, 'AUTH_ERROR', undefined, [
          `Remove SQLSERVER_TENANT_ID (or --tenant-id) to use the server's tenant${serverTenant ? `, or set it to ${serverTenant}` : ''}`,
          'Check that your account is a user in that database',
        ]);
      }
      if (findCause(error, (cause): cause is SignInRequired => cause instanceof SignInRequired) || isMsalError(error)) {
        throw new SqlqError(
          `Microsoft Entra sign-in failed: ${messages(error)}`,
          'AUTH_ERROR',
          undefined,
          [
            'Sign in again with: sqlq auth set (add -e <name> for a named environment)',
            'If the tenant blocks the default sign-in app, set SQLSERVER_CLIENT_ID to an app registration with an http://localhost redirect URI',
          ],
        );
      }
      throw error;
    }
  }

  private async openPool(auth: Partial<sql.config>): Promise<void> {
    const sqlConfig: sql.config = {
      server: this.config.server,
      database: this.config.database,
      ...auth,
      port: this.config.port,
      options: {
        encrypt: this.config.encrypt,
        trustServerCertificate: this.config.trustServerCertificate,
        connectTimeout: this.config.connectionTimeout,
        requestTimeout: this.config.requestTimeout,
        ...(auth.beforeConnect ? { debug: { token: true, packet: false, data: false, payload: false } } : {}),
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    const pool = new sql.ConnectionPool(sqlConfig);
    try {
      await pool.connect();
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw error;
    }
    this.pool = pool;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  private isTransientError(error: unknown): boolean {
    return SqlServerConnection.TRANSIENT_ERRORS.has((error as { code?: string })?.code ?? '');
  }

  private async withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === maxRetries || !this.isTransientError(error)) {
          throw error;
        }
        const delay = Math.pow(attempt + 1, 2) * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
        try {
          if (this.pool) {
            await this.pool.close();
          }
        } catch {
          // best-effort close
        }
        this.pool = null;
        try {
          await this.connect();
        } catch {
          // reconnect may fail; next attempt will re-throw if it persists
        }
      }
    }
    throw new Error('Retry logic failed unexpectedly');
  }

  async query<T = any>(queryText: string): Promise<sql.IResult<T>> {
    if (!this.pool) {
      throw new Error('Database connection not established');
    }

    return this.withRetry(() => {
      const request = this.pool!.request();
      return request.query(queryText);
    });
  }

  async queryWithParams<T = any>(queryText: string, params: QueryParam[]): Promise<sql.IResult<T>> {
    if (!this.pool) {
      throw new Error('Database connection not established');
    }

    return this.withRetry(() => {
      const request = this.pool!.request();
      for (const param of params) {
        if (param.type) {
          request.input(param.name, param.type, param.value);
        } else {
          request.input(param.name, param.value);
        }
      }
      return request.query(queryText);
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.connect();
      const result = await this.query('SELECT 1 as test');
      return result.recordset.length > 0;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.pool !== null && this.pool.connected;
  }

  getConfig(): Readonly<ConnectionConfig> {
    return { ...this.config };
  }
}

/** mssql wraps driver errors in originalError, and tedious wraps login errors in an AggregateError. */
function causes(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const e = error as { originalError?: unknown; cause?: unknown; errors?: unknown[] };
  return [error, ...causes(e.originalError, seen), ...causes(e.cause, seen), ...(e.errors ?? []).flatMap(inner => causes(inner, seen))];
}

function findCause<T>(error: unknown, match: (cause: unknown) => cause is T): T | undefined {
  return causes(error).find(match);
}

function messages(error: unknown): string {
  return [...new Set(causes(error).map(cause => (cause as Error).message).filter(Boolean))].join(': ');
}

function isMsalError(error: unknown): boolean {
  return causes(error).some(cause => typeof (cause as { errorCode?: unknown }).errorCode === 'string');
}
