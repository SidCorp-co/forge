/**
 * The deploy capability is written twice — once in core, once in `@forge/contracts` — and this
 * test is the only thing that makes the second copy safe.
 *
 * Neither package can hold it for both sides. Core must not import a runtime value from contracts:
 * contracts is absent from core's production image, so such an import compiles green and crashes
 * at boot (`contracts-runtime-boundary.test.ts`). web-v2 must not import one from core: pulling
 * `@forge/core/public` into the browser bundle runs core's env validation at import time, which
 * throws. So the list is mirrored, and drift is caught here rather than by an operator being
 * offered "Deploy target" for a provider the server then refuses.
 *
 * A test-time value import of contracts is explicitly fine — `*.test.ts` never reaches `dist`.
 *
 * ISS-1071 moved the core-side answer off a static `DEPLOY_CAPABLE_PROVIDERS` constant onto the
 * registry: `deployCapableProviders()` derives the list from every declaration's `canDeploy`, so
 * this test registers the real eight before comparing.
 */

import { DEPLOY_CAPABLE_PROVIDERS as CONTRACT_LIST } from '@forge/contracts/deploy-capability';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// cm:why registering the real declarations pulls in every adapter, and coolify's reaches
// db/client.js (and, since ISS-922, queue/boss.js via its confirm enqueue) which parses the
// runtime env at import time — same reason `capabilities.test.ts` stubs both.
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

  // cm:guard the predicate and not only the array: a copy that kept the list and inverted the
  // membership test would pass the case above, and the screen would then refuse `deploy` on
  // exactly the providers that support it.
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
