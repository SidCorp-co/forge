/**
 * ISS-1140 — what the github health probe answers once it also asks where GitHub is calling.
 *
 * Before this, every branch of `healthcheck` turned on `GET /repos/:owner/:repo`: whether Forge
 * can call OUT. An App addressed at a host that serves no such route passed all of them and the
 * binding reported `ok` while nothing arrived, for three days on this project.
 *
 * What the probe may decide here is limited on purpose. `last_health_status` is the CONNECTION's
 * column and one connection may serve bindings in several projects, so the probe rules only on
 * what is true of the whole App — no address, an address switched off, a read that failed — and
 * stores the observation for the per-binding comparison `agent-client` makes at read time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn(async (_id: string, _patch: Record<string, unknown>) => null);
const installationTokenMock = vi.fn(async () => 'ghs_token');

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../store.js', async () => {
  const real = await vi.importActual<typeof import('../store.js')>('../store.js');
  return {
    ...real,
    updateConnection: (id: string, patch: Record<string, unknown>) =>
      updateConnectionMock(id, patch),
  };
});
vi.mock('./app-auth.js', async () => {
  const real = await vi.importActual<typeof import('./app-auth.js')>('./app-auth.js');
  return { ...real, installationToken: (...a: unknown[]) => installationTokenMock(...(a as [])) };
});

const { getAdapter } = await import('../registry.js');
const { registerAllIntegrations } = await import('../register-all.js');
registerAllIntegrations();

const originalFetch = globalThis.fetch;

// A real key, because `readAppHookConfig` signs the App JWT itself: a placeholder string would
// fail inside the signer and every case would go red for a reason that is not the subject.
const { generateKeyPairSync } = await import('node:crypto');
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

/** The repository answers, and the App's webhook configuration is whatever a case says it is. */
function serving(hook: { status?: number; body?: unknown; ok?: boolean }) {
  return vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith('/app/hook/config')) {
      const status = hook.status ?? 200;
      return {
        ok: hook.ok ?? status < 400,
        status,
        json: async () => hook.body ?? {},
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ full_name: 'SidCorp-co/forge', default_branch: 'main' }),
    } as unknown as Response;
  });
}

const ctx = {
  connectionId: 'conn-1',
  bindingId: 'bind-1',
  projectId: 'proj-1',
  provider: 'github' as const,
  role: 'service' as const,
  stages: [],
  config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42 },
  secrets: { appId: '1234', privateKey: PEM },
  integrationSecret: null,
};

// biome-ignore lint/suspicious/noExplicitAny: the adapter context is generic over config/secrets
const probe = () => getAdapter('github')?.healthcheck(ctx as any);

/** Every `updateConnection` patch this probe wrote, merged in the order they were written. */
function written(): Record<string, unknown> {
  return Object.assign({}, ...updateConnectionMock.mock.calls.map((c) => c[1] ?? {}));
}

beforeEach(() => {
  updateConnectionMock.mockClear();
  installationTokenMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('the github health probe and the inbound door', () => {
  it('reports ok and records the address when the App holds a live webhook', async () => {
    globalThis.fetch = serving({
      body: { url: 'https://api.example.test/api/webhooks/in/forge-dev', active: true },
    }) as unknown as typeof fetch;

    await expect(probe()).resolves.toMatchObject({ status: 'ok' });
    expect(written()).toMatchObject({
      lastHealthStatus: 'ok',
      lastHealthDetail: null,
      inboundEndpointObserved: {
        url: 'https://api.example.test/api/webhooks/in/forge-dev',
        active: true,
      },
    });
  });

  // Criterion 3.
  it('refuses ok when the App s webhook is switched off on GitHub s side', async () => {
    globalThis.fetch = serving({
      body: { url: 'https://api.example.test/api/webhooks/in/forge-dev', active: false },
    }) as unknown as typeof fetch;

    const result = await probe();
    expect(result?.status).toBe('degraded');
    expect(result?.message).toMatch(/switched off/);
    expect(written()).toMatchObject({ lastHealthStatus: 'degraded' });
  });

  it('refuses ok when the App holds no webhook address at all', async () => {
    globalThis.fetch = serving({ body: { active: true } }) as unknown as typeof fetch;

    const result = await probe();
    expect(result?.status).toBe('degraded');
    expect(result?.message).toMatch(/holds no webhook address/);
  });

  // Criterion 17. An unknown is not a green, and the reason is stored rather than discarded.
  it('refuses ok when GitHub could not be asked, and records why', async () => {
    globalThis.fetch = serving({ status: 502 }) as unknown as typeof fetch;

    const result = await probe();
    expect(result?.status).toBe('degraded');
    expect(result?.message).toMatch(/HTTP 502/);
    expect(written()).toMatchObject({
      inboundEndpointObserved: { url: null, readError: expect.stringMatching(/HTTP 502/) },
    });
  });

  // Criterion 15. The sweep discarded this sentence entirely until ISS-1140, so a status read an
  // hour later carried no reason anyone could act on.
  it('persists the sentence beside the status on every outbound refusal too', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response,
    ) as unknown as typeof fetch;

    await probe();
    expect(written()).toMatchObject({
      lastHealthStatus: 'error',
      lastHealthDetail: expect.stringMatching(/not among the repositories/),
    });
  });

  // The door is asked only once the repository answers: a probe that cannot reach the App at all
  // has a refusal to report already, and a second failing call would replace it with a worse one.
  it('does not ask where GitHub calls when the repository read already refused', async () => {
    const fetchMock = vi.fn(
      async (_url: string): Promise<Response> =>
        ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(probe()).resolves.toMatchObject({ status: 'error' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/app/hook/config'))).toBe(false);
  });
});
