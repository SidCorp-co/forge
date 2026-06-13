/**
 * ISS-399 / ISS-410 — recordDelivery writes the binding_id key (post-cutover);
 * the legacy backing column was dropped, so a new binding inserts binding_id only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let inserted: Record<string, unknown> | null = null;
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return { returning: async () => [{ id: 'delivery-1' }] };
      },
    }),
  },
}));

const { recordDelivery } = await import('./deliveries.js');

beforeEach(() => {
  inserted = null;
});

describe('recordDelivery', () => {
  it('persists binding_id only for new bindings', async () => {
    const id = await recordDelivery({
      bindingId: 'bind-1',
      direction: 'outbound',
      eventName: 'release.requested',
      payload: { runId: 'run-1' },
      requestId: 'req-1',
      status: 'pending',
    });
    expect(id).toBe('delivery-1');
    expect(inserted).toMatchObject({
      bindingId: 'bind-1',
      direction: 'outbound',
      eventName: 'release.requested',
      requestId: 'req-1',
      status: 'pending',
    });
  });
});
