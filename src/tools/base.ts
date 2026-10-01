import { ConnectionManager } from '../connection-manager.js';
import { QueryValidator } from '../security.js';
import { ErrorHandler } from '../errors.js';
import { ObjectType, QueryParam, ResolvedObject } from '../types.js';
import type { ObjectReference } from '../validation.js';
import { resolveObject } from './objects.js';

export abstract class BaseTool {
	protected connectionManager: ConnectionManager;
	protected maxRows: number;

	constructor(connectionManager: ConnectionManager, maxRows: number = 1000) {
		this.connectionManager = connectionManager;
		this.maxRows = maxRows;
	}

	protected async executeQuery<T = any>(query: string, maxRowsOverride?: number, database?: string): Promise<T[]> {
		const validation = QueryValidator.validateQuery(query);
		if (!validation.isValid) {
			throw new Error(`Query validation failed: ${validation.error}`);
		}

		const sanitizedQuery = QueryValidator.sanitizeQuery(query);
		const limitedQuery = QueryValidator.addRowLimit(sanitizedQuery, maxRowsOverride ?? this.maxRows);

		const connection = await this.connectionManager.getConnection(database);
		const result = await connection.query<T>(limitedQuery);
		return result.recordset;
	}

	protected async executeSafeQuery<T = any>(query: string, maxRowsOverride?: number, database?: string): Promise<T[]> {
		try {
			const connection = await this.connectionManager.getConnection(database);
			await connection.connect();
			return await this.executeQuery<T>(query, maxRowsOverride, database);
		} catch (error) {
			throw ErrorHandler.handleSqlServerError(error);
		}
	}

	protected async executeQueryWithParams<T = any>(query: string, params: QueryParam[], database?: string): Promise<T[]> {
		const validation = QueryValidator.validateQuery(query);
		if (!validation.isValid) {
			throw new Error(`Query validation failed: ${validation.error}`);
		}

		const sanitizedQuery = QueryValidator.sanitizeQuery(query);
		const limitedQuery = QueryValidator.addRowLimit(sanitizedQuery, this.maxRows);

		const connection = await this.connectionManager.getConnection(database);
		const result = await connection.queryWithParams<T>(limitedQuery, params);
		return result.recordset;
	}

	protected async executeSafeQueryWithParams<T = any>(query: string, params: QueryParam[], database?: string): Promise<T[]> {
		try {
			const connection = await this.connectionManager.getConnection(database);
			await connection.connect();
			return await this.executeQueryWithParams<T>(query, params, database);
		} catch (error) {
			throw ErrorHandler.handleSqlServerError(error);
		}
	}

	protected async resolveObject(ref: ObjectReference, allowed: readonly ObjectType[], command: string): Promise<ResolvedObject> {
		return resolveObject(
			<T>(query: string, params: QueryParam[]) => this.executeSafeQueryWithParams<T>(query, params, ref.database),
			ref,
			allowed,
			command,
		);
	}

	abstract getName(): string;
	abstract getDescription(): string;
	abstract getInputSchema(): any;
	abstract execute(params: any): Promise<any>;
}
