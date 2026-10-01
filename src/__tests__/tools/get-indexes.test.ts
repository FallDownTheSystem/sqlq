import { GetIndexesTool } from '../../tools/get-indexes.js';
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

const base = {
	table_schema: 'sales',
	table_name: 'Orders',
	is_unique: false,
	is_primary_key: false,
	is_unique_constraint: false,
	filter_definition: null,
	is_included_column: false,
	is_descending_key: false,
};

describe('GetIndexesTool', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockQueryWithParams.mockReset();
	});

	it('should group index columns into key and included lists', async () => {
		mockQueryWithParams
			.mockResolvedValueOnce({ recordset: [{ object_id: 42, schema_name: 'sales', object_name: 'Orders', type_code: 'U' }] })
			.mockResolvedValueOnce({
				recordset: [
					{ ...base, index_id: 1, index_name: 'PK_Orders', index_type: 'CLUSTERED', is_unique: true, is_primary_key: true, column_name: 'Id' },
					{ ...base, index_id: 2, index_name: 'IX_Orders_Customer', index_type: 'NONCLUSTERED', column_name: 'CustomerId' },
					{ ...base, index_id: 2, index_name: 'IX_Orders_Customer', index_type: 'NONCLUSTERED', column_name: 'OrderDate', is_descending_key: true },
					{ ...base, index_id: 2, index_name: 'IX_Orders_Customer', index_type: 'NONCLUSTERED', column_name: 'Total', is_included_column: true },
				],
			});

		const tool = new GetIndexesTool(new ConnectionManager({} as any));
		const result = await tool.execute({ table_name: 'Orders' });

		const [, params] = mockQueryWithParams.mock.calls[1];
		expect(params).toEqual([{ name: 'objectId', value: 42 }]);
		expect(result).toEqual([
			expect.objectContaining({ index_name: 'PK_Orders', is_primary_key: true, key_columns: ['Id'], included_columns: [] }),
			expect.objectContaining({ index_name: 'IX_Orders_Customer', key_columns: ['CustomerId', 'OrderDate DESC'], included_columns: ['Total'] }),
		]);
	});
});
