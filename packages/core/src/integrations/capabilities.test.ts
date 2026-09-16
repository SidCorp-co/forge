import { beforeEach, describe, expect, it } from 'vitest';
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
import { z } from 'zod';

// Contract test for the registry mechanics ISS-1071 introduced: `declareIntegration`'s default,
// and the two registry readers (`providerCanDeploy` / `deployCapableProviders`,
// `directMcpIntegrations`) that answer from the declared capabilities rather than a per-provider
// list. `__resetRegistry()` + locally-declared fixtures keep this independent of the real eight
// providers, whose own agreement with `@forge/contracts` is `deploy-capability-parity.test.ts`'s
// job.

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
        agentPath: {
          kind: 'direct-mcp',
          tools: [],
          serverName: 'fake-direct',
          justification: 'fixture only',
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
        agentPath: { kind: 'core-mediated', tools: ['some_tool'] },
      }),
    );
    expect(directMcpIntegrations()).toEqual([]);
  });
});
