// ISS-1421 r5 repair 2 — an override of Cloudflare's ranges that names none, or one that is not a
// range, would leave no edge recognised; core refuses it at start rather than on a request.

import { describe, expect, it } from 'vitest';
import { EnvSchema } from './env.js';

const BASE = {
  DATABASE_URL: 'postgres://localhost/test',
  JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
  DEVICE_TOKEN_PEPPER: 'test-pepper-at-least-32-chars-long-abcdefgh',
};

const parse = (CLOUDFLARE_IP_RANGES?: string) =>
  EnvSchema.safeParse(
    CLOUDFLARE_IP_RANGES === undefined ? BASE : { ...BASE, CLOUDFLARE_IP_RANGES },
  );

describe('CLOUDFLARE_IP_RANGES', () => {
  it('is optional, and the shipped list answers where it is unset', () => {
    const parsed = parse();
    expect(parsed.success).toBe(true);
    expect(parsed.data?.CLOUDFLARE_IP_RANGES).toBeUndefined();
  });

  it('takes a comma-separated list of ranges', () => {
    expect(parse('104.16.0.0/13, 2606:4700::/32').data?.CLOUDFLARE_IP_RANGES).toEqual([
      '104.16.0.0/13',
      '2606:4700::/32',
    ]);
  });

  it.each([',', ' , '])('refuses %j, which names no range', (value) => {
    const parsed = parse(value);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('names no range');
  });

  it.each(['104.16.0.0', '104.16.0.0/', '104.16.0.0/13/extra', '104.16.0.0/40', 'edge/13'])(
    'refuses %j, which is not address/bits',
    (value) => {
      const parsed = parse(value);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('is not an address range');
    },
  );
});
