/**
 * ISS-760 (REQ-45 BC-2, BC-10, BC-12; issue-lifecycle revision 23): an issue a requirement-level
 * fail reopened goes back the way it came once the fail is routed past it.
 *
 * Planted from orbit: REQ-3 BC-3 was traced by ISS-16, closed with its own half passing, and by
 * ISS-18, still building the rest. A fail recorded at the requirement before ISS-756 reopened ISS-16,
 * and from `reopen` the lifecycle had no move back: `closed` is the design-only close
 * (DESIGN_NOT_DELIVERED) and `awaiting_release` no edge at all. The move back is allowed only where
 * the reopen came from a requirement-level fail, to the status it came from, and the fail's routing
 * (`requirements/verdicts.ts:routeFail`) would leave the issue standing; it is refused by name
 * otherwise.
 *
 * @direct-test-of packages/core/src/issues/transition-guards.ts
 * @direct-test-of packages/core/src/issues/fail-return.ts
 * @direct-test-of packages/core/src/issues/fail-wording.ts
 * @direct-test-of packages/core/src/issues/design-delivered-guard.ts
 * @direct-test-of packages/core/src/issues/release-evidence.ts
 * @direct-test-of packages/core/src/requirements/fail-return.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const NEW = '2222222222222222222222222222222222222222';
const LIVE = '9999999999999999999999999999999999999999';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  // a move back to `closed`, or a reopen from `awaiting_release`, enqueues the memory reconcile
  // (`memory/reconcile.ts:registerMemoryReconcileTrigger`): its queue exists as the server boots it
  await (await import('../../src/memory/index.js')).registerMemoryReconcileWorker();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (
    await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa: 'independent' } })
  ).id;
  token = await userToken(ownerId);
  unplant = plantLiveBuild(LIVE, { [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<ApiResponse>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function agreedRequirement(): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Health',
      reason: 'planted',
      criteria: [{ body: 'Health answers the version and commit' }, { body: 'Health is public' }],
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(
    onProject('POST', `/requirements/${key}/revisions/1/accept`, {
      reason: 'Accepted for this test.',
    }),
  );
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

type At = 'closed' | 'awaiting_release' | 'in_progress';

/** Issue `seq` tracing BC-1 of `req` at `status`, landed at `mergedAt` on commit NEW where it is past its build. */
async function tracing(req: string, seq: number, status: At, mergedAt: string | null) {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    mergedAt: mergedAt ? new Date(mergedAt) : null,
  });
  // a landing Forge observed, which every source shape takes as the merge (`merged` guard)
  if (mergedAt) await rows(sql`UPDATE issues SET merged_commit_sha = ${NEW} WHERE id = ${id}`);
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
  await ok(api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes: ['BC-1'] }));
  await seedIssueStatus(id, status);
  return id;
}

