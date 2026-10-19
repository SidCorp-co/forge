/**
 * ISS-1380 — the overlay every dispatch reads, and the keys a connection never supplies to it.
 *
 * `effectiveConfig` lays the connection's config under the binding's. A binding-only key held on the
 * connection (Sentry's `targets`, written there by every release before this one) would otherwise
 * reach every project bound to it, which is the cross-project read this change removes.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { registerAllIntegrations } = await import('./register-all.js');
const { effectiveConfig } = await import('./store.js');

type Pair = Parameters<typeof effectiveConfig>[0];

const pair = (provider: string, connection: object, binding: object) =>
  ({
    binding: { provider, config: binding },
    connection: { config: connection },
  }) as unknown as Pair;

const core = { label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' };
const web = { label: 'web', organizationSlug: 'canawan', projectSlug: 'forge-web' };

beforeAll(() => registerAllIntegrations());

describe('a sentry binding', () => {
  it('takes targets from itself, whatever the shared connection holds', () => {
    const cfg = effectiveConfig<{ host: string; targets: unknown[] }>(
      pair('sentry', { host: 'logs.canawan.com', targets: [web] }, { targets: [core] }),
    );

    expect(cfg).toEqual({ host: 'logs.canawan.com', targets: [core] });
  });

  it('declares no targets when only the connection holds them', () => {
    const cfg = effectiveConfig(pair('sentry', { host: 'logs.canawan.com', targets: [web] }, {}));

    expect(
      cfg.targets,
      "a sibling project's targets must not become this project's",
    ).toBeUndefined();
    expect(cfg.host).toBe('logs.canawan.com');
  });

  it('still takes every other connection key', () => {
    expect(effectiveConfig(pair('sentry', { host: 'h', releaseRunnerLabel: 'box' }, {}))).toEqual({
      host: 'h',
      releaseRunnerLabel: 'box',
    });
  });
});

describe('a provider that lets a binding inherit', () => {
  it('still reads coolify targets from the connection', () => {
    const cfg = effectiveConfig(pair('coolify', { baseUrl: 'b', targets: [web] }, {}));

    expect(cfg.targets).toEqual([web]);
  });
});
