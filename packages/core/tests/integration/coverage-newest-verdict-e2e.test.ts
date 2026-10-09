/**
 * A business criterion's coverage is the newest verdict across every issue criterion tracing its
 * current wording (requirement-lifecycle `delivered`: "traced by an issue criterion whose latest
 * verdict on the running build is a pass"), not a vote every tracing row must win: a row nobody
 * judged does not mask a judged newer one, and an old fail stands only while it is the newest. Each
 * BC names the verdict that counts. A trace left on a reworded BC's earlier wording is refreshed to
 * the current wording from the issue's Criteria tab by the same tie act, matched by wording as
 * coverage matches it; the verdict the old wording earned stays on its retired row and does not
 * count for the new wording until it is judged again. A commit verdict, or the commit a runtime
 * served, counts only where the live build is read to hold it (`tests/helpers/live-build.ts` plants
 * one); where production cannot be read or the ancestry goes unanswered it does not count and its
 * line says why. Through the app's own routes, against real Postgres.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
/** The commit production serves in these tests, holding both OLD and NEW. */
const LIVE = '9999999999999999999999999999999999999999';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  unplant = plantLiveBuild(LIVE, { [OLD]: true, [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

const onProject = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function agreedRequirement(linkWorkflow?: string): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Reminders',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
    }),
  );
  const key = String(created.key);
  if (linkWorkflow) {
    await ok(onProject('POST', `/requirements/${key}/workflows`, { workflowId: linkWorkflow }));
  }
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, {}));
  await ok(onProject('POST', `/requirements/${key}/agree`, { revision: 1 }));
  return key;
}

/** A closed issue delivering `req`, tied to `codes` through the Criteria tab's act. */
async function closedIssueTracing(req: string, seq: number, codes: string[]): Promise<string> {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
  await ok(api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes }));
  return id;
}

/** A verdict on criterion `n` of `issueId` at `commit` (or the identity named), recorded as judged at `at`. */
async function judge(
  issueId: string,
  n: number,
  verdict: 'pass' | 'short' | 'fail',
  commit: string | Record<string, unknown>,
  at: string,
) {
  const r = await ok(
    api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: n,
      verdict,
      reason: `${verdict} on the running build`,
      identity: typeof commit === 'string' ? { kind: 'commit', sha: commit } : commit,
      evidence: ['shot.png'],
    }),
  );
  await db.execute(sql`UPDATE criterion_verdicts SET created_at = ${at} WHERE id = ${r.verdictId}`);
}

type Link = {
  displayId: string;
  criterion: number;
  verdict: string | null;
  identity: string | null;
  notCounted: string | null;
  stale: boolean;
};
type Bc = {
  code: string;
  body: string;
  verdict: string;
  issues: Link[];
  why: string | null;
  counts: {
    displayId: string;
    criterion: number;
    verdict: string;
    at: string;
    identity: string;
    commit: string | null;
    inLiveBuild: boolean | null;
  } | null;
};

async function standingOf(req: string) {
  const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
    standing: { coverage: Bc[]; facts: { criteria: number; passing: number; judged: number } };
  };
  return d.standing;
}
const bc = async (req: string, code: string) =>
  (await standingOf(req)).coverage.find((c) => c.code === code) as Bc;

