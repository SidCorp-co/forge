import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_VERSION, classifyFailure } from './failure-classifier.js';

describe('failure-classifier', () => {
  it('returns CLASSIFIER_VERSION on every result so callers can pin it', () => {
    expect(CLASSIFIER_VERSION).toBe(3);
    expect(classifyFailure({}).version).toBe(CLASSIFIER_VERSION);
    expect(classifyFailure({ error: 'whatever' }).version).toBe(CLASSIFIER_VERSION);
  });

  it('classifies content-filter blocks as code (Decision C: permanent→code)', () => {
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

  it('classifies authentication_error meta as infra (Decision C: permission→infra)', () => {
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

  it('classifies rate_limit_error from meta as infra (Decision C: transient→infra)', () => {
    const r = classifyFailure({
      meta: { error: { type: 'rate_limit_error', message: 'slow down' } },
    });
    expect(r.kind).toBe('infra');
  });

  it('classifies overloaded_error as infra', () => {
    const r = classifyFailure({ meta: { error: { type: 'overloaded_error' } } });
    expect(r.kind).toBe('infra');
  });

  it('classifies "401 Unauthorized" text as infra (permission→infra)', () => {
    expect(classifyFailure({ error: 'HTTP 401 Unauthorized' }).kind).toBe('infra');
  });

  it('classifies "Forbidden" text as infra (permission→infra)', () => {
    expect(classifyFailure({ error: 'Forbidden access to resource' }).kind).toBe('infra');
  });

  it('classifies permission_denied as infra', () => {
    expect(classifyFailure({ error: 'permission_denied' }).kind).toBe('infra');
  });

  it('classifies validation_error text as code (permanent→code)', () => {
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

  it('classifies "runner stale" as infra (transient→infra, legacy phrasing)', () => {
    expect(classifyFailure({ error: 'runner stale' }).kind).toBe('infra');
  });

  it('classifies ECONNRESET as infra (transient→infra)', () => {
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

  describe('cc-startup-death → transient-cc (ISS-450 / ISS-402)', () => {
    it('classifies a tiny session that died before first tool use via structured signal', () => {
      const r = classifyFailure({
        error: 'agent session terminated',
        signals: { diedBeforeFirstToolUse: true, sessionMessageCount: 2 },
      });
      expect(r.kind).toBe('transient-cc');
      expect(r.reason).toMatch(/cc-startup/i);
    });

    it('does NOT treat a long-running session as a startup death (message threshold)', () => {
      const r = classifyFailure({
        error: 'socket ECONNRESET',
        signals: { diedBeforeFirstToolUse: true, sessionMessageCount: 42 },
      });
      expect(r.kind).toBe('infra');
    });

    it('does NOT treat a session that used a tool as a startup death', () => {
      const r = classifyFailure({
        error: 'socket ECONNRESET',
        signals: { diedBeforeFirstToolUse: false, sessionMessageCount: 1 },
      });
      expect(r.kind).toBe('infra');
    });

    it('falls back to the "Unknown command" error signature when no signal', () => {
      expect(classifyFailure({ error: 'Unknown command: /forge-review' }).kind).toBe(
        'transient-cc',
      );
    });
  });

  it('classifies unmatched text as infra + flags needsReview (gets cautious retry)', () => {
    const r = classifyFailure({ error: 'inscrutable weirdness' });
    expect(r.kind).toBe('infra');
    expect(r.reason).toContain('inscrutable weirdness');
    expect(r.meta).toMatchObject({ needsReview: true });
  });

  it('classifies empty input as infra with a stable reason', () => {
    expect(classifyFailure({}).kind).toBe('infra');
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

  it('prefers code when both pattern groups match (permanent→code is more specific)', () => {
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
