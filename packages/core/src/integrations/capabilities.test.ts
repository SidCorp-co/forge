import { describe, expect, it, vi } from 'vitest';

// cm:why the coolify adapter's import path reaches db/client.js and, since ISS-922 put the deploy-confirmation enqueue on it, queue/boss.js — both parse the runtime env at import time, so a pure-capabilities test still needs the env stubbed.
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
const { DEFAULT_CAPABILITIES, capabilitiesFor } = await import('./types.js');
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
      hasEnvironments: true,
      prodConfirmGate: true,
      hasDeliveryLog: true,
    },
  },
  postman: {
    adapter: postmanAdapter as IntegrationAdapter,
    caps: {
      canDispatch: false,
      canReceiveWebhook: false,
      injectsMcp: true,
      hasEnvironments: false,
      prodConfirmGate: false,
      hasDeliveryLog: false,
    },
  },
  epodsystem: {
    adapter: epodsystemAdapter as IntegrationAdapter,
    caps: {
      canDispatch: false,
      canReceiveWebhook: false,
      injectsMcp: true,
      hasEnvironments: false,
      prodConfirmGate: false,
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
      // cm:guard the OR is load-bearing and coolify is the shape that proves it — since ISS-922 it receives nothing and still keeps its delivery log on the strength of dispatch alone, so narrowing this to canReceiveWebhook would delete an audit trail.
      if (c.hasDeliveryLog) {
        expect(c.canDispatch || c.canReceiveWebhook).toBe(true);
      }
      // A prod confirm gate only makes sense with an environment split.
      if (c.prodConfirmGate) {
        expect(c.hasEnvironments).toBe(true);
      }
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
