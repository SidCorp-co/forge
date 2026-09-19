import { beforeEach, describe, expect, it } from 'vitest';
import { registerAllIntegrations } from './register-all.js';
import {
  __resetRegistry,
  deployCapableProviders,
  directMcpIntegrations,
  dispatchThrough,
  getAdapter,
  getIntegration,
  isRegistered,
  listIntegrations,
  mcpServerNameFor,
  providerCanDeploy,
  providerImplementsDispatch,
  providerNames,
  registerIntegration,
} from './registry.js';
import { INTEGRATION_PROVIDERS, type IntegrationDeclaration } from './types.js';

beforeEach(() => {
  __resetRegistry();
  registerAllIntegrations();
});

describe('the registry IS the provider vocabulary', () => {
  it('holds exactly the providers the type union names', () => {
    expect([...providerNames()].sort()).toEqual([...INTEGRATION_PROVIDERS].sort());
  });

  it('answers every declared provider, and nothing else', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(getIntegration(provider), provider).toBeDefined();
    }
    expect(getIntegration('not-a-provider')).toBeUndefined();
  });

  it('refuses a second declaration of the same provider rather than replacing it', () => {
    // Last-write-wins would make the vocabulary depend on import order, which is exactly the class
    // of bug this registry exists to remove.
    const existing = getIntegration('coolify') as IntegrationDeclaration;
    expect(() => registerIntegration(existing)).toThrow(/already declared/);
  });

  it('is idempotent to register, so a test and the app can both call it', () => {
    const before = providerNames().length;
    registerAllIntegrations();
    expect(providerNames()).toHaveLength(before);
  });
});

describe('reading an EMPTY registry is a named failure, not an empty answer', () => {
  // The whole point: `[]` and `undefined` are answers a caller acts on. A process that never
  // registered would refuse every provider in the product while blaming the provider.
  beforeEach(() => {
    __resetRegistry();
  });

  it('throws from every derived read, naming the cause', () => {
    for (const read of [
      () => providerNames(),
      () => listIntegrations(),
      () => getIntegration('coolify'),
      () => getAdapter('coolify'),
      () => deployCapableProviders(),
      () => directMcpIntegrations(),
    ]) {
      expect(read).toThrow(/registerAllIntegrations\(\) was never called/);
    }
  });

  it('leaves `isRegistered` answering, because the registrar asks it while filling', () => {
    expect(isRegistered('coolify')).toBe(false);
  });
});

describe('derived questions, asked instead of naming a provider', () => {
  it('deployCapableProviders is derived from the declarations, not listed', () => {
    const derived = deployCapableProviders();
    expect(derived.length).toBeGreaterThan(0);
    for (const provider of providerNames()) {
      expect(providerCanDeploy(provider), provider).toBe(derived.includes(provider));
    }
  });

  it('providerCanDeploy answers false for a provider nobody declared', () => {
    // Not a throw: an unknown provider IS a legitimate question from a caller holding a string,
    // and `false` is the safe answer. Only an unpopulated registry is a fault.
    expect(providerCanDeploy('not-a-provider')).toBe(false);
  });

  it('getAdapter answers undefined for a declaration with no methods', () => {
    // `agent` has schemas and an agent path and nothing to call. Answering with an object that has
    // no methods is the affordance defect; `undefined` is what every caller already guards.
    expect(getIntegration('agent')).toBeDefined();
    expect(getAdapter('agent')).toBeUndefined();
  });

  it('directMcpIntegrations holds only providers whose credential reaches a runner', () => {
    const direct = directMcpIntegrations();
    expect(direct.length).toBeGreaterThan(0);
    for (const decl of direct) {
      expect(decl.capabilities.agentPath.kind).toBe('direct-mcp');
    }
    for (const decl of listIntegrations()) {
      if (decl.capabilities.agentPath.kind === 'direct-mcp') continue;
      expect(direct).not.toContain(decl);
    }
  });
});

describe('dispatchThrough — the one place an unimplemented dispatch is refused', () => {
  const ctx = () => ({}) as unknown as Parameters<typeof dispatchThrough>[1];
  const input = () => ({}) as unknown as Parameters<typeof dispatchThrough>[2];

  it('refuses a provider that implements none, naming it and what it declares', async () => {
    expect(providerImplementsDispatch('google')).toBe(false);
    await expect(dispatchThrough('google', ctx(), input())).rejects.toThrow(
      /google implements no outbound dispatch.*canDispatch: false/s,
    );
  });

  // ISS-1085 split this refusal from the one above, because the two are different mistakes and the
  // caller acts on each differently. A provider that exists and cannot dispatch is told what it
  // declares; a name that is not a provider at all is told the set that IS one — which it has to
  // be, now that the callers most needing this door read the name off `integration_bindings.provider`,
  // a `text` column the type system cannot vouch for.
  it('refuses a name no declaration carries, naming the set that is declared', async () => {
    const err = await dispatchThrough('not-a-provider', ctx(), input()).then(
      () => new Error('dispatchThrough resolved for a name no declaration carries'),
      (e: Error) => e,
    );
    expect(err.message).toMatch(/^not-a-provider is not a provider this deployment declares/);
    for (const decl of listIntegrations()) {
      expect(err.message, decl.provider).toContain(decl.provider);
    }
    // Not the OTHER refusal: this name declares nothing, so it declares no `canDispatch` either.
    expect(err.message).not.toMatch(/implements no outbound dispatch/);
  });

  it('reports dispatch as implemented exactly where the adapter carries the method', () => {
    for (const decl of listIntegrations()) {
      expect(providerImplementsDispatch(decl.provider), decl.provider).toBe(
        typeof decl.adapter?.dispatchOutbound === 'function',
      );
    }
  });
});

describe('mcpServerNameFor — the one place the label suffix rule lives', () => {
  // It was written out four times before ISS-1071 (the epodsystem resolver's `labelToMcpSuffix`, its
  // `startsWith('epodsystem_')` gate, `isIntegrationSentinelName`'s prefix test, and an inline
  // `replace(/-/g,'_')` in the preview service) and every copy named epodsystem.
  const multi = () => directMcpIntegrations().find((d) => d.capabilities.multiBinding);
  const single = () => directMcpIntegrations().find((d) => !d.capabilities.multiBinding);

  it('suffixes a labelled binding of a multi-binding provider, dashes to underscores', () => {
    const decl = multi();
    expect(decl).toBeDefined();
    if (!decl) return;
    const base = mcpServerNameFor(decl, '');
    expect(mcpServerNameFor(decl, 'store-a')).toBe(`${base}_store_a`);
    expect(mcpServerNameFor(decl, 'partner-abc')).toBe(`${base}_partner_abc`);
  });

  it('gives the bare name for the unlabelled binding', () => {
    const decl = multi();
    if (!decl) return;
    expect(mcpServerNameFor(decl, '')).not.toContain('_');
  });

  it('ignores a label on a provider that cannot have one', () => {
    // The column exists on every binding; only a `multiBinding` provider can use it. A stray label
    // must not invent a server name nothing resolves.
    const decl = single();
    expect(decl).toBeDefined();
    if (!decl) return;
    expect(mcpServerNameFor(decl, 'stray')).toBe(mcpServerNameFor(decl, ''));
  });

  it('answers null for a provider that renders no server at all', () => {
    const decl = listIntegrations().find((d) => d.capabilities.agentPath.kind !== 'direct-mcp');
    expect(decl).toBeDefined();
    if (!decl) return;
    expect(mcpServerNameFor(decl, '')).toBeNull();
    expect(mcpServerNameFor(decl, 'label')).toBeNull();
  });
});
