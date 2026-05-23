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

function makeApp() {
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
  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}

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
});
