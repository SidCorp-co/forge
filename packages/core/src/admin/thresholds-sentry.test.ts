/**
 * ISS-1085 slice 3 — criteria 11 and 12: the two Sentry admission thresholds as OPERATOR POLICY.
 *
 * Its own file, not an addition to an existing admin suite, because `admin/` has no thresholds
 * test at all: `thresholds.ts` and `thresholds-routes.ts` shipped under ISS-654 covered only by
 * integration tests that need a database. These two criteria are about the shape of the policy —
 * what an absent row means, and what the write door refuses — and both are answerable without one.
 *
 * Criterion 11 is the one worth stating plainly: an `admin_thresholds` table with NO ROW must
 * admit exactly what a row written from `ADMIN_THRESHOLD_DEFAULTS` would. A fleet that has never
 * opened the Ops Console has no row, so the defaults are not a fallback — they are the policy in
 * force for every such fleet, and `judgeSentryIssue` must not be able to tell the difference.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
const ADMIN_EMAIL = 'ops@example.com';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test', ADMIN_EMAILS: ADMIN_EMAIL },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn((_p: unknown) => ({ limit: selectLimit }));
const selectFrom = vi.fn((_p: unknown) => ({ where: selectWhere }));
const onConflictDoUpdate = vi.fn(async (_p: unknown) => undefined);
const insertValues = vi.fn((_p: unknown) => ({ onConflictDoUpdate }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const { Hono } = await import('hono');
const { adminThresholdRoutes } = await import('./thresholds-routes.js');
const { readThresholds } = await import('./thresholds.js');
const { ADMIN_THRESHOLD_DEFAULTS, SENTRY_THRESHOLD_MAX, SENTRY_THRESHOLD_MIN } = await import(
  './types.js'
);
const { judgeSentryIssue } = await import('../integrations/sentry/admission.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');

const USER_ID = '22222222-2222-4222-8222-222222222222';

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.route('/api/admin', adminThresholdRoutes);
  app.onError(errorHandler);
  return app;
}

/** The two `users` reads every gated route makes: `assertEmailVerified`, then `requireAdmin`. */
function authedAsAdmin() {
  selectLimit.mockResolvedValueOnce([
    { id: USER_ID, email: ADMIN_EMAIL, emailVerifiedAt: new Date() },
  ]);
}

