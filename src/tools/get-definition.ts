import { BaseTool } from './base.js';
import { NotFoundError } from '../errors.js';
import { ObjectDefinition } from '../types.js';
import { ParameterValidator } from '../validation.js';
import { qualifiedName } from './objects.js';

export class GetDefinitionTool extends BaseTool {
	getName(): string {
		return 'get_definition';
	}

	getDescription(): string {
		return 'Show the SQL source of a view, stored procedure, function or trigger';
	}

	getInputSchema(): any {
		return {
			type: 'object',
			properties: {
				object_name: {
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
			required: ['object_name'],
		};
	}

	async execute(params: { object_name: string; schema?: string; database?: string }): Promise<ObjectDefinition> {
		const ref = ParameterValidator.parseObjectName(params.object_name, params);
		const object = await this.resolveObject(ref, ['view', 'procedure', 'scalar function', 'table function', 'trigger'], 'definition');

		const rows = await this.executeSafeQueryWithParams<{ definition: string | null }>(
			'SELECT OBJECT_DEFINITION(@objectId) AS definition',
			[{ name: 'objectId', value: object.object_id }],
			ref.database,
		);

		const definition = rows[0]?.definition;
		if (definition === null || definition === undefined) {
			const name = qualifiedName(object.schema, object.name);
			throw new NotFoundError(`The source of ${name} is not available`, [
				'The object may be created WITH ENCRYPTION, or be a CLR object without T-SQL source',
				'Your login may lack the VIEW DEFINITION permission',
			]);
		}

		return {
			schema: object.schema,
			name: object.name,
			type: object.type,
			definition: definition.trim(),
		};
	}
}
