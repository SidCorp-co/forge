// ISS-1421 r5 repair 1 — a connection made from the Integrations tab was named "coolify · host",
// and every surface listing it names the provider beside the name again.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { defaultConnectionDisplayName } = await import('./route-helpers.js');

describe('defaultConnectionDisplayName', () => {
  it('names a new connection by the host its owner typed, without the provider id', () => {
    expect(
      defaultConnectionDisplayName('coolify', { baseUrl: 'https://coolify.example.com/' }),
    ).toBe('coolify.example.com');
  });

  it('answers null where the config says nothing that tells one connection from another', () => {
    expect(defaultConnectionDisplayName('coolify', {})).toBeNull();
  });
});
