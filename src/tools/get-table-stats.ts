import { BaseTool } from './base.js';
import { TableStats, QueryParam } from '../types.js';
import { ParameterValidator } from '../validation.js';

export class GetTableStatsTool extends BaseTool {
	getName(): string {
		return 'get_table_stats';
	}

	getDescription(): string {
		return 'Get statistics for tables including row counts and size information';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				table_name: {
					type: 'string',
					description: 'Table name: name, schema.name or database.schema.name (optional - if not provided, returns stats for all tables)',
				},
				schema: {
					type: 'string',
					description: 'Schema name (optional; with a table it qualifies the table, without one it filters the tables)',
				},
				database: {
					type: 'string',
					description: 'Target database name (optional, uses default if not specified)',
				},
			},
			required: [],
		};
	}

	async execute(params: { table_name?: string; schema?: string; database?: string }): Promise<TableStats[]> {
		const ref = params.table_name ? ParameterValidator.parseObjectName(params.table_name, params) : undefined;
		const database = ref?.database ?? (params.database ? ParameterValidator.validateDatabaseName(params.database) : undefined);

		const queryParams: QueryParam[] = [];

		let query = `
			SELECT
				s.name as table_schema,
				t.name as table_name,
				p.rows as row_count,
				SUM(a.total_pages) * 8 as total_size_kb,
				SUM(a.used_pages) * 8 as data_size_kb,
				(SUM(a.total_pages) - SUM(a.used_pages)) * 8 as index_size_kb
			FROM sys.tables t
			INNER JOIN sys.indexes i ON t.object_id = i.object_id
			INNER JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
			INNER JOIN sys.allocation_units a ON p.partition_id = a.container_id
			LEFT OUTER JOIN sys.schemas s ON t.schema_id = s.schema_id
			WHERE t.name NOT LIKE 'dt%'
				AND t.is_ms_shipped = 0
				AND i.object_id > 255
		`;

		if (ref) {
			const object = await this.resolveObject(ref, ['table'], 'stats');
			query += ' AND t.object_id = @objectId';
			queryParams.push({ name: 'objectId', value: object.object_id });
		} else if (params.schema) {
			query += ' AND s.name = @schema';
			queryParams.push({ name: 'schema', value: ParameterValidator.validateSchemaName(params.schema) });
		}

		query += `
			GROUP BY s.name, t.name, p.rows
			ORDER BY table_schema, table_name
		`;

		return await this.executeSafeQueryWithParams<TableStats>(query, queryParams, database);
	}
}
