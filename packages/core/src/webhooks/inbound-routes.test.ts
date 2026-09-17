import { createHmac } from 'node:crypto';
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
// ISS-1071 — the router derives its header→provider map from the DECLARATIONS rather than holding a
// literal array, so this mock has to answer `listIntegrations` too. Declaring github's webhook header
// here is the point of the test: if the route stopped reading `capabilities.webhookHeader`, or a
// provider declared one without `canReceiveWebhook`, the derived map would change and these
// signature tests would go red rather than routing to nobody in silence.
//
// ISS-1085 slice 4 — `webhookSignatureHeader` is declared here for the same reason. Sentry appears
// beside github so the route is exercised for TWO providers signing under two different headers,
// which is the whole of what moving that knowledge out of this file bought; `noSignature` is a
// provider that declared an inbound surface and forgot how it is signed.
const declarations = [
  {
    provider: 'github',
    capabilities: {
      canReceiveWebhook: true,
      webhookHeader: 'x-github-event',
      webhookSignatureHeader: 'x-hub-signature-256',
    },
  },
  {
    provider: 'sentry',
    capabilities: {
      canReceiveWebhook: true,
      webhookHeader: 'sentry-hook-resource',
      webhookSignatureHeader: 'sentry-hook-signature',
    },
  },
];
let declared = declarations;
vi.mock('../integrations/registry.js', () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...(a as [])),
  listIntegrations: () => declared,
}));

const listBindingsMock = vi.fn(async () => [
  {
    binding: { id: 'b1', role: 'service', stages: [], integrationSecret: BINDING_SECRET },
    connection: {},
  },
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
  declared = declarations;
});

/** Sentry signs with a BARE hex digest rather than github's `sha256=` prefix. */
function sentrySignature(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

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
    const json = (await r.json()) as {
      handler: string;
      actions: number;
      role: string;
      stages: string[];
    };
    expect(json.handler).toBe('github');
    expect(json.actions).toBe(1);
    // github is never a deploy target — `providerCanDeploy('github')` is false —
    // so an inbound github delivery is always answered by a service binding.
    expect(json.role).toBe('service');
    expect(json.stages).toEqual([]);
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

  // ── ISS-1085 slice 4 — the signature header is the matched provider's own ──────────────────

  it('routes a delivery carrying sentry-hook-resource to the Sentry adapter', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    getAdapterMock.mockReturnValueOnce({ provider: 'sentry', handleInbound: handleInboundMock });
    const body = '{"action":"created","data":{"issue":{}}}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'sentry-hook-resource': 'issue',
        'sentry-hook-signature': sentrySignature(BINDING_SECRET, body),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { handler: string };
    expect(json.handler).toBe('sentry');
    expect(handleInboundMock).toHaveBeenCalled();
  });

  it('401 INVALID_SIGNATURE when the Sentry digest does not verify', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = '{"action":"created"}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'sentry-hook-resource': 'issue',
        'sentry-hook-signature': 'deadbeef',
      }),
    );
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code?: string }).code).toBe('INVALID_SIGNATURE');
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it('401 MISSING_SIGNATURE when a Sentry delivery carries no signature at all', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', '{}', { 'sentry-hook-resource': 'issue' }),
    );
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code?: string }).code).toBe('MISSING_SIGNATURE');
  });

  // cm:guard the narrowing ISS-1085 slice 4 took, asserted in both directions. A provider-routed delivery is verified against the ONE header its declaration names, so a correct digest under another provider's header no longer opens the door: the header name is what identifies the sender, and a set-of-headers lookup made it decorative.
  it('401 when a Sentry delivery is signed under x-hub-signature-256 instead', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = '{"action":"created"}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'sentry-hook-resource': 'issue',
        'x-hub-signature-256': signHmacSha256(BINDING_SECRET, body),
      }),
    );
    expect(r.status).toBe(401);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it('401 when a GitHub delivery is signed only under x-forge-signature-256', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = '{"action":"opened","issue":{"id":1}}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-github-event': 'issues',
        'x-forge-signature-256': signHmacSha256(BINDING_SECRET, body),
      }),
    );
    expect(r.status).toBe(401);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  // cm:guard the GENERIC path keeps BOTH headers. It is not provider-routed, so there is no declaration to read one off, and narrowing it would break every project pointed at the generic door while its adapter is written.
  it.each(['x-hub-signature-256', 'x-forge-signature-256'])(
    'still accepts a provider-less delivery signed under %s',
    async (header) => {
      selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
      const body = '{"ping":true}';
      const r = await buildApp().fetch(
        await post('/api/webhooks/in/p', body, { [header]: signHmacSha256(SECRET, body) }),
      );
      expect(r.status).toBe(200);
      expect(((await r.json()) as { handler: string }).handler).toBe('generic');
    },
  );

  // cm:guard a matched provider that declares NO signature header is refused BY NAME rather than dropped through to the generic path. Falling through would verify a provider's delivery against `projects.webhookSecret` and answer `actions: 0` — a 200 for a payload nobody handled.
  it('refuses by name a provider that declares a webhook and no signature header', async () => {
    declared = [
      {
        provider: 'github',
        capabilities: { canReceiveWebhook: true, webhookHeader: 'x-github-event' },
      },
    ] as typeof declarations;
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    const body = '{"action":"opened"}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'x-github-event': 'issues',
        'x-hub-signature-256': signHmacSha256(BINDING_SECRET, body),
      }),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code?: string }).code).toBe(
      'PROVIDER_DECLARES_NO_SIGNATURE_HEADER',
    );
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it('echoes a handler refusal so an operator sees why nothing happened', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p1', secret: SECRET }]);
    getAdapterMock.mockReturnValueOnce({ provider: 'sentry', handleInbound: handleInboundMock });
    handleInboundMock.mockResolvedValueOnce({
      deliveryId: 'del-2',
      actions: 0,
      refusal: 'this delivery carries sentry-hook-resource "error"',
    } as never);
    const body = '{"action":"created"}';
    const r = await buildApp().fetch(
      await post('/api/webhooks/in/p', body, {
        'sentry-hook-resource': 'error',
        'sentry-hook-signature': sentrySignature(BINDING_SECRET, body),
      }),
    );
    const json = (await r.json()) as { actions: number; refusal?: string };
    expect(json.actions).toBe(0);
    expect(json.refusal).toContain('"error"');
  });
});
