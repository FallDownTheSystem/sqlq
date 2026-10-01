import { z } from 'zod';
import { ValidationError } from './errors.js';

export interface ObjectReference {
  name: string;
  schema?: string;
  database?: string;
}

export class ParameterValidator {
  // Schema and object names are only ever bound as query parameters, never
  // interpolated, so any name SQL Server accepts (Order, my-table, "Sales Data")
  // must be accepted here too. Only the sysname length limit applies.
  private static schemaNameSchema = z.string()
    .min(1, 'Schema name cannot be empty')
    .max(128, 'Schema name cannot exceed 128 characters');

  private static tableNameSchema = z.string()
    .min(1, 'Object name cannot be empty')
    .max(128, 'Object name cannot exceed 128 characters');

  // Column name validation
  private static columnNameSchema = z.string()
    .min(1, 'Column name cannot be empty')
    .max(128, 'Column name cannot exceed 128 characters')
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Column name must start with letter or underscore and contain only letters, numbers, and underscores');

  // Database name validation
  private static databaseNameSchema = z.string()
    .min(1, 'Database name cannot be empty')
    .max(128, 'Database name cannot exceed 128 characters')
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Database name must start with letter or underscore and contain only letters, numbers, and underscores')
    .refine(name => !this.isReservedWord(name), 'Database name cannot be a reserved word');

  // Row limit validation
  private static rowLimitSchema = z.number()
    .int('Row limit must be an integer')
    .min(1, 'Row limit must be at least 1')
    .max(10000, 'Row limit cannot exceed 10,000 for safety');

  // SQL Server reserved words (subset)
  private static readonly RESERVED_WORDS = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE',
    'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON', 'AS',
    'ORDER', 'BY', 'GROUP', 'HAVING', 'UNION', 'DISTINCT', 'TOP', 'NULL',
    'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'ALL', 'ANY',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'WHILE', 'BEGIN', 'EXEC',
    'DECLARE', 'SET', 'PRINT', 'RETURN', 'FUNCTION', 'PROCEDURE', 'TRIGGER',
    'INDEX', 'VIEW', 'TABLE', 'DATABASE', 'SCHEMA', 'USER', 'ROLE', 'GRANT',
    'REVOKE', 'DENY', 'PRIMARY', 'FOREIGN', 'KEY', 'CONSTRAINT', 'UNIQUE',
  ]);

  private static isReservedWord(word: string): boolean {
    return this.RESERVED_WORDS.has(word.toUpperCase());
  }

  static validateSchemaName(schema: string): string {
    return this.schemaNameSchema.parse(schema);
  }

  static validateTableName(tableName: string): string {
    return this.tableNameSchema.parse(tableName);
  }

  static validateColumnName(columnName: string): string {
    return this.columnNameSchema.parse(columnName);
  }

  static validateDatabaseName(databaseName: string): string {
    return this.databaseNameSchema.parse(databaseName);
  }

  static validateRowLimit(limit: number): number {
    return this.rowLimitSchema.parse(limit);
  }

  // Validate and sanitize identifiers by escaping them with brackets
  static escapeIdentifier(identifier: string): string {
    // First validate the identifier
    if (!identifier || typeof identifier !== 'string') {
      throw new Error('Identifier must be a non-empty string');
    }

    // Remove any existing brackets
    const cleaned = identifier.replace(/[\[\]]/g, '');
    
    // Validate the cleaned identifier
    if (cleaned.length === 0) {
      throw new Error('Identifier cannot be empty after cleaning');
    }

    if (cleaned.length > 128) {
      throw new Error('Identifier cannot exceed 128 characters');
    }

    // Escape with brackets for safe use in queries
    return `[${cleaned}]`;
  }

  // Validate query parameters for execute_query tool
  static validateQueryParameters(params: { query?: string; limit?: number }): {
    query: string;
    limit: number;
  } {
    const querySchema = z.string()
      .min(1, 'Query cannot be empty')
      .max(10000, 'Query cannot exceed 10,000 characters')
      .refine(q => q.trim().length > 0, 'Query cannot be only whitespace');

    const limitSchema = z.number()
      .int('Limit must be an integer')
      .min(1, 'Limit must be at least 1')
      .max(10000, 'Limit cannot exceed 10,000')
      .optional()
      .default(1000);

    return {
      query: querySchema.parse(params.query),
      limit: limitSchema.parse(params.limit),
    };
  }

  /**
   * Parses an object reference as written in T-SQL: `name`, `schema.name` or
   * `database.schema.name`, each part optionally quoted with [] or "".
   * Separate `schema` / `database` options are accepted too, but must not
   * contradict the qualified name.
   */
  static parseObjectName(input: string, options: { schema?: string | undefined; database?: string | undefined } = {}): ObjectReference {
    if (!input || !input.trim()) {
      throw new ValidationError('Object name cannot be empty');
    }

    const parts = this.splitQualifiedName(input.trim());
    if (parts.length > 3 || parts.some(part => part.length === 0)) {
      throw new ValidationError(`Invalid object name "${input}"`, undefined, [
        'Use name, schema.name or database.schema.name',
        'Quote names that contain dots: [My.Table]',
      ]);
    }

    const name = parts[parts.length - 1]!;
    const qualifiedSchema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const qualifiedDatabase = parts.length === 3 ? parts[0] : undefined;

    const schema = this.pickConsistent('schema', qualifiedSchema, options.schema);
    const database = this.pickConsistent('database', qualifiedDatabase, options.database);

    const result: ObjectReference = { name: this.validateTableName(name) };
    if (schema) result.schema = this.validateSchemaName(schema);
    if (database) result.database = this.validateDatabaseName(database);
    return result;
  }

  private static pickConsistent(label: string, qualified: string | undefined, option: string | undefined): string | undefined {
    if (qualified && option && qualified.toLowerCase() !== option.toLowerCase()) {
      throw new ValidationError(`The name says ${label} "${qualified}" but the ${label} option says "${option}"`);
    }
    return qualified ?? option;
  }

  private static splitQualifiedName(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === '[' || ch === '"') {
        const close = ch === '[' ? ']' : '"';
        i++;
        while (i < input.length) {
          if (input[i] === close) {
            // A doubled closing character is an escaped literal inside the quotes.
            if (input[i + 1] === close) { current += close; i += 2; continue; }
            i++;
            break;
          }
          current += input[i];
          i++;
        }
        continue;
      }
      if (ch === '.') {
        parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
      current += ch;
      i++;
    }
    parts.push(current.trim());
    return parts;
  }

  // Validate list tables parameters
  static validateListTablesParameters(params: { schema?: string }): {
    schema?: string;
  } {
    const result: { schema?: string } = {};
    if (params.schema) {
      result.schema = this.validateSchemaName(params.schema);
    }
    return result;
  }

  // General parameter validation for any tool
  static validateParameters<T>(params: any, schema: z.ZodSchema<T>): T {
    try {
      return schema.parse(params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
        throw new Error(`Parameter validation failed: ${errorMessages.join(', ')}`);
      }
      throw error;
    }
  }
}