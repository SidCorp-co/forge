import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const infoSpy = vi.fn();
const warnSpy = vi.fn();
const errorSpy = vi.fn();
const debugSpy = vi.fn();

vi.mock('../logger.js', () => {
  const fakeLogger = {
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    debug: debugSpy,
    child: () => fakeLogger,
  };
  return {
    logger: fakeLogger,
    getLogger: () => fakeLogger,
  };
});

const { errorHandler, notFoundHandler } = await import('./error.js');
const { requestId } = await import('./request-id.js');

import type { RequestIdVars } from './request-id.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$bWlkZGxld2FyZQ';

function failedInsert(): DrizzleQueryError {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "u"'), {
    code: '23505',
  });
  return new DrizzleQueryError(
    'insert into "users" values ($1, $2)',
    ['dup@example.test', HASH],
    pg,
  );
}

/** A JSON refusal as postgres-js throws it: the start of the bound document in its `where`. */
function jsonRefusal(): DrizzleQueryError {
  const document = '{"note":"zq9-secret-document"}';
  const pg = Object.assign(new Error('invalid input syntax for type json'), {
    severity: 'ERROR',
    code: '22P02',
    where: `JSON data, line 1: ${document.slice(0, 20)}`,
  });
  Object.defineProperty(pg, 'parameters', { value: [document], enumerable: false });
  return new DrizzleQueryError('insert into "notes" ("body") values ($1)', [document], pg);
}

function makeApp(handler: typeof errorHandler = errorHandler) {
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.get('/http-ex', () => {
    throw new HTTPException(404, { message: 'thing not found' });
  });
  app.get('/http-ex-cause', () => {
    throw new HTTPException(422, {
      message: 'invalid',
      cause: { code: 'VALIDATION_FAILED', details: { field: 'email' } },
    });
  });
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.get('/http-ex-www-auth', () => {
    throw new HTTPException(401, {
      message: 'invalid personal access token',
      cause: {
        code: 'UNAUTHENTICATED',
        wwwAuthenticate: 'Bearer realm="forge-mcp", error="invalid_token"',
      },
    });
  });
  app.get('/http-ex-500-www-auth', () => {
    throw new HTTPException(500, {
      message: 'storage down',
      cause: {
        code: 'INTERNAL_ERROR',
        wwwAuthenticate: 'Bearer realm="forge-mcp"',
      },
    });
  });
  app.get('/http-ex-error-cause', () => {
    // Simulate a Postgres / fs Error with a `.code` property bubbling up
    // through a wrapping HTTPException. The error handler must NOT propagate
    // `enoent`-style codes into the response body's `code` field — that
    // would bypass the documented enum and leak implementation detail.
    const fsError = Object.assign(new Error('disk gone'), { code: 'ENOENT' });
    throw new HTTPException(500, { message: 'persist failed', cause: fsError });
  });
  app.get('/failed-query', () => {
    throw failedInsert();
  });
  app.get('/failed-query-http', () => {
    const err = failedInsert();
    throw new HTTPException(500, { message: `persist failed: ${err.message}`, cause: err });
  });
  app.get('/failed-query-details', () => {
    throw new HTTPException(409, {
      message: 'conflict',
      cause: { code: 'CONFLICT', details: { reason: failedInsert().message } },
    });
  });
  app.get('/failed-query-error-in-details', () => {
    throw new HTTPException(409, {
      message: 'conflict',
      cause: { code: 'CONFLICT', details: { error: failedInsert() } },
    });
  });
  app.get('/failed-query-deep-in-details', () => {
    let details: unknown = { error: failedInsert() };
    for (let i = 0; i < 40; i++) details = { inner: details };
    throw new HTTPException(409, { message: 'conflict', cause: { code: 'CONFLICT', details } });
  });
  app.get('/failed-query-beside-reason', () => {
    throw new HTTPException(409, {
      message: 'conflict',
      cause: {
        code: 'CONFLICT',
        details: { error: failedInsert(), reason: 'duplicate dup@example.test' },
      },
    });
  });
  app.get('/driver-where-in-details', () => {
    throw new HTTPException(422, {
      message: 'unreadable',
      cause: { code: 'UNPROCESSABLE_ENTITY', details: { error: jsonRefusal().cause } },
    });
  });
  app.get('/driver-where-plain-cause', () => {
    const where = (jsonRefusal().cause as { where: string }).where;
    throw new HTTPException(400, { message: `bad: ${where}`, cause: new Error('parse failed') });
  });
  app.get('/driver-message-plain-cause', () => {
    throw new HTTPException(400, {
      message: 'bad: invalid input syntax for type uuid: "zq9"',
      cause: new Error('lookup failed'),
    });
  });
  app.notFound(notFoundHandler);
  app.onError(handler);
  return app;
}

