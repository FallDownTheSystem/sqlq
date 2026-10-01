import { DescribeTableTool, formatColumnType } from '../../tools/describe-table.js';
import { ConnectionManager } from '../../connection-manager.js';
import { NotFoundError, ValidationError } from '../../errors.js';

const mockQueryWithParams = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);

const mockConnection = {
	connect: mockConnect,
	queryWithParams: mockQueryWithParams,
};

jest.mock('../../connection-manager.js', () => ({
	ConnectionManager: jest.fn().mockImplementation(() => ({
		getConnection: jest.fn().mockResolvedValue(mockConnection),
	})),
}));

function respond(...recordsets: unknown[][]): void {
	for (const recordset of recordsets) {
		mockQueryWithParams.mockResolvedValueOnce({ recordset });
	}
}

const ordersTable = { object_id: 42, schema_name: 'sales', object_name: 'Orders', type_code: 'U' };

const idColumn = {
	table_schema: 'sales',
	table_name: 'Orders',
	ordinal_position: 1,
	column_name: 'Id',
	type_name: 'int',
	system_type_name: 'int',
	max_length: 4,
	precision: 10,
	scale: 0,
	is_nullable: false,
	column_default: null,
	is_identity: true,
	is_computed: false,
	computed_definition: null,
	primary_key_ordinal: 1,
	referenced_schema: null,
	referenced_table: null,
	referenced_column: null,
};

const customerColumn = {
	...idColumn,
	ordinal_position: 2,
	column_name: 'CustomerId',
	is_identity: false,
	primary_key_ordinal: null,
	referenced_schema: 'sales',
	referenced_table: 'Customers',
	referenced_column: 'Id',
};

