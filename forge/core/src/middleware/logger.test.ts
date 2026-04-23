import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const infoSpy = vi.fn();
const warnSpy = vi.fn();
const errorSpy = vi.fn();

vi.mock('../logger.js', () => {
  const fakeLogger = {
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    debug: vi.fn(),
    child: () => fakeLogger,
  };
  return {
    logger: fakeLogger,
    getLogger: () => fakeLogger,
  };
});

const { requestLogger } = await import('./logger.js');
const { errorHandler } = await import('./error.js');
const { requestId } = await import('./request-id.js');
import type { RequestIdVars } from './request-id.js';

function makeApp() {
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.use('*', requestLogger());
  app.get('/ok', (c) => c.json({ ok: true }));
  app.get('/client', () => {
    throw new HTTPException(400, { message: 'bad' });
  });
  app.get('/server', () => {
    throw new Error('oops');
  });
  app.onError(errorHandler);
  return app;
}

describe('requestLogger middleware', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
  });

  it('logs start + end at info for 2xx', async () => {
    const res = await makeApp().request('/ok');
    expect(res.status).toBe(200);
    const events = infoSpy.mock.calls.map((call) => call[1]);
    expect(events).toContain('request.start');
    expect(events).toContain('request.end');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs end at warn for 4xx responses', async () => {
    const res = await makeApp().request('/client');
    expect(res.status).toBe(400);
    const warnEvents = warnSpy.mock.calls.map((call) => call[1]);
    expect(warnEvents).toContain('request.end');
  });

  it('logs end at error for 5xx responses', async () => {
    const res = await makeApp().request('/server');
    expect(res.status).toBe(500);
    const errorEvents = errorSpy.mock.calls.map((call) => call[1]);
    expect(errorEvents).toContain('request.end');
  });
});
