/**
 * The status cards, whose KEY is how a screen addresses one binding rather than another.
 *
 * Under the retired model a duplicate key was unreachable: a binding served exactly one
 * environment, and one project could not have two `prod` Coolify bindings. ISS-1046 makes two
 * live deploy bindings legal, and a card set with two identical keys is one React renders once
 * — every drill-in, test and delete then reaches whichever row the list happened to hold first,
 * silently. Nothing tested any of this: `buildIntegrationsStatusCards` appeared in exactly two
 * files before this one, both of them source.
 */

import { describe, expect, it, vi } from 'vitest';

// `status-service.ts` reaches the db client transitively, which validates the environment at
// import. The card builder is pure; only the module graph needs a stand-in.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { buildProviderCards } = await import('./status-service.js');

// The registry is process-global and empty until something fills it. Reading it empty THROWS
// (registry.ts:assertPopulated), so a test reaching any registry-backed path registers here rather
// than inheriting a vocabulary from whichever test file happened to run first.
const { registerAllIntegrations } = await import('./register-all.js');
registerAllIntegrations();

function row(over: Partial<Parameters<typeof buildProviderCards>[0]['rows'][number]> = {}) {
  return {
    id: 'b1',
    provider: 'coolify',
    role: 'deploy',
    stages: ['live'],
    config: {},
    active: true,
    lastHealthStatus: 'ok',
    lastHealthAt: null,
    breakerOpenedAt: null,
    ...over,
  };
}

function cards(rows: ReturnType<typeof row>[], alwaysEnvKeyed = true) {
  return buildProviderCards({
    rows,
    provider: 'coolify',
    label: 'Coolify',
    alwaysEnvKeyed,
    neverCheckedDetail: 'never checked',
  });
}

describe('a status card names one binding and no other', () => {
  it('keys a preview and a live binding apart by stage, as it always has', () => {
    const keys = cards([
      row({ id: 'b1', stages: ['preview'] }),
      row({ id: 'b2', stages: ['live'] }),
    ]).map((c) => c.key);
    expect(keys).toEqual(['coolify:preview', 'coolify:live']);
  });

  // cm:guard the defect this file exists for. Two bindings serving the SAME stage collide on the
  // stage-keyed spelling, and the card set then has two members the screen cannot tell apart.
  it('keys two same-stage bindings apart rather than minting the same key twice', () => {
    const keys = cards([row({ id: 'b1' }), row({ id: 'b2' })]).map((c) => c.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(['coolify:live:b1', 'coolify:live:b2']);
  });

  it('leaves a unique key alone, because drill-ins are bookmarked on that spelling', () => {
    expect(cards([row({ id: 'b1' })]).map((c) => c.key)).toEqual(['coolify:live']);
  });

  it('carries the binding id in meta on every configured card', () => {
    const set = cards([row({ id: 'b1', stages: ['preview'] }), row({ id: 'b2' })]);
    expect(set.map((c) => c.meta?.bindingId)).toEqual(['b1', 'b2']);
  });

  it('keys a service binding apart from a deploy one on the same provider', () => {
    const keys = cards([
      row({ id: 'b1', role: 'service', stages: [] }),
      row({ id: 'b2', stages: ['live'] }),
    ]).map((c) => c.key);
    expect(keys).toEqual(['coolify:service', 'coolify:live']);
  });

  it('answers a single not-configured card when the project has no binding', () => {
    const set = cards([]);
    expect(set).toHaveLength(1);
    expect(set[0]?.configured).toBe(false);
    expect(set[0]?.key).toBe('coolify');
  });
});