/** A person's verdict on criterion 1 of `issueId` at the commit the live build holds. */
async function judged(issueId: string, verdict: 'pass' | 'fail') {
  const res = await api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict,
    reason: verdict === 'pass' ? 'the commit half answers' : 'the commit half is gone',
    identity: { kind: 'commit', sha: NEW },
    evidence: ['healthz.txt'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await settleOutbox();
}

/** The master's fail on BC-1 at the requirement, as orbit's 08:18Z verdict was. */
async function failAtRequirement(req: string): Promise<string> {
  const res = await onProject('POST', `/requirements/${req}/verdicts`, {
    criterion: 'BC-1',
    verdict: 'fail',
    reason: 'the running build answers no version',
    identity: { kind: 'commit', sha: NEW },
    evidence: ['healthz.txt'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await settleOutbox();
  return String(res.body.verdictId);
}

const move = (issueId: string, toStatus: string, reason?: string) =>
  api(token, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus,
    ...(reason ? { reason } : {}),
  });

function refusal(res: ApiResponse): { code: string; detail: string } {
  const listed = (res.body.error as { refusals?: { code: string; detail: string }[] } | undefined)
    ?.refusals;
  return listed?.[0] ?? { code: String(res.body.code), detail: String(res.body.detail) };
}

async function statusOf(issueId: string): Promise<string> {
  const [row] = await rows<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return row?.status ?? 'missing';
}

async function saidOn(issueId: string): Promise<string[]> {
  return (
    await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at`,
    )
  ).map((r) => r.body);
}

/** ISS-1's verdict on BC-1 as the requirement's coverage reads it now. */
async function coveredBy(req: string, issueId: string): Promise<string | null> {
  const read = await ok(onProject('GET', `/requirements/${req}`));
  const coverage = (
    read.standing as {
      coverage: { code: string; issues: { issueId: string; verdict: string | null }[] }[];
    }
  ).coverage;
  return (
    coverage.find((c) => c.code === 'BC-1')?.issues.find((l) => l.issueId === issueId)?.verdict ??
    null
  );
}

/**
 * The move the fail consumer wrote before ISS-756 (`issues/fail-reopen.ts:reopenOnFail`), with its
 * reason as that consumer worded it then (`delivered`) or words it now (`traces`).
 */
async function reopenAsTheFailDid(
  issueId: string,
  req: string,
  verdictId: string,
  wording: 'delivered' | 'traces',
) {
  await ok(
    move(
      issueId,
      'reopen',
      `${req} BC-1, which this issue ${wording}, was judged fail at its requirement (verdict ${verdictId}): the running build answers no version. A failing verdict reopens the issue that owns the work: correct it here, not in a new issue.`,
    ),
  );
}

/**
 * orbit's ISS-16: ISS-1 landed at `at` with its own criterion passing, ISS-2 building the rest, and a
 * fail at the requirement that, before ISS-756, sent ISS-1 back. ISS-756 leaves it standing now, so
 * the reopen it no longer makes is written as it was then.
 */
async function reopenedByRequirementFail(
  at: 'closed' | 'awaiting_release',
  wording: 'delivered' | 'traces' = 'traces',
) {
  const req = await agreedRequirement();
  const delivered = await tracing(req, 1, at, '2026-10-20T00:00:00Z');
  await judged(delivered, 'pass');
  const building = await tracing(req, 2, 'in_progress', null);
  const verdictId = await failAtRequirement(req);
  expect(await statusOf(delivered)).toBe(at);
  await reopenAsTheFailDid(delivered, req, verdictId, wording);
  expect(await statusOf(delivered)).toBe('reopen');
  return { req, delivered, building, verdictId };
}

describe('c1: an issue a requirement fail reopened goes back once its own half passes and another owns the rest', () => {
  it('moves ISS-1 from reopen back to closed, with the note an issue the fail stays on gets (orbit ISS-16)', async () => {
    const { req, delivered, verdictId } = await reopenedByRequirementFail('closed');

    const res = await move(delivered, 'closed');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await statusOf(delivered)).toBe('closed');
    const said = await saidOn(delivered);
    const note = said.at(-1) ?? '';
    expect(note).toContain(
      `${req} BC-1, which this issue traces, was judged fail at its requirement`,
    );
    expect(note).toContain(verdictId);
    expect(note).toContain('It stays at `closed`');
    expect(note).toContain('ISS-2 owns what is missing');
    // the same note ISS-756 posted when the fail was recorded, now posted again by the return
    expect(said.filter((b) => b.includes('It stays at `closed`'))).toHaveLength(2);
    // the return undid the reopen: the pass it voided counts again
    expect(await coveredBy(req, delivered)).toBe('pass');
  });

  it('moves it back to awaiting release where the fail reopened it from there', async () => {
    const { delivered } = await reopenedByRequirementFail('awaiting_release');

    const res = await move(delivered, 'awaiting_release');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await statusOf(delivered)).toBe('awaiting_release');
  });

  it('reads a reopen written before ISS-756, whose reason says the issue delivered the BC', async () => {
    const { delivered } = await reopenedByRequirementFail('closed', 'delivered');

    const res = await move(delivered, 'closed');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await statusOf(delivered)).toBe('closed');
  });
});

describe('c2: a reopen from anything but a requirement fail is refused the move back by name', () => {
  it("refuses the issue its own criterion's fail reopened", async () => {
    const req = await agreedRequirement();
    const delivered = await tracing(req, 1, 'closed', '2026-10-20T00:00:00Z');
    await tracing(req, 2, 'in_progress', null);
    await judged(delivered, 'fail');
    expect(await statusOf(delivered)).toBe('reopen');

    const res = await move(delivered, 'closed');

    expect(refusal(res).code).toBe('REOPEN_NOT_BY_REQUIREMENT_FAIL');
    expect(await statusOf(delivered)).toBe('reopen');
  });

  it("refuses the issue a person reopened, and one whose reason cites a verdict that is not a requirement's fail", async () => {
    const req = await agreedRequirement();
    const delivered = await tracing(req, 1, 'closed', '2026-10-20T00:00:00Z');
    await judged(delivered, 'pass');
    await tracing(req, 2, 'in_progress', null);
    await ok(move(delivered, 'reopen', 'The health page shows the wrong commit.'));

    expect(refusal(await move(delivered, 'closed')).code).toBe('REOPEN_NOT_BY_REQUIREMENT_FAIL');

    await seedIssueStatus(delivered, 'closed');
    await ok(
      move(
        delivered,
        'reopen',
        `${req} BC-1, which this issue traces, was judged fail at its requirement (verdict 00000000-0000-4000-8000-000000000000): planted.`,
      ),
    );
    const res = await move(delivered, 'closed');
    expect(refusal(res).code).toBe('REOPEN_NOT_BY_REQUIREMENT_FAIL');
    expect(await statusOf(delivered)).toBe('reopen');
  });
});

describe('c3: an issue whose own criterion on the BC does not pass stays reopened', () => {
  it('refuses the move back naming criterion 1, failed since the reopen', async () => {
    const { delivered } = await reopenedByRequirementFail('closed');
    await judged(delivered, 'fail');

    const res = await move(delivered, 'closed');

    const why = refusal(res);
    expect(why.code).toBe('REOPEN_CRITERIA_NOT_PASSING');
    expect(why.detail).toContain('criterion 1');
    expect(await statusOf(delivered)).toBe('reopen');
  });

  it('refuses it where no other issue owns what the BC lacks', async () => {
    const req = await agreedRequirement();
    const only = await tracing(req, 1, 'closed', '2026-10-20T00:00:00Z');
    await judged(only, 'pass');
    await failAtRequirement(req);

    const res = await move(only, 'closed');

    expect(refusal(res).code).toBe('REOPEN_FAIL_UNOWNED');
    expect(await statusOf(only)).toBe('reopen');
  });
});

describe('c4: an issue reopened twice goes back to where the second reopen took it from', () => {
  it('refuses closed naming awaiting release, and moves it to awaiting release', async () => {
    const { req, delivered } = await reopenedByRequirementFail('closed');
    // landed again, as a run landing it would leave it; its pass sits before the first reopen, so the
    // next fail at the requirement finds its own criterion not passing and sends it back from there
    await seedIssueStatus(delivered, 'awaiting_release');
    await failAtRequirement(req);
    expect(await statusOf(delivered)).toBe('reopen');

    const wrong = await move(delivered, 'closed');
    expect(refusal(wrong).code).toBe('ILLEGAL_TRANSITION');
    expect(refusal(wrong).detail).toContain('`awaiting_release`');
    expect(await statusOf(delivered)).toBe('reopen');

    const res = await move(delivered, 'awaiting_release');
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await statusOf(delivered)).toBe('awaiting_release');
  });
});
