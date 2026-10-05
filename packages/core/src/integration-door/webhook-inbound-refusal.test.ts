import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { refuser } from '../lib/refusal.js';
import { errorHandler } from '../middleware/error.js';

const refuse = refuser<'WEBHOOK_FOREIGN_REPOSITORY' | 'INTEGRATION_REFUSED'>('INTEGRATION_REFUSED');

vi.mock('../integrations/index.js', () => ({
  bindingInboundSecret: () => 'secret',
  buildContextFromBinding: () => ({}),
  dropPreviousHeldInboundSecret: async () => {},
  getAdapter: () => ({
    handleInbound: async () => {
      throw refuse(
        'WEBHOOK_FOREIGN_REPOSITORY',
        'delivery is for other/repo, this binding is acme/shop',
      );
    },
  }),
  listActiveBindingsForProjectProvider: async () => [
    { binding: { id: 'b1', role: 'source' }, connection: { id: 'c1' } },
  ],
  listIntegrations: () => [
    {
      provider: 'github',
      capabilities: {
        canReceiveWebhook: true,
        webhookHeader: 'x-github-event',
        webhookSignatureHeader: 'x-hub-signature-256',
        webhookVerification: 'hmac-sha256',
      },
    },
  ],
  previousHeldInboundSecret: () => null,
  recordTurnedAwayInboundCall: async () => {},
}));
vi.mock('../lib/hmac.js', () => ({
  verifyHmacSignature: () => true,
  verifySharedToken: () => true,
}));
vi.mock('../projects/index.js', () => ({ findProjectIdBySlug: async () => 'p1' }));
vi.mock('../outbox/index.js', () => ({ emitEvents: async () => {} }));

const { webhookInboundRoutes } = await import('./webhook-inbound-routes.js');

describe('webhook door: an adapter refusal', () => {
  it('answers under its own code, not 500 HANDLER_FAILED', async () => {
    const app = new Hono().route('/', webhookInboundRoutes);
    app.onError(errorHandler as never);
    const res = await app.request('/in/shop', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=abc',
      },
      body: '{}',
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe('WEBHOOK_FOREIGN_REPOSITORY');
  });
});
