/**
 * ISS-50 — a provider declaring the `shared-token` scheme (GitLab's `X-Gitlab-Token`) is let in only
 * when the header IS the binding's secret. A missing token and a wrong one are each turned away with
 * their own code and recorded on the door; neither reaches the adapter.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'proj-1' }] }) }) }),
  },
}));

const SECRET = 'whsec_binding_secret_0001';
const handleInbound = vi.fn(async () => ({ deliveryId: 'd-1', actions: 2 }));
const turnedAway = vi.fn(async (_args: { code: string }) => undefined);

vi.mock('../integrations/inbound-door.js', () => ({
  recordTurnedAwayInboundCall: (args: { code: string }) => turnedAway(args),
}));
vi.mock('../integrations/registry.js', () => ({
  getAdapter: () => ({ handleInbound }),
  listIntegrations: () => [
    {
      provider: 'gitlab',
      capabilities: {
        canReceiveWebhook: true,
        webhookHeader: 'x-gitlab-event',
        webhookSignatureHeader: 'x-gitlab-token',
        webhookVerification: 'shared-token',
      },
    },
  ],
}));
vi.mock('../integrations/store.js', () => ({
  listActiveBindingsForProjectProvider: async () => [
    { binding: { id: 'bind-gl', role: 'service', integrationSecret: SECRET }, connection: {} },
  ],
  buildContextFromBinding: () => ({ bindingId: 'bind-gl' }),
}));

const { webhookInboundRoutes } = await import('./inbound-routes.js');
const { errorHandler } = await import('../middleware/error.js');

// biome-ignore lint/suspicious/noExplicitAny: test-only mount, as the integration harness does
const app: any = new Hono();
app.route('/api/webhooks', webhookInboundRoutes);
app.onError(errorHandler);

const deliver = (headers: Record<string, string>): Promise<Response> =>
  app.request('/api/webhooks/in/autoflow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitlab-event': 'Push Hook', ...headers },
    body: JSON.stringify({ ref: 'refs/heads/main' }),
  });

beforeEach(() => vi.clearAllMocks());

describe('the shared-token door', () => {
  it('lets in a delivery whose token is the binding’s secret', async () => {
    const res = await deliver({ 'x-gitlab-token': SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, handler: 'gitlab', actions: 2 });
    expect(handleInbound).toHaveBeenCalledTimes(1);
  });

  it('turns away a token that is not the secret, by name, and records it on the door', async () => {
    const res = await deliver({ 'x-gitlab-token': `${SECRET}x` });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toContain('WEBHOOK_TOKEN_MISMATCH');
    expect(turnedAway).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WEBHOOK_TOKEN_MISMATCH' }),
    );
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('turns away a delivery carrying no token under its own code', async () => {
    const res = await deliver({});
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toContain('MISSING_WEBHOOK_TOKEN');
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('does not take an HMAC of the body in place of the token', async () => {
    const { signHmacSha256 } = await import('./hmac.js');
    const res = await deliver({
      'x-gitlab-token': signHmacSha256(SECRET, JSON.stringify({ ref: 'refs/heads/main' })),
    });
    expect(res.status).toBe(401);
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
