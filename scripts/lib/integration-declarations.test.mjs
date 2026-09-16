import { describe, expect, it } from 'vitest';
import { declarationFaults, unusableReport } from './integration-declarations.mjs';

/** The projection the tsx probe prints for a declaration that answers everything. */
function sound(overrides = {}) {
  return {
    provider: 'coolify',
    capabilities: {
      types: {
        canDispatch: 'boolean',
        canReceiveWebhook: 'boolean',
        canDeploy: 'boolean',
        liveConfirmGate: 'boolean',
        hasDeliveryLog: 'boolean',
        multiBinding: 'boolean',
      },
      canDeploy: true,
      agentPath: { present: true, kind: 'core-mediated', toolsType: 'array' },
    },
    schemas: {
      present: true,
      declaredKeys: [
        'connectionConfig',
        'bindingConfig',
        'patchConfig',
        'secrets',
        'patchSecrets',
        'primaryCredentialField',
        'previousCredentialField',
        'bindingConfigKeys',
      ],
      types: {
        connectionConfig: 'object',
        bindingConfig: 'object',
        patchConfig: 'object',
        secrets: 'object',
        patchSecrets: 'object',
        primaryCredentialField: 'string',
        previousCredentialField: 'null',
        bindingConfigKeys: 'array',
      },
    },
    ...overrides,
  };
}

const directMcp = (path = {}) =>
  sound({
    provider: 'epodsystem',
    capabilities: {
      ...sound().capabilities,
      agentPath: {
        present: true,
        kind: 'direct-mcp',
        toolsType: 'array',
        serverName: 'epodsystem',
        justification: 'the storefront GraphQL surface has no core-mediated equivalent',
        buildEntryType: 'function',
        ...path,
      },
    },
  });

const judge = (decl, contract = { coolify: true, epodsystem: true }) =>
  declarationFaults({ providers: [decl], contractCanDeploy: contract });

const reasons = (decl, contract) => judge(decl, contract).flatMap((f) => f.reasons);

describe('declarationFaults — a declaration that answers everything', () => {
  it('reports nothing for a core-mediated provider', () => {
    expect(judge(sound())).toEqual([]);
  });

  it('reports nothing for a direct-mcp provider that carries its whole arm', () => {
    expect(judge(directMcp())).toEqual([]);
  });
});

describe('declarationFaults — the provider name', () => {
  it('faults a declaration whose provider is an empty string', () => {
    expect(reasons(sound({ provider: '' }))).toContainEqual(expect.stringContaining('provider'));
  });

  it('names the fault against a placeholder rather than dropping it, when there is no name', () => {
    expect(judge(sound({ provider: undefined }))[0].provider).toBe('(unnamed declaration)');
  });
});

describe('declarationFaults — capabilities', () => {
  // The defect this whole checker was written from: until ISS-1071 the capabilities object was
  // optional behind an all-false fallback, so a declaration that said nothing read as inert to
  // every generic path and said so nowhere.
  it('faults a declaration carrying no capabilities object at all', () => {
    expect(reasons(sound({ capabilities: undefined }))).toEqual([
      'declares no `capabilities` object',
    ]);
  });

  it('names each missing boolean by its own field', () => {
    const caps = sound().capabilities;
    caps.types = { ...caps.types, canReceiveWebhook: 'undefined' };
    expect(reasons(sound({ capabilities: caps }))).toContain(
      'capabilities.canReceiveWebhook is missing',
    );
  });

  it('faults a boolean that is present but is a string', () => {
    const caps = sound().capabilities;
    caps.types = { ...caps.types, multiBinding: 'string' };
    expect(reasons(sound({ capabilities: caps }))).toContain(
      'capabilities.multiBinding is a string, not a boolean',
    );
  });

  it('faults a missing agentPath', () => {
    const caps = { ...sound().capabilities, agentPath: { present: false } };
    expect(reasons(sound({ capabilities: caps }))).toContain('capabilities.agentPath is missing');
  });

  it('faults an agentPath kind outside the three the type admits', () => {
    const caps = {
      ...sound().capabilities,
      agentPath: { present: true, kind: 'mcp', toolsType: 'array' },
    };
    expect(reasons(sound({ capabilities: caps }))[0]).toContain(
      'none | core-mediated | direct-mcp',
    );
  });

  it('asks a `none` arm for no tools, because there is nothing to call', () => {
    const caps = { ...sound().capabilities, agentPath: { present: true, kind: 'none' } };
    expect(judge(sound({ capabilities: caps }))).toEqual([]);
  });

  it('faults a core-mediated arm that carries no tools array', () => {
    const caps = {
      ...sound().capabilities,
      agentPath: { present: true, kind: 'core-mediated', toolsType: 'undefined' },
    };
    expect(reasons(sound({ capabilities: caps }))[0]).toContain('not an array');
  });
});

