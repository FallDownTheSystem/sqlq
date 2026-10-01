import { BaseTool } from './base.js';
import { ForeignKeyInfo, QueryParam } from '../types.js';
import { ParameterValidator } from '../validation.js';

export class GetForeignKeysTool extends BaseTool {
	getName(): string {
		return 'get_foreign_keys';
	}

	getDescription(): string {
		return 'Get foreign key relationships for a table (outgoing and incoming) or for the entire database';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				table_name: {
					type: 'string',
					description: 'Table name: name, schema.name or database.schema.name (optional - if not provided, returns all foreign keys)',
				},
				schema: {
					type: 'string',
					description: 'Schema name (optional; with a table it qualifies the table, without one it filters the referencing tables)',
				},
				database: {
					type: 'string',
					description: 'Target database name (optional, uses default if not specified)',
				},
			},
			required: [],
		};
	}

	async execute(params: { table_name?: string; schema?: string; database?: string }): Promise<ForeignKeyInfo[]> {
		const ref = params.table_name ? ParameterValidator.parseObjectName(params.table_name, params) : undefined;
		const database = ref?.database ?? (params.database ? ParameterValidator.validateDatabaseName(params.database) : undefined);

		const queryParams: QueryParam[] = [];

		let query = `
			SELECT
				fk.name as constraint_name,
				OBJECT_SCHEMA_NAME(fk.parent_object_id) as table_schema,
				OBJECT_NAME(fk.parent_object_id) as table_name,
				COL_NAME(fkc.parent_object_id, fkc.parent_column_id) as column_name,
				OBJECT_SCHEMA_NAME(fk.referenced_object_id) as referenced_table_schema,
				OBJECT_NAME(fk.referenced_object_id) as referenced_table_name,
				COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) as referenced_column_name
			FROM sys.foreign_keys fk
			INNER JOIN sys.foreign_key_columns fkc
				ON fk.object_id = fkc.constraint_object_id
		`;

		if (ref) {
			// Both directions: what this table points to, and what points at it.
			const object = await this.resolveObject(ref, ['table'], 'foreign-keys');
			query += ' WHERE (fk.parent_object_id = @objectId OR fk.referenced_object_id = @objectId)';
			queryParams.push({ name: 'objectId', value: object.object_id });
		} else if (params.schema) {
			query += ' WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = @schema';
			queryParams.push({ name: 'schema', value: ParameterValidator.validateSchemaName(params.schema) });
		}

		query += ' ORDER BY table_schema, table_name, constraint_name, fkc.constraint_column_id';

		return await this.executeSafeQueryWithParams<ForeignKeyInfo>(query, queryParams, database);
	}
}