describe('DescribeTableTool', () => {
	let tool: DescribeTableTool;

	beforeEach(() => {
		jest.clearAllMocks();
		mockQueryWithParams.mockReset();
		const mockManager = new ConnectionManager({} as any);
		tool = new DescribeTableTool(mockManager);
	});

	it('should have correct name', () => {
		expect(tool.getName()).toBe('describe_table');
	});

	it('should search every schema when the name is unqualified', async () => {
		respond([ordersTable], [idColumn]);

		await tool.execute({ table_name: 'Orders' });

		const [resolveQuery, resolveParams] = mockQueryWithParams.mock.calls[0];
		expect(resolveQuery).toContain('o.name = @name');
		expect(resolveQuery).not.toContain('@schema');
		expect(resolveParams).toEqual([{ name: 'name', value: 'Orders' }]);
	});

	it('should restrict the search to the schema of a qualified name', async () => {
		respond([ordersTable], [idColumn]);

		await tool.execute({ table_name: 'sales.Orders' });

		const [resolveQuery, resolveParams] = mockQueryWithParams.mock.calls[0];
		expect(resolveQuery).toContain('s.name = @schema');
		expect(resolveParams).toEqual([
			{ name: 'name', value: 'Orders' },
			{ name: 'schema', value: 'sales' },
		]);
	});

	it('should describe the resolved object by id with keys, identity and references', async () => {
		respond([ordersTable], [idColumn, customerColumn]);

		const result = await tool.execute({ table_name: 'Orders' });

		const [columnsQuery, columnsParams] = mockQueryWithParams.mock.calls[1];
		expect(columnsQuery).toContain('FROM sys.columns c');
		expect(columnsParams).toEqual([{ name: 'objectId', value: 42 }]);

		expect(result).toEqual([
			expect.objectContaining({ column_name: 'Id', data_type: 'int', is_identity: true, primary_key_ordinal: 1, references: null }),
			expect.objectContaining({ column_name: 'CustomerId', primary_key_ordinal: null, references: 'sales.Customers.Id' }),
		]);
	});

	it('should list the qualified alternatives when the name exists in several schemas', async () => {
		respond([
			ordersTable,
			{ object_id: 43, schema_name: 'archive', object_name: 'Orders', type_code: 'U' },
		]);

		const error = await tool.execute({ table_name: 'Orders' }).catch(e => e);

		expect(error).toBeInstanceOf(ValidationError);
		expect(error.message).toContain('exists in 2 schemas');
		expect(error.suggestions).toEqual(['sqlq describe sales.Orders', 'sqlq describe archive.Orders']);
	});

	it('should point to the right command when the object has another type', async () => {
		respond([{ object_id: 7, schema_name: 'dbo', object_name: 'GetOrders', type_code: 'P' }]);

		const error = await tool.execute({ table_name: 'GetOrders' }).catch(e => e);

		expect(error).toBeInstanceOf(ValidationError);
		expect(error.message).toBe('dbo.GetOrders is a procedure; "describe" works on tables, views and table functions');
		expect(error.suggestions).toEqual(['sqlq definition dbo.GetOrders']);
	});

	it('should name the target of a synonym', async () => {
		respond(
			[{ object_id: 8, schema_name: 'dbo', object_name: 'Ord', type_code: 'SN' }],
			[{ base_object_name: '[sales].[Orders]' }],
		);

		const error = await tool.execute({ table_name: 'Ord' }).catch(e => e);

		expect(error.message).toBe('dbo.Ord is a synonym for [sales].[Orders]');
	});

	it('should suggest close matches when nothing has the name', async () => {
		respond([], [
			{ object_id: 42, schema_name: 'sales', object_name: 'Orders', type_code: 'U' },
			{ object_id: 50, schema_name: 'rpt', object_name: 'Order Summary', type_code: 'V' },
		]);

		const error = await tool.execute({ table_name: 'Order' }).catch(e => e);

		expect(error).toBeInstanceOf(NotFoundError);
		expect(error.message).toBe('No tables, views and table functions named Order in the current database');
		expect(error.suggestions).toEqual(expect.arrayContaining([
			'Did you mean sales.Orders (table)? sqlq describe sales.Orders',
			'Did you mean rpt.[Order Summary] (view)? sqlq describe rpt.[Order Summary]',
			'Search all names: sqlq find Order',
		]));

		const [, candidateParams] = mockQueryWithParams.mock.calls[1];
		expect(candidateParams).toEqual([
			{ name: 'name', value: 'Order' },
			{ name: 'contains', value: '%Order%' },
			{ name: 'prefix', value: 'Orde%' },
		]);
	});

	it('should treat LIKE metacharacters in a missing name literally', async () => {
		respond([], []);

		await tool.execute({ table_name: 'tmp_orders' }).catch(() => undefined);

		const [, candidateParams] = mockQueryWithParams.mock.calls[1];
		expect(candidateParams).toContainEqual({ name: 'contains', value: '%tmp[_]orders%' });
	});

	it('should reject a missing table_name', async () => {
		await expect(tool.execute({} as any)).rejects.toThrow('Object name cannot be empty');
	});
});

describe('formatColumnType', () => {
	it.each([
		[['nvarchar', 'nvarchar', 100, 0, 0], 'nvarchar(50)'],
		[['nvarchar', 'nvarchar', -1, 0, 0], 'nvarchar(max)'],
		[['varchar', 'varchar', 20, 0, 0], 'varchar(20)'],
		[['varbinary', 'varbinary', -1, 0, 0], 'varbinary(max)'],
		[['decimal', 'decimal', 9, 18, 2], 'decimal(18,2)'],
		[['datetime2', 'datetime2', 8, 27, 7], 'datetime2(7)'],
		[['int', 'int', 4, 10, 0], 'int'],
		[['sysname', 'nvarchar', 256, 0, 0], 'sysname'],
	] as const)('%j -> %s', ([typeName, systemType, maxLength, precision, scale], expected) => {
		expect(formatColumnType(typeName, systemType, maxLength, precision, scale)).toBe(expected);
	});
});
