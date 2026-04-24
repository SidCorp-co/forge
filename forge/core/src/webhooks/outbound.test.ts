import { beforeEach, describe, expect, it, vi } from 'vitest';

// Single queue: each call consumes one `nextSelect()` result, whether it ends in .where() or .where().limit()
const nextSelect = vi.fn();

function makeWhereChain() {
  let consumed = false;
  const resolver = async () => {
    if (consumed) return [];
    consumed = true;
    return nextSelect();
  };
  // Thenable that also exposes .limit; whichever is called first consumes the row.
  const chain: Record<string, unknown> = {};
  const thenKey = 'then';
  chain[thenKey] = (onFulfilled: (v: unknown) => unknown) => resolver().then(onFulfilled);
  chain.limit = (_n: number) => resolver();
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => makeWhereChain() }) }),
  },
}));

const sendMock = vi.fn(async () => 'msg-1');
const workMock = vi.fn(async () => {});

vi.mock('../queue/boss.js', () => ({
  boss: { createQueue: vi.fn(async () => {}), send: sendMock, work: workMock },
}));

// Manual fetch mock
const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
vi.stubGlobal('fetch', fetchMock);

const { enqueueDelivery, handleDelivery } = await import('./outbound.js');

beforeEach(() => {
  vi.clearAllMocks();
  nextSelect.mockReset();
});

describe('enqueueDelivery', () => {
  it('fans out to every active webhook whose events include the event', async () => {
    nextSelect.mockResolvedValueOnce([
      { id: 'wh-1', events: ['issue.statusChanged'] },
      { id: 'wh-2', events: ['issue.created', 'issue.statusChanged'] },
      { id: 'wh-3', events: ['issue.created'] },
    ]);

    const n = await enqueueDelivery('p1', 'issue.statusChanged', { foo: 'bar' });
    expect(n).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledWith(
      'webhook-delivery',
      expect.objectContaining({ webhookId: 'wh-1', event: 'issue.statusChanged' }),
      expect.objectContaining({ retryLimit: 5, retryBackoff: true }),
    );
  });

  it('no-op when no active webhooks match', async () => {
    nextSelect.mockResolvedValueOnce([]);
    const n = await enqueueDelivery('p1', 'issue.statusChanged', {});
    expect(n).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('handleDelivery', () => {
  it('POSTs with HMAC signature and completes on 2xx', async () => {
    nextSelect.mockResolvedValueOnce([
      {
        id: 'wh-1',
        url: 'https://example.test/hook',
        secret: 'sek',
        events: ['issue.statusChanged'],
        active: true,
      },
    ]);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await handleDelivery({ webhookId: 'wh-1', event: 'issue.statusChanged', data: { a: 1 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://example.test/hook');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['x-forge-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['x-forge-event']).toBe('issue.statusChanged');
  });

  it('throws on 5xx so pg-boss retries', async () => {
    nextSelect.mockResolvedValueOnce([
      { id: 'wh-1', url: 'https://x', secret: 's', events: ['e'], active: true },
    ]);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(handleDelivery({ webhookId: 'wh-1', event: 'e', data: {} })).rejects.toThrow(
      /503/,
    );
  });

  it('swallows 4xx as permanent failure (no retry)', async () => {
    nextSelect.mockResolvedValueOnce([
      { id: 'wh-1', url: 'https://x', secret: 's', events: ['e'], active: true },
    ]);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(
      handleDelivery({ webhookId: 'wh-1', event: 'e', data: {} }),
    ).resolves.toBeUndefined();
  });

  it('skips when webhook row is missing', async () => {
    nextSelect.mockResolvedValueOnce([]);
    await handleDelivery({ webhookId: 'wh-missing', event: 'e', data: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when webhook row is inactive', async () => {
    nextSelect.mockResolvedValueOnce([
      { id: 'wh-1', url: 'https://x', secret: 's', events: ['e'], active: false },
    ]);
    await handleDelivery({ webhookId: 'wh-1', event: 'e', data: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
