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
      rollback: { mode: 'coolify-image' },
    };
    const parsed = configSchemaForProvider('coolify').parse(patch) as Record<string, unknown>;
    const tiers = splitProviderConfig('coolify', parsed);
    expect(tiers.binding).toEqual(patch);
    expect(tiers.connection).toEqual({});
  });

  // cm:guard the three github keys travel TOGETHER or the binding is useless: adapter.ts reads owner, repo and installationId in one destructure, so a split that keeps two of them produces a binding that names a repository it cannot mint a token for — a bind that succeeds and a healthcheck that never can
  it('keeps all three github keys on the binding, installationId included', () => {
    const cfg = { installationId: 159473037, owner: 'SidCorp-co', repo: 'forge' };
    const parsed = configSchemaForProvider('github').parse(cfg) as Record<string, unknown>;
    const tiers = splitProviderConfig('github', parsed);
    expect(tiers.binding).toEqual(cfg);
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

describe('the rollback declaration', () => {
  it('refuses free text on a coolify binding, naming the action that replaces it', () => {
    const res = configSchemaForProvider('coolify').safeParse({
      rollback: 'redeploy the previous Coolify deployment',
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain('coolify-image');
  });

  it('accepts the coolify rollback action', () => {
    const parsed = configSchemaForProvider('coolify').parse({
      rollback: { mode: 'coolify-image' },
    }) as Record<string, unknown>;
    expect(parsed.rollback).toEqual({ mode: 'coolify-image' });
  });

  it('refuses a mode nothing implements rather than storing it', () => {
    expect(
      configSchemaForProvider('coolify').safeParse({ rollback: { mode: 'whatever' } }).success,
    ).toBe(false);
  });

  // cm:guard prose stays legal for the channels whose API cannot express a rollback — that is the whole reason the field survives ISS-925, and collapsing every provider onto the coolify shape would leave an epodsystem or agent release with no way to say anything at all.
  it('keeps free text for a channel whose API cannot roll anything back', () => {
    for (const provider of ['epodsystem', 'agent', 'postman', 'sentry', 'rocketchat']) {
      const parsed = configSchemaForProvider(provider).parse({
        rollback: 'promote the previous theme revision',
      }) as Record<string, unknown>;
      expect(parsed.rollback).toBe('promote the previous theme revision');
    }
  });
});

describe('the release channel on every provider that can be the production binding', () => {
  // cm:guard `resolveReleaseChannel` reads the oldest ACTIVE prod binding whatever its provider, so the three keys are generic and every schema owes them. Pixelight's epodsystem binding is the case that proved it: base===production hid the gap until 2026-09-04, and behind it the label PATCH was a 200 that stripped the field, leaving a storefront project no way to declare a release runner at all.
  const patch = {
    releaseRunnerLabel: 'release',
    verify: { probes: [{ url: 'https://store.example.test/api/health' }] },
    rollback: 'promote the previous theme revision',
  };

  // cm:guard coolify is deliberately absent from this loop: ISS-925 made `rollback` the one key whose TYPE differs by provider, and the loop's prose value is exactly what a coolify binding now refuses. Adding it back green would mean the refusal had been undone.
  for (const provider of ['postman', 'epodsystem', 'sentry', 'rocketchat', 'agent']) {
    it(`survives a partial PATCH on ${provider}, on the binding tier`, () => {
      const parsed = configSchemaForProvider(provider).parse(patch) as Record<string, unknown>;
      expect(parsed).toEqual(patch);
      expect(splitProviderConfig(provider, parsed).binding).toEqual(patch);
    });
  }

  it('survives a partial PATCH on coolify, with the rollback ACTION in place of prose', () => {
    const coolifyPatch = { ...patch, rollback: { mode: 'coolify-image' } };
    const parsed = configSchemaForProvider('coolify').parse(coolifyPatch) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual(coolifyPatch);
    expect(splitProviderConfig('coolify', parsed).binding).toEqual(coolifyPatch);
  });

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
