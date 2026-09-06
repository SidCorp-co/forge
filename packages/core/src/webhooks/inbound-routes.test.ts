import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signHmacSha256 } from './hmac.js';

const SECRET = 'test-webhook-secret';
const BINDING_SECRET = 'whsec_binding_scoped';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const handleInboundMock = vi.fn(async () => ({ deliveryId: 'del-1', actions: 1 }));
const getAdapterMock = vi.fn(() => ({ provider: 'github', handleInbound: handleInboundMock }));
vi.mock('../integrations/registry.js', () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...(a as [])),
}));

const listBindingsMock = vi.fn(async () => [
  { binding: { id: 'b1', environment: 'prod', integrationSecret: BINDING_SECRET }, connection: {} },
]);
vi.mock('../integrations/store.js', () => ({
  listActiveBindingsForProjectProvider: (...a: unknown[]) => listBindingsMock(...(a as [])),
  buildContextFromBinding: (pair: { binding: { id: string } }) => ({ bindingId: pair.binding.id }),
}));

const { webhookInboundRoutes } = await import('./inbound-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/webhooks', webhookInboundRoutes);
  app.onError(errorHandler);
  return app;
}

async function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

describe('POST /api/webhooks/in/:slug', () => {
  it('404 when slug has no matching project', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const r = await buildApp().fetch(await post('/api/webhooks/in/nope', '{}'));
    expect(r.status).toBe(404);
  });

  it('400 WEBHOOK_DISABLED when project.webhookSecret is null', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: null }]);
    const r = await buildApp().fetch(await post('/api/webhooks/in/p', '{}'));
    expect(r.status).toBe(400);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('WEBHOOK_DISABLED');
  });

  it('401 INVALID_SIGNATURE when HMAC is wrong', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', '{}', { 'x-hub-signature-256': 'sha256=deadbeef' }),
    );
    expect(r.status).toBe(401);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
  });

  it('200 generic handler when no x-github-event header', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = '{"ping":true}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(SECRET, body),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { handler: string; actions: number };
    expect(json.handler).toBe('generic');
    expect(json.actions).toBe(0);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it('dispatches a GitHub delivery to the adapter, signed with the BINDING secret', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = JSON.stringify({ action: 'opened', issue: { id: 42, title: 't' } });
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(BINDING_SECRET, body),
        'x-github-event': 'issues',
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { handler: string; actions: number; environment: string };
    expect(json.handler).toBe('github');
    expect(json.actions).toBe(1);
    expect(json.environment).toBe('prod');
    expect(handleInboundMock).toHaveBeenCalled();
  });

  it("refuses a GitHub delivery signed with the project's own webhookSecret", async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = JSON.stringify({ action: 'opened', issue: { id: 42 } });
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(SECRET, body),
        'x-github-event': 'issues',
      }),
    );
    expect(r.status).toBe(401);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it('400 INTEGRATION_NOT_CONFIGURED when the project has no github binding', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    listBindingsMock.mockResolvedValueOnce([]);
    const body = '{"action":"opened"}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(BINDING_SECRET, body),
        'x-github-event': 'issues',
      }),
    );
    expect(r.status).toBe(400);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });

  it('500 HANDLER_FAILED if the github adapter throws', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    handleInboundMock.mockRejectedValueOnce(new Error('boom'));
    const body = '{"action":"opened","issue":{"id":1}}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(BINDING_SECRET, body),
        'x-github-event': 'issues',
      }),
    );
    expect(r.status).toBe(500);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('HANDLER_FAILED');
  });
});
