import { BaseTool } from './base.js';
import { ColumnInfo } from '../types.js';
import { ParameterValidator } from '../validation.js';

interface ColumnRow {
	table_schema: string;
	table_name: string;
	ordinal_position: number;
	column_name: string;
	type_name: string;
	system_type_name: string | null;
	max_length: number;
	precision: number;
	scale: number;
	is_nullable: boolean;
	column_default: string | null;
	is_identity: boolean;
	is_computed: boolean;
	computed_definition: string | null;
	primary_key_ordinal: number | null;
	referenced_schema: string | null;
	referenced_table: string | null;
	referenced_column: string | null;
}

/** Renders a column type the way it is declared in T-SQL, e.g. nvarchar(50) or decimal(18,2). */
export function formatColumnType(typeName: string, systemTypeName: string | null, maxLength: number, precision: number, scale: number): string {
	// Alias types (sysname, user-defined types) already imply their length.
	if (systemTypeName && systemTypeName !== typeName) {
		return typeName;
	}

	switch (typeName) {
		case 'char':
		case 'varchar':
		case 'binary':
		case 'varbinary':
			return `${typeName}(${maxLength === -1 ? 'max' : maxLength})`;
		case 'nchar':
		case 'nvarchar':
			return `${typeName}(${maxLength === -1 ? 'max' : maxLength / 2})`;
		case 'decimal':
		case 'numeric':
			return `${typeName}(${precision},${scale})`;
		case 'datetime2':
		case 'datetimeoffset':
		case 'time':
			return `${typeName}(${scale})`;
		default:
			return typeName;
	}
}

export class DescribeTableTool extends BaseTool {
	getName(): string {
		return 'describe_table';
	}

	getDescription(): string {
		return 'Describe the columns of a table, view or table-valued function: types, nullability, defaults, primary key, identity, computed columns and foreign key references';
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

	async execute(params: { table_name: string; schema?: string; database?: string }): Promise<ColumnInfo[]> {
		const ref = ParameterValidator.parseObjectName(params.table_name, params);
		const object = await this.resolveObject(ref, ['table', 'view', 'table function'], 'describe');

		const query = `
			SELECT
				s.name AS table_schema,
				o.name AS table_name,
				c.column_id AS ordinal_position,
				c.name AS column_name,
				TYPE_NAME(c.user_type_id) AS type_name,
				TYPE_NAME(c.system_type_id) AS system_type_name,
				c.max_length,
				c.[precision],
				c.scale,
				c.is_nullable,
				dc.definition AS column_default,
				c.is_identity,
				c.is_computed,
				cc.definition AS computed_definition,
				pk.key_ordinal AS primary_key_ordinal,
				fk.referenced_schema,
				fk.referenced_table,
				fk.referenced_column
			FROM sys.columns c
			INNER JOIN sys.objects o ON o.object_id = c.object_id
			INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
			LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
			LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
			LEFT JOIN (
				SELECT ic.column_id, ic.key_ordinal
				FROM sys.indexes i
				INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
				WHERE i.object_id = @objectId AND i.is_primary_key = 1
			) pk ON pk.column_id = c.column_id
			OUTER APPLY (
				SELECT TOP 1
					OBJECT_SCHEMA_NAME(fkc.referenced_object_id) AS referenced_schema,
					OBJECT_NAME(fkc.referenced_object_id) AS referenced_table,
					COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column
				FROM sys.foreign_key_columns fkc
				WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
				ORDER BY fkc.constraint_object_id
			) fk
			WHERE c.object_id = @objectId
			ORDER BY c.column_id
		`;

		const rows = await this.executeSafeQueryWithParams<ColumnRow>(query, [{ name: 'objectId', value: object.object_id }], ref.database);

		return rows.map(row => ({
			table_schema: row.table_schema,
			table_name: row.table_name,
			ordinal_position: row.ordinal_position,
			column_name: row.column_name,
			data_type: formatColumnType(row.type_name, row.system_type_name, row.max_length, row.precision, row.scale),
			is_nullable: row.is_nullable,
			column_default: row.column_default,
			is_identity: row.is_identity,
			is_computed: row.is_computed,
			computed_definition: row.computed_definition,
			primary_key_ordinal: row.primary_key_ordinal,
			references: row.referenced_table
				? `${row.referenced_schema}.${row.referenced_table}.${row.referenced_column}`
				: null,
		}));
	}
}
