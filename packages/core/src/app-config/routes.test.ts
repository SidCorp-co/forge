/**
 * ISS-1421 r18 — judge-75 sent PUT /api/app-config/:projectId `{"chatProviderId":"q-j75"}` and read
 * 200: the id was stored, and every chat turn then passed it over for the fallback provider, so the
 * setting read as taken and did nothing. A provider id nothing registered names is refused by name.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT = '6f0a3066-9880-4bfd-9199-a0cb1dda9ce0';

const returning = vi.fn(async () => [{ projectId: PROJECT }]);
const insertValues = vi.fn((_v: unknown) => ({
  onConflictDoUpdate: () => ({ returning }),
}));

vi.mock('../db/client.js', () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
}));
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({ role: 'admin' })),
  assertRoleFor: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (c: import('hono').Context, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    await next();
  },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../api-reference/declare/describe.js', async (original) => ({
  ...(await original<typeof import('../api-reference/declare/describe.js')>()),
  answer: (_schema: unknown, value: unknown) => value,
}));

const { appConfigRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const providers = await import('../assistant/providers/registry.js');

function put(body: unknown) {
  const app = new Hono();
  app.route('/api/app-config', appConfigRoutes);
  app.onError(errorHandler as never);
  return app.request(`/api/app-config/${PROJECT}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  providers.clearProviders();
  insertValues.mockClear();
});

describe('PUT /api/app-config/:projectId chatProviderId', () => {
  it('refuses an id no provider has, naming it and the providers there are, and stores nothing', async () => {
    providers.register('anthropic', () => ({}) as never);
    const res = await put({ chatProviderId: 'q-j75' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('CHAT_PROVIDER_UNKNOWN');
    expect(body.message).toBe('No chat provider is named "q-j75". This deployment has anthropic.');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('says a deployment with no provider takes only null', async () => {
    const res = await put({ chatProviderId: 'anthropic' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      'No chat provider is named "anthropic": this deployment has none, so chatProviderId takes only null.',
    );
  });

  it('stores an id a provider has, and a null that clears it', async () => {
    providers.register('anthropic', () => ({}) as never);
    expect((await put({ chatProviderId: 'anthropic' })).status).toBe(200);
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({ chatProviderId: 'anthropic' });
    expect((await put({ chatProviderId: null })).status).toBe(200);
    expect(insertValues.mock.calls[1]?.[0]).toMatchObject({ chatProviderId: null });
  });
});
