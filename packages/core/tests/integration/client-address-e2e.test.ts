// ISS-1421 r5 repair 2 — on beta, Cloudflare sits in front of Coolify's Traefik, which does not trust
// Cloudflare: it drops the X-Forwarded-For Cloudflare wrote and sends one entry, the edge's address.
// Over a real socket, through the sign-in door and its limit of five, the client is the address
// Cloudflare says connected where the peer Traefik vouches for is a Cloudflare edge, and nothing a
// client writes for itself counts. The suite's socket is loopback, which stands for Traefik.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let resetLimits: () => void;

const EDGE = '104.16.0.10';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ __resetRateLimitStore: resetLimits } = await import('../../src/middleware/rate-limit.js'));
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  resetLimits();
});

/** One sign-in attempt with a password nobody holds, as the headers say it arrived. */
async function attempt(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${server.baseUrl}/api/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'nobody@test.local', password: 'not-the-password' }),
  });
  await res.text();
  return res.status;
}

async function six(headers: (n: number) => Record<string, string>): Promise<number[]> {
  const statuses: number[] = [];
  for (let n = 1; n <= 6; n++) statuses.push(await attempt(headers(n)));
  return statuses;
}

describe('the sign-in limit, behind Cloudflare and a Traefik that does not trust it', () => {
  it('gives each person Cloudflare names a bucket of their own', async () => {
    const first = await six(() => ({ 'x-forwarded-for': EDGE, 'cf-connecting-ip': '203.0.113.7' }));
    expect(first.at(-1)).toBe(429);
    const other = await attempt({ 'x-forwarded-for': EDGE, 'cf-connecting-ip': '203.0.113.8' });
    expect(other).not.toBe(429);
  });

  it('ignores a CF-Connecting-IP forged on a request that did not come from Cloudflare', async () => {
    const statuses = await six((n) => ({
      'x-forwarded-for': '198.51.100.20',
      'cf-connecting-ip': `203.0.113.${n}`,
    }));
    expect(statuses.at(-1)).toBe(429);
  });

  it('ignores a forged left-most X-Forwarded-For entry', async () => {
    const statuses = await six((n) => ({
      'x-forwarded-for': `198.51.100.${n}, ${EDGE}`,
      'cf-connecting-ip': '203.0.113.9',
    }));
    expect(statuses.at(-1)).toBe(429);
  });
});
