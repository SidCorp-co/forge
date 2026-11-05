// @direct-test-of packages/core/src/lib/db-errors.ts
import { PROBLEM_CONTENT_TYPE } from '@forge/contracts/refusal';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from './request-id.js';

const reportFailure = vi.fn();
vi.mock('../lib/error-tracking.js', () => ({ reportFailure }));

const { connectionUnavailable } = await import('../lib/db-errors.js');
const { errorHandler, resetConnectionReports, DB_CONNECTIONS_RETRY_AFTER_SECONDS } = await import(
  './error.js'
);

/** The shapes each client throws, as they arrive: postgres.js and pg carry SQLSTATE in `code`. */
const tooManyClients = () =>
  Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
const drizzleWrapped = () =>
  Object.assign(new Error('Failed query: select 1'), { cause: tooManyClients() });
const connectTimeout = () =>
  Object.assign(new Error('write CONNECT_TIMEOUT db:5432'), { code: 'CONNECT_TIMEOUT' });
const poolWaitExpired = () => new Error('timeout exceeded when trying to connect');

describe('connectionUnavailable', () => {
  it('reads a refused or timed-out connection from every client core holds', () => {
    expect(connectionUnavailable(tooManyClients())).toBe('refused');
    expect(connectionUnavailable(drizzleWrapped())).toBe('refused');
    expect(connectionUnavailable(connectTimeout())).toBe('timed-out');
    expect(connectionUnavailable(poolWaitExpired())).toBe('timed-out');
  });

  it('leaves every other failure alone', () => {
    expect(connectionUnavailable(Object.assign(new Error('dup'), { code: '23505' }))).toBeNull();
    expect(connectionUnavailable(new Error('boom'))).toBeNull();
    expect(connectionUnavailable(null)).toBeNull();
    expect(connectionUnavailable('53300')).toBeNull();
    // the sentence alone, on an error that carries a code of its own, is not pg-pool's wait
    expect(
      connectionUnavailable(
        Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'X' }),
      ),
    ).toBeNull();
  });
});

function app(thrown: () => unknown) {
  const a = new Hono<{ Variables: RequestIdVars }>();
  a.post('/write', () => {
    throw thrown();
  });
  a.onError(errorHandler);
  return a;
}

describe('a request that cannot get a connection', () => {
  beforeEach(() => {
    reportFailure.mockClear();
    resetConnectionReports();
  });

  it('answers 503 DB_CONNECTIONS_EXHAUSTED, retryable, with Retry-After, never a bare 500', async () => {
    for (const thrown of [tooManyClients, drizzleWrapped, connectTimeout, poolWaitExpired]) {
      const res = await app(thrown).request('/write', { method: 'POST' });
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
      expect(res.headers.get('retry-after')).toBe(String(DB_CONNECTIONS_RETRY_AFTER_SECONDS));
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 503,
        code: 'DB_CONNECTIONS_EXHAUSTED',
        details: { retryable: true, retryAfterSeconds: DB_CONNECTIONS_RETRY_AFTER_SECONDS },
        error: { code: 'DB_CONNECTIONS_EXHAUSTED' },
      });
      expect(String(body.detail)).toMatch(/nothing was written, retry after/);
    }
  });

  it('is reported once per burst, the next report counting the refusals between', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      for (let i = 0; i < 5; i++) await app(tooManyClients).request('/write', { method: 'POST' });
      expect(reportFailure).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_000_000 + 60_000);
      await app(tooManyClients).request('/write', { method: 'POST' });
      expect(reportFailure).toHaveBeenCalledTimes(2);
      expect(reportFailure.mock.calls[1]?.[1]).toMatchObject({
        tags: { 'error.code': 'DB_CONNECTIONS_EXHAUSTED' },
        extra: { refusedSinceLastReport: 4 },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('still answers any other failure 500 and reports each one', async () => {
    const res = await app(() => new Error('boom')).request('/write', { method: 'POST' });
    expect(res.status).toBe(500);
    await app(() => new Error('boom')).request('/write', { method: 'POST' });
    expect(reportFailure).toHaveBeenCalledTimes(2);
  });
});
