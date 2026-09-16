import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
  },
}));

const { coolifyAdapter } = await import('./coolify/adapter.js');
const { epodsystemAdapter } = await import('./epodsystem/adapter.js');
const { postmanAdapter } = await import('./postman/adapter.js');
const { DEFAULT_CAPABILITIES, capabilitiesFor, providerCanDeploy } = await import('./types.js');
type IntegrationAdapter = import('./types.js').IntegrationAdapter;
type IntegrationCapabilities = import('./types.js').IntegrationCapabilities;

// Contract test for the connection/binding capabilities layer. Guards the two
// provider archetypes (deploy-2way vs MCP-injection) so a future adapter edit
// can't silently flip an archetype flag and break the adaptive UI, and ensures
// every shipped adapter declares the full surface it implements.

const ARCHETYPES: Record<string, { adapter: IntegrationAdapter; caps: IntegrationCapabilities }> = {
  coolify: {
    adapter: coolifyAdapter as IntegrationAdapter,
    caps: {
      canDispatch: true,
      canReceiveWebhook: false,
      injectsMcp: false,
      canDeploy: true,
      liveConfirmGate: true,
      hasDeliveryLog: true,
    },
  },
  postman: {
    adapter: postmanAdapter as IntegrationAdapter,
    caps: {
      canDispatch: false,
      canReceiveWebhook: false,
      injectsMcp: true,
      canDeploy: false,
      liveConfirmGate: false,
      hasDeliveryLog: false,
    },
  },
  epodsystem: {
    adapter: epodsystemAdapter as IntegrationAdapter,
    caps: {
      canDispatch: false,
      canReceiveWebhook: false,
      injectsMcp: true,
      // A storefront IS somewhere Forge deploys to: its preview is the draft
      // theme and its live is the published one, which is why three fleet
      // storefronts carry one binding on both stages. The old `hasEnvironments`
      // said `false` here for the different question of a staging/prod split.
      canDeploy: true,
      liveConfirmGate: false,
      hasDeliveryLog: false,
    },
  },
};

describe('integration adapter capabilities', () => {
  for (const [provider, { adapter, caps }] of Object.entries(ARCHETYPES)) {
    it(`${provider} declares the expected archetype + a healthcheck`, () => {
      expect(adapter.provider).toBe(provider);
      expect(typeof adapter.healthcheck).toBe('function');
      expect(adapter.capabilities).toEqual(caps);
    });

    it(`${provider}: dispatch capability matches implemented dispatch surface`, () => {
      const c = capabilitiesFor(adapter);
      // An MCP-injection provider must not claim dispatch/webhook/delivery-log.
      if (c.injectsMcp && !c.canDispatch) {
        expect(c.canReceiveWebhook).toBe(false);
        expect(c.hasDeliveryLog).toBe(false);
      }
      if (c.hasDeliveryLog) {
        expect(c.canDispatch || c.canReceiveWebhook).toBe(true);
      }
      // A live confirm gate only makes sense where Forge can deploy at all.
      if (c.liveConfirmGate) {
        expect(c.canDeploy).toBe(true);
      }
      // cm:guard the capability and the create schema must agree. The UI offers
      // `role: 'deploy'` on the strength of `canDeploy`; `createSchema` refuses it
      // on the strength of `providerCanDeploy`. Two answers to one question is an
      // affordance defect — the operator fills in a form the server then rejects.
      expect(c.canDeploy).toBe(providerCanDeploy(provider));
    });
  }

  it('capabilitiesFor falls back to the conservative default', () => {
    expect(capabilitiesFor(undefined)).toEqual(DEFAULT_CAPABILITIES);
    expect(
      capabilitiesFor({ capabilities: undefined } as unknown as Parameters<
        typeof capabilitiesFor
      >[0]),
    ).toEqual(DEFAULT_CAPABILITIES);
    expect(
      capabilitiesFor({ capabilities: { canDispatch: true } as IntegrationCapabilities }),
    ).toEqual({ ...DEFAULT_CAPABILITIES, canDispatch: true });
  });
});