describe('the newest verdict across the rows tracing a BC is the one that counts', () => {
  it('an older fail on one issue and an unjudged row on another do not outvote a newer pass', async () => {
    const req = await agreedRequirement();
    const older = await closedIssueTracing(req, 1, ['BC-1']);
    const newer = await closedIssueTracing(req, 2, ['BC-1']);
    await closedIssueTracing(req, 3, ['BC-1']);
    await judge(older, 1, 'fail', OLD, '2026-10-01T10:00:00Z');
    await judge(newer, 1, 'pass', NEW, '2026-10-05T10:00:00Z');

    const one = await bc(req, 'BC-1');

    expect(one.issues).toHaveLength(3);
    expect(one.verdict).toBe('passing');
    expect(one.counts).toEqual({
      issueId: newer,
      displayId: 'ISS-2',
      criterion: 1,
      verdict: 'pass',
      at: '2026-10-05T10:00:00.000Z',
      identity: `commit ${NEW.slice(0, 12)}`,
      commit: NEW,
      inLiveBuild: true,
    });
    expect((await standingOf(req)).facts).toMatchObject({ criteria: 2, passing: 1, judged: 1 });
  });

  it('a newer fail stands while it is the newest, and a later pass then counts again', async () => {
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-1']);
    await judge(a, 1, 'pass', OLD, '2026-10-01T10:00:00Z');
    await judge(b, 1, 'fail', NEW, '2026-10-05T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'failing',
      counts: { displayId: 'ISS-2', verdict: 'fail' },
    });

    await judge(a, 1, 'short', NEW, '2026-10-07T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1', verdict: 'short', commit: NEW },
    });
  });

  it('a BC traced only by rows nobody judged reads not judged, naming no verdict', async () => {
    const req = await agreedRequirement();
    await closedIssueTracing(req, 1, ['BC-2']);

    expect(await bc(req, 'BC-2')).toMatchObject({ verdict: 'not_judged', counts: null });
  });
});

describe('a trace left on a reworded BC is refreshed to the current wording', () => {
  async function reword(req: string) {
    await ok(
      onProject('POST', `/requirements/${req}/revisions`, {
        baseRevision: 1,
        reason: 'BC-1 reworded',
        criteria: [
          { code: 'BC-1', body: 'A nurse sees the reminder before the round' },
          { code: 'BC-2', body: 'A doctor sees the report' },
        ],
      }),
    );
    await ok(onProject('POST', `/requirements/${req}/revisions/2/propose`, {}));
    await ok(onProject('POST', `/requirements/${req}/revisions/2/accept`, { reason: 'ok' }));
  }

  it('the tie act refreshes the stale trace; the old verdict stays on its retired row and counts only once judged again', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await judge(issue, 1, 'pass', OLD, '2026-10-01T10:00:00Z');
    await reword(req);
    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'stale', counts: null });

    const tied = await api(token, 'POST', `/api/issues/${issue}/criteria/traces`, {
      codes: ['BC-1'],
    });

    expect(tied.status, JSON.stringify(tied.body)).toBe(201);
    const rows = (tied.body as { criteria: Array<Record<string, unknown>> }).criteria;
    expect(rows).toEqual([
      expect.objectContaining({
        n: 1,
        statement: `(${req} BC-1) A nurse sees the reminder before the round`,
        latest: null,
      }),
    ]);
    const kept = [
      ...(await db.execute(sql`
        SELECT c.retired_at IS NOT NULL AS retired, v.verdict
          FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
         WHERE v.issue_id = ${issue}`)),
    ];
    expect(kept).toEqual([{ retired: true, verdict: 'pass' }]);
    // ISS-489 r2: the retired row and the verdict it earned read back, beside the live row
    const read = await ok(api(token, 'GET', `/api/issues/${issue}/criteria`));
    expect(read.retired).toEqual([
      expect.objectContaining({
        n: 1,
        statement: `(${req} BC-1) A nurse sees the reminder`,
        retiredAt: expect.any(String),
        verdicts: [
          expect.objectContaining({ verdict: 'pass', identityKind: 'commit', commitSha: OLD }),
        ],
      }),
    ]);
    expect(read.criteria).toEqual([expect.objectContaining({ n: 1, latest: null })]);
    const refreshed = await bc(req, 'BC-1');
    expect(refreshed.verdict).toBe('not_judged');
    expect(refreshed.issues).toEqual([
      expect.objectContaining({ displayId: 'ISS-1', criterion: 1, verdict: null, stale: false }),
    ]);

    await judge(issue, 1, 'pass', NEW, '2026-10-06T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1', commit: NEW },
    });
  });

  it("the issue's own standing reads a trace on an earlier wording as stale, not as current, until it is tied again", async () => {
    const req = await agreedRequirement();
    await closedIssueTracing(req, 1, ['BC-1', 'BC-2']);
    const issue = await closedIssueTracing(req, 2, ['BC-1']);
    await reword(req);
    const rail = async (key: string) =>
      (
        (await ok(onProject('GET', `/issues/standing/${key}`))) as {
          standing: { requirement: { criteria: string[]; staleCriteria: string[] } };
        }
      ).standing.requirement;

    expect(await rail('ISS-1')).toMatchObject({ criteria: ['BC-2'], staleCriteria: ['BC-1'] });
    expect(await rail('ISS-2')).toMatchObject({ criteria: [], staleCriteria: ['BC-1'] });

    await ok(api(token, 'POST', `/api/issues/${issue}/criteria/traces`, { codes: ['BC-1'] }));

    expect(await rail('ISS-2')).toMatchObject({ criteria: ['BC-1'], staleCriteria: [] });
  });

  it('tying a BC the issue already traces at its current wording is refused, naming the criterion', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await reword(req);
    expect(
      (await api(token, 'POST', `/api/issues/${issue}/criteria/traces`, { codes: ['BC-1'] }))
        .status,
    ).toBe(201);

    const again = await api(token, 'POST', `/api/issues/${issue}/criteria/traces`, {
      codes: ['BC-1'],
    });

    expect(again.status).toBe(422);
    expect(JSON.stringify(again.body)).toContain('CRITERIA_TRACE_DUPLICATE');
    expect(JSON.stringify(again.body)).toContain('already traced by criterion 1');
  });
});

// ISS-489 r2: a verdict whose identity was not a commit reached coverage with no commit, so nothing
// checked it and a pass counted. A runtime resolves to the commit its build served or does not count;
// a design or contract counts only at what the requirement's latest baseline pins.
describe('every verdict identity is checked by a rule or named as not counting', () => {
  async function approvedDesign(
    flow: string,
  ): Promise<{ id: string; doc: Record<string, unknown> }> {
    const doc = JSON.parse(
      readFileSync(
        new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    doc.project = projectId;
    doc.flow = flow;
    const made = (await ok(
      onProject('POST', '/workflows', { baseRevision: null, document: doc }),
    )) as {
      document: Record<string, unknown> & { id: string };
    };
    const id = made.document.id;
    await ok(onProject('POST', `/workflows/${id}/design/propose`, { revision: 1 }));
    await ok(
      onProject('POST', `/workflows/${id}/design/decision`, { revision: 1, decision: 'approve' }),
    );
    return { id, doc: made.document };
  }

  it('a runtime counts at the commit it names; one nothing resolves to a build does not, and says why', async () => {
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-2']);
    await judge(a, 1, 'pass', { kind: 'runtime', ref: NEW }, '2026-10-05T10:00:00Z');
    const digest = 'd'.repeat(64);
    await judge(b, 1, 'pass', { kind: 'runtime', ref: digest }, '2026-10-05T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { identity: `runtime ${NEW.slice(0, 12)}`, commit: NEW, inLiveBuild: true },
    });
    const unresolved = await bc(req, 'BC-2');
    expect(unresolved).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(unresolved.issues[0]?.notCounted).toBe(
      `runtime ${digest.slice(0, 12)} is not a commit and no release Forge verified served it, so nothing says which build it was`,
    );
    expect(unresolved.why).toContain(
      'no verdict counts yet: ISS-2 criterion 1: runtime dddddddddddd',
    );
  });

  it('a design counts at the revision the baseline pins, not at a later approved one', async () => {
    const { id, doc } = await approvedDesign('reminders-flow');
    const req = await agreedRequirement(id);
    await ok(
      onProject('PUT', `/workflows/${id}`, {
        baseRevision: 1,
        document: { ...doc, summary: 'revision two' },
      }),
    );
    await ok(
      onProject('POST', `/workflows/${id}/design/decision`, { revision: 2, decision: 'approve' }),
    );
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-2']);
    await judge(
      a,
      1,
      'pass',
      { kind: 'design', workflow: 'reminders-flow', revision: 1 },
      '2026-10-05T10:00:00Z',
    );
    await judge(
      b,
      1,
      'pass',
      { kind: 'design', workflow: 'reminders-flow', revision: 2 },
      '2026-10-05T10:00:00Z',
    );

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { identity: 'design reminders-flow rev 1', commit: null },
    });
    const later = await bc(req, 'BC-2');
    expect(later).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(later.issues[0]?.notCounted).toBe(
      "judged against design reminders-flow rev 2, and the requirement's latest baseline pins rev 1",
    );
  });

  it('a contract counts at the version the baseline pins, and not at another', async () => {
    const req = await agreedRequirement();
    const [project] = [
      ...(await db.execute(sql`SELECT slug FROM projects WHERE id = ${projectId}`)),
    ] as { slug: string }[];
    for (const version of ['1.1.0', '1.2.0']) {
      await db.execute(sql`
        INSERT INTO contract_versions (provider_project_id, contract_slug, version, contract_type, document, classification)
        VALUES (${projectId}, 'api', ${version}, 'openapi', '{}'::jsonb, 'initial')`);
    }
    await db.execute(sql`
      INSERT INTO requirement_baseline_pins (requirement_id, revision, baseline_seq, provider_project_id, contract_slug, contract_version)
      SELECT b.requirement_id, b.revision, b.seq, ${projectId}, 'api', '1.2.0'
        FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${projectId}
       ORDER BY b.revision DESC, b.seq DESC LIMIT 1`);
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-2']);
    const ref = `${project?.slug}/api`;
    await judge(a, 1, 'pass', { kind: 'contract', ref, version: '1.2.0' }, '2026-10-05T10:00:00Z');
    await judge(b, 1, 'pass', { kind: 'contract', ref, version: '1.1.0' }, '2026-10-05T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { identity: `contract ${ref}@1.2.0` },
    });
    const other = await bc(req, 'BC-2');
    expect(other).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(other.issues[0]?.notCounted).toBe(
      `judged against contract ${ref}@1.1.0, and the requirement's latest baseline pins 1.2.0`,
    );
  });
});

