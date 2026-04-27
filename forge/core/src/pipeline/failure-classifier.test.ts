import { describe, expect, it } from 'vitest';
import { CLASSIFIER_VERSION, classifyFailure } from './failure-classifier.js';

describe('failure-classifier', () => {
  it('returns CLASSIFIER_VERSION on every result so callers can pin it', () => {
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

  it('classifies authentication_error meta as permanent', () => {
    const r = classifyFailure({
      meta: { error: { type: 'authentication_error', message: 'invalid api key' } },
    });
    expect(r.kind).toBe('permanent');
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

  it('classifies "401 Unauthorized" text as permanent', () => {
    expect(classifyFailure({ error: 'HTTP 401 Unauthorized' }).kind).toBe('permanent');
  });

  it('classifies "Forbidden" text as permanent', () => {
    expect(classifyFailure({ error: 'Forbidden access to resource' }).kind).toBe('permanent');
  });

  it('classifies validation_error text as permanent', () => {
    expect(classifyFailure({ error: 'schema validation_error: missing field' }).kind).toBe(
      'permanent',
    );
  });

  it('classifies ETIMEDOUT as transient', () => {
    expect(classifyFailure({ error: 'connect ETIMEDOUT 1.2.3.4:443' }).kind).toBe('transient');
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
    expect(classifyFailure({ error: 'runner offline (no heartbeat for 6m)' }).kind).toBe(
      'transient',
    );
  });

  it('classifies "runner stale" / heartbeat stale as transient', () => {
    expect(classifyFailure({ error: 'runner stale heartbeat' }).kind).toBe('transient');
    expect(classifyFailure({ error: 'heartbeat stale' }).kind).toBe('transient');
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
});
