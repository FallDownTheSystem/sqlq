import { table, heading, field, divider, outputPlain, outputTable, type OutputMode } from './output.js';
import type {
	TableInfo,
	ColumnInfo,
	ForeignKeyInfo,
	ViewInfo,
	DatabaseInfo,
	ServerInfo,
	QueryResult,
	TableStats,
	FindMatch,
	IndexInfo,
	ObjectDefinition,
	RoutineInfo,
} from '../types.js';
import { qualifiedName } from '../tools/objects.js';

interface ConnectionTestResult {
	isConnected: boolean;
	serverInfo?: { serverName: string; version: string; edition: string };
	database?: string;
	connectionTime?: number;
	error?: string;
	details?: { canExecuteQueries: boolean; hasSystemAccess: boolean; encryptionEnabled: boolean };
}

export function formatConnectionTest(data: ConnectionTestResult, mode: OutputMode): void {
	if (mode === 'plain') {
		outputPlain(`connected: ${data.isConnected}`);
		if (data.connectionTime !== undefined) outputPlain(`time: ${data.connectionTime}ms`);
		if (data.database) outputPlain(`database: ${data.database}`);
		if (data.serverInfo) {
			outputPlain(`server: ${data.serverInfo.serverName}`);
			outputPlain(`edition: ${data.serverInfo.edition}`);
		}
		if (data.error) outputPlain(`error: ${data.error}`);
		if (data.details) {
			outputPlain(`queries: ${data.details.canExecuteQueries}`);
			outputPlain(`system_access: ${data.details.hasSystemAccess}`);
		}
		return;
	}

	heading('Connection Test');
	field('Connected', data.isConnected ? 'Yes' : 'No');
	if (data.connectionTime !== undefined) field('Response Time', `${data.connectionTime}ms`);
	if (data.database) field('Database', data.database);
	if (data.serverInfo) {
		field('Server', data.serverInfo.serverName);
		field('Edition', data.serverInfo.edition);
	}
	if (data.error) field('Error', data.error);
	if (data.details) {
		divider();
		field('Execute Queries', data.details.canExecuteQueries ? 'Yes' : 'No');
		field('System Access', data.details.hasSystemAccess ? 'Yes' : 'No');
		field('Encryption', data.details.encryptionEnabled ? 'Yes' : 'No');
	}
}

export function formatDatabases(data: DatabaseInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No databases found.'); }
		else { heading('No databases found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const db of data) {
			outputPlain(`${db.name}\t${db.state_desc}\t${db.collation_name}`);
		}
		return;
	}

	const rows = data.map(db => [db.name, String(db.database_id), db.state_desc, db.collation_name, db.create_date]);
	outputTable(table(['Name', 'ID', 'State', 'Collation', 'Created'], rows));
}

export function formatTables(data: TableInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No tables found.'); }
		else { heading('No tables found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const t of data) {
			outputPlain(`${t.table_schema}.${t.table_name}\t${t.table_type}`);
		}
		return;
	}

	const rows = data.map(t => [t.table_schema, t.table_name, t.table_type]);
	outputTable(table(['Schema', 'Table', 'Type'], rows));
}

export function formatViews(data: ViewInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No views found.'); }
		else { heading('No views found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const v of data) {
			outputPlain(`${v.table_schema}.${v.table_name}\t${v.is_updatable}`);
		}
		return;
	}

	const rows = data.map(v => [v.table_schema, v.table_name, v.is_updatable, v.check_option ?? '']);
	outputTable(table(['Schema', 'View', 'Updatable', 'Check Option'], rows));
}

function keyFlags(c: ColumnInfo, compositeKey: boolean): string[] {
	const flags: string[] = [];
	if (c.primary_key_ordinal !== null) flags.push(compositeKey ? `PK(${c.primary_key_ordinal})` : 'PK');
	if (c.is_identity) flags.push('IDENTITY');
	return flags;
}

export function formatDescribe(data: ColumnInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No columns found.'); }
		else { heading('No columns found.'); }
		return;
	}

	const compositeKey = data.filter(c => c.primary_key_ordinal !== null).length > 1;

	if (mode === 'plain') {
		for (const c of data) {
			const flags = keyFlags(c, compositeKey);
			if (c.computed_definition) flags.push(`AS ${c.computed_definition}`);
			if (c.column_default) flags.push(`DEFAULT ${c.column_default}`);
			if (c.references) flags.push(`-> ${c.references}`);
			const nullability = c.is_nullable ? 'NULL' : 'NOT NULL';
			outputPlain([c.column_name, c.data_type, nullability, ...(flags.length ? [flags.join(' ')] : [])].join('\t'));
		}
		return;
	}

	heading(qualifiedName(data[0]!.table_schema, data[0]!.table_name));
	const rows = data.map(c => [
		String(c.ordinal_position),
		c.column_name,
		c.data_type,
		c.is_nullable ? 'Yes' : 'No',
		keyFlags(c, compositeKey).join(' '),
		c.computed_definition ? `AS ${c.computed_definition}` : c.column_default ?? '',
		c.references ?? '',
	]);
	outputTable(table(['#', 'Column', 'Type', 'Nullable', 'Key', 'Default / Computed', 'References'], rows));
}

