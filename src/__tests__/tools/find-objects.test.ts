import { FindObjectsTool, toLikePattern } from '../../tools/find-objects.js';
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

describe('toLikePattern', () => {
	it('should match plain text anywhere, taking _ and [ literally', () => {
		expect(toLikePattern('order_id')).toEqual({ pattern: '%order[_]id%', prefix: 'order[_]id%' });
		expect(toLikePattern('a[b')).toEqual({ pattern: '%a[[]b%', prefix: 'a[[]b%' });
	});

	it('should translate * and ? wildcards', () => {
		expect(toLikePattern('Order*')).toEqual({ pattern: 'Order%', prefix: 'Order%' });
		expect(toLikePattern('Ord?r_*')).toEqual({ pattern: 'Ord_r[_]%', prefix: 'Ord_r[_]%' });
	});
});

describe('FindObjectsTool', () => {
	let tool: FindObjectsTool;

	beforeEach(() => {
		jest.clearAllMocks();
		mockQueryWithParams.mockReset();
		mockQueryWithParams.mockResolvedValue({ recordset: [] });
		tool = new FindObjectsTool(new ConnectionManager({} as any));
	});

	it('should search objects and columns in one limited union', async () => {
		mockQueryWithParams.mockResolvedValueOnce({
			recordset: [
				{ schema_name: 'rpt', object_name: 'PortfolioReport', type_code: 'V', column_name: null, type_name: null },
				{ schema_name: 'dbo', object_name: 'Contract', type_code: 'U', column_name: 'PortfolioId', type_name: 'int' },
			],
		});

		const result = await tool.execute({ pattern: 'portfolio' });

		const [queryText, params] = mockQueryWithParams.mock.calls[0];
		expect(queryText).toContain('UNION ALL');
		expect(queryText).toMatch(/^SELECT TOP 1000 \* FROM \(/);
		expect(params).toEqual([
			{ name: 'pattern', value: '%portfolio%' },
			{ name: 'prefix', value: 'portfolio%' },
			{ name: 'exact', value: 'portfolio' },
		]);
		expect(result).toEqual([
			{ schema: 'rpt', object_name: 'PortfolioReport', object_type: 'view', column_name: null, data_type: null },
			{ schema: 'dbo', object_name: 'Contract', object_type: 'table', column_name: 'PortfolioId', data_type: 'int' },
		]);
	});

	it('should only search columns for the column kind', async () => {
		await tool.execute({ pattern: 'Id', kinds: ['columns'] });

		const [queryText] = mockQueryWithParams.mock.calls[0];
		expect(queryText).toContain('FROM sys.columns c');
		expect(queryText).not.toContain('UNION');
	});

	it('should only search routine types for the routine kind', async () => {
		await tool.execute({ pattern: 'Get', kinds: ['routine'] });

		const [queryText] = mockQueryWithParams.mock.calls[0];
		expect(queryText).toContain("o.type IN ('P', 'PC', 'FN', 'FS', 'IF', 'TF', 'FT')");
		expect(queryText).not.toContain('sys.columns');
	});

	it('should filter by schema', async () => {
		await tool.execute({ pattern: 'x', schema: 'sales' });

		const [queryText, params] = mockQueryWithParams.mock.calls[0];
		expect(queryText).toContain('s.name = @schema');
		expect(params).toContainEqual({ name: 'schema', value: 'sales' });
	});

	it('should reject unknown kinds and empty patterns', async () => {
		await expect(tool.execute({ pattern: 'x', kinds: ['index'] })).rejects.toThrow('Unknown kind: index');
		await expect(tool.execute({ pattern: '  ' })).rejects.toThrow('Search pattern cannot be empty');
	});
});
