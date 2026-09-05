import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_VERSION, classifyFailure, deriveActionFromKind } from './failure-classifier.js';

describe('failure-classifier (v3 taxonomy — ISS-450)', () => {
  it('returns CLASSIFIER_VERSION on every result so callers can pin it', () => {
    expect(CLASSIFIER_VERSION).toBe(11);
    expect(classifyFailure({}).version).toBe(CLASSIFIER_VERSION);
    expect(classifyFailure({ error: 'whatever' }).version).toBe(CLASSIFIER_VERSION);
  });

  describe('ISS-479 — explicit runner failureReason tokens', () => {
    it('routes [MCP_INIT_FAILED] to infra', () => {
      const r = classifyFailure({
        error: '[MCP_INIT_FAILED] forge(failed) did not connect at startup',
      });
      expect(r.kind).toBe('infra');
    });

    it('routes [SIGNAL_KILLED] to infra (OOM/host)', () => {
      const r = classifyFailure({ error: '[SIGNAL_KILLED] signal=9' });
      expect(r.kind).toBe('infra');
    });

    it('routes [NO_RESULT_CLEAN_EXIT] to transient-cc (startup death → failover)', () => {
      const r = classifyFailure({
        error: '[NO_RESULT_CLEAN_EXIT] claude exited 0 before emitting a result event',
      });
      expect(r.kind).toBe('transient-cc');
    });

    it('routes [NO_RESULT_EXIT] to transient-cc', () => {
      const r = classifyFailure({ error: '[NO_RESULT_EXIT] exitCode=1, no result event' });
      expect(r.kind).toBe('transient-cc');
    });

    it('the runner token wins over the cc-startup message-count heuristic', () => {
      // cm:why an MCP-init death also looks like `diedBeforeFirstToolUse`, so this asserts the token wins over the heuristic rather than agreeing with it by luck.
      const r = classifyFailure({
        error: '[MCP_INIT_FAILED] forge(failed) did not connect at startup',
        signals: { diedBeforeFirstToolUse: true, sessionMessageCount: 1 },
      });
      expect(r.kind).toBe('infra');
    });

    it('[RESULT_ERROR] falls through to message patterns (invalid_request → code)', () => {
      const r = classifyFailure({ error: '[RESULT_ERROR] invalid_request_error: bad input' });
      expect(r.kind).toBe('code');
    });
  });

  describe('ISS-596 — usage/session limit → transient-cc (cross-device failover)', () => {
    it('routes CLI session-limit text to transient-cc', () => {
      const r = classifyFailure({
        error:
          "[RESULT_ERROR] success: You've hit your session limit · resets 1pm (Asia/Ho_Chi_Minh)",
      });
      expect(r.kind).toBe('transient-cc');
      expect(r.reason).toContain('usage/session limit');
    });

    it('routes [USAGE_LIMIT] runner token to transient-cc', () => {
      const r = classifyFailure({ error: '[USAGE_LIMIT] usage limit reached; resets 6pm (UTC)' });
      expect(r.kind).toBe('transient-cc');
    });

    it('plain 429 / rate-limit still classifies as infra (unchanged)', () => {
      expect(classifyFailure({ error: '429 too many requests' }).kind).toBe('infra');
      expect(classifyFailure({ error: 'rate limit exceeded' }).kind).toBe('infra');
    });

    it('[MCP_INIT_FAILED] still wins as infra (runner token beats usage-limit check)', () => {
      // MCP init failures should not be reclassified as transient-cc.
      const r = classifyFailure({
        error: '[MCP_INIT_FAILED] forge(failed) did not connect at startup',
      });
      expect(r.kind).toBe('infra');
    });
  });

  describe('ISS-823 — org/account spend-cap → transient-cc/failover (spec override)', () => {
    it('pins the exact evidenced string to failover, NOT terminal', () => {
      const r = classifyFailure({ error: "You've hit your org's monthly spend limit" });
      expect(r.kind).toBe('transient-cc');
      expect(r.action).toBe('failover');
      expect(r.meta).toMatchObject({ limitScope: 'account-spend' });
    });

    it('still classifies a time-windowed limit as failover (no regression)', () => {
      const r = classifyFailure({
        error: "You've hit your 5-hour limit. Your limit resets 11am (Asia/Bangkok).",
      });
      expect(r.kind).toBe('transient-cc');
      expect(r.action).toBe('failover');
      expect((r.meta as Record<string, unknown> | null)?.limitScope).toBeUndefined();
    });
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
    expect(classifyFailure({ error: 'preflight_failed: hooks_path: missing' }).kind).toBe('infra');
  });

  // cm:guard assert BOTH axes on every case — this test read only `.kind` and demanded `code`, which is how a runner-workspace fault came to blame the repo. The `terminal` half is the load-bearing one (retrying a missing git repo is the ubuntu1 loop, 8 jobs on 2026-08-14); `infra` is the half a triaging human reads.
  it('classifies structural preflight sub-variants as infra with a terminal action (ISS-808)', () => {
    for (const error of [
      "preflight_failed: origin_remote: no 'origin' remote configured",
      'preflight_failed: work_tree: not a git working tree',
      'preflight_failed: repo_path: not a directory',
    ]) {
      expect(classifyFailure({ error })).toMatchObject({ kind: 'infra', action: 'terminal' });
    }
  });

  it('still retries the non-structural preflight checks — those a runner can recover from', () => {
    expect(classifyFailure({ error: 'preflight_failed: hooks_path: missing' })).toMatchObject({
      kind: 'infra',
      action: 'retry',
    });
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
      // cm:why the text alone lands on infra via the transient patterns, so this asserts the signal overrides it rather than agreeing with it.
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
    expect(r.action).toBe('retry');
    expect(r.reason).toContain('weirdness nobody mapped');
    expect((r.meta as { needsReview?: boolean })?.needsReview).toBe(true);
  });

  it('classifies empty input as infra with a stable reason + needsReview', () => {
    const r = classifyFailure({});
    expect(r.kind).toBe('infra');
    expect(r.action).toBe('retry');
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

  describe('ISS-823 — action axis', () => {
    it('assigns terminal to code failures', () => {
      const r = classifyFailure({
        meta: { error: { type: 'invalid_request_error', message: 'bad input' } },
      });
      expect(r.kind).toBe('code');
      expect(r.action).toBe('terminal');
    });

    it('deriveActionFromKind round-trips all four kinds', () => {
      expect(deriveActionFromKind('code')).toBe('terminal');
      expect(deriveActionFromKind('transient-cc')).toBe('failover');
      expect(deriveActionFromKind('infra')).toBe('retry');
      expect(deriveActionFromKind('timeout')).toBe('retry');
    });
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

describe('duplex session channel failures (RFC 0003)', () => {
  it('classifies a failed write as infra, retryable', () => {
    const r = classifyFailure({ error: 'session_send_failed: stdin write aborted' });
    expect(r.kind).toBe('infra');
    expect(r.action).toBe('retry');
  });

  it('does NOT let session_ack_timeout fall into the generic timeout bucket', () => {
    const r = classifyFailure({ error: 'session_ack_timeout after 10000ms' });
    expect(r.kind).toBe('infra');
  });

  it('classifies a checkpoint that overran its deadline as infra', () => {
    const r = classifyFailure({ error: 'session_checkpoint_deadline_exceeded' });
    expect(r.kind).toBe('infra');
    expect(r.action).toBe('retry');
  });
});

describe('failure-classifier — a full box says the box is full (ISS-920)', () => {
  // cm:guard the literal the runner renders, not an approximation — `acquire_session_permit`'s own test pins the same bytes, and the digits are why: a cap or wait rendering as 503 would be claimed by TRANSIENT_PATTERNS' /\\b50[0-9]\\b/ if this bucket sat behind it.
  const SATURATED =
    'session_permit_saturated: all 3 duplex permits on this box held after 600s; ' +
    'holders: codemap, forge-dev, forge-dev';

  it('routes a saturated box to failover, not to a retry on the same box', () => {
    const r = classifyFailure({ error: SATURATED });
    expect(r.kind).toBe('infra');
    expect(r.action).toBe('failover');
    expect(r.cause).toBe('box_session_saturated');
    expect(r.meta?.needsReview).toBeUndefined();
  });

  it('keeps the holders in the reason an operator reads', () => {
    expect(classifyFailure({ error: SATURATED }).reason).toContain('holders: codemap');
  });

  // cm:why the permit wait no longer runs under the root lock, so a lock timeout can only mean a sibling genuinely spent the wait in preflight or `git worktree add` — a different event with a different cause.
  // cm:guard the SIGNAL is what this pins, and without it the whole bucket is dead code: a job that dies in either pre-spawn wait never spawned, and the heartbeat leaves `deriveCcStartupSignals` reading `total > 0, toolCalls === 0` — so `classifyFailure` was taking the cc-startup branch for every real occurrence while a signal-free test said otherwise.
  it('survives the cc-startup signal a job that never spawned always carries', () => {
    const signals = { diedBeforeFirstToolUse: true, sessionMessageCount: 0 };
    expect(classifyFailure({ error: SATURATED, signals }).cause).toBe('box_session_saturated');
    expect(classifyFailure({ error: SATURATED, signals }).action).toBe('failover');
    expect(
      classifyFailure({ error: 'repo_lock_timeout: /srv/x is still held after 600s', signals })
        .cause,
    ).toBe('repo_root_contention');
  });

  // cm:why the holder list is project slugs, so the routed text carries a value nobody validates — `store-403` would otherwise be claimed by PERMISSION_PATTERNS' /\b(401|403)\b/ and routed `retry`, back onto the box that just refused.
  it('a project slug that looks like an HTTP status does not change the routing', () => {
    const r = classifyFailure({
      error:
        'session_permit_saturated: all 503 duplex permits on this box held after 600s; ' +
        'holders: store-403, store-401',
    });
    expect(r.cause).toBe('box_session_saturated');
    expect(r.action).toBe('failover');
  });

  it('a repo-lock timeout is root contention and NOT saturation', () => {
    const r = classifyFailure({
      error: 'repo_lock_timeout: /home/forge/projects/codemap is still held after 600s',
    });
    expect(r.cause).toBe('repo_root_contention');
    expect(r.meta?.needsReview).toBeUndefined();
    expect(r.kind).toBe('infra');
  });
});
