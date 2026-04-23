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

const { generateToken } = await import('./verification-token.js');

describe('generateToken', () => {
  it('returns a base64url string of 43 chars (32 bytes)', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);
  });

  it('produces distinct values across calls', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});
