import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'x'.repeat(32),
  },
}));

vi.mock('../db/client.js', () => ({
  db: {},
}));

const { generateToken, INVITATION_TTL_MS } = await import('./invitation-token.js');

describe('invitation-token', () => {
  it('generateToken returns a base64url string of 43 chars', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);
  });

  it('generateToken produces distinct values', () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it('INVITATION_TTL_MS is 7 days', () => {
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
