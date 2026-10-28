import sql from 'mssql';
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

    const sqlConfig: sql.config = {
      server: this.config.server,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      port: this.config.port,
      options: {
        encrypt: this.config.encrypt,
        trustServerCertificate: this.config.trustServerCertificate,
        connectTimeout: this.config.connectionTimeout,
        requestTimeout: this.config.requestTimeout,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    this.pool = new sql.ConnectionPool(sqlConfig);
    await this.pool.connect();
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