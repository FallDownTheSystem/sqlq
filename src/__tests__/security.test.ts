import { QueryValidator } from '../security.js';

describe('QueryValidator', () => {
	describe('validateQuery', () => {
		it('should accept valid SELECT queries', () => {
			expect(QueryValidator.validateQuery('SELECT * FROM Users')).toEqual({ isValid: true });
			expect(QueryValidator.validateQuery('SELECT name FROM Products')).toEqual({ isValid: true });
		});

		it('should accept WITH (CTE) queries', () => {
			expect(QueryValidator.validateQuery('WITH cte AS (SELECT 1) SELECT * FROM cte')).toEqual({ isValid: true });
		});

		it('should accept SHOW queries', () => {
			expect(QueryValidator.validateQuery('SHOW TABLES')).toEqual({ isValid: true });
		});

		it('should accept DESCRIBE queries', () => {
			expect(QueryValidator.validateQuery('DESCRIBE Users')).toEqual({ isValid: true });
		});

		it('should accept EXPLAIN queries', () => {
			expect(QueryValidator.validateQuery('EXPLAIN SELECT * FROM Users')).toEqual({ isValid: true });
		});

		it('should reject empty queries', () => {
			const result = QueryValidator.validateQuery('');
			expect(result.isValid).toBe(false);
			expect(result.error).toBe('Empty query not allowed');
		});

		it('should reject whitespace-only queries', () => {
			const result = QueryValidator.validateQuery('   ');
			expect(result.isValid).toBe(false);
			expect(result.error).toBe('Empty query not allowed');
		});

		it('should reject queries not starting with allowed statement', () => {
			const result = QueryValidator.validateQuery('INSERT INTO Users VALUES (1)');
			expect(result.isValid).toBe(false);
			expect(result.error).toContain('Query must start with one of');
		});

		it('should reject queries containing forbidden keywords', () => {
			const forbidden = [
				'SELECT * FROM Users; INSERT INTO Users VALUES (1)',
				'SELECT * FROM Users; DELETE FROM Users',
				'SELECT * FROM Users; DROP TABLE Users',
				'SELECT * FROM Users; CREATE TABLE Hack(id int)',
				'SELECT * FROM Users; ALTER TABLE Users ADD col int',
				'SELECT * FROM Users; TRUNCATE TABLE Users',
				'SELECT * FROM Users; EXEC sp_help',
				'SELECT * FROM Users; EXECUTE sp_help',
				'SELECT * FROM SP_TABLES',
				'SELECT * FROM XP_CMDSHELL',
				'SELECT * FROM OPENROWSET()',
				'SELECT * FROM OPENDATASOURCE()',
				'SELECT BULK INSERT stuff',
				'SELECT * FROM Users MERGE INTO Users',
				'SELECT * FROM Users; GRANT SELECT TO User',
				'SELECT * FROM Users; REVOKE SELECT FROM User',
				'SELECT * FROM Users; DENY SELECT TO User',
			];

			for (const query of forbidden) {
				const result = QueryValidator.validateQuery(query);
				expect(result.isValid).toBe(false);
				expect(result.error).toContain('Forbidden keyword detected');
			}
		});

		it('should be case-insensitive for validation', () => {
			expect(QueryValidator.validateQuery('select * from Users')).toEqual({ isValid: true });
			expect(QueryValidator.validateQuery('Select Name From Users')).toEqual({ isValid: true });
		});

		it('should not false-positive on column names containing forbidden substrings', () => {
			expect(QueryValidator.validateQuery('SELECT create_date FROM sys.databases')).toEqual({ isValid: true });
			expect(QueryValidator.validateQuery('SELECT updated_at FROM Users')).toEqual({ isValid: true });
			expect(QueryValidator.validateQuery('SELECT is_deleted FROM Items')).toEqual({ isValid: true });
		});

		it('should detect SQL comment injection (--)', () => {
			const result = QueryValidator.validateQuery('SELECT * FROM Users -- comment here');
			expect(result.isValid).toBe(false);
			expect(result.error).toBe('Potential SQL injection pattern detected');
		});

		it('should detect multi-line comment injection (/*)', () => {
			const result = QueryValidator.validateQuery('SELECT * FROM Users /* malicious */');
			expect(result.isValid).toBe(false);
			expect(result.error).toBe('Potential SQL injection pattern detected');
		});

		it('should accept UNION and UNION ALL queries', () => {
			expect(QueryValidator.validateQuery('SELECT name FROM Users UNION SELECT name FROM Customers')).toEqual({ isValid: true });
			expect(QueryValidator.validateQuery('SELECT id FROM Orders UNION ALL SELECT id FROM ArchivedOrders')).toEqual({ isValid: true });
		});

		it('should still reject forbidden keywords in UNION queries', () => {
			const result = QueryValidator.validateQuery('SELECT name FROM Users UNION SELECT name FROM Customers; DELETE FROM Users');
			expect(result.isValid).toBe(false);
		});

		it('should detect statement injection via semicolon', () => {
			const result = QueryValidator.validateQuery("SELECT * FROM Users;SELECT * FROM passwords");
			expect(result.isValid).toBe(false);
			expect(result.error).toBe('Potential SQL injection pattern detected');
		});
	});

	describe('sanitizeQuery', () => {
		it('should trim whitespace', () => {
			expect(QueryValidator.sanitizeQuery('  SELECT * FROM Users  ')).toBe('SELECT * FROM Users');
		});

		it('should normalize internal whitespace', () => {
			expect(QueryValidator.sanitizeQuery('SELECT  *  FROM   Users')).toBe('SELECT * FROM Users');
		});

		it('should remove trailing semicolons', () => {
			expect(QueryValidator.sanitizeQuery('SELECT * FROM Users;')).toBe('SELECT * FROM Users');
		});

		it('should handle tabs and newlines', () => {
			expect(QueryValidator.sanitizeQuery('SELECT\n\t*\n\tFROM Users')).toBe('SELECT * FROM Users');
		});
	});

	describe('addRowLimit', () => {
		it('should add TOP clause to SELECT queries', () => {
			expect(QueryValidator.addRowLimit('SELECT * FROM Users', 100)).toBe('SELECT TOP 100 * FROM Users');
		});

		it('should not modify queries that already have TOP', () => {
			const query = 'SELECT TOP 50 * FROM Users';
			expect(QueryValidator.addRowLimit(query, 100)).toBe(query);
		});

		it('should handle case-insensitive SELECT', () => {
			expect(QueryValidator.addRowLimit('select * FROM Users', 100)).toBe('select TOP 100 * FROM Users');
		});

		it('should preserve leading whitespace in replacement', () => {
			expect(QueryValidator.addRowLimit('  SELECT * FROM Users', 10)).toBe('  SELECT TOP 10 * FROM Users');
		});

		it('should wrap UNION queries in a derived table instead of limiting the first branch', () => {
			expect(QueryValidator.addRowLimit('SELECT a FROM t1 UNION ALL SELECT a FROM t2', 100))
				.toBe('SELECT TOP 100 * FROM (SELECT a FROM t1 UNION ALL SELECT a FROM t2) AS [__sqlq_limit]');
		});

		it('should hoist a trailing ORDER BY outside the UNION wrapper', () => {
			expect(QueryValidator.addRowLimit('SELECT a FROM t1 UNION SELECT a FROM t2 ORDER BY a', 50))
				.toBe('SELECT TOP 50 * FROM (SELECT a FROM t1 UNION SELECT a FROM t2) AS [__sqlq_limit] ORDER BY a');
		});

		it('should not treat UNION inside a subquery as top-level for ORDER BY hoisting', () => {
			expect(QueryValidator.addRowLimit('SELECT a FROM (SELECT a FROM t1 UNION SELECT a FROM t2) AS x', 25))
				.toBe('SELECT TOP 25 a FROM (SELECT a FROM t1 UNION SELECT a FROM t2) AS x');
		});

		it('should not treat UNION inside string literals or identifiers as a union', () => {
			expect(QueryValidator.addRowLimit("SELECT 'credit UNION member' AS label FROM t", 10))
				.toBe("SELECT TOP 10 'credit UNION member' AS label FROM t");
			expect(QueryValidator.addRowLimit('SELECT [union] FROM CreditUnions', 10))
				.toBe('SELECT TOP 10 [union] FROM CreditUnions');
		});

		it('should not modify UNION queries that already have TOP', () => {
			const query = 'SELECT TOP 5 a FROM t1 UNION SELECT TOP 5 a FROM t2';
			expect(QueryValidator.addRowLimit(query, 100)).toBe(query);
		});
	});
});
