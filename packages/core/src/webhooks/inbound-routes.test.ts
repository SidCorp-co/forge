import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signHmacSha256 } from './hmac.js';

const SECRET = 'test-webhook-secret';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const handleGitHubEventMock = vi.fn(async () => ({ actions: 1 }));
vi.mock('./github-adapter.js', () => ({
  handleGitHubEvent: (...a: unknown[]) => handleGitHubEventMock(...(a as [])),
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
    expect(handleGitHubEventMock).not.toHaveBeenCalled();
  });

  it('200 and invokes GitHub adapter when x-github-event is present', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = JSON.stringify({ action: 'opened', issue: { id: 42, title: 't' } });
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(SECRET, body),
        'x-github-event': 'issues',
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { handler: string; actions: number };
    expect(json.handler).toBe('github');
    expect(json.actions).toBe(1);
    expect(handleGitHubEventMock).toHaveBeenCalledWith('p1', 'issues', expect.any(Object));
  });

  it('500 HANDLER_FAILED if the GitHub adapter throws', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    handleGitHubEventMock.mockRejectedValueOnce(new Error('boom'));
    const body = '{"action":"opened","issue":{"id":1}}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-hub-signature-256': signHmacSha256(SECRET, body),
        'x-github-event': 'issues',
      }),
    );
    expect(r.status).toBe(500);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('HANDLER_FAILED');
  });
});
