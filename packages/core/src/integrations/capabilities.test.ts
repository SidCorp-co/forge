import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  __resetRegistry,
  deployCapableProviders,
  directMcpIntegrations,
  providerCanDeploy,
  registerIntegration,
} from './registry.js';
import {
  CORE_MEDIATED_BY_DEFAULT,
  declareIntegration,
  type IntegrationDeclarationInput,
} from './types.js';

const emptySchema = z.object({}).strict();

/** The minimum a declaration must carry, so each fixture below only states what it varies. */
function fixture(
  provider: string,
  capabilities: IntegrationDeclarationInput['capabilities'],
): ReturnType<typeof declareIntegration> {
  return declareIntegration({
    // biome-ignore lint/suspicious/noExplicitAny: a fake provider name outside the real union, on purpose
    provider: provider as any,
    capabilities,
    schemas: {
      connectionConfig: emptySchema,
      bindingConfig: emptySchema,
      patchConfig: emptySchema,
      secrets: emptySchema,
      patchSecrets: emptySchema,
      primaryCredentialField: null,
      previousCredentialField: null,
      independentSecretFields: [],
      bindingConfigKeys: [],
    },
    usage: null,
    presentation: null,
  });
}

beforeEach(() => {
  __resetRegistry();
});

describe('declareIntegration', () => {
  it('defaults a declaration with no agentPath to CORE_MEDIATED_BY_DEFAULT', () => {
    const decl = fixture('fake-a', {
      canDispatch: false,
      canReceiveWebhook: false,
      canDeploy: false,
      liveConfirmGate: false,
      hasDeliveryLog: false,
      multiBinding: false,
      structuredRollback: false,
    });
    expect(decl.capabilities.agentPath).toEqual(CORE_MEDIATED_BY_DEFAULT);
  });

  it('keeps an explicitly declared agentPath rather than overriding it', () => {
    const decl = fixture('fake-b', {
      canDispatch: false,
      canReceiveWebhook: false,
      canDeploy: false,
      liveConfirmGate: false,
      hasDeliveryLog: false,
      multiBinding: false,
      structuredRollback: false,
      agentPath: { kind: 'none' },
    });
    expect(decl.capabilities.agentPath).toEqual({ kind: 'none' });
  });
});

describe('providerCanDeploy / deployCapableProviders', () => {
  it('read the declared canDeploy, not a separate list', () => {
    registerIntegration(
      fixture('fake-deploy', {
        canDispatch: false,
        canReceiveWebhook: false,
        canDeploy: true,
        liveConfirmGate: false,
        hasDeliveryLog: false,
        multiBinding: false,
        structuredRollback: false,
      }),
    );
    registerIntegration(
      fixture('fake-no-deploy', {
        canDispatch: false,
        canReceiveWebhook: false,
        canDeploy: false,
        liveConfirmGate: false,
        hasDeliveryLog: false,
        multiBinding: false,
        structuredRollback: false,
      }),
    );

    expect(providerCanDeploy('fake-deploy')).toBe(true);
    expect(providerCanDeploy('fake-no-deploy')).toBe(false);
    expect(providerCanDeploy('never-registered')).toBe(false);
    expect(deployCapableProviders()).toEqual(['fake-deploy']);
  });
});

describe('directMcpIntegrations', () => {
  it('excludes a provider declaring agentPath.kind === "none"', () => {
    registerIntegration(
      fixture('fake-none', {
        canDispatch: false,
        canReceiveWebhook: false,
        canDeploy: false,
        liveConfirmGate: false,
        hasDeliveryLog: false,
        multiBinding: false,
        structuredRollback: false,
        agentPath: { kind: 'none' },
      }),
    );
    registerIntegration(
      fixture('fake-direct', {
        canDispatch: false,
        canReceiveWebhook: false,
        canDeploy: false,
        liveConfirmGate: false,
        hasDeliveryLog: false,
        multiBinding: false,
        structuredRollback: false,
        agentPath: {
          kind: 'direct-mcp',
          tools: [],
          serverName: 'fake-direct',
          justification: 'fixture only',
          previewSecrets: {},
          buildEntry: () => null,
        },
      }),
    );

    const names = directMcpIntegrations().map((d) => d.provider);
    expect(names).toEqual(['fake-direct']);
    expect(names).not.toContain('fake-none');
  });

  it('also excludes a core-mediated provider (only direct-mcp qualifies)', () => {
    registerIntegration(
      fixture('fake-core-mediated', {
        canDispatch: false,
        canReceiveWebhook: false,
        canDeploy: false,
        liveConfirmGate: false,
        hasDeliveryLog: false,
        multiBinding: false,
        structuredRollback: false,
        agentPath: { kind: 'core-mediated', tools: ['some_tool'] },
      }),
    );
    expect(directMcpIntegrations()).toEqual([]);
  });
});

/**
 * Criteria 3 and 4 are claims about the COMPILER, so their evidence has to be a thing that would
 * compile if the type were loosened — a runtime assertion cannot make either of them.
 *
 * `@ts-expect-error` IS the assertion here, and `pnpm typecheck` (the `core typecheck` gate) is what
 * runs it: `packages/core/tsconfig.json` includes `src/**`, and a directive whose error stops
 * happening becomes an error itself, `Unused '@ts-expect-error' directive`. So widening
 * `IntegrationCapabilities` or making `justification` optional turns this file red without anyone
 * having to remember these two cases exist. Core's vitest has no `typecheck` block, unlike
 * contracts', and this needs no new one.
 *
 * Nothing below runs. It is a type-level fixture and is deliberately never registered: registering
 * a declaration the type rejects is not a thing the tests above could do anyway.
 */
const COMPILE_ONLY = {
  // A declaration that omits a required capability field. `structuredRollback` stands for all of
  // them: `capabilities` is required as a whole, and every field on it is required individually,
  // which is what stops an adapter opting out by leaving one off and reading as inert.
  missingCapabilityField: () =>
    // @ts-expect-error criterion 3 — `structuredRollback` is required; omitting it must not compile
    fixture('fake-missing-field', {
      canDispatch: false,
      canReceiveWebhook: false,
      canDeploy: false,
      liveConfirmGate: false,
      hasDeliveryLog: false,
      multiBinding: false,
      agentPath: { kind: 'none' },
    }),

  // A direct-MCP arm with no written reason for putting a project's credential on a runner box.
  directMcpWithoutJustification: () =>
    fixture('fake-unjustified', {
      canDispatch: false,
      canReceiveWebhook: false,
      canDeploy: false,
      liveConfirmGate: false,
      hasDeliveryLog: false,
      multiBinding: false,
      structuredRollback: false,
      // The two directives sit at different levels ON PURPOSE, and each is where tsc puts the
      // error: a MISSING capability field fails the whole argument, so criterion 3's is on the
      // call; a malformed `agentPath` fails that property against the union, so this one is here.
      // @ts-expect-error criterion 4 — a `direct-mcp` arm without `justification` must not compile
      agentPath: {
        kind: 'direct-mcp',
        tools: [],
        serverName: 'fake-unjustified',
        previewSecrets: {},
        buildEntry: () => null,
      },
    }),
};

// Referenced so it is not dead code. Nothing here is ever CALLED: these two declarations do
// not compile, which is the whole assertion, and calling one would only be a runtime error about
// a fixture the type already refused.
void COMPILE_ONLY;
