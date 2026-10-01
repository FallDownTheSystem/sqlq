import { BaseTool } from './base.js';
import { ValidationError } from '../errors.js';
import { FindMatch, ObjectType, QueryParam } from '../types.js';
import { ParameterValidator } from '../validation.js';
import { escapeLike, objectTypeOf, typeCodesSql } from './objects.js';

export const FIND_KINDS = ['table', 'view', 'routine', 'trigger', 'synonym', 'column'] as const;
export type FindKind = typeof FIND_KINDS[number];

const OBJECT_TYPES_FOR_KIND: Record<Exclude<FindKind, 'column'>, ObjectType[]> = {
	table: ['table'],
	view: ['view'],
	routine: ['procedure', 'scalar function', 'table function'],
	trigger: ['trigger'],
	synonym: ['synonym'],
};

interface MatchRow {
	schema_name: string;
	object_name: string;
	type_code: string;
	column_name: string | null;
	type_name: string | null;
}

/**
 * Plain text matches anywhere in the name, with LIKE metacharacters taken
 * literally (underscores are common in names). Text containing * ? or % is a
 * wildcard pattern instead: * and % match any run of characters, ? one character.
 */
export function toLikePattern(input: string): { pattern: string; prefix: string } {
	if (/[*?%]/.test(input)) {
		const pattern = input
			.replace(/[[_]/g, ch => `[${ch}]`)
			.replace(/\*/g, '%')
			.replace(/\?/g, '_');
		return { pattern, prefix: pattern };
	}
	const escaped = escapeLike(input);
	return { pattern: `%${escaped}%`, prefix: `${escaped}%` };
}

export class FindObjectsTool extends BaseTool {
	getName(): string {
		return 'find_objects';
	}

	getDescription(): string {
		return 'Search table, view, routine, trigger, synonym and column names';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: 'Text to find anywhere in a name, or a wildcard pattern using * and ?',
				},
				kinds: {
					type: 'array',
					items: { type: 'string', enum: [...FIND_KINDS] },
					description: 'Limit the search to these kinds (optional, default: all)',
				},
				schema: {
					type: 'string',
					description: 'Schema name to search in (optional)',
				},
				database: {
					type: 'string',
					description: 'Target database name (optional, uses default if not specified)',
				},
			},
			required: ['pattern'],
		};
	}

	async execute(params: { pattern: string; kinds?: string[]; schema?: string; database?: string }): Promise<FindMatch[]> {
		const database = params.database ? ParameterValidator.validateDatabaseName(params.database) : undefined;
		const input = params.pattern?.trim();
		if (!input) {
			throw new ValidationError('Search pattern cannot be empty');
		}

		const kinds = this.parseKinds(params.kinds);
		const objectTypes = kinds.flatMap(kind => (kind === 'column' ? [] : OBJECT_TYPES_FOR_KIND[kind]));
		const { pattern, prefix } = toLikePattern(input);

		const queryParams: QueryParam[] = [
			{ name: 'pattern', value: pattern },
			{ name: 'prefix', value: prefix },
			{ name: 'exact', value: input },
		];

		let schemaFilter = '';
		if (params.schema) {
			schemaFilter = ' AND s.name = @schema';
			queryParams.push({ name: 'schema', value: ParameterValidator.validateSchemaName(params.schema) });
		}

		const branches: string[] = [];

		if (objectTypes.length > 0) {
			branches.push(`
				SELECT
					s.name AS schema_name,
					o.name AS object_name,
					RTRIM(o.type) AS type_code,
					CAST(NULL AS sysname) AS column_name,
					CAST(NULL AS sysname) AS type_name,
					CASE WHEN o.name = @exact THEN 0 WHEN o.name LIKE @prefix THEN 1 ELSE 2 END AS match_rank,
					0 AS is_column
				FROM sys.objects o
				INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
				WHERE o.type IN (${typeCodesSql(objectTypes)})
					AND o.is_ms_shipped = 0
					AND o.name LIKE @pattern${schemaFilter}
			`);
		}

		if (kinds.includes('column')) {
			branches.push(`
				SELECT
					s.name AS schema_name,
					o.name AS object_name,
					RTRIM(o.type) AS type_code,
					c.name AS column_name,
					TYPE_NAME(c.user_type_id) AS type_name,
					CASE WHEN c.name = @exact THEN 0 WHEN c.name LIKE @prefix THEN 1 ELSE 2 END AS match_rank,
					1 AS is_column
				FROM sys.columns c
				INNER JOIN sys.objects o ON o.object_id = c.object_id
				INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
				WHERE o.type IN (${typeCodesSql(['table', 'view'])})
					AND o.is_ms_shipped = 0
					AND c.name LIKE @pattern${schemaFilter}
			`);
		}

		const query = `${branches.join(' UNION ALL ')} ORDER BY is_column, match_rank, schema_name, object_name, column_name`;
		const rows = await this.executeSafeQueryWithParams<MatchRow>(query, queryParams, database);

		return rows.map(row => ({
			schema: row.schema_name,
			object_name: row.object_name,
			object_type: objectTypeOf(row.type_code),
			column_name: row.column_name,
			data_type: row.type_name,
		}));
	}

	private parseKinds(kinds: string[] | undefined): FindKind[] {
		if (!kinds || kinds.length === 0) {
			return [...FIND_KINDS];
		}

		const normalized = kinds.map(kind => kind.trim().toLowerCase().replace(/s$/, ''));
		const invalid = normalized.filter(kind => !(FIND_KINDS as readonly string[]).includes(kind));
		if (invalid.length > 0) {
			throw new ValidationError(`Unknown kind: ${invalid.join(', ')}`, undefined, [
				`Valid kinds: ${FIND_KINDS.join(', ')}`,
			]);
		}
		return normalized as FindKind[];
	}
}
