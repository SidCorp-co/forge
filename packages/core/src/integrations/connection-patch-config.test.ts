/**
 * The schema an owner-scoped connection config PATCH is held to. ISS-1275 — it read the CREATE
 * schema, against the patch BODY. ISS-8 — a coolify connection holds no `targets` at all, on
 * either door: the binding's `target` is where a deploy goes.
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

  // ISS-8 — a connection carries no deploy target: the binding's `target` is the one home.
  it.each([
    ['create', createSchema],
    ['patch', patchSchema],
  ])('refuses `targets` on a coolify connection %s body by name', (_door, schema) => {
    const answer = schema('coolify').safeParse({
      baseUrl: 'https://coolify.example.com',
      targets: [{ resourceUuid: 'app-1' }],
    });

    expect(answer.success).toBe(false);
    expect(JSON.stringify(answer.error?.issues)).toContain('carries no deploy target');
  });

  it('takes the create body carrying the base url alone, as the patch does', () => {
    expect(
      createSchema('coolify').safeParse({ baseUrl: 'https://coolify.example.com' }).success,
    ).toBe(true);
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