describe('declarationFaults — ISS-1071 rule 2, the direct-mcp justification', () => {
  // A direct-mcp arm renders the project's credential into a runner box's MCP config and puts
  // Forge outside the call path. `justification` is the only place that decision is written
  // down, so an empty one fails NAMING the provider — the reader who has to act on this is
  // deciding whether the provider should take that route at all.
  it('faults a direct-mcp arm whose justification is missing', () => {
    const faults = judge(directMcp({ justification: undefined }));
    expect(faults[0].provider).toBe('epodsystem');
    expect(faults[0].reasons.join(' ')).toContain('justification');
  });

  it('faults a direct-mcp arm whose justification is an empty string', () => {
    expect(reasons(directMcp({ justification: '' })).join(' ')).toContain('justification');
  });

  it('faults a direct-mcp arm whose justification is only whitespace', () => {
    expect(reasons(directMcp({ justification: '  \n ' })).join(' ')).toContain('justification');
  });

  it('says what the way out is, so the refusal is actionable rather than only correct', () => {
    expect(reasons(directMcp({ justification: '' })).join(' ')).toContain('core-mediated');
  });

  it('asks a core-mediated arm for no justification at all', () => {
    expect(judge(sound())).toEqual([]);
  });

  it('faults a direct-mcp arm with no serverName', () => {
    expect(reasons(directMcp({ serverName: '' })).join(' ')).toContain('serverName');
  });

  it('faults a direct-mcp arm whose buildEntry is not a function', () => {
    expect(reasons(directMcp({ buildEntryType: 'undefined' })).join(' ')).toContain('buildEntry');
  });
});

describe('declarationFaults — schemas', () => {
  it('faults a declaration carrying no schemas object', () => {
    expect(reasons(sound({ schemas: { present: false } }))).toEqual([
      'declares no `schemas` object',
    ]);
  });

  it('names a schema key that is not a zod object', () => {
    const schemas = sound().schemas;
    schemas.types = { ...schemas.types, patchSecrets: 'undefined' };
    expect(reasons(sound({ schemas }))).toContain(
      'schemas.patchSecrets is undefined, not a zod schema',
    );
  });

  it('faults bindingConfigKeys that is not an array', () => {
    const schemas = sound().schemas;
    schemas.types = { ...schemas.types, bindingConfigKeys: 'string' };
    expect(reasons(sound({ schemas }))).toContain(
      'schemas.bindingConfigKeys is string, not an array',
    );
  });

  // Null is a legal answer and `undefined` is a provider that never answered. `rotation.ts`
  // reads this field instead of its own per-provider table, so the difference is a rotation
  // that correctly does nothing against one that silently skips a provider that has a credential.
  it('accepts an explicit null primary credential field', () => {
    const schemas = sound().schemas;
    schemas.types = { ...schemas.types, primaryCredentialField: 'null' };
    expect(judge(sound({ schemas }))).toEqual([]);
  });

  // A key that was never written and one written as the wrong type are two different mistakes,
  // and the author has to be told which: "not declared" sends them to add `: null`, while "is a
  // number" sends them to fix a value they already thought about.
  it('tells an author who never declared the field so, rather than naming its type', () => {
    const schemas = sound().schemas;
    schemas.declaredKeys = schemas.declaredKeys.filter((k) => k !== 'primaryCredentialField');
    schemas.types = { ...schemas.types, primaryCredentialField: undefined };
    expect(reasons(sound({ schemas }))).toEqual([
      'schemas.primaryCredentialField is not declared — null is the answer for "there is none"',
    ]);
  });

  it('faults a previous credential field of the wrong type', () => {
    const schemas = sound().schemas;
    schemas.types = { ...schemas.types, previousCredentialField: 'number' };
    expect(reasons(sound({ schemas }))).toContain(
      'schemas.previousCredentialField is a number, not a string or null',
    );
  });
});

