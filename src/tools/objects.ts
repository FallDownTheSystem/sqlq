import { NotFoundError, ValidationError } from '../errors.js';
import type { ObjectType, QueryParam, ResolvedObject } from '../types.js';
import type { ObjectReference } from '../validation.js';

/** sys.objects type codes for the user objects sqlq can navigate. */
const TYPE_CODES: Record<string, ObjectType> = {
	U: 'table',
	V: 'view',
	P: 'procedure',
	PC: 'procedure',
	FN: 'scalar function',
	FS: 'scalar function',
	IF: 'table function',
	TF: 'table function',
	FT: 'table function',
	TR: 'trigger',
	SN: 'synonym',
};

export const ALL_OBJECT_TYPES: readonly ObjectType[] = [...new Set(Object.values(TYPE_CODES))];

/** The sqlq command that shows the most useful information for each object type. */
const COMMAND_FOR_TYPE: Record<ObjectType, string> = {
	'table': 'describe',
	'view': 'describe',
	'table function': 'describe',
	'procedure': 'definition',
	'scalar function': 'definition',
	'trigger': 'definition',
	'synonym': 'find',
};

export type QueryRunner = <T>(query: string, params: QueryParam[]) => Promise<T[]>;

interface ObjectRow {
	object_id: number;
	schema_name: string;
	object_name: string;
	type_code: string;
}

export function objectTypeOf(typeCode: string): ObjectType {
	const type = TYPE_CODES[typeCode.trim()];
	if (!type) {
		throw new Error(`Unsupported object type code: ${typeCode}`);
	}
	return type;
}

/** SQL list of type codes, built only from the fixed map above, for an IN (...) clause. */
export function typeCodesSql(types: readonly ObjectType[]): string {
	return Object.entries(TYPE_CODES)
		.filter(([, type]) => types.includes(type))
		.map(([code]) => `'${code}'`)
		.join(', ');
}

function quotePart(part: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `[${part.replace(/]/g, ']]')}]`;
}

/** schema.name, bracket-quoted only where needed, so it can be pasted into a command or query. */
export function qualifiedName(schema: string, name: string): string {
	return `${quotePart(schema)}.${quotePart(name)}`;
}

export function escapeLike(value: string): string {
	return value.replace(/[[%_]/g, ch => `[${ch}]`);
}

function describeTypes(types: readonly ObjectType[]): string {
	const plural = types.map(type => (type === 'table' ? 'tables' : `${type}s`));
	if (plural.length <= 1) return plural.join('');
	return `${plural.slice(0, -1).join(', ')} and ${plural[plural.length - 1]}`;
}

function displayName(ref: ObjectReference): string {
	return ref.schema ? qualifiedName(ref.schema, ref.name) : ref.name;
}

/**
 * Finds the single object a user-typed name refers to. Without a schema every
 * schema is searched: guessing dbo would silently describe the wrong object when
 * the name lives elsewhere, so a name in several schemas is an error that lists
 * the qualified alternatives instead.
 */
export async function resolveObject(
	run: QueryRunner,
	ref: ObjectReference,
	allowed: readonly ObjectType[],
	command: string,
): Promise<ResolvedObject> {
	const params: QueryParam[] = [{ name: 'name', value: ref.name }];
	let filter = 'o.name = @name';
	if (ref.schema) {
		filter += ' AND s.name = @schema';
		params.push({ name: 'schema', value: ref.schema });
	}

	const rows = await run<ObjectRow>(`
		SELECT o.object_id, s.name AS schema_name, o.name AS object_name, RTRIM(o.type) AS type_code
		FROM sys.objects o
		INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
		WHERE ${filter}
			AND o.type IN (${typeCodesSql(ALL_OBJECT_TYPES)})
		ORDER BY s.name
	`, params);

	const matching = rows.filter(row => allowed.includes(objectTypeOf(row.type_code)));

	if (matching.length === 1) {
		const row = matching[0]!;
		return {
			object_id: row.object_id,
			schema: row.schema_name,
			name: row.object_name,
			type: objectTypeOf(row.type_code),
		};
	}

	if (matching.length > 1) {
		const names = matching.map(row => `${qualifiedName(row.schema_name, row.object_name)} (${objectTypeOf(row.type_code)})`);
		throw new ValidationError(
			`"${ref.name}" exists in ${matching.length} schemas: ${names.join(', ')}`,
			undefined,
			matching.map(row => `sqlq ${command} ${qualifiedName(row.schema_name, row.object_name)}`),
		);
	}

	if (rows.length > 0) {
		throw await wrongTypeError(run, rows[0]!, allowed, command);
	}

	throw await notFoundError(run, ref, allowed, command);
}

async function wrongTypeError(
	run: QueryRunner,
	row: ObjectRow,
	allowed: readonly ObjectType[],
	command: string,
): Promise<ValidationError> {
	const type = objectTypeOf(row.type_code);
	const name = qualifiedName(row.schema_name, row.object_name);

	if (type === 'synonym') {
		const target = await run<{ base_object_name: string }>(
			'SELECT base_object_name FROM sys.synonyms WHERE object_id = @objectId',
			[{ name: 'objectId', value: row.object_id }],
		);
		const base = target[0]?.base_object_name ?? 'an unknown object';
		return new ValidationError(`${name} is a synonym for ${base}`, undefined, [
			`Run the command on ${base} instead (a name with a database part needs -d or database.schema.name)`,
		]);
	}

	const better = COMMAND_FOR_TYPE[type];
	return new ValidationError(
		`${name} is a ${type}; "${command}" works on ${describeTypes(allowed)}`,
		undefined,
		better !== command ? [`sqlq ${better} ${name}`] : [],
	);
}

async function notFoundError(
	run: QueryRunner,
	ref: ObjectReference,
	allowed: readonly ObjectType[],
	command: string,
): Promise<NotFoundError> {
	const escaped = escapeLike(ref.name);
	const candidates = await run<ObjectRow>(`
		SELECT TOP 10 o.object_id, s.name AS schema_name, o.name AS object_name, RTRIM(o.type) AS type_code
		FROM sys.objects o
		INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
		WHERE o.type IN (${typeCodesSql(allowed)})
			AND (
				o.name LIKE @contains
				OR o.name LIKE @prefix
				OR (LEN(o.name) >= 4 AND @name LIKE '%' + o.name + '%')
			)
		ORDER BY
			CASE WHEN o.name = @name THEN 0 WHEN o.name LIKE @contains THEN 1 ELSE 2 END,
			LEN(o.name),
			s.name,
			o.name
	`, [
		{ name: 'name', value: ref.name },
		{ name: 'contains', value: `%${escaped}%` },
		{ name: 'prefix', value: `${escapeLike(ref.name.slice(0, 4))}%` },
	]);

	const where = ref.database ? `database ${ref.database}` : 'the current database';
	const suggestions = candidates.map(row =>
		`Did you mean ${qualifiedName(row.schema_name, row.object_name)} (${objectTypeOf(row.type_code)})? sqlq ${command} ${qualifiedName(row.schema_name, row.object_name)}`,
	);
	suggestions.push(`Search all names: sqlq find ${ref.name}`);
	if (!ref.database) {
		suggestions.push('Look in another database: sqlq -d <database> ...  (list them with sqlq databases)');
	}

	return new NotFoundError(`No ${describeTypes(allowed)} named ${displayName(ref)} in ${where}`, suggestions);
}
