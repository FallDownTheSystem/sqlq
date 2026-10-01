import { z } from 'zod';
import { ParameterValidator } from '../validation.js';

describe('ParameterValidator', () => {
	describe('escapeIdentifier', () => {
		it('should wrap identifier in brackets', () => {
			expect(ParameterValidator.escapeIdentifier('Users')).toBe('[Users]');
		});

		it('should remove existing brackets before re-wrapping', () => {
			expect(ParameterValidator.escapeIdentifier('[Users]')).toBe('[Users]');
		});

		it('should handle nested brackets', () => {
			expect(ParameterValidator.escapeIdentifier('[My]Table')).toBe('[MyTable]');
		});

		it('should throw on empty string', () => {
			expect(() => ParameterValidator.escapeIdentifier('')).toThrow('Identifier must be a non-empty string');
		});

		it('should throw on null/undefined', () => {
			expect(() => ParameterValidator.escapeIdentifier(null as any)).toThrow('Identifier must be a non-empty string');
			expect(() => ParameterValidator.escapeIdentifier(undefined as any)).toThrow('Identifier must be a non-empty string');
		});

		it('should throw on brackets-only input', () => {
			expect(() => ParameterValidator.escapeIdentifier('[]')).toThrow('Identifier cannot be empty after cleaning');
		});

		it('should throw on identifiers exceeding 128 characters', () => {
			const longName = 'a'.repeat(129);
			expect(() => ParameterValidator.escapeIdentifier(longName)).toThrow('Identifier cannot exceed 128 characters');
		});

		it('should accept identifiers exactly 128 characters', () => {
			const name = 'a'.repeat(128);
			expect(ParameterValidator.escapeIdentifier(name)).toBe(`[${name}]`);
		});
	});

	describe('validateTableName', () => {
		it('should accept valid table names', () => {
			expect(ParameterValidator.validateTableName('Users')).toBe('Users');
			expect(ParameterValidator.validateTableName('my_table')).toBe('my_table');
			expect(ParameterValidator.validateTableName('_private')).toBe('_private');
		});

		it('should accept any name SQL Server accepts, since names are bound as parameters', () => {
			expect(ParameterValidator.validateTableName('1table')).toBe('1table');
			expect(ParameterValidator.validateTableName('my-table')).toBe('my-table');
			expect(ParameterValidator.validateTableName('my table')).toBe('my table');
			expect(ParameterValidator.validateTableName('Order')).toBe('Order');
			expect(ParameterValidator.validateTableName('User')).toBe('User');
		});

		it('should reject empty names', () => {
			expect(() => ParameterValidator.validateTableName('')).toThrow();
		});

		it('should reject names exceeding 128 characters', () => {
			expect(() => ParameterValidator.validateTableName('a'.repeat(129))).toThrow();
		});
	});

	describe('validateSchemaName', () => {
		it('should accept valid schema names', () => {
			expect(ParameterValidator.validateSchemaName('dbo')).toBe('dbo');
			expect(ParameterValidator.validateSchemaName('sales')).toBe('sales');
		});

		it('should accept names that are keywords or contain punctuation', () => {
			expect(ParameterValidator.validateSchemaName('user')).toBe('user');
			expect(ParameterValidator.validateSchemaName('my-schema')).toBe('my-schema');
		});

		it('should reject empty names', () => {
			expect(() => ParameterValidator.validateSchemaName('')).toThrow();
		});
	});

	describe('validateColumnName', () => {
		it('should accept valid column names', () => {
			expect(ParameterValidator.validateColumnName('id')).toBe('id');
			expect(ParameterValidator.validateColumnName('first_name')).toBe('first_name');
		});

		it('should reject invalid column names', () => {
			expect(() => ParameterValidator.validateColumnName('1col')).toThrow();
			expect(() => ParameterValidator.validateColumnName('')).toThrow();
		});
	});

	describe('validateDatabaseName', () => {
		it('should accept valid database names', () => {
			expect(ParameterValidator.validateDatabaseName('master')).toBe('master');
			expect(ParameterValidator.validateDatabaseName('my_db')).toBe('my_db');
		});

		it('should reject reserved words', () => {
			expect(() => ParameterValidator.validateDatabaseName('DATABASE')).toThrow();
		});
	});

	describe('validateRowLimit', () => {
		it('should accept valid limits', () => {
			expect(ParameterValidator.validateRowLimit(1)).toBe(1);
			expect(ParameterValidator.validateRowLimit(100)).toBe(100);
			expect(ParameterValidator.validateRowLimit(10000)).toBe(10000);
		});

		it('should reject zero', () => {
			expect(() => ParameterValidator.validateRowLimit(0)).toThrow();
		});

		it('should reject negative numbers', () => {
			expect(() => ParameterValidator.validateRowLimit(-1)).toThrow();
		});

		it('should reject numbers exceeding 10000', () => {
			expect(() => ParameterValidator.validateRowLimit(10001)).toThrow();
		});

		it('should reject non-integers', () => {
			expect(() => ParameterValidator.validateRowLimit(1.5)).toThrow();
		});
	});

	describe('validateQueryParameters', () => {
		it('should validate and return defaults', () => {
			const result = ParameterValidator.validateQueryParameters({ query: 'SELECT 1' });
			expect(result.query).toBe('SELECT 1');
			expect(result.limit).toBe(1000);
		});

		it('should accept custom limit', () => {
			const result = ParameterValidator.validateQueryParameters({ query: 'SELECT 1', limit: 500 });
			expect(result.limit).toBe(500);
		});

		it('should reject empty query', () => {
			expect(() => ParameterValidator.validateQueryParameters({ query: '' })).toThrow();
		});

		it('should reject whitespace-only query', () => {
			expect(() => ParameterValidator.validateQueryParameters({ query: '   ' })).toThrow();
		});

		it('should reject missing query', () => {
			expect(() => ParameterValidator.validateQueryParameters({})).toThrow();
		});

		it('should reject query exceeding 10000 characters', () => {
			expect(() => ParameterValidator.validateQueryParameters({ query: 'S'.repeat(10001) })).toThrow();
		});
	});

	describe('parseObjectName', () => {
		it('should leave the schema open for an unqualified name', () => {
			expect(ParameterValidator.parseObjectName('Users')).toEqual({ name: 'Users' });
		});

		it('should split schema.name', () => {
			expect(ParameterValidator.parseObjectName('sales.Orders')).toEqual({ schema: 'sales', name: 'Orders' });
		});

		it('should split database.schema.name', () => {
			expect(ParameterValidator.parseObjectName('Shop.sales.Orders')).toEqual({ database: 'Shop', schema: 'sales', name: 'Orders' });
		});

		it('should honour [] and "" quoting, including dots and escaped brackets', () => {
			expect(ParameterValidator.parseObjectName('[my schema].[Order.Lines]')).toEqual({ schema: 'my schema', name: 'Order.Lines' });
			expect(ParameterValidator.parseObjectName('"dbo"."a]]b"')).toEqual({ schema: 'dbo', name: 'a]]b' });
			expect(ParameterValidator.parseObjectName('[a]]b]')).toEqual({ name: 'a]b' });
		});

		it('should take schema and database from options', () => {
			expect(ParameterValidator.parseObjectName('Orders', { schema: 'sales', database: 'Shop' }))
				.toEqual({ database: 'Shop', schema: 'sales', name: 'Orders' });
		});

		it('should accept options that agree with the qualified name', () => {
			expect(ParameterValidator.parseObjectName('sales.Orders', { schema: 'SALES' })).toEqual({ schema: 'sales', name: 'Orders' });
		});

		it('should reject options that contradict the qualified name', () => {
			expect(() => ParameterValidator.parseObjectName('sales.Orders', { schema: 'dbo' })).toThrow(/schema "sales".*"dbo"/);
			expect(() => ParameterValidator.parseObjectName('Shop.sales.Orders', { database: 'Other' })).toThrow(/database/);
		});

		it('should reject empty names and empty or extra parts', () => {
			expect(() => ParameterValidator.parseObjectName('')).toThrow('Object name cannot be empty');
			expect(() => ParameterValidator.parseObjectName('sales.')).toThrow(/Invalid object name/);
			expect(() => ParameterValidator.parseObjectName('a.b.c.d')).toThrow(/Invalid object name/);
		});
	});

	describe('validateListTablesParameters', () => {
		it('should accept empty params', () => {
			const result = ParameterValidator.validateListTablesParameters({});
			expect(result).toEqual({});
		});

		it('should validate schema when provided', () => {
			const result = ParameterValidator.validateListTablesParameters({ schema: 'dbo' });
			expect(result.schema).toBe('dbo');
		});
	});

	describe('validateParameters', () => {
		it('should format Zod errors with field paths', () => {
			const schema = z.object({ name: z.string(), age: z.number() });
			expect(() => ParameterValidator.validateParameters({ name: 123, age: 'old' }, schema)).toThrow(/Parameter validation failed.*name.*age/);
		});
	});
});
