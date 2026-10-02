/**
 * An Autoflow connection renews its 12-hour access token from its rotating refresh token (ISS-52).
 *
 * Against real Postgres, because the property that matters is the row lock: the platform spends a
 * refresh token on use and revokes the whole connection when a spent one is presented again, so two
 * refreshes racing on one stored chain must rotate it exactly once. The token endpoint is a fake
 * holding the platform's rule (`backend-go/internal/oauth/usecase/service.go:Refresh`) without its
 * reuse grace — a second presentation of a spent token is refused, so a double rotation goes red.
 */

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationConnections } from '../../src/db/schema.js';
import {
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const BASE = 'https://auto.example.test';
const HOUR = 3_600_000;

type Refresh = typeof import('../../src/integrations/autoflow/refresh.js');
type Store = typeof import('../../src/integrations/store.js');
type Vault = typeof import('../../src/integrations/vault.js');
type Adapter = typeof import('../../src/integrations/autoflow/adapter.js');

let harness: TestDatabase;
let refresh: Refresh;
let store: Store;
let vault: Vault;
let adapterMod: Adapter;
let ownerId: string;

/** The platform's token endpoint: one live refresh token per chain, spent on use. */
function fakePlatform(opts: { delayMs?: number; revoked?: boolean } = {}) {
  const state = { live: 'srt_gen0', generation: 0, rotations: 0, presented: [] as string[] };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/oauth/token`) {
      const form = new URLSearchParams(String(init?.body));
      state.presented.push(form.get('refresh_token') ?? '');
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const invalid = () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'the refresh token is invalid, expired or revoked',
          }),
          { status: 400 },
        );
      if (
        opts.revoked ||
        form.get('grant_type') !== 'refresh_token' ||
        form.get('client_id') !== 'mcpc_forge' ||
        form.get('refresh_token') !== state.live
      ) {
        return invalid();
      }
      state.generation += 1;
      state.rotations += 1;
      state.live = `srt_gen${state.generation}`;
      return new Response(
        JSON.stringify({
          access_token: `sat_gen${state.generation}`,
          token_type: 'Bearer',
          expires_in: 43_200,
          refresh_token: state.live,
          scope: 'mcp',
        }),
        { status: 200 },
      );
    }
    if (url === `${BASE}/graphql`) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const current = `Bearer sat_gen${state.generation}`;
      if (auth !== current && !(state.generation === 0 && auth === 'Bearer sat_gen0')) {
        return new Response(
          JSON.stringify({
            errors: [{ message: 'unauthenticated', extensions: { code: 'UNAUTHENTICATED' } }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            apiKeyContext: {
              organization_id: 'org-1',
              stores: [
                { id: 1, slug: 'hop', name: 'HOP', commerce_enabled: false, active_theme_id: 2 },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return state;
}

async function seed(secrets: Record<string, unknown>): Promise<string> {
  const row = await store.createConnection({
    ownerId,
    provider: 'autoflow',
    config: { baseUrl: BASE },
    secrets,
  });
  return row.id;
}

async function stored(id: string) {
  const [row] = await harness.db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  if (!row?.secretsEnc) throw new Error('no secrets stored');
  return { row, secrets: vault.decryptJson<Record<string, unknown>>(row.secretsEnc) };
}

const expiringIn = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  refresh = await import('../../src/integrations/autoflow/refresh.js');
  store = await import('../../src/integrations/store.js');
  vault = await import('../../src/integrations/vault.js');
  adapterMod = await import('../../src/integrations/autoflow/adapter.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autoflow token refresh (ISS-52)', () => {
  it('refreshes an access token inside the margin and persists the rotated refresh token', async () => {
    const platform = fakePlatform();
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(10 * 60_000),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });

    const out = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
    });

    expect(out).toMatchObject({ kind: 'ok', rotated: true });
    expect(platform.rotations).toBe(1);
    const { secrets } = await stored(id);
    expect(secrets).toMatchObject({
      accessToken: 'sat_gen1',
      refreshToken: 'srt_gen1',
      clientId: 'mcpc_forge',
      previousAccessToken: 'sat_gen0',
    });
    const expiresAt = Date.parse(String(secrets.accessTokenExpiresAt));
    expect(expiresAt - Date.now()).toBeGreaterThan(11 * HOUR);

    // The next caller reads the persisted chain: no second rotation while the token is fresh.
    const again = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
    });
    expect(again).toMatchObject({ kind: 'ok', rotated: false });
    expect(platform.rotations).toBe(1);
  });

  it('leaves a token with more than the margin left alone', async () => {
    const platform = fakePlatform();
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(8 * HOUR),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });
    const out = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
    });
    expect(out).toMatchObject({ kind: 'ok', rotated: false });
    expect(platform.presented).toEqual([]);
  });

  it('rotates exactly once when two refreshes race on one chain', async () => {
    const platform = fakePlatform({ delayMs: 150 });
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(-60_000),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });

    const call = () =>
      refresh.ensureFreshAutoflowToken({
        connectionId: id,
        config: { baseUrl: BASE },
        minLifetimeMs: refresh.AUTOFLOW_INJECTION_MIN_LIFETIME_MS,
      });
    const [a, b] = await Promise.all([call(), call()]);

    expect(platform.rotations).toBe(1);
    expect(platform.presented).toEqual(['srt_gen0']);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('unreachable');
    expect(a.secrets.accessToken).toBe('sat_gen1');
    expect(b.secrets.accessToken).toBe('sat_gen1');
    expect([a.rotated, b.rotated].sort()).toEqual([false, true]);
    expect((await stored(id)).secrets.refreshToken).toBe('srt_gen1');
  });

  it('refreshes once on a 401 and only while the refused token is still the stored one', async () => {
    const platform = fakePlatform();
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(8 * HOUR),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });
    const first = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
      refusedToken: 'sat_gen0',
    });
    expect(first).toMatchObject({ kind: 'ok', rotated: true });
    // A second caller refused with the same old token finds it already replaced.
    const second = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
      refusedToken: 'sat_gen0',
    });
    expect(second).toMatchObject({ kind: 'ok', rotated: false });
    expect(platform.rotations).toBe(1);
  });

  it('puts a connection whose refresh token is revoked into a named needs-re-auth state, once', async () => {
    const platform = fakePlatform({ revoked: true });
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(-60_000),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });

    const out = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
    });
    expect(out).toEqual({
      kind: 'needs_reauth',
      reason: 'refresh_refused: invalid_grant: the refresh token is invalid, expired or revoked',
    });

    const { row, secrets } = await stored(id);
    expect(row.lastHealthStatus).toBe('needs_reauth');
    expect(row.lastHealthDetail).toContain('Autoflow refresh refused (invalid_grant');
    expect(row.lastHealthDetail).toContain('nothing will retry it');
    expect(secrets.refreshToken).toBeUndefined();
    expect(secrets.refreshRefusedReason).toContain('invalid_grant');

    // The dead chain is not presented again: the next call answers the recorded reason.
    const again = await refresh.ensureFreshAutoflowToken({
      connectionId: id,
      config: { baseUrl: BASE },
      minLifetimeMs: refresh.AUTOFLOW_REFRESH_MARGIN_MS,
    });
    expect(again.kind).toBe('needs_reauth');
    expect(platform.presented).toEqual(['srt_gen0']);
  });
});

describe('autoflow token refresh at its callers (ISS-52)', () => {
  it('hands a run a refreshed token at injection, and leaves a needs-re-auth one out', async () => {
    fakePlatform();
    const path = adapterMod.autoflowIntegration.capabilities.agentPath;
    if (path.kind !== 'direct-mcp' || !path.freshSecrets) throw new Error('no freshSecrets');
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(2 * HOUR),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });
    const secrets = await path.freshSecrets({
      connectionId: id,
      config: { baseUrl: BASE },
      secrets: (await stored(id)).secrets,
    });
    expect(secrets?.accessToken).toBe('sat_gen1');
    expect(path.buildEntry({ baseUrl: BASE }, secrets ?? {})).toMatchObject({
      headers: { Authorization: 'Bearer sat_gen1' },
    });

    vi.unstubAllGlobals();
    fakePlatform({ revoked: true });
    const dead = await seed({
      accessToken: 'sat_old',
      accessTokenExpiresAt: expiringIn(-60_000),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });
    expect(
      await path.freshSecrets({ connectionId: dead, config: { baseUrl: BASE }, secrets: {} }),
    ).toBeNull();
  });

  it('a healthcheck refreshes an expired token and reports the site through the new one', async () => {
    fakePlatform();
    const id = await seed({
      accessToken: 'sat_gen0',
      accessTokenExpiresAt: expiringIn(-60_000),
      refreshToken: 'srt_gen0',
      clientId: 'mcpc_forge',
    });
    const adapter = adapterMod.autoflowIntegration.adapter;
    if (!adapter) throw new Error('no adapter');
    const out = await adapter.healthcheck({
      connectionId: id,
      bindingId: 'b1',
      projectId: 'p1',
      provider: 'autoflow',
      role: 'service',
      config: { baseUrl: BASE },
      secrets: (await stored(id)).secrets as never,
      integrationSecret: null,
    });
    expect(out).toMatchObject({ status: 'ok', message: 'Connected to HOP' });
    expect((await stored(id)).secrets.accessToken).toBe('sat_gen1');
  });
});
