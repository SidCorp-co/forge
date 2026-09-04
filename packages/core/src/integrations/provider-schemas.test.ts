// The `agent` release channel is the one provider with no credential and no
// adapter: the production key stays on the runner box and the deploy is the
// project's own script. These pin the two halves that makes true — it can be
// created at all, and it cannot carry a secret.

import { describe, expect, it, vi } from 'vitest';

// cm:why the schemas are pure but `provider-schemas` reaches `route-helpers` for the vault assertion, which pulls the db client and with it the whole env contract — hence two mocks for a file that touches neither
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { configSchemaForProvider, createSchema, splitProviderConfig } = await import(
  './provider-schemas.js'
);

const AGENT = {
  provider: 'agent' as const,
  config: {
    releaseRunnerLabel: 'epod-prod',
    verify: { probes: [{ url: 'https://admin.example.test/api/health', commitPath: 'commit' }] },
    rollback: 'docker compose up -d at the previous image tag',
  },
};

describe('the agent release channel', () => {
  // cm:guard the REST create path validates through this union, so a provider missing from it cannot be created at all — `provider` being a text column only means no migration is needed, not that any string works
  it('can be created, which is what makes the column value reachable', () => {
    const parsed = createSchema.parse(AGENT);
    expect(parsed.provider).toBe('agent');
    expect(parsed.environment).toBe('prod');
  });

  // cm:guard a deploy key stored here would put every project's production behind one decryption path — the blast radius the design refuses under "Not doing"
  it('refuses to carry a secret', () => {
    expect(() => createSchema.parse({ ...AGENT, secrets: { sshKey: 'hunter2' } })).toThrow();
  });

  it('refuses a probe that is not a real URL, so verification cannot be silently unreachable', () => {
    expect(() =>
      createSchema.parse({
        ...AGENT,
        config: { verify: { probes: [{ url: 'admin.example.test/health' }] } },
      }),
    ).toThrow();
  });

  it('accepts a channel that declares nothing but itself', () => {
    expect(createSchema.parse({ provider: 'agent', config: {} }).provider).toBe('agent');
  });
});

describe('the release channel on a coolify production binding', () => {
  // cm:guard this is the PATCH that returned 200 on sidpeak's prod binding on 2026-09-03 and changed nothing: zod drops unknown keys, so a schema without the field turns "declare the release runner" into a silent no-op the roster then reports as undeclared
  it('keeps releaseRunnerLabel, verify and rollback through a partial PATCH, on the binding tier', () => {
    const patch = {
      releaseRunnerLabel: 'release',
      verify: { probes: [{ url: 'https://hrm.example.test/api/health' }] },
      rollback: 'redeploy the previous Coolify deployment',
    };
    const parsed = configSchemaForProvider('coolify').parse(patch) as Record<string, unknown>;
    const tiers = splitProviderConfig('coolify', parsed);
    expect(tiers.binding).toEqual(patch);
    expect(tiers.connection).toEqual({});
  });

  it('still leaves baseUrl with the credential', () => {
    const tiers = splitProviderConfig('coolify', {
      baseUrl: 'https://coolify.example.test',
      releaseRunnerLabel: 'release',
    });
    expect(tiers.connection).toEqual({ baseUrl: 'https://coolify.example.test' });
    expect(tiers.binding).toEqual({ releaseRunnerLabel: 'release' });
  });
});

describe('the release channel on every provider that can be the production binding', () => {
  // cm:guard `resolveReleaseChannel` reads the oldest ACTIVE prod binding whatever its provider, so the three keys are generic and every schema owes them. Pixelight's epodsystem binding is the case that proved it: base===production hid the gap until 2026-09-04, and behind it the label PATCH was a 200 that stripped the field, leaving a storefront project no way to declare a release runner at all.
  const patch = {
    releaseRunnerLabel: 'release',
    verify: { probes: [{ url: 'https://store.example.test/api/health' }] },
    rollback: 'promote the previous theme revision',
  };

  for (const provider of ['coolify', 'postman', 'epodsystem', 'sentry', 'rocketchat', 'agent']) {
    it(`survives a partial PATCH on ${provider}, on the binding tier`, () => {
      const parsed = configSchemaForProvider(provider).parse(patch) as Record<string, unknown>;
      expect(parsed).toEqual(patch);
      expect(splitProviderConfig(provider, parsed).binding).toEqual(patch);
    });
  }

  // cm:guard the `agent` branch of the dispatch, absent until 2026-09-04: without it an agent binding fell through to `coolifyConfigSchema.partial()`, which happens to carry the same three keys — so the bug was invisible on the release path and showed only as a channel accepting a deploy target it has no adapter for.
  it('does not let an agent binding accept coolify deploy targets', () => {
    const parsed = configSchemaForProvider('agent').parse({
      ...patch,
      baseUrl: 'https://coolify.example.test',
      targets: [{ label: 'api', resourceUuid: 'abc' }],
    }) as Record<string, unknown>;
    expect(parsed.baseUrl).toBeUndefined();
    expect(parsed.targets).toBeUndefined();
  });
});
