import { describe, it, expect, vi, beforeEach } from 'vitest';
import forgeApiKey from '../../../strapi/src/middlewares/forge-api-key';

describe('forge-api-key middleware', () => {
  let mockStrapi: any;
  let middleware: any;
  let mockFindMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFindMany = vi.fn();
    mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findMany: mockFindMany,
      }),
    };
    middleware = forgeApiKey({}, { strapi: mockStrapi });
  });

  it('should find project by valid key and attach to ctx.state', async () => {
    const project = { documentId: 'proj-1', name: 'Test' };
    mockFindMany.mockResolvedValue([project]);

    const ctx = {
      request: { headers: { 'x-forge-api-key': 'valid-key-123' } },
      state: {},
      status: 200,
      body: null,
    } as any;
    const next = vi.fn();

    await middleware(ctx, next);

    expect(mockFindMany).toHaveBeenCalledWith({
      filters: { apiKey: { $eq: 'valid-key-123' } },
      limit: 1,
    });
    expect(ctx.state.forgeProject).toEqual(project);
    expect(next).toHaveBeenCalled();
  });

  it('should return 401 for invalid key', async () => {
    mockFindMany.mockResolvedValue([]);

    const ctx = {
      request: { headers: { 'x-forge-api-key': 'bad-key' } },
      state: {},
      status: 200,
      body: null,
    } as any;
    const next = vi.fn();

    await middleware(ctx, next);

    expect(ctx.status).toBe(401);
    expect(ctx.body).toEqual({ error: 'Invalid API key' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass through when no header present', async () => {
    const ctx = {
      request: { headers: {} },
      state: {},
    } as any;
    const next = vi.fn();

    await middleware(ctx, next);

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('should pass through for empty key string', async () => {
    const ctx = {
      request: { headers: { 'x-forge-api-key': '' } },
      state: {},
      status: 200,
      body: null,
    } as any;
    const next = vi.fn();

    await middleware(ctx, next);

    // Empty string is falsy, so it passes through without querying
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
