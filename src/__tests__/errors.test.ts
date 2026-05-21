import {
	SqlqError,
	ConnectionError,
	ValidationError,
	SecurityError,
	QueryError,
	TimeoutError,
	PermissionError,
	ErrorHandler,
} from '../errors.js';

describe('Error classes', () => {
	it('SqlqError should have correct properties', () => {
		const err = new SqlqError('test', 'TEST_CODE', { detail: 1 });
		expect(err.message).toBe('test');
		expect(err.code).toBe('TEST_CODE');
		expect(err.details).toEqual({ detail: 1 });
		expect(err.name).toBe('SqlqError');
		expect(err).toBeInstanceOf(Error);
	});

	it('ConnectionError should set correct code', () => {
		const err = new ConnectionError('conn failed');
		expect(err.code).toBe('CONNECTION_ERROR');
		expect(err.name).toBe('ConnectionError');
		expect(err).toBeInstanceOf(SqlqError);
	});

	it('ValidationError should set correct code', () => {
		const err = new ValidationError('bad input');
		expect(err.code).toBe('VALIDATION_ERROR');
		expect(err.name).toBe('ValidationError');
	});

	it('SecurityError should set correct code', () => {
		const err = new SecurityError('forbidden');
		expect(err.code).toBe('SECURITY_ERROR');
		expect(err.name).toBe('SecurityError');
	});

	it('QueryError should set correct code', () => {
		const err = new QueryError('query failed');
		expect(err.code).toBe('QUERY_ERROR');
		expect(err.name).toBe('QueryError');
	});

	it('TimeoutError should set correct code', () => {
		const err = new TimeoutError('timed out');
		expect(err.code).toBe('TIMEOUT_ERROR');
		expect(err.name).toBe('TimeoutError');
	});

	it('PermissionError should set correct code', () => {
		const err = new PermissionError('no access');
		expect(err.code).toBe('PERMISSION_ERROR');
		expect(err.name).toBe('PermissionError');
	});
});

describe('ErrorHandler.handleSqlServerError', () => {
	it('should handle null/undefined error', () => {
		const result = ErrorHandler.handleSqlServerError(null);
		expect(result).toBeInstanceOf(SqlqError);
		expect(result.code).toBe('UNKNOWN_ERROR');
	});

	it('should map error code 18456 to ConnectionError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Login failed', number: 18456 });
		expect(result).toBeInstanceOf(ConnectionError);
		expect(result.message).toContain('Authentication failed');
	});

	it('should map error code 2 to ConnectionError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Server not found', number: 2 });
		expect(result).toBeInstanceOf(ConnectionError);
		expect(result.message).toContain('Server not found');
	});

	it('should map error code 53 to ConnectionError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Network path not found', number: 53 });
		expect(result).toBeInstanceOf(ConnectionError);
	});

	it('should map error code -2 to TimeoutError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Timeout', number: -2 });
		expect(result).toBeInstanceOf(TimeoutError);
	});

	it('should map error code 208 to ValidationError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Invalid object', number: 208 });
		expect(result).toBeInstanceOf(ValidationError);
		expect(result.message).toContain('Invalid table');
	});

	it('should map error code 207 to ValidationError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Invalid column', number: 207 });
		expect(result).toBeInstanceOf(ValidationError);
		expect(result.message).toContain('Invalid column');
	});

	it('should map error code 262 to PermissionError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Permission denied', number: 262 });
		expect(result).toBeInstanceOf(PermissionError);
	});

	it('should map error code 229 to PermissionError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'SELECT denied', number: 229 });
		expect(result).toBeInstanceOf(PermissionError);
	});

	it('should map error code 1205 to QueryError (deadlock)', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Deadlock', number: 1205 });
		expect(result).toBeInstanceOf(QueryError);
		expect(result.message).toContain('deadlock');
	});

	it('should map error code 8152 to ValidationError (string truncation)', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Truncated', number: 8152 });
		expect(result).toBeInstanceOf(ValidationError);
	});

	it('should map error code 515 to ValidationError (null insert)', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Cannot insert null', number: 515 });
		expect(result).toBeInstanceOf(ValidationError);
	});

	it('should map unknown numeric codes to generic QueryError', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Something', number: 99999 });
		expect(result).toBeInstanceOf(QueryError);
		expect(result.message).toContain('99999');
	});

	it('should detect login failed from message text', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Login failed for user' });
		expect(result).toBeInstanceOf(ConnectionError);
	});

	it('should detect server not found from message text', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'server was not found or was not accessible' });
		expect(result).toBeInstanceOf(ConnectionError);
	});

	it('should detect network-related errors from message text', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'A network-related instance error' });
		expect(result).toBeInstanceOf(ConnectionError);
	});

	it('should detect timeout from message text', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Connection timeout expired' });
		expect(result).toBeInstanceOf(TimeoutError);
	});

	it('should detect SSL/certificate errors from message text', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'SSL certificate error' });
		expect(result).toBeInstanceOf(ConnectionError);
		expect(result.message).toContain('SSL');
	});

	it('should detect permission denied from message text', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Permission denied on object' });
		expect(result).toBeInstanceOf(PermissionError);
	});

	it('should fall back to QueryError for unrecognized messages', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Something unexpected happened' });
		expect(result).toBeInstanceOf(QueryError);
		expect(result.message).toContain('Something unexpected happened');
	});

	it('should use error.code field when number is not present', () => {
		const result = ErrorHandler.handleSqlServerError({ message: 'Login failed', code: 18456 });
		expect(result).toBeInstanceOf(ConnectionError);
	});
});

describe('ErrorHandler.formatErrorForUser', () => {
	it('should provide suggestions for CONNECTION_ERROR', () => {
		const err = new ConnectionError('conn failed');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.error).toBe('conn failed');
		expect(result.code).toBe('CONNECTION_ERROR');
		expect(result.suggestions!.length).toBeGreaterThan(0);
		expect(result.suggestions).toContain('Verify server hostname and port number');
	});

	it('should provide suggestions for VALIDATION_ERROR', () => {
		const err = new ValidationError('bad input');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.code).toBe('VALIDATION_ERROR');
		expect(result.suggestions!.length).toBeGreaterThan(0);
	});

	it('should provide suggestions for SECURITY_ERROR', () => {
		const err = new SecurityError('forbidden');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.code).toBe('SECURITY_ERROR');
		expect(result.suggestions).toContain('Only read-only SELECT queries are allowed');
	});

	it('should provide suggestions for PERMISSION_ERROR', () => {
		const err = new PermissionError('no access');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.code).toBe('PERMISSION_ERROR');
		expect(result.suggestions!.length).toBeGreaterThan(0);
	});

	it('should provide suggestions for TIMEOUT_ERROR', () => {
		const err = new TimeoutError('timed out');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.code).toBe('TIMEOUT_ERROR');
		expect(result.suggestions!.length).toBeGreaterThan(0);
	});

	it('should provide suggestions for QUERY_ERROR', () => {
		const err = new QueryError('query failed');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.code).toBe('QUERY_ERROR');
		expect(result.suggestions!.length).toBeGreaterThan(0);
	});

	it('should return empty suggestions for unknown error codes', () => {
		const err = new SqlqError('unknown', 'UNKNOWN_ERROR');
		const result = ErrorHandler.formatErrorForUser(err);
		expect(result.suggestions).toEqual([]);
	});
});