// ISS-489 r3: a commit or runtime pass whose hold nobody answered counted with inLiveBuild null and
// nothing said why — the round-2 runtime case above passed that way, with no live build read here
describe('a verdict nobody could check against the live build does not count', () => {
  it('production unread: neither a commit nor a runtime pass counts, and each line says the live build could not be read', async () => {
    unplant?.();
    unplant = null;
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-2']);
    await judge(a, 1, 'pass', NEW, '2026-10-05T10:00:00Z');
    await judge(b, 1, 'pass', { kind: 'runtime', ref: NEW }, '2026-10-05T10:00:00Z');

    const commit = await bc(req, 'BC-1');
    const runtime = await bc(req, 'BC-2');

    for (const [c, judged] of [
      [commit, `commit ${NEW.slice(0, 12)}`],
      [runtime, `runtime ${NEW.slice(0, 12)}, which served commit ${NEW.slice(0, 12)}`],
    ] as const) {
      expect(c).toMatchObject({ verdict: 'not_judged', counts: null });
      expect(c.issues[0]?.notCounted).toBe(
        `judged at ${judged}, and whether the live build holds it could not be checked: the live build could not be read: its production declares no source probe, so nothing reads which commit it serves`,
      );
      expect(c.why).toContain('no verdict counts yet:');
    }
    expect((await standingOf(req)).facts).toMatchObject({ passing: 0, judged: 0 });
  });

  it('ancestry unanswered: neither a commit nor a runtime pass counts, and each line names the reader', async () => {
    unplant?.();
    const live = '8888888888888888888888888888888888888888';
    unplant = plantLiveBuild(live, { [NEW]: { unread: 'the host timed out' } });
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-2']);
    await judge(a, 1, 'pass', NEW, '2026-10-05T10:00:00Z');
    await judge(b, 1, 'pass', { kind: 'runtime', ref: NEW }, '2026-10-05T10:00:00Z');

    const commit = await bc(req, 'BC-1');
    const runtime = await bc(req, 'BC-2');

    for (const [c, judged] of [
      [commit, `commit ${NEW.slice(0, 12)}`],
      [runtime, `runtime ${NEW.slice(0, 12)}, which served commit ${NEW.slice(0, 12)}`],
    ] as const) {
      expect(c).toMatchObject({ verdict: 'not_judged', counts: null });
      expect(c.issues[0]).toMatchObject({ inLiveBuild: null });
      expect(c.issues[0]?.notCounted).toBe(
        `judged at ${judged}, and whether the live build (888888888888) holds it could not be checked: the ancestry reader could not answer: the host timed out`,
      );
    }
  });
});
