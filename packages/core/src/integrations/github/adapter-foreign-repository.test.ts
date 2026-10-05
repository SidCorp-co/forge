import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../../lib/refusal.js';

const recordRefusedInbound = vi.fn(async (_input: Record<string, unknown>) => 'delivery-1');
const applyClaimedInbound = vi.fn(async () => ({
  deliveryId: 'delivery-ok',
  result: { actions: 0 },
}));

vi.mock('../index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyClaimedInbound,
  recordRefusedInbound,
}));

const { githubIntegration } = await import('./adapter.js');
const adapter = githubIntegration.adapter as NonNullable<typeof githubIntegration.adapter>;

const ctx = {
  projectId: 'p1',
  bindingId: 'b1',
  config: { owner: 'acme', repo: 'shop' },
  secrets: {},
} as never;

const input = (headers: Record<string, string>, repository: string) =>
  ({
    headers,
    rawBody: '{}',
    payload: { action: 'opened', repository: { full_name: repository } },
    emitFacts: async () => {},
  }) as never;

describe('github handleInbound: a delivery for another repository', () => {
  beforeEach(() => {
    recordRefusedInbound.mockClear();
    applyClaimedInbound.mockClear();
  });

  it('is recorded as a refused delivery and refused by name, never applied', async () => {
    const err = await adapter
      .handleInbound(
        ctx,
        input({ 'x-github-event': 'pull_request', 'x-github-delivery': 'guid-1' }, 'other/repo'),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isRefusal(err, 'WEBHOOK_FOREIGN_REPOSITORY')).toBe(true);
    expect(recordRefusedInbound).toHaveBeenCalledOnce();
    expect(recordRefusedInbound.mock.calls[0]?.[0]).toMatchObject({
      bindingId: 'b1',
      eventName: 'pull_request.opened',
      requestId: 'guid-1',
      code: 'WEBHOOK_FOREIGN_REPOSITORY',
    });
    expect(applyClaimedInbound).not.toHaveBeenCalled();
  });

  it('a delivery naming no event is recorded and refused by name', async () => {
    const err = await adapter
      .handleInbound(ctx, input({ 'x-github-delivery': 'guid-2' }, 'acme/shop'))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isRefusal(err, 'WEBHOOK_EVENT_MISSING')).toBe(true);
    expect(recordRefusedInbound.mock.calls[0]?.[0]).toMatchObject({
      code: 'WEBHOOK_EVENT_MISSING',
    });
    expect(applyClaimedInbound).not.toHaveBeenCalled();
  });

  it('a delivery for the bound repository is applied (case-insensitive)', async () => {
    await adapter.handleInbound(
      ctx,
      input({ 'x-github-event': 'pull_request', 'x-github-delivery': 'guid-3' }, 'ACME/Shop'),
    );
    expect(applyClaimedInbound).toHaveBeenCalledOnce();
    expect(recordRefusedInbound).not.toHaveBeenCalled();
  });
});
