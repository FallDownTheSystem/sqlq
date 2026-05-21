import { BaseTool } from './base.js';
import { QueryResult } from '../types.js';
import { ParameterValidator } from '../validation.js';
import { ErrorHandler } from '../errors.js';

export class ExecuteQueryTool extends BaseTool {
	getName(): string {
		return 'execute_query';
	}

	getDescription(): string {
		return 'Execute a read-only SELECT query against the database';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'SQL SELECT query to execute (read-only operations only)',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of rows to return (optional)',
					minimum: 1,
					maximum: 10000,
				},
				database: {
					type: 'string',
					description: 'Target database name (optional, uses default if not specified)',
				},
			},
			required: ['query'],
		};
	}

	async execute(params: { query: string; limit?: number; database?: string }): Promise<QueryResult> {
		const database = params.database ? ParameterValidator.validateDatabaseName(params.database) : undefined;
		const validatedParams = ParameterValidator.validateQueryParameters(params);
		const { query, limit } = validatedParams;
		const maxRows = limit;

		const startTime = Date.now();

		try {
			const connection = await this.connectionManager.getConnection(database);
			await connection.connect();

			const result = await this.executeQuery(query, maxRows, database);
			const executionTime = Date.now() - startTime;

			const columns = result.length > 0 ? Object.keys(result[0]) : [];

			const rows = result.map(row => columns.map(col => row[col]));

			return {
				columns,
				rows,
				rowCount: result.length,
				executionTime,
			};
		} catch (error) {
			const executionTime = Date.now() - startTime;
			const handled = ErrorHandler.handleSqlServerError(error);
			handled.message = `${handled.message} (execution time: ${executionTime}ms)`;
			throw handled;
		}
	}
}
