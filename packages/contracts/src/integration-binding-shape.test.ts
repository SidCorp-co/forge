/**
 * `BindingShapeInput` — the shapes the server refuses, made unrepresentable for a typed caller
 * rather than discovered as a 400.
 *
 * Which environment a deploy binding serves moved to the project document (ISS-8), so `stages`
 * is refused on either role. These are compile-time assertions. `@ts-expect-error` IS the
 * assertion: the line fails the build when the error it expects stops happening.
 */

import { describe, expect, it } from 'vitest';
import type {
  CoolifyConfigInput,
  CoolifySecretsInput,
  IntegrationBindingCreateInput,
} from './integrations.js';

const coolifyParts: {
  provider: 'coolify';
  config: CoolifyConfigInput;
  secrets: CoolifySecretsInput;
} = {
  provider: 'coolify',
  config: { baseUrl: 'https://coolify.example.com', targets: [] },
  secrets: { apiToken: 't' },
};

describe('the shapes a typed caller may declare', () => {
  it('accepts a service binding and a deploy binding, neither naming an environment', () => {
    const service: IntegrationBindingCreateInput = { ...coolifyParts, role: 'service' };
    const deploy: IntegrationBindingCreateInput = { ...coolifyParts, role: 'deploy' };
    expect([service.role, deploy.role]).toEqual(['service', 'deploy']);
  });
});

describe('the shapes it refuses at compile time', () => {
  it('refuses stages beside a deploy binding', () => {
    const body: IntegrationBindingCreateInput = {
      ...coolifyParts,
      role: 'deploy',
      // @ts-expect-error the environment a deploy binding serves is the project document's
      stages: ['live'],
    };
    expect(body).toBeDefined();
  });

  it('refuses stages beside a service binding', () => {
    const body: IntegrationBindingCreateInput = {
      ...coolifyParts,
      role: 'service',
      // @ts-expect-error a `service` binding serves no environment, so it takes no `stages`
      stages: ['live'],
    };
    expect(body).toBeDefined();
  });

  it('refuses a body with no role at all, because there is no default for it', () => {
    // @ts-expect-error `role` is required and is one of `deploy` | `service`
    const missing: IntegrationBindingCreateInput = { ...coolifyParts };
    expect(missing).toBeDefined();
  });
});
