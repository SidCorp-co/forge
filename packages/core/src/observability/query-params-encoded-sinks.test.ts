// ISS-1383 r5 — each sink, given text a caller re-encoded or a failed query that bound nothing.

import { redactedMessage } from '@forge/observability';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { Cancellation } from '../issues/backlog/cancellation.js';
import { emitBacklogStream } from '../issues/backlog/emitter.js';
import { createLogger } from '../logger.js';
import type { RequestIdVars } from '../middleware/request-id.js';
import { driverError } from './query-params.fixture.js';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    APP_BASE_URL: 'https://forge.test',
    UPLOADS_MAX_BYTES: 1,
    UPLOADS_INLINE_MAX_BYTES: 1,
    FEEDBACK_MAX_PER_JOB: 1,
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>();
  const quiet = actual.createLogger({ level: 'silent' });
  return { ...actual, logger: quiet, getLogger: () => quiet };
});

const { classifyError } = await import('../mcp/server.js');

const LONG = 'S3cr3tVal-r5-QZX';
const SHORT = 'q9z';
const LEAKS = new RegExp(`${LONG}|${SHORT}`);
const enc = (text: string) => JSON.stringify({ m: text });
const refusal = (v: string) => `invalid input syntax for type uuid: "${v}"`;

function failedInsert(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into r5u values ($1, $2)',
    [LONG, `${LONG}-hash`],
    driverError('duplicate key value violates unique constraint "r5u_email_key"', {
      code: '23505',
    }),
  );
}

function shortRefusal(): DrizzleQueryError {
  return new DrizzleQueryError(
    'select $1::uuid',
    [SHORT],
    driverError(refusal(SHORT), { code: '22P02' }),
  );
}

function parameterless(): DrizzleQueryError {
  return new DrizzleQueryError(
    'select 1/0',
    [],
    driverError('division by zero', { code: '22012' }),
  );
}

/** j4's two causes as an error a sink is handed: text escaped once, and a query that bound nothing. */
const WRAPPERS: [string, () => Error][] = [
  [
    'a short value in a driver text escaped once, its error as cause',
    () =>
      new Error(`upstream: ${enc(shortRefusal().cause?.message as string)}`, {
        cause: shortRefusal(),
      }),
  ],
  [
    'another failed query quoted, a parameterless failed query as cause',
    () => new Error(`retry gave up after: ${failedInsert().message}`, { cause: parameterless() }),
  ],
];

function capturing(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', ...options }, { write: (s: string) => lines.push(s) });
  return { log, text: () => lines.join('') };
}

describe('the core logger, given text a caller escaped', () => {
  it.each([
    ['under another key, no error', (log, t) => log.error({ body: enc(t) }, 'upstream said')],
    ['under err, no error', (log, t) => log.error({ err: enc(t) })],
    ['interpolated with %s, no error', (log, t) => log.error('upstream: %s', enc(t))],
  ] as [string, (log: ReturnType<typeof createLogger>, t: string) => void][])(
    'writes no bound value of a failed query or a refusal %s',
    (_, write) => {
      for (const t of [failedInsert().message, refusal(LONG)]) {
        const { log, text } = capturing();
        write(log, t);
        expect(text()).not.toMatch(LEAKS);
      }
    },
  );

  it('writes no short value escaped beside the error that names it', () => {
    const { log, text } = capturing();
    const err = shortRefusal();
    log.error({ err, body: enc(refusal(SHORT)) }, 'x');
    log.error({ err }, `failed: ${enc(refusal(SHORT))}`);
    expect(text()).not.toMatch(LEAKS);
    expect(text()).toContain('select $1::uuid');
  });

  it('writes no value of a failed query logged beside one that bound nothing', () => {
    const { log, text } = capturing();
    log.error({ err: { failed: parameterless(), note: failedInsert().message } }, 'x');
    log.error({ err: parameterless() }, `also: ${failedInsert().message}`);
    expect(text()).not.toMatch(LEAKS);
  });

  it('redacts at the finished line what reached it past every call hook (a mixin)', () => {
    const { log, text } = capturing({
      mixin: () => ({ upstream: failedInsert().message, escaped: enc(refusal(LONG)) }),
    });
    log.info('ordinary');
    expect(text()).toContain('ordinary');
    expect(text()).toContain('insert into r5u');
    expect(text()).not.toMatch(LEAKS);
  });

  it('reads a finished line whose only value-quoting text was escaped twice before it', () => {
    const { log, text } = capturing({
      mixin: () => ({ twice: JSON.stringify(enc(refusal(SHORT))) }),
    });
    log.info('ordinary');
    expect(text()).toContain('ordinary');
    expect(text()).not.toMatch(LEAKS);
  });
});

describe.each([false, true])('the HTTP error body (production: %s)', (prod) => {
  async function bodyOf(thrown: () => never): Promise<string> {
    if (prod) vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { errorHandler } = await import('../middleware/error.js');
    vi.unstubAllEnvs();
    const app = new Hono<{ Variables: RequestIdVars }>();
    app.onError(errorHandler);
    app.get('/x', thrown);
    return (await app.request('/x')).text();
  }

  it.each([
    [
      'an HTTPException message holding an escaped refusal',
      () => {
        throw new HTTPException(400, { message: `upstream: ${enc(refusal(LONG))}` });
      },
    ],
    [
      'details holding an escaped failed query',
      () => {
        throw new HTTPException(502, {
          message: 'x',
          cause: { details: { body: enc(failedInsert().message) } },
        });
      },
    ],
    ...WRAPPERS.map(([name, make]): [string, () => never] => [
      `unhandled: ${name}`,
      () => {
        throw make();
      },
    ]),
  ] as [string, () => never][])('carries no bound value for %s', async (_, thrown) => {
    expect(await bodyOf(thrown)).not.toMatch(LEAKS);
  });
});

describe.each(WRAPPERS)('a text sink handed %s', (_, make) => {
  it('gives classifyError and redactedMessage no bound value', () => {
    expect(classifyError(make()).message).not.toMatch(LEAKS);
    expect(redactedMessage(make())).not.toMatch(LEAKS);
  });

  it("writes no bound value into the backlog stream's error frame", async () => {
    const frames: string[] = [];
    const stream = {
      writeSSE: async (m: { data: string }) => void frames.push(m.data),
      onAbort: () => {},
      close: async () => {},
    };
    const source = (async function* () {
      yield { i: 0 };
      throw make();
    })();
    await emitBacklogStream({ get: () => undefined } as never, stream as never, {
      kind: 'ordering',
      projectId: 'p1',
      total: 1,
      limit: 10,
      budgetMs: 60_000,
      cancellation: new Cancellation(),
      source: source as never,
    });
    expect(frames.at(-1)).toContain('BACKLOG_STREAM_FAILED');
    expect(frames.at(-1)).not.toMatch(LEAKS);
  });
});
