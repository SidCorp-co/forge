// @direct-test-of packages/core/src/middleware/error.ts
// @direct-test-of packages/core/src/lib/db-errors.ts
// ISS-1020: a request Postgres refuses a connection to answers 503 DB_CONNECTIONS_EXHAUSTED, not a
// bare 500. Postgres itself does the refusing: this file's process connects as a role whose
// CONNECTION LIMIT is 0, so every connection it opens is refused 53300, the SQLSTATE forge-dev's
// server answered with "sorry, too many clients already" while a deploy ran two containers.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.TEST_PG_ADMIN_URL;
const fileUrl = process.env.DATABASE_URL;
if (!adminUrl || !fileUrl) throw new Error('the integration setup did not run');

const role = `refused_${randomBytes(4).toString('hex')}`;
const password = randomBytes(12).toString('hex');
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' CONNECTION LIMIT 0`);

// before anything reads the env, so every client this process opens connects as the refused role
const refusedUrl = new URL(fileUrl);
refusedUrl.username = role;
refusedUrl.password = password;
process.env.DATABASE_URL = refusedUrl.toString();

afterAll(async () => {
  const { closeDb } = await import('../../src/db/client.js');
  const { closeRateLimitStore } = await import('../../src/middleware/rate-limit.js');
  await Promise.all([closeDb(), closeRateLimitStore()]);
  await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end({ timeout: 5 });
});

describe('a request Postgres refuses a connection to', () => {
  it('answers 503 DB_CONNECTIONS_EXHAUSTED, retryable, through the refusal envelope', async () => {
    const { app } = await import('../../src/index.js');
    const { generatePatPlaintext } = await import('../../src/credentials/pat-format.js');
    const res = await app.fetch(
      new Request(`http://forge.test/api/projects/${randomUUID()}/issues`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${generatePatPlaintext('dev')}`,
        },
        body: JSON.stringify({ title: 'a write the server has no slot for' }),
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect({ status: res.status, code: body.code }).toEqual({
      status: 503,
      code: 'DB_CONNECTIONS_EXHAUSTED',
    });
    expect(res.headers.get('retry-after')).toBe('5');
    expect(body).toMatchObject({
      status: 503,
      details: { retryable: true, retryAfterSeconds: 5 },
      error: { code: 'DB_CONNECTIONS_EXHAUSTED', refusals: [{ code: 'DB_CONNECTIONS_EXHAUSTED' }] },
    });
  });

  it('is read as a refused connection from the rate limiter store, which is another client', async () => {
    const { consumeRateLimit } = await import('../../src/middleware/rate-limit.js');
    const { connectionUnavailable } = await import('../../src/lib/db-errors.js');
    const err = await consumeRateLimit('iss-1020', 10, 60_000).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: unknown } | null)?.code).toBe('53300');
    expect(connectionUnavailable(err)).toBe('refused');
  });
});
