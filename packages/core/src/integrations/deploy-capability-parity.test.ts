import { DEPLOY_CAPABLE_PROVIDERS as CONTRACT_LIST } from '@forge/contracts/deploy-capability';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
  },
}));

const { registerAllIntegrations } = await import('./register-all.js');
const { deployCapableProviders, providerCanDeploy } = await import('./registry.js');

beforeAll(() => {
  registerAllIntegrations();
});

describe('the deploy capability is the same list on both sides of the package boundary', () => {
  it('holds the same providers, in the same order', () => {
    expect([...deployCapableProviders()]).toEqual([...CONTRACT_LIST]);
  });

  it('answers the same way for a provider on the list and one off it', () => {
    for (const provider of deployCapableProviders()) {
      expect(providerCanDeploy(provider), provider).toBe(true);
      expect((CONTRACT_LIST as readonly string[]).includes(provider), provider).toBe(true);
    }
    for (const provider of ['sentry', 'rocketchat', 'github', 'postman', 'google']) {
      expect(providerCanDeploy(provider), provider).toBe(false);
      expect((CONTRACT_LIST as readonly string[]).includes(provider), provider).toBe(false);
    }
  });
});
