import { BaseTool } from './base.js';
import { IndexInfo } from '../types.js';
import { ParameterValidator } from '../validation.js';

interface IndexColumnRow {
	table_schema: string;
	table_name: string;
	index_id: number;
	index_name: string;
	index_type: string;
	is_unique: boolean;
	is_primary_key: boolean;
	is_unique_constraint: boolean;
	filter_definition: string | null;
	column_name: string;
	is_included_column: boolean;
	is_descending_key: boolean;
}

export class GetIndexesTool extends BaseTool {
	getName(): string {
		return 'get_indexes';
	}

	getDescription(): string {
		return 'List the indexes of a table or indexed view with their key columns, included columns and filters';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				table_name: {
					type: 'string',
					description: 'Object name: name, schema.name or database.schema.name',
				},
				schema: {
					type: 'string',
					description: 'Schema name (optional; all schemas are searched when omitted)',
				},
				database: {
					type: 'string',
					description: 'Target database name (optional, uses default if not specified)',
				},
			},
			required: ['table_name'],
		};
	}

	async execute(params: { table_name: string; schema?: string; database?: string }): Promise<IndexInfo[]> {
		const ref = ParameterValidator.parseObjectName(params.table_name, params);
		const object = await this.resolveObject(ref, ['table', 'view'], 'indexes');

		// Heaps (index type 0) have no index to show. Key columns sort before
		// included ones; columnstore columns have no key ordinal, so the column
		// position breaks the tie.
		const query = `
			SELECT
				OBJECT_SCHEMA_NAME(i.object_id) AS table_schema,
				OBJECT_NAME(i.object_id) AS table_name,
				i.index_id,
				i.name AS index_name,
				i.type_desc AS index_type,
				i.is_unique,
				i.is_primary_key,
				i.is_unique_constraint,
				i.filter_definition,
				c.name AS column_name,
				ic.is_included_column,
				ic.is_descending_key
			FROM sys.indexes i
			INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
			INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
			WHERE i.object_id = @objectId AND i.type > 0
			ORDER BY i.is_primary_key DESC, i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id
		`;

		const rows = await this.executeSafeQueryWithParams<IndexColumnRow>(query, [{ name: 'objectId', value: object.object_id }], ref.database);

		const indexes = new Map<number, IndexInfo>();
		for (const row of rows) {
			let index = indexes.get(row.index_id);
			if (!index) {
				index = {
					table_schema: row.table_schema,
					table_name: row.table_name,
					index_name: row.index_name,
					index_type: row.index_type,
					is_unique: row.is_unique,
					is_primary_key: row.is_primary_key,
					is_unique_constraint: row.is_unique_constraint,
					key_columns: [],
					included_columns: [],
					filter_definition: row.filter_definition,
				};
				indexes.set(row.index_id, index);
			}

			if (row.is_included_column) {
				index.included_columns.push(row.column_name);
			} else {
				index.key_columns.push(row.is_descending_key ? `${row.column_name} DESC` : row.column_name);
			}
		}

		return [...indexes.values()];
	}
}
