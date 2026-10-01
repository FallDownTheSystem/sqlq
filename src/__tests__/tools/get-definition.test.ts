import { GetDefinitionTool } from '../../tools/get-definition.js';
import { ConnectionManager } from '../../connection-manager.js';
import { NotFoundError } from '../../errors.js';

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

const view = { object_id: 9, schema_name: 'rpt', object_name: 'PortfolioReport', type_code: 'V' };

describe('GetDefinitionTool', () => {
	let tool: GetDefinitionTool;

	beforeEach(() => {
		jest.clearAllMocks();
		mockQueryWithParams.mockReset();
		tool = new GetDefinitionTool(new ConnectionManager({} as any));
	});

	it('should return the trimmed source of the resolved object', async () => {
		mockQueryWithParams
			.mockResolvedValueOnce({ recordset: [view] })
			.mockResolvedValueOnce({ recordset: [{ definition: '\r\nCREATE VIEW rpt.PortfolioReport AS SELECT 1 AS x\r\n' }] });

		const result = await tool.execute({ object_name: 'PortfolioReport' });

		const [queryText, params] = mockQueryWithParams.mock.calls[1];
		expect(queryText).toContain('OBJECT_DEFINITION(@objectId)');
		expect(params).toEqual([{ name: 'objectId', value: 9 }]);
		expect(result).toEqual({
			schema: 'rpt',
			name: 'PortfolioReport',
			type: 'view',
			definition: 'CREATE VIEW rpt.PortfolioReport AS SELECT 1 AS x',
		});
	});

	it('should explain why the source is missing', async () => {
		mockQueryWithParams
			.mockResolvedValueOnce({ recordset: [view] })
			.mockResolvedValueOnce({ recordset: [{ definition: null }] });

		const error = await tool.execute({ object_name: 'PortfolioReport' }).catch(e => e);

		expect(error).toBeInstanceOf(NotFoundError);
		expect(error.message).toBe('The source of rpt.PortfolioReport is not available');
	});

	it('should send tables to describe', async () => {
		mockQueryWithParams.mockResolvedValueOnce({ recordset: [{ object_id: 1, schema_name: 'dbo', object_name: 'Orders', type_code: 'U' }] });

		const error = await tool.execute({ object_name: 'Orders' }).catch(e => e);

		expect(error.suggestions).toEqual(['sqlq describe dbo.Orders']);
	});
});