describe('declarationFaults — canDeploy across the package boundary', () => {
  // The comparison is against `@forge/contracts/deploy-capability` and NOT against core's own
  // `providerCanDeploy`, which reads this very field: asking core would be a tautology, and a
  // test that cannot fail has not been written. The contracts copy is the only one that can
  // disagree, and disagreement is a screen offering a deploy role the server then refuses.
  it('reports nothing when both copies say the provider can deploy', () => {
    expect(judge(sound(), { coolify: true })).toEqual([]);
  });

  it('faults a provider the declaration deploys and the contracts list does not', () => {
    expect(reasons(sound(), { coolify: false }).join(' ')).toContain('deploy-capability');
  });

  it('faults a provider the contracts list deploys and the declaration does not', () => {
    const caps = { ...sound().capabilities, canDeploy: false };
    expect(reasons(sound({ capabilities: caps }), { coolify: true }).join(' ')).toContain(
      'canDeploy is false',
    );
  });

  it('treats a provider absent from the contracts list as one that cannot deploy', () => {
    expect(reasons(sound(), {}).join(' ')).toContain('says false');
  });

  it('makes no deploy claim when canDeploy is not a boolean — the missing field is the fault', () => {
    const caps = sound().capabilities;
    caps.types = { ...caps.types, canDeploy: 'undefined' };
    caps.canDeploy = undefined;
    expect(reasons(sound({ capabilities: caps }), {})).toEqual([
      'capabilities.canDeploy is missing',
    ]);
  });
});

describe('declarationFaults — reporting', () => {
  it('reports every faulty provider rather than the first', () => {
    const faults = declarationFaults({
      providers: [sound({ capabilities: undefined }), directMcp({ justification: '' })],
      contractCanDeploy: { coolify: true, epodsystem: true },
    });
    expect(faults.map((f) => f.provider)).toEqual(['coolify', 'epodsystem']);
  });

  it('collects every reason for one provider rather than the first', () => {
    const schemas = sound().schemas;
    schemas.types = { ...schemas.types, secrets: 'undefined', patchConfig: 'undefined' };
    expect(reasons(sound({ schemas })).length).toBeGreaterThan(1);
  });
});

describe('unusableReport', () => {
  it('passes a report with providers and a contract list', () => {
    expect(
      unusableReport({ providers: [sound()], contractCanDeploy: { coolify: true } }),
    ).toBeNull();
  });

  // `registerAllIntegrations` is one dropped import away from being a no-op, and "no provider
  // is missing a field" is exactly what an empty map reports. Measured while building this
  // checker: a probe that resolved a SECOND instance of registry.ts read zero declarations from
  // a registry holding eight, and this is the sentence that separated the two.
  it('refuses a registry that registered nothing', () => {
    expect(unusableReport({ providers: [], contractCanDeploy: { coolify: true } })).toContain(
      'registered nothing',
    );
  });

  it('refuses a report with no providers array at all', () => {
    expect(unusableReport({})).toContain('providers');
  });

  it('refuses a report whose contract list is empty, since canDeploy could not be compared', () => {
    expect(unusableReport({ providers: [sound()], contractCanDeploy: {} })).toContain(
      'deploy-capability',
    );
  });
});