export function formatFind(data: FindMatch[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No matches found.'); }
		else { heading('No matches found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const m of data) {
			const name = qualifiedName(m.schema, m.object_name);
			if (m.column_name) {
				outputPlain(`${name}.${m.column_name}\tcolumn (${m.object_type})\t${m.data_type ?? ''}`);
			} else {
				outputPlain(`${name}\t${m.object_type}`);
			}
		}
		return;
	}

	const rows = data.map(m => [m.schema, m.object_name, m.object_type, m.column_name ?? '', m.data_type ?? '']);
	outputTable(table(['Schema', 'Object', 'Type', 'Column', 'Column Type'], rows));
}

function indexKind(i: IndexInfo): string {
	const words = [i.index_type];
	if (i.is_primary_key) words.push('PRIMARY KEY');
	else if (i.is_unique_constraint) words.push('UNIQUE CONSTRAINT');
	else if (i.is_unique) words.push('UNIQUE');
	return words.join(' ');
}

export function formatIndexes(data: IndexInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No indexes found.'); }
		else { heading('No indexes found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const i of data) {
			const parts = [i.index_name, indexKind(i), i.key_columns.join(', ')];
			if (i.included_columns.length) parts.push(`INCLUDE (${i.included_columns.join(', ')})`);
			if (i.filter_definition) parts.push(`WHERE ${i.filter_definition}`);
			outputPlain(parts.join('\t'));
		}
		return;
	}

	heading(qualifiedName(data[0]!.table_schema, data[0]!.table_name));
	const rows = data.map(i => [
		i.index_name,
		indexKind(i),
		i.key_columns.join(', '),
		i.included_columns.join(', '),
		i.filter_definition ?? '',
	]);
	outputTable(table(['Index', 'Type', 'Key Columns', 'Included', 'Filter'], rows));
}

export function formatDefinition(data: ObjectDefinition, mode: OutputMode): void {
	if (mode === 'rich') {
		heading(`${qualifiedName(data.schema, data.name)} (${data.type})`);
		process.stdout.write('\n');
	}
	outputPlain(data.definition);
}

export function formatRoutines(data: RoutineInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No routines found.'); }
		else { heading('No routines found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const r of data) {
			outputPlain(`${qualifiedName(r.routine_schema, r.routine_name)}\t${r.routine_type}`);
		}
		return;
	}

	const rows = data.map(r => [r.routine_schema, r.routine_name, r.routine_type, new Date(r.modify_date).toISOString().slice(0, 10)]);
	outputTable(table(['Schema', 'Name', 'Type', 'Modified'], rows));
}

export function formatQuery(data: QueryResult, mode: OutputMode): void {
	if (data.rows.length === 0) {
		if (mode === 'plain') { outputPlain('No rows returned.'); }
		else { heading('No rows returned.'); }
		return;
	}

	if (mode === 'plain') {
		outputPlain(data.columns.join('\t'));
		for (const row of data.rows) {
			outputPlain(row.map(v => v ?? '').join('\t'));
		}
		return;
	}

	const rows = data.rows.map(row => row.map(v => v === null || v === undefined ? '' : String(v)));
	outputTable(table(data.columns, rows));
	process.stdout.write(`\n${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} (${data.executionTime}ms)\n`);
}

export function formatForeignKeys(data: ForeignKeyInfo[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No foreign keys found.'); }
		else { heading('No foreign keys found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const fk of data) {
			outputPlain(`${fk.constraint_name}\t${fk.table_schema}.${fk.table_name}.${fk.column_name}\t->\t${fk.referenced_table_schema}.${fk.referenced_table_name}.${fk.referenced_column_name}`);
		}
		return;
	}

	const rows = data.map(fk => [
		fk.constraint_name,
		`${fk.table_schema}.${fk.table_name}`,
		fk.column_name,
		`${fk.referenced_table_schema}.${fk.referenced_table_name}`,
		fk.referenced_column_name,
	]);
	outputTable(table(['Constraint', 'Table', 'Column', 'References', 'Ref Column'], rows));
}

export function formatServerInfo(data: ServerInfo, mode: OutputMode): void {
	if (mode === 'plain') {
		outputPlain(`server: ${data.server_name}`);
		outputPlain(`version: ${data.product_version}`);
		outputPlain(`level: ${data.product_level}`);
		outputPlain(`edition: ${data.edition}`);
		outputPlain(`engine: ${data.engine_edition}`);
		return;
	}

	heading('Server Information');
	field('Server Name', data.server_name);
	field('Version', data.product_version);
	field('Product Level', data.product_level);
	field('Edition', data.edition);
	field('Engine Edition', data.engine_edition);
}

export function formatTableStats(data: TableStats[], mode: OutputMode): void {
	if (data.length === 0) {
		if (mode === 'plain') { outputPlain('No table stats found.'); }
		else { heading('No table stats found.'); }
		return;
	}

	if (mode === 'plain') {
		for (const s of data) {
			outputPlain(`${s.table_schema}.${s.table_name}\t${s.row_count}\t${s.total_size_kb}KB`);
		}
		return;
	}

	const rows = data.map(s => [
		s.table_schema,
		s.table_name,
		String(s.row_count),
		`${s.data_size_kb} KB`,
		`${s.index_size_kb} KB`,
		`${s.total_size_kb} KB`,
	]);
	outputTable(table(['Schema', 'Table', 'Rows', 'Data Size', 'Index Size', 'Total Size'], rows));
}