const LEAKS = /argon2|dup@example\.test/;

describe('error middleware', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    debugSpy.mockReset();
  });

  it('HTTPException 4xx → JSON shape with mapped code, logs at warn', async () => {
    const res = await makeApp().request('/http-ex');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ code: 'NOT_FOUND', message: 'thing not found' });
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('HTTPException cause.code overrides default code and passes details', async () => {
    const res = await makeApp().request('/http-ex-cause');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'invalid',
      details: { field: 'email' },
    });
  });

  it('generic thrown Error → 500 with INTERNAL_ERROR code, logs at error', async () => {
    const res = await makeApp().request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Internal Server Error');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('notFound handler returns { code: NOT_FOUND, message }', async () => {
    const res = await makeApp().request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toContain('/nope');
  });

  it('HTTPException cause.wwwAuthenticate is attached to the response', async () => {
    const res = await makeApp().request('/http-ex-www-auth');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_token"',
    );
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.message).toBe('invalid personal access token');
  });

  it('HTTPException without cause.wwwAuthenticate sets no WWW-Authenticate header', async () => {
    const res = await makeApp().request('/http-ex');
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('cause.wwwAuthenticate is suppressed on non-401 statuses (RFC 7235)', async () => {
    const res = await makeApp().request('/http-ex-500-www-auth');
    expect(res.status).toBe(500);
    // The handler must not leak a Bearer challenge on a 5xx — challenge
    // headers are 401-specific and clients seeing one on a 500 may retry
    // with credentials they shouldn't.
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('cause that is an Error instance does NOT propagate its .code into the response body', async () => {
    const res = await makeApp().request('/http-ex-error-cause');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    // ENOENT comes from Node's fs Error — must be filtered out so the
    // response body's `code` stays within the documented enum.
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.code).not.toBe('ENOENT');
  });

  it.each([
    '/failed-query',
    '/failed-query-http',
    '/failed-query-details',
    '/failed-query-error-in-details',
    '/failed-query-deep-in-details',
    '/failed-query-beside-reason',
    '/driver-where-in-details',
    '/driver-where-plain-cause',
  ])("answers %s with none of the failed query's bound params outside production", async (path) => {
    const text = await (await makeApp().request(path)).text();
    expect(text).not.toMatch(LEAKS);
    expect(text).not.toContain('zq9');
    expect(text).toContain('[Redacted]');
  });

  it.each([
    ['/failed-query-http', errorSpy],
    ['/driver-message-plain-cause', warnSpy],
  ])("logs %s's HTTPException with none of the failed query's bound values", async (path, spy) => {
    await makeApp().request(path);
    const text = JSON.stringify(spy.mock.calls);
    expect(spy).toHaveBeenCalled();
    expect(text).not.toMatch(LEAKS);
    expect(text).not.toContain('zq9');
  });

  it('answers an HTTPException quoting a value the database refused with none of it', async () => {
    const text = await (await makeApp().request('/driver-message-plain-cause')).text();
    expect(text).not.toContain('zq9');
    expect(text).toContain('invalid input syntax for type uuid');
  });

  it('names an unhandled failed query by its statement in the non-production details', async () => {
    const body = (await (await makeApp().request('/failed-query')).json()) as {
      details: { message: string };
    };
    expect(body.details.message).toBe(
      'Failed query: insert into "users" values ($1, $2)\nparams: [Redacted]',
    );
  });
});

describe('error middleware in production', () => {
  it.each([
    '/failed-query',
    '/failed-query-http',
    '/failed-query-details',
    '/failed-query-error-in-details',
    '/failed-query-deep-in-details',
    '/failed-query-beside-reason',
    '/driver-where-in-details',
    '/driver-where-plain-cause',
  ])("answers %s with none of the failed query's bound params", async (path) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const prod = await import('./error.js');
    vi.unstubAllEnvs();
    const text = await (await makeApp(prod.errorHandler).request(path)).text();
    expect(text).not.toMatch(LEAKS);
    expect(text).not.toContain('zq9');
  });
});
