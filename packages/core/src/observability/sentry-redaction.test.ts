import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$c2VudHJ5LWhhc2g';
const EMAIL = 'dup@example.test';

/** A stand-in Sentry ingest on loopback, holding every envelope the real client sends it. */
let ingest: Server;
const envelopes: string[] = [];

beforeAll(async () => {
  ingest = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      envelopes.push(
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(body).toString() : body.toString(),
      );
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  const { port } = ingest.address() as AddressInfo;
  vi.stubEnv('SENTRY_DSN', `http://public@127.0.0.1:${port}/1`);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => ingest.close(() => resolve()));
});

describe('the Sentry client core starts', () => {
  it("sends a failed query's statement and none of its bound params", async () => {
    const { initSentry, Sentry } = await import('./sentry.js');
    expect(initSentry()).toBe(true);
    const driver = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
      { code: '23505', severity: 'ERROR', detail: `Key (email)=(${EMAIL}) already exists.` },
    );
    const failed = new DrizzleQueryError(
      'insert into "users" ("email", "password_hash") values ($1, $2)',
      [EMAIL, HASH],
      driver,
    );
    Sentry.captureException(new Error('register failed', { cause: failed }));
    expect(await Sentry.flush(5000)).toBe(true);

    const sent = envelopes.join('\n');
    expect(sent).toContain('insert into \\"users\\"');
    expect(sent).toContain('users_email_unique');
    expect(sent).not.toContain(HASH);
    expect(sent).not.toContain(EMAIL);
  });
});
