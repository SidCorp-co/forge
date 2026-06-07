/**
 * ISS-399 — unit coverage for the connection/binding dispatch helpers added by
 * the cutover. Pure-function paths only (no DB): the effective-config overlay
 * and the binding→AdapterContext builder. DB-backed resolution
 * (findActiveBinding / listActiveBindingsForProjectProvider) is exercised by the
 * integration e2e suite.
 */

import { describe, expect, it, vi } from 'vitest';

// Pure-function coverage only — avoid the import-time env validation in the real
// db client / vault (order-dependent across the full suite).
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    INTEGRATION_MASTER_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { buildContextFromBinding, effectiveConfig } = await import('./store.js');

function makePair(overrides?: {
  bindingConfig?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  secretsEnc?: Buffer | null;
  integrationSecret?: string | null;
}) {
  return {
    binding: {
      id: 'bind-1',
      connectionId: 'conn-1',
      projectId: 'proj-1',
      provider: 'coolify',
      environment: 'staging',
      config: overrides?.bindingConfig ?? {},
      integrationSecret: overrides?.integrationSecret ?? 'whsec_abc',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    connection: {
      id: 'conn-1',
      ownerType: 'user' as const,
      ownerId: 'owner-1',
      provider: 'coolify',
      displayName: null,
      config: overrides?.connectionConfig ?? {},
      secretsEnc: overrides?.secretsEnc ?? null,
      oauthInstallationId: null,
      active: true,
      breakerOpenedAt: null,
      lastHealthStatus: null,
      lastHealthAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    // biome-ignore lint/suspicious/noExplicitAny: row-shape stub for a pure helper
  } as any;
}

describe('effectiveConfig', () => {
  it('overlays binding.config on top of connection.config (binding wins)', () => {
    const cfg = effectiveConfig(
      makePair({
        connectionConfig: { baseUrl: 'https://c', resourceUuid: 'from-conn', branch: 'main' },
        bindingConfig: { resourceUuid: 'from-binding' },
      }),
    );
    expect(cfg).toEqual({ baseUrl: 'https://c', resourceUuid: 'from-binding', branch: 'main' });
  });
});

describe('buildContextFromBinding', () => {
  it('threads connectionId + bindingId and the per-binding HMAC secret', () => {
    const ctx = buildContextFromBinding(
      makePair({ integrationSecret: 'whsec_xyz', connectionConfig: { baseUrl: 'https://c' } }),
    );
    expect(ctx.connectionId).toBe('conn-1');
    expect(ctx.bindingId).toBe('bind-1');
    expect(ctx.projectId).toBe('proj-1');
    expect(ctx.provider).toBe('coolify');
    expect(ctx.environment).toBe('staging');
    expect(ctx.integrationSecret).toBe('whsec_xyz');
    // No secretsEnc → empty secrets, no decrypt attempted.
    expect(ctx.secrets).toEqual({});
    expect(ctx.config).toMatchObject({ baseUrl: 'https://c' });
  });
});
