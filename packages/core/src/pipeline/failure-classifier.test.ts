import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_VERSION, classifyFailure } from './failure-classifier.js';

describe('failure-classifier', () => {
  it('returns CLASSIFIER_VERSION on every result so callers can pin it', () => {
    expect(CLASSIFIER_VERSION).toBe(2);
    expect(classifyFailure({}).version).toBe(CLASSIFIER_VERSION);
    expect(classifyFailure({ error: 'whatever' }).version).toBe(CLASSIFIER_VERSION);
  });

  it('classifies content-filter blocks as permanent (Anthropic real-world)', () => {
    const r = classifyFailure({
      error:
        'API Error: {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}',
    });
    expect(r.kind).toBe('permanent');
    expect(r.reason).toMatch(/content/i);
  });

  it('classifies invalid_request_error from structured meta even if text is generic', () => {
    const r = classifyFailure({
      error: 'API Error',
      meta: { type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } },
    });
    expect(r.kind).toBe('permanent');
    expect(r.reason).toContain('invalid_request_error');
  });

  it('classifies authentication_error meta as permission (v2 split)', () => {
    const r = classifyFailure({
      meta: { error: { type: 'authentication_error', message: 'invalid api key' } },
    });
    expect(r.kind).toBe('permission');
  });

  it('classifies permission_error meta as permission', () => {
    const r = classifyFailure({
      meta: { error: { type: 'permission_error', message: 'no access' } },
    });
    expect(r.kind).toBe('permission');
  });

  it('classifies rate_limit_error from meta as transient', () => {
    const r = classifyFailure({
      meta: { error: { type: 'rate_limit_error', message: 'slow down' } },
    });
    expect(r.kind).toBe('transient');
  });

  it('classifies overloaded_error as transient', () => {
    const r = classifyFailure({ meta: { error: { type: 'overloaded_error' } } });
    expect(r.kind).toBe('transient');
  });

  it('classifies "401 Unauthorized" text as permission (v2 split)', () => {
    expect(classifyFailure({ error: 'HTTP 401 Unauthorized' }).kind).toBe('permission');
  });

  it('classifies "Forbidden" text as permission (v2 split)', () => {
    expect(classifyFailure({ error: 'Forbidden access to resource' }).kind).toBe('permission');
  });

  it('classifies permission_denied as permission', () => {
    expect(classifyFailure({ error: 'permission_denied' }).kind).toBe('permission');
  });

  it('classifies validation_error text as permanent', () => {
    expect(classifyFailure({ error: 'schema validation_error: missing field' }).kind).toBe(
      'permanent',
    );
  });

  it('classifies ETIMEDOUT as timeout (v2 split)', () => {
    expect(classifyFailure({ error: 'connect ETIMEDOUT 1.2.3.4:443' }).kind).toBe('timeout');
  });

  it('classifies "no progress for" as timeout', () => {
    expect(classifyFailure({ error: 'no progress for 5m' }).kind).toBe('timeout');
  });

  it('classifies "heartbeat stale" as timeout (v2 split)', () => {
    expect(classifyFailure({ error: 'heartbeat stale' }).kind).toBe('timeout');
    expect(classifyFailure({ error: 'heartbeat missing' }).kind).toBe('timeout');
  });

  it('classifies "runner stale" as transient (legacy phrasing)', () => {
    // The "runner (offline|stale|disconnected)" branch lives in the
    // transient bucket; mixed phrasings like "runner stale heartbeat" can
    // legitimately land on either side of the split and are not asserted.
    expect(classifyFailure({ error: 'runner stale' }).kind).toBe('transient');
  });

  it('classifies ECONNRESET as transient', () => {
    expect(classifyFailure({ error: 'socket ECONNRESET' }).kind).toBe('transient');
  });

  it('classifies "503 Service Unavailable" as transient', () => {
    expect(classifyFailure({ error: 'HTTP 503 Service Unavailable' }).kind).toBe('transient');
  });

  it('classifies HTTP 429 / rate limit as transient', () => {
    expect(classifyFailure({ error: 'rate limit exceeded' }).kind).toBe('transient');
    expect(classifyFailure({ error: '429 too many requests' }).kind).toBe('transient');
  });

  it('classifies "runner offline" as transient', () => {
    expect(classifyFailure({ error: 'runner offline (server unreachable)' }).kind).toBe(
      'transient',
    );
  });

  it('classifies unmatched text as unknown (gets cautious retry)', () => {
    const r = classifyFailure({ error: 'unknown weirdness' });
    expect(r.kind).toBe('unknown');
    expect(r.reason).toContain('unknown weirdness');
  });

  it('classifies empty input as unknown with a stable reason', () => {
    expect(classifyFailure({}).kind).toBe('unknown');
    expect(classifyFailure({}).reason).toBe('unclassified');
  });

  it('preserves meta on the result so the sweeper / UI can render it', () => {
    const meta = { error: { type: 'invalid_request_error', message: 'x' }, request_id: 'req_abc' };
    const r = classifyFailure({ error: 'API Error', meta });
    expect(r.meta).toBe(meta);
  });

  it('truncates very long error excerpts in reason (UI sanity)', () => {
    const long = 'x'.repeat(500);
    const r = classifyFailure({ error: long });
    expect(r.reason.length).toBeLessThanOrEqual(200);
    expect(r.reason).toMatch(/…$/);
  });

  it('prefers permanent when both pattern groups match (permanent is more specific)', () => {
    const r = classifyFailure({
      error: 'invalid_request_error: rate limit-shaped phrasing but auth was the real cause',
    });
    expect(r.kind).toBe('permanent');
  });

  describe('retryAfter extraction', () => {
    const FIXED_NOW = new Date('2026-05-23T12:00:00.000Z').getTime();
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('extracts Retry-After delta-seconds from meta.headers', () => {
      const r = classifyFailure({
        error: '429 too many requests',
        meta: { headers: { 'retry-after': '600' } },
      });
      expect(r.kind).toBe('transient');
      expect(r.retryAfter).toEqual(new Date(FIXED_NOW + 600 * 1000));
    });

    it('extracts Retry-After from meta.response.headers (axios shape)', () => {
      const r = classifyFailure({
        error: '503 Service Unavailable',
        meta: { response: { headers: { 'Retry-After': '120' } } },
      });
      expect(r.retryAfter).toEqual(new Date(FIXED_NOW + 120 * 1000));
    });

    it('extracts Retry-After from meta.error.headers (SDK shape)', () => {
      const r = classifyFailure({
        meta: { error: { type: 'rate_limit_error', headers: { 'retry-after': '300' } } },
      });
      expect(r.retryAfter).toEqual(new Date(FIXED_NOW + 300 * 1000));
    });

    it('returns null retryAfter when no header present', () => {
      const r = classifyFailure({ error: '429' });
      expect(r.retryAfter).toBeNull();
    });

    it('returns null retryAfter for unparseable header', () => {
      const r = classifyFailure({
        error: '429',
        meta: { headers: { 'retry-after': 'not-a-date' } },
      });
      expect(r.retryAfter).toBeNull();
    });
  });
});
