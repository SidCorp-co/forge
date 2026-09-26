/**
 * The schema an owner-scoped connection config PATCH is held to. ISS-1275 — it read the CREATE
 * schema, against the patch BODY, and coolify splits its required `targets` to the binding tier,
 * so every config patch to a coolify connection was refused for a key that tier cannot hold.
 */

import { describe, expect, it } from 'vitest';
import { connectionConfigSchemaForProvider } from './provider-schemas.js';
import { registerAllIntegrations } from './register-all.js';
import { listIntegrations } from './registry.js';

registerAllIntegrations();

const patchSchema = (provider: string) => connectionConfigSchemaForProvider(provider);

const createSchema = (provider: string) => {
  const decl = listIntegrations().find((d) => d.provider === provider);
  if (!decl) throw new Error(`no declaration for ${provider}`);
  return decl.schemas.connectionConfig;
};

describe('the connection config PATCH schema', () => {
  it('takes a coolify body carrying the base url alone', () => {
    expect(
      patchSchema('coolify').safeParse({ baseUrl: 'https://coolify.example.com' }).success,
    ).toBe(true);
  });

  // The defect itself, kept as a case rather than as prose: the create schema
  // refuses the same body, and it is what the route read until this change.
  it('is not the create schema, which refuses that same body', () => {
    expect(
      createSchema('coolify').safeParse({ baseUrl: 'https://coolify.example.com' }).success,
    ).toBe(false);
  });

  it('takes a coolify body whose only key is a null release runner label', () => {
    expect(patchSchema('coolify').safeParse({ releaseRunnerLabel: null }).success).toBe(true);
  });

  it('refuses a malformed value in that partial body rather than absorbing it', () => {
    const answer = patchSchema('coolify').safeParse({ baseUrl: 'not-a-url' });

    expect(answer.success).toBe(false);
    expect(JSON.stringify(answer.error?.issues)).toContain('baseUrl');
  });

  it('refuses a release runner label that is not a string', () => {
    expect(patchSchema('coolify').safeParse({ releaseRunnerLabel: 7 }).success).toBe(false);
  });

  // `connectionConfigSchemaForProvider` reads one field off the declaration, so
  // a provider that declared none would throw at request time rather than here.
  it('is declared by every provider this build registers', () => {
    const providers = listIntegrations().map((d) => d.provider);

    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect({ provider, parsed: patchSchema(provider).safeParse({}).success }).toEqual({
        provider,
        parsed: true,
      });
    }
  });

  it('refuses a provider this build does not declare', () => {
    expect(() => patchSchema('not-a-provider')).toThrow();
  });
});
