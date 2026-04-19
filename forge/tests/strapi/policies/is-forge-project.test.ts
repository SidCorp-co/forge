import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errors } from '@strapi/utils';

describe('is-forge-project policy', () => {
  let policy: any;
  let mockFindMany: ReturnType<typeof vi.fn>;
  let mockJwtVerify: ReturnType<typeof vi.fn>;
  let mockUserFindOne: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockFindMany = vi.fn();
    mockJwtVerify = vi.fn();
    mockUserFindOne = vi.fn();

    (globalThis as any).strapi = {
      documents: vi.fn().mockReturnValue({ findMany: mockFindMany }),
      plugin: vi.fn().mockReturnValue({
        service: vi.fn().mockReturnValue({ verify: mockJwtVerify }),
      }),
      db: {
        query: vi.fn().mockReturnValue({ findOne: mockUserFindOne }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };

    const mod = await import('../../../strapi/src/policies/is-forge-project');
    policy = mod.default;
  });

  it('allows when ctx.state.user is already set', async () => {
    const ctx = { state: { user: { id: 1 } }, request: { headers: {} } };
    const result = await policy(ctx);
    expect(result).toBe(true);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('authenticates JWT from Authorization header on auth:false routes', async () => {
    mockJwtVerify.mockResolvedValue({ id: 42 });
    mockUserFindOne.mockResolvedValue({ id: 42, username: 'admin' });

    const ctx = {
      state: {},
      request: { headers: { authorization: 'Bearer valid-jwt-token' } },
    };

    const result = await policy(ctx);
    expect(result).toBe(true);
    expect(ctx.state.user).toEqual({ id: 42, username: 'admin' });
    expect(mockJwtVerify).toHaveBeenCalledWith('valid-jwt-token');
  });

  it('falls through to API key when JWT is invalid', async () => {
    mockJwtVerify.mockRejectedValue(new Error('Invalid token'));
    const project = { documentId: 'proj-1', apiKey: 'key' };
    mockFindMany.mockResolvedValue([project]);

    const ctx = {
      state: {},
      request: {
        headers: {
          authorization: 'Bearer bad-token',
          'x-forge-api-key': 'key',
        },
      },
    };

    const result = await policy(ctx);
    expect(result).toBe(true);
    expect(ctx.state.forgeProject).toBe(project);
  });

  it('throws UnauthorizedError when no JWT and no API key', async () => {
    const ctx = { state: {}, request: { headers: {} } };
    await expect(policy(ctx)).rejects.toThrow(errors.UnauthorizedError);
  });

  it('looks up project by API key and attaches to state', async () => {
    const project = { documentId: 'proj-1', name: 'Test', apiKey: 'valid-key' };
    mockFindMany.mockResolvedValue([project]);

    const ctx = {
      state: {},
      request: { headers: { 'x-forge-api-key': 'valid-key' } },
    };

    const result = await policy(ctx);
    expect(result).toBe(true);
    expect(ctx.state.forgeProject).toBe(project);
    expect(mockFindMany).toHaveBeenCalledWith({
      filters: { apiKey: { $eq: 'valid-key' } },
      limit: 1,
    });
  });

  it('throws PolicyError for invalid API key', async () => {
    mockFindMany.mockResolvedValue([]);

    const ctx = {
      state: {},
      request: { headers: { 'x-forge-api-key': 'bad-key' } },
    };

    await expect(policy(ctx)).rejects.toThrow(errors.PolicyError);
  });

  it('rejects when JWT user not found in DB', async () => {
    mockJwtVerify.mockResolvedValue({ id: 999 });
    mockUserFindOne.mockResolvedValue(null);

    const ctx = {
      state: {},
      request: { headers: { authorization: 'Bearer orphan-token' } },
    };

    // No API key either, so should throw
    await expect(policy(ctx)).rejects.toThrow(errors.UnauthorizedError);
  });
});
