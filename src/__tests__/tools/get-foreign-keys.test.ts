import { GetForeignKeysTool } from '../../tools/get-foreign-keys.js';
import { ConnectionManager } from '../../connection-manager.js';

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

describe('GetForeignKeysTool', () => {
	let tool: GetForeignKeysTool;

	beforeEach(() => {
		jest.clearAllMocks();
		mockQueryWithParams.mockReset();
		mockQueryWithParams.mockResolvedValue({ recordset: [] });
		tool = new GetForeignKeysTool(new ConnectionManager({} as any));
	});

	it('should return keys in both directions for a resolved table', async () => {
		mockQueryWithParams.mockResolvedValueOnce({ recordset: [{ object_id: 42, schema_name: 'sales', object_name: 'Orders', type_code: 'U' }] });

		await tool.execute({ table_name: 'sales.Orders' });

		const [queryText, params] = mockQueryWithParams.mock.calls[1];
		expect(queryText).toContain('fk.parent_object_id = @objectId OR fk.referenced_object_id = @objectId');
		expect(params).toEqual([{ name: 'objectId', value: 42 }]);
	});

	it('should filter all keys by schema when no table is given', async () => {
		await tool.execute({ schema: 'sales' });

		const [queryText, params] = mockQueryWithParams.mock.calls[0];
		expect(queryText).toContain('OBJECT_SCHEMA_NAME(fk.parent_object_id) = @schema');
		expect(params).toEqual([{ name: 'schema', value: 'sales' }]);
	});

	it('should return every key without a table or schema', async () => {
		await tool.execute({});

		const [queryText, params] = mockQueryWithParams.mock.calls[0];
		expect(queryText).not.toContain('WHERE');
		expect(params).toEqual([]);
	});
});
