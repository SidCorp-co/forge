import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ChatSession Controller - create', () => {
  let controller: any;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCreate = vi.fn().mockResolvedValue({
      documentId: 'chat-1',
      title: 'Test chat',
    });

    (globalThis as any).strapi = {
      documents: vi.fn().mockReturnValue({ create: mockCreate }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    vi.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid: string, fn: any) => fn({ strapi: (globalThis as any).strapi }),
      },
    }));

    const mod = await import('../../../../strapi/src/api/chat-session/controllers/chat-session');
    controller = mod.default;
  });

  it('creates chat session with all fields including project relation', async () => {
    const ctx = {
      request: {
        body: {
          data: {
            title: 'Help chat',
            messages: [{ role: 'user', content: 'Hi' }],
            source: 'widget',
            metadata: { page: '/home' },
            project: 'proj-1',
          },
        },
      },
      state: {},
    };

    const result = await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        title: 'Help chat',
        messages: [{ role: 'user', content: 'Hi' }],
        source: 'widget',
        metadata: { page: '/home' },
        project: 'proj-1',
      },
    });
    expect(result).toEqual({ data: expect.objectContaining({ documentId: 'chat-1' }) });
  });

  it('creates chat session without project', async () => {
    const ctx = {
      request: { body: { data: { title: 'No project chat', messages: [] } } },
      state: {},
    };

    await controller.create(ctx);

    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.project).toBeUndefined();
  });

  it('handles missing data gracefully', async () => {
    const ctx = {
      request: { body: {} },
      state: {},
    };

    await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        title: undefined,
        messages: undefined,
        source: undefined,
        metadata: undefined,
      },
    });
  });
});
