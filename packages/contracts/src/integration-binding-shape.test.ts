/**
 * `BindingShapeInput` — the three shapes the server refuses, made unrepresentable for a typed
 * caller rather than discovered as a 400.
 *
 * The create body's type said `stages: DeployStage[]` on the coolify arm with a comment reading
 * "Empty for `service`", which is not what the server does: a service binding carrying `stages`
 * at all is refused by name. The type and the runtime disagreed, and the type is the one a caller
 * reads first.
 *
 * These are compile-time assertions. `@ts-expect-error` IS the assertion: the line fails the
 * build when the error it expects stops happening, so widening the union back turns this red.
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
  it('accepts a service binding with no stages', () => {
    const body: IntegrationBindingCreateInput = { ...coolifyParts, role: 'service' };
    expect(body.role).toBe('service');
  });

  it('accepts a deploy binding declaring one stage, and one declaring both', () => {
    const one: IntegrationBindingCreateInput = {
      ...coolifyParts,
      role: 'deploy',
      stages: ['live'],
    };
    const both: IntegrationBindingCreateInput = {
      ...coolifyParts,
      role: 'deploy',
      stages: ['preview', 'live'],
    };
    expect(one.stages).toEqual(['live']);
    expect(both.stages).toHaveLength(2);
  });
});

describe('the shapes it refuses at compile time', () => {
  it('refuses stages beside a service binding', () => {
    const body: IntegrationBindingCreateInput = {
      ...coolifyParts,
      role: 'service',
      // @ts-expect-error a `service` binding serves no stage, so it takes no `stages`
      stages: ['live'],
    };
    expect(body).toBeDefined();
  });

  it('refuses a deploy binding that declares no stages', () => {
    // @ts-expect-error a `deploy` binding must declare at least one stage
    const body: IntegrationBindingCreateInput = { ...coolifyParts, role: 'deploy' };
    expect(body).toBeDefined();
  });

  it('refuses a deploy binding whose stage list is empty', () => {
    const body: IntegrationBindingCreateInput = {
      ...coolifyParts,
      role: 'deploy',
      // @ts-expect-error the empty array is not a declaration — `[DeployStage, ...DeployStage[]]`
      stages: [],
    };
    expect(body).toBeDefined();
  });

  it('refuses a body with no role at all, because there is no default for it', () => {
    // @ts-expect-error `role` is required and is one of `deploy` | `service`
    const missing: IntegrationBindingCreateInput = { ...coolifyParts };
    expect(missing).toBeDefined();
  });
});
