import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_VERSION, classifyFailure } from './failure-classifier.js';

describe('failure-classifier (v3 taxonomy — ISS-450)', () => {
  it('returns CLASSIFIER_VERSION on every result so callers can pin it', () => {
    expect(CLASSIFIER_VERSION).toBe(3);
    expect(classifyFailure({}).version).toBe(CLASSIFIER_VERSION);
    expect(classifyFailure({ error: 'whatever' }).version).toBe(CLASSIFIER_VERSION);
  });

  it('classifies content-filter blocks as code (was permanent)', () => {
    const r = classifyFailure({
      error:
        'API Error: {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}',
    });
    expect(r.kind).toBe('code');
    expect(r.reason).toMatch(/content/i);
  });

  it('classifies invalid_request_error from structured meta even if text is generic', () => {
    const r = classifyFailure({
      error: 'API Error',
      meta: { type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } },
    });
    expect(r.kind).toBe('code');
    expect(r.reason).toContain('invalid_request_error');
  });

  it('classifies authentication_error meta as infra (was permission)', () => {
    const r = classifyFailure({
      meta: { error: { type: 'authentication_error', message: 'invalid api key' } },
    });
    expect(r.kind).toBe('infra');
  });

  it('classifies permission_error meta as infra', () => {
    const r = classifyFailure({
      meta: { error: { type: 'permission_error', message: 'no access' } },
    });
    expect(r.kind).toBe('infra');
  });

  it('classifies rate_limit_error from meta as infra (was transient)', () => {
    const r = classifyFailure({
      meta: { error: { type: 'rate_limit_error', message: 'slow down' } },
    });
    expect(r.kind).toBe('infra');
  });

  it('classifies overloaded_error as infra', () => {
    expect(classifyFailure({ meta: { error: { type: 'overloaded_error' } } }).kind).toBe('infra');
  });

  it('classifies "401 Unauthorized" text as infra (permission patterns)', () => {
    expect(classifyFailure({ error: 'HTTP 401 Unauthorized' }).kind).toBe('infra');
  });

  it('classifies "Forbidden" text as infra (permission patterns)', () => {
    expect(classifyFailure({ error: 'Forbidden access to resource' }).kind).toBe('infra');
  });

  it('classifies permission_denied as infra', () => {
    expect(classifyFailure({ error: 'permission_denied' }).kind).toBe('infra');
  });

  it('classifies validation_error text as code (was permanent)', () => {
    expect(classifyFailure({ error: 'schema validation_error: missing field' }).kind).toBe('code');
  });

  it('classifies ETIMEDOUT as timeout (unchanged)', () => {
    expect(classifyFailure({ error: 'connect ETIMEDOUT 1.2.3.4:443' }).kind).toBe('timeout');
  });

  it('classifies "no progress for" as timeout', () => {
    expect(classifyFailure({ error: 'no progress for 5m' }).kind).toBe('timeout');
  });

  it('classifies "heartbeat stale" as timeout', () => {
    expect(classifyFailure({ error: 'heartbeat stale' }).kind).toBe('timeout');
    expect(classifyFailure({ error: 'heartbeat missing' }).kind).toBe('timeout');
  });

  it('classifies "runner stale" as infra (transient patterns)', () => {
    // The "runner (offline|stale|disconnected)" branch lives in the
    // transient→infra bucket; mixed phrasings like "runner stale heartbeat"
    // can legitimately land on either side of the split and are not asserted.
    expect(classifyFailure({ error: 'runner stale' }).kind).toBe('infra');
  });

  it('classifies ECONNRESET as infra (was transient)', () => {
    expect(classifyFailure({ error: 'socket ECONNRESET' }).kind).toBe('infra');
  });

  it('classifies "503 Service Unavailable" as infra', () => {
    expect(classifyFailure({ error: 'HTTP 503 Service Unavailable' }).kind).toBe('infra');
  });

  it('classifies HTTP 429 / rate limit as infra', () => {
    expect(classifyFailure({ error: 'rate limit exceeded' }).kind).toBe('infra');
    expect(classifyFailure({ error: '429 too many requests' }).kind).toBe('infra');
  });

  it('classifies "runner offline" as infra', () => {
    expect(classifyFailure({ error: 'runner offline (server unreachable)' }).kind).toBe('infra');
  });

  it('classifies preflight failures as infra (ISS-451 runner preflight)', () => {
    expect(
      classifyFailure({ error: 'preflight_failed: push_credentials: ls-remote timed out' }).kind,
    ).toBe('infra');
  });

  describe('cc-startup death → transient-cc (ISS-402 class)', () => {
    it('structured signal: died with no tool use and ≤3 messages', () => {
      const r = classifyFailure({
        error: 'Agent completed with errors',
        signals: { diedBeforeFirstToolUse: true, sessionMessageCount: 2 },
      });
      expect(r.kind).toBe('transient-cc');
      expect(r.reason).toContain('cc-startup-death');
    });

    it('structured signal takes precedence over text patterns', () => {
      // Text alone would land on infra (transient patterns); the signal wins.
      const r = classifyFailure({
        error: 'network error during startup',
        signals: { diedBeforeFirstToolUse: true, sessionMessageCount: 1 },
      });
      expect(r.kind).toBe('transient-cc');
    });

    it('does NOT fire when the session used tools (a real run died)', () => {
      const r = classifyFailure({
        error: 'socket ECONNRESET',
        signals: { diedBeforeFirstToolUse: false, sessionMessageCount: 2 },
      });
      expect(r.kind).toBe('infra');
    });

    it('does NOT fire past the message threshold', () => {
      const r = classifyFailure({
        error: 'socket ECONNRESET',
        signals: { diedBeforeFirstToolUse: true, sessionMessageCount: 10 },
      });
      expect(r.kind).toBe('infra');
    });

    it('text fallback: "Unknown command" matches when no signal is available', () => {
      const r = classifyFailure({ error: 'Unknown command: /forge-code' });
      expect(r.kind).toBe('transient-cc');
    });
  });

  it('classifies unmatched text as infra with needsReview (no unknown class — I4)', () => {
    const r = classifyFailure({ error: 'weirdness nobody mapped' });
    expect(r.kind).toBe('infra');
    expect(r.reason).toContain('weirdness nobody mapped');
    expect((r.meta as { needsReview?: boolean })?.needsReview).toBe(true);
  });

  it('classifies empty input as infra with a stable reason + needsReview', () => {
    const r = classifyFailure({});
    expect(r.kind).toBe('infra');
    expect(r.reason).toBe('unclassified');
    expect((r.meta as { needsReview?: boolean })?.needsReview).toBe(true);
  });

  it('preserves meta on the result so the sweeper / UI can render it', () => {
    const meta = { error: { type: 'invalid_request_error', message: 'x' }, request_id: 'req_abc' };
    const r = classifyFailure({ error: 'API Error', meta });
    expect(r.meta).toBe(meta);
  });

  it('preserves caller meta fields on the needsReview fallback', () => {
    const meta = { request_id: 'req_abc' };
    const r = classifyFailure({ error: 'totally unmapped', meta });
    expect(r.meta).toMatchObject({ request_id: 'req_abc', needsReview: true });
  });

  it('truncates very long error excerpts in reason (UI sanity)', () => {
    const long = 'x'.repeat(500);
    const r = classifyFailure({ error: long });
    expect(r.reason.length).toBeLessThanOrEqual(200);
    expect(r.reason).toMatch(/…$/);
  });

  it('prefers code when both pattern groups match (permanent is more specific)', () => {
    const r = classifyFailure({
      error: 'invalid_request_error: rate limit-shaped phrasing but auth was the real cause',
    });
    expect(r.kind).toBe('code');
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
      expect(r.kind).toBe('infra');
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
