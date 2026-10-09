/**
 * An environment's `routes` (ISS-470): the path prefixes each declared service answers, so a kept
 * request probe is replayed on the origin that answers its path. A route names only a declared
 * service, and no prefix is claimed by two services.
 *
 * @direct-test-of packages/core/src/project-config/schema.ts
 * @direct-test-of packages/core/src/project-config/environment-routes.ts
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { environmentSchema } from './schema.js';

const base = {
  tier: 'production',
  deployment: { binding: randomUUID(), trigger: 'on-land' },
  url: 'https://forge-dev.example.test',
  services: { api: 'https://forge-dev-api.example.test' },
};

const messages = (env: unknown) =>
  (environmentSchema.safeParse(env).error?.issues ?? []).map((i) => i.message);

describe('environments.<name>.routes', () => {
  it('accepts the prefixes a declared service answers, and its absence', () => {
    expect(
      environmentSchema.safeParse({ ...base, routes: { api: ['/api', '/version'] } }).success,
    ).toBe(true);
    expect(environmentSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a route for a service the environment does not declare', () => {
    expect(messages({ ...base, routes: { admin: ['/admin'] } })).toEqual([
      'routes names service `admin`, which `services` does not declare',
    ]);
  });

  it('refuses one prefix routed by two services', () => {
    const env = {
      ...base,
      services: { ...base.services, admin: 'https://admin.example.test' },
      routes: { api: ['/api'], admin: ['/api'] },
    };
    expect(messages(env)).toEqual(['prefix `/api` is routed by both `api` and `admin`']);
  });

  it('refuses a prefix that is not a path', () => {
    expect(messages({ ...base, routes: { api: ['api'] } })).toEqual([
      'a path prefix starting with `/` (no query or fragment)',
    ]);
    expect(messages({ ...base, routes: { api: ['/api?x=1'] } })).toHaveLength(1);
  });
});