async function put(body: Record<string, unknown>) {
  return buildApp().request('/api/admin/thresholds', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await signUserToken(USER_ID)}`,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  onConflictDoUpdate.mockClear();
});

describe('criterion 11 — an absent row is the default policy, not a missing one', () => {
  it('answers the shipped defaults when `admin_thresholds` holds no row', async () => {
    selectLimit.mockResolvedValueOnce([]);
    await expect(readThresholds()).resolves.toEqual(ADMIN_THRESHOLD_DEFAULTS);
  });

  // cm:guard this one exists because the mutation that swaps `row.sentryMinEventCount` for
  // `ADMIN_THRESHOLD_DEFAULTS.sentryMinEventCount` SURVIVED the test below it: that test compares a
  // no-row reading against a row whose values ARE the defaults, so serving the defaults in place of
  // the stored row is undetectable there. The failure it misses is the one that matters — an
  // operator sets 25 and the gate keeps filing at 10, with nothing anywhere saying so.
  it('reads a stored policy back verbatim, rather than serving the defaults over it', async () => {
    selectLimit.mockResolvedValueOnce([
      { ...ADMIN_THRESHOLD_DEFAULTS, sentryMinEventCount: 25, sentryMinUserCount: 7 },
    ]);
    await expect(readThresholds()).resolves.toMatchObject({
      sentryMinEventCount: 25,
      sentryMinUserCount: 7,
    });
  });

  it('carries the stored policy into the gate, so a raised floor actually refuses', async () => {
    selectLimit.mockResolvedValueOnce([
      { ...ADMIN_THRESHOLD_DEFAULTS, sentryMinEventCount: 25, sentryMinUserCount: 7 },
    ]);
    const policy = await readThresholds();
    const twentyEvents = {
      id: 'CORE-9',
      shortId: 'CORE-9',
      status: 'unresolved',
      substatus: null,
      level: 'error',
      count: 20,
      userCount: 9,
      firstSeen: null,
      lastSeen: null,
      permalink: null,
      projectSlug: 'forge-core',
      title: null,
      culprit: null,
      metadataValue: null,
    };
    // 20 events clears the DEFAULT floor of 10 and not the stored floor of 25. A reader that served
    // the defaults over the row would admit this; the operator's own policy refuses it.
    const verdict = judgeSentryIssue(twentyEvents, {
      minEventCount: policy.sentryMinEventCount,
      minUserCount: policy.sentryMinUserCount,
    });
    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toContain('25');
  });

  it('admits and refuses identically with no row and with a row written from the defaults', async () => {
    // cm:guard the claim is about the GATE's answer, not about two objects being equal — the
    // reader already asserted that above. A row could carry the same numbers and still be read
    // through a different code path, so both readings are put through `judgeSentryIssue` and the
    // verdicts compared, including the message, which is what an operator actually sees.
    selectLimit.mockResolvedValueOnce([]);
    const fromAbsentRow = await readThresholds();

    selectLimit.mockResolvedValueOnce([{ ...ADMIN_THRESHOLD_DEFAULTS }]);
    const fromWrittenRow = await readThresholds();

    const issue = (
      shortId: string,
      over: Partial<import('../integrations/sentry/types.js').SentryIssueDetail>,
    ): import('../integrations/sentry/types.js').SentryIssueDetail => ({
      id: shortId,
      shortId,
      status: 'unresolved',
      substatus: null,
      level: 'error',
      count: 10,
      userCount: 2,
      firstSeen: null,
      lastSeen: null,
      permalink: null,
      projectSlug: 'forge-core',
      title: null,
      culprit: null,
      metadataValue: null,
      ...over,
    });

    const cases = [
      issue('CORE-1', {}), // clears both thresholds exactly
      issue('CORE-2', { count: 9 }), // one event short
      issue('CORE-3', { userCount: 1 }), // one user short
      issue('CORE-4', { level: 'warning', count: 99, userCount: 9 }), // loud, wrong level
      issue('CORE-5', { count: null }), // absent, which is not zero
    ];

    for (const c of cases) {
      const a = judgeSentryIssue(c, {
        minEventCount: fromAbsentRow.sentryMinEventCount,
        minUserCount: fromAbsentRow.sentryMinUserCount,
      });
      const b = judgeSentryIssue(c, {
        minEventCount: fromWrittenRow.sentryMinEventCount,
        minUserCount: fromWrittenRow.sentryMinUserCount,
      });
      expect({ shortId: c.shortId, verdict: a }).toEqual({ shortId: c.shortId, verdict: b });
    }

    // and the defaults are a policy that REFUSES the marginal case, which is the point of ISS-1085:
    // nine events is one short of the shipped floor, and an operator who has never opened the Ops
    // Console gets that refusal rather than the filing.
    const marginal = judgeSentryIssue(issue('CORE-2', { count: 9 }), {
      minEventCount: fromAbsentRow.sentryMinEventCount,
      minUserCount: fromAbsentRow.sentryMinUserCount,
    });
    expect(marginal.admit).toBe(false);
    expect(marginal.admit === false && marginal.reason).toContain('10');

    // the one that clears them is admitted, so the comparison above is not two refusals agreeing
    expect(
      judgeSentryIssue(issue('CORE-1', {}), {
        minEventCount: fromAbsentRow.sentryMinEventCount,
        minUserCount: fromAbsentRow.sentryMinUserCount,
      }).admit,
    ).toBe(true);
  });
});

describe('criterion 12 — the write door refuses a threshold outside its bounds', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['below the minimum by one', SENTRY_THRESHOLD_MIN - 1],
    ['fractional', 2.5],
    ['above the maximum', SENTRY_THRESHOLD_MAX + 1],
  ])('400s a sentryMinEventCount that is %s, and writes nothing', async (_name, value) => {
    authedAsAdmin();
    const res = await put({ sentryMinEventCount: value });
    expect(res.status).toBe(400);
    // cm:guard the refusal must also be a NON-WRITE. A 400 that had already upserted would leave
    // the operator reading a value the response told them was invalid — the status code alone does
    // not say which of the two happened.
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['fractional', 1.5],
    ['above the maximum', SENTRY_THRESHOLD_MAX + 1],
  ])('400s a sentryMinUserCount that is %s', async (_name, value) => {
    authedAsAdmin();
    const res = await put({ sentryMinUserCount: value });
    expect(res.status).toBe(400);
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('accepts the boundary values rather than refusing them', async () => {
    authedAsAdmin();
    selectLimit.mockResolvedValueOnce([]); // readThresholds inside the handler: no row yet
    const res = await put({
      sentryMinEventCount: SENTRY_THRESHOLD_MIN,
      sentryMinUserCount: SENTRY_THRESHOLD_MAX,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sentryMinEventCount: SENTRY_THRESHOLD_MIN,
      sentryMinUserCount: SENTRY_THRESHOLD_MAX,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('patches one Sentry threshold without discarding the other keys', async () => {
    // cm:why this is the `wholesale-config-clobber` shape and the reason the handler merges over
    // the EFFECTIVE row. A PUT naming one key must not reset the seven it did not name.
    authedAsAdmin();
    selectLimit.mockResolvedValueOnce([
      { ...ADMIN_THRESHOLD_DEFAULTS, stuckJobSeconds: 999, sentryMinEventCount: 50 },
    ]);
    const res = await put({ sentryMinEventCount: 25 });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sentryMinEventCount: 25,
      sentryMinUserCount: ADMIN_THRESHOLD_DEFAULTS.sentryMinUserCount,
      stuckJobSeconds: 999,
    });
  });

  it('refuses a key the schema does not declare rather than ignoring it', async () => {
    authedAsAdmin();
    const res = await put({ sentryMinEventCounts: 5 });
    expect(res.status).toBe(400);
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });
});
