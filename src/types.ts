import type { ISqlType } from 'mssql';
import { z } from 'zod';

export interface QueryParam {
	name: string;
	type?: ISqlType;
	value: unknown;
}

export const ConnectionConfigSchema = z.object({
  server: z.string(),
  database: z.string().optional(),
  user: z.string(),
  password: z.string(),
  port: z.number().optional().default(1433),
  encrypt: z.boolean().optional().default(true),
  trustServerCertificate: z.boolean().optional().default(true),
  connectionTimeout: z.number().optional().default(30000),
  requestTimeout: z.number().optional().default(60000),
  maxRows: z.number().optional().default(1000),
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

export interface TableInfo {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  table_type: string;
}

export type ObjectType =
  | 'table'
  | 'view'
  | 'procedure'
  | 'scalar function'
  | 'table function'
  | 'trigger'
  | 'synonym';

export interface ResolvedObject {
  object_id: number;
  schema: string;
  name: string;
  type: ObjectType;
}

export interface ColumnInfo {
  table_schema: string;
  table_name: string;
  ordinal_position: number;
  column_name: string;
  /** Full declared type, e.g. nvarchar(50), decimal(18,2), varchar(max). */
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_identity: boolean;
  is_computed: boolean;
  computed_definition: string | null;
  /** Position within the primary key, or null when not part of it. */
  primary_key_ordinal: number | null;
  /** Referenced column as schema.table.column when the column is a foreign key. */
  references: string | null;
}

export interface ForeignKeyInfo {
  constraint_name: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  referenced_table_schema: string;
  referenced_table_name: string;
  referenced_column_name: string;
}

export interface IndexInfo {
  table_schema: string;
  table_name: string;
  index_name: string;
  index_type: string;
  is_unique: boolean;
  is_primary_key: boolean;
  is_unique_constraint: boolean;
  /** Key columns in key order; descending keys carry a " DESC" suffix. */
  key_columns: string[];
  included_columns: string[];
  filter_definition: string | null;
}

export interface RoutineInfo {
  routine_schema: string;
  routine_name: string;
  routine_type: ObjectType;
  modify_date: Date;
}

export interface ObjectDefinition {
  schema: string;
  name: string;
  type: ObjectType;
  definition: string;
}

export interface FindMatch {
  schema: string;
  object_name: string;
  object_type: ObjectType;
  /** Set when the match is a column of the object rather than the object itself. */
  column_name: string | null;
  data_type: string | null;
}

export interface ViewInfo {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  view_definition: string;
  check_option: string | null;
  is_updatable: string;
}

export interface DatabaseInfo {
  database_id: number;
  name: string;
  create_date: string;
  collation_name: string;
  state_desc: string;
}

export interface ServerInfo {
  server_name: string;
  product_version: string;
  product_level: string;
  edition: string;
  engine_edition: number;
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  executionTime: number;
}

export interface TableStats {
  table_schema: string;
  table_name: string;
  row_count: number;
  data_size_kb: number;
  index_size_kb: number;
  total_size_kb: number;
}