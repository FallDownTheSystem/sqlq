import { BaseTool } from './base.js';
import { QueryParam, RoutineInfo } from '../types.js';
import { ParameterValidator } from '../validation.js';
import { objectTypeOf, typeCodesSql } from './objects.js';

export class ListRoutinesTool extends BaseTool {
	getName(): string {
		return 'list_routines';
	}

	getDescription(): string {
		return 'List stored procedures and functions';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				schema: {
					type: 'string',
					description: 'Schema name to filter routines (optional)',
				},
				database: {
					type: 'string',
					description: 'Target database name (optional, uses default if not specified)',
				},
			},
			required: [],
		};
	}

	async execute(params: { schema?: string; database?: string }): Promise<RoutineInfo[]> {
		const database = params.database ? ParameterValidator.validateDatabaseName(params.database) : undefined;
		const queryParams: QueryParam[] = [];

		let query = `
			SELECT
				s.name AS routine_schema,
				o.name AS routine_name,
				RTRIM(o.type) AS type_code,
				o.modify_date
			FROM sys.objects o
			INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
			WHERE o.type IN (${typeCodesSql(['procedure', 'scalar function', 'table function'])})
				AND o.is_ms_shipped = 0
		`;

		if (params.schema) {
			query += ' AND s.name = @schema';
			queryParams.push({ name: 'schema', value: ParameterValidator.validateSchemaName(params.schema) });
		}

		query += ' ORDER BY s.name, o.name';

		const rows = await this.executeSafeQueryWithParams<{ routine_schema: string; routine_name: string; type_code: string; modify_date: Date }>(
			query,
			queryParams,
			database,
		);

		return rows.map(row => ({
			routine_schema: row.routine_schema,
			routine_name: row.routine_name,
			routine_type: objectTypeOf(row.type_code),
			modify_date: row.modify_date,
		}));
	}
}
