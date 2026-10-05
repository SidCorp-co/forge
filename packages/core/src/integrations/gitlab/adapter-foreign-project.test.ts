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

const { gitlabIntegration } = await import('./adapter.js');
const adapter = gitlabIntegration.adapter as NonNullable<typeof gitlabIntegration.adapter>;

const ctx = {
  projectId: 'p1',
  bindingId: 'b1',
  config: { projectPath: 'acme/shop' },
  secrets: {},
} as never;

const input = (headers: Record<string, string>, project: string) =>
  ({
    headers,
    rawBody: '{}',
    payload: { project: { path_with_namespace: project } },
    emitFacts: async () => {},
  }) as never;

const settle = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe('gitlab handleInbound: a delivery for another project', () => {
  beforeEach(() => {
    recordRefusedInbound.mockClear();
    applyClaimedInbound.mockClear();
  });

  it('is recorded as a refused delivery and refused by name, never applied', async () => {
    const err = await settle(
      adapter.handleInbound(
        ctx,
        input(
          { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'uuid-1' },
          'other/repo',
        ),
      ),
    );
    expect(isRefusal(err, 'WEBHOOK_FOREIGN_REPOSITORY')).toBe(true);
    expect(recordRefusedInbound).toHaveBeenCalledOnce();
    expect(recordRefusedInbound.mock.calls[0]?.[0]).toMatchObject({
      bindingId: 'b1',
      eventName: 'Merge Request Hook',
      requestId: 'uuid-1',
      code: 'WEBHOOK_FOREIGN_REPOSITORY',
    });
    expect(applyClaimedInbound).not.toHaveBeenCalled();
  });

  it('a delivery naming no event is recorded and refused by name', async () => {
    const err = await settle(
      adapter.handleInbound(ctx, input({ 'x-gitlab-event-uuid': 'uuid-2' }, 'acme/shop')),
    );
    expect(isRefusal(err, 'WEBHOOK_EVENT_MISSING')).toBe(true);
    expect(recordRefusedInbound.mock.calls[0]?.[0]).toMatchObject({
      code: 'WEBHOOK_EVENT_MISSING',
    });
    expect(applyClaimedInbound).not.toHaveBeenCalled();
  });

  it('a delivery for the bound project is applied (case-insensitive)', async () => {
    await adapter.handleInbound(
      ctx,
      input({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-event-uuid': 'uuid-3' }, 'ACME/Shop'),
    );
    expect(applyClaimedInbound).toHaveBeenCalledOnce();
    expect(recordRefusedInbound).not.toHaveBeenCalled();
  });
});
