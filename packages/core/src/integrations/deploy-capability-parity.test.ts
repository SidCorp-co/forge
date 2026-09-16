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
 */

import { DEPLOY_CAPABLE_PROVIDERS as CONTRACT_LIST } from '@forge/contracts/deploy-capability';
import { describe, expect, it } from 'vitest';
import { DEPLOY_CAPABLE_PROVIDERS, providerCanDeploy } from './types.js';

describe('the deploy capability is the same list on both sides of the package boundary', () => {
  it('holds the same providers, in the same order', () => {
    expect([...CONTRACT_LIST]).toEqual([...DEPLOY_CAPABLE_PROVIDERS]);
  });

  it('answers the same way for a provider on the list and one off it', () => {
    for (const provider of DEPLOY_CAPABLE_PROVIDERS) {
      expect(providerCanDeploy(provider), provider).toBe(true);
      expect((CONTRACT_LIST as readonly string[]).includes(provider), provider).toBe(true);
    }
    for (const provider of ['sentry', 'rocketchat', 'github', 'postman', 'google']) {
      expect(providerCanDeploy(provider), provider).toBe(false);
      expect((CONTRACT_LIST as readonly string[]).includes(provider), provider).toBe(false);
    }
  });
});
