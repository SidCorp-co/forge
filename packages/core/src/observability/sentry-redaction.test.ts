import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { scrubSentryEvent } from '@forge/observability';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$c2VudHJ5LWhhc2g';
const EMAIL = 'dup@example.test';
/** Kept up here: the real client sends the source lines around each frame, the test's own among them. */
const QUOTED = 'zq9';
const QUOTED_REFUSAL = `invalid input syntax for type uuid: "${QUOTED}"`;

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

function failedInsert(): DrizzleQueryError {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint "u"'), {
    code: '23505',
    severity: 'ERROR',
  });
  return new DrizzleQueryError('insert into "users" values ($1, $2)', [EMAIL, HASH], driver);
}

/** Each way a value's text reaches an event through what a serializer calls, not a field it holds. */
const SERIALIZER_HOOKS: [string, (text: string) => unknown][] = [
  ['its own toJSON', (text) => ({ toJSON: () => text })],
  ['a toJSON it inherits', (text) => Object.create({ toJSON: () => text })],
  [
    'a getter',
    (text) => Object.defineProperty({}, 'reason', { get: () => text, enumerable: true }),
  ],
  [
    "a boxed string's Symbol.toPrimitive",
    (text) => Object.assign(new String('ordinary'), { [Symbol.toPrimitive]: () => text }),
  ],
  [
    "a boxed string's toString",
    (text) => Object.assign(new String('ordinary'), { toString: () => text }),
  ],
  ['a field of a tagged object', (text) => ({ [Symbol.toStringTag]: 'Reading', reason: text })],
];

describe.each(SERIALIZER_HOOKS)('a Sentry event holding a value rendered through %s', (_, hook) => {
  it.each([
    ['a failed query', () => failedInsert().message],
    ['a value the database quotes', () => QUOTED_REFUSAL],
  ])('is scrubbed of %s wherever the value sits', (_, text) => {
    const event = {
      extra: { reading: hook(text()) },
      contexts: { reading: { value: hook(text()) } },
      breadcrumbs: [{ message: 'read', data: { reading: hook(text()) } }],
    };
    const sent = JSON.stringify(scrubSentryEvent(event));
    expect(sent).not.toContain(HASH);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain(QUOTED);
  });

  it("sends none of a failed query's bound params through the real client", async () => {
    const { initSentry, Sentry } = await import('./sentry.js');
    expect(initSentry()).toBe(true);
    const before = envelopes.length;
    Sentry.captureException(new Error('unrelated'), {
      extra: { reading: hook(failedInsert().message) },
      contexts: { reading: { value: hook(QUOTED_REFUSAL) } },
    });
    expect(await Sentry.flush(5000)).toBe(true);
    const sent = envelopes.slice(before).join('\n');
    expect(sent).toContain('unrelated');
    expect(sent).not.toContain(HASH);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain(QUOTED);
  });
});

describe('scrubSentryEvent, given a request body that renders itself', () => {
  it('censors a key-named secret before the body renders it unlabelled', () => {
    const data = {
      password: 'ordinary-password',
      toJSON() {
        return this.password;
      },
    };
    const event = {
      request: { data },
      extra: { reading: { toJSON: () => failedInsert().message } },
    };
    const sent = JSON.stringify(scrubSentryEvent(event));
    expect(sent).not.toContain('ordinary-password');
    expect(sent).not.toContain(HASH);
  });

  it('drops an event whose fixed body will not give up a key-named secret', () => {
    const data = Object.freeze({
      password: 'ordinary-password',
      toJSON() {
        return this.password;
      },
    });
    expect(scrubSentryEvent({ request: { data } })).toBeNull();
    const request = Object.freeze({ data: Object.freeze({ token: 'ordinary-token' }) });
    expect(scrubSentryEvent({ request })).toBeNull();
  });

  it('drops an event whose rendering shows a fixed body that keeps a key-named secret', () => {
    const event = {
      breadcrumbs: [],
      toJSON: () => ({ request: { data: Object.freeze({ password: 'ordinary-password' }) } }),
    };
    expect(scrubSentryEvent(event)).toBeNull();
  });

  it('sends an event whose fixed fields hold nothing to scrub', () => {
    const event = { request: Object.freeze({ url: '/x', data: Object.freeze({ note: 'kept' }) }) };
    expect(JSON.stringify(scrubSentryEvent(event))).toContain('kept');
  });

  it('drops an event whose body gives a key-named secret only through a getter', () => {
    const data = Object.defineProperty({}, 'password', {
      get: () => 'getter-password',
      enumerable: true,
    });
    expect(scrubSentryEvent({ request: { data } })).toBeNull();
  });
});
