// The `agent` release channel is the one provider with no credential and no
// adapter: the production key stays on the runner box and the deploy is the
// project's own script. These pin the two halves that makes true — it can be
// created at all, and it cannot carry a secret.

import { describe, expect, it, vi } from 'vitest';

// `provider-schemas` reaches `route-helpers` for the vault assertion, which
// pulls the db client and therefore the whole env contract. The schemas
// themselves are pure.
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { createSchema } = await import('./provider-schemas.js');

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
