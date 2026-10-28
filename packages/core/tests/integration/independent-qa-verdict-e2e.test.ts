/**
 * Independent QA holds in the kernel, not in prompt text (ISS-475, REQ-36 BC-16, REQ-74 BC-2,
 * REQ-45 BC-1). Under `qa: independent` a verdict counts only where a run other than the building
 * run recorded it: the building run's own pass is kept as its evidence, with its probe, and its
 * write answers `notCounted` naming VERDICT_BY_BUILDER. Who recorded it is the run session the
 * write resolves (`run`, else the session holding the issue's lease on the caller's box), and the
 * building run is the one that took the issue before its work landed, so a judge run declared over
 * the issue at awaiting_release, on the builder's own box, is not it and its pass counts. The move to
 * awaiting_release still asks no verdict. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/built-by.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 */

import { randomUUID } from 'node:crypto';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { BUILDER_PASS_CUTOVER } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const NEW = '2222222222222222222222222222222222222222';
const LIVE = '9999999999999999999999999999999999999999';
const BUILDER_WHY =
  "passed by the run that built it, and a builder's own pass never counts where gate builder_verdict is enforced (gates.overrides.builder_verdict relaxes it)";
const PROBE = {
  kind: 'command',
  command: { argv: ['pnpm', 'test', 'reminders'] },
  expect: { exitCode: 0 },
};

let projectId: string;
let ownerId: string;
let token: string;
let box: string;
let boxToken: string;
let seq = 0;
let unplant: (() => void) | null = null;

async function world(qa: 'independent' | 'self') {
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa } })).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  box = await createTestDevice(ownerId);
  boxToken = (await mintPat({ permissions: ['*'], userId: ownerId, name: 'box', deviceId: box }))
    .plaintext;
}

beforeEach(async () => {
  await truncateAll();
  await world('independent');
  unplant = plantLiveBuild(LIVE, { [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

async function ok(r: Promise<{ status: number; body: unknown }>): Promise<Doc> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
}

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function agreedRequirement(): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Reminders',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
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

/**
 * An in_progress issue delivering `req`, its two criteria traced to BC-1 and BC-2, criterion 1
 * observable and criterion 2 a code property in its design.
 */
async function issueTracing(req: string): Promise<{ id: string; key: string }> {
  seq += 1;
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: issue.key }));
  await ok(
    api(token, 'POST', `/api/issues/${issue.id}/criteria/traces`, { codes: ['BC-1', 'BC-2'] }),
  );
  await ok(
    api(token, 'PUT', `/api/issues/${issue.id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: null, proof: 'the reminders probe' },
        { criterion: 2, class: 'code_property', pattern: null, proof: 'the review reads the diff' },
      ],
      modules: [],
      contracts: [],
    }),
  );
  return issue;
}

/**
 * A run session on the box, declared over `key` while the issue stood at `openedAt`, as a box opens
 * one (`devices/run-session.ts`); `lease` gives it the issue's lease. Answers its session and the
 * box's own run id for it.
 */
async function declaredRun(
  key: string,
  openedAt: string,
  lease: boolean,
): Promise<{ session: string; boxRunId: string }> {
  const boxRunId = randomUUID();
  const runId = randomUUID();
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: openedAt },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  const [s] = await rows<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${box}, ${runId}, 'run_session', 'running', now() - interval '1 minute', now() - interval '1 minute')
    RETURNING id`);
  if (!s) throw new Error('no run session seeded');
  if (lease) {
    await db.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${projectId}, ${key}, ${box}, ${s.id}, ${runId})
      ON CONFLICT (project_id, issue_key)
      DO UPDATE SET device_id = EXCLUDED.device_id, session_id = EXCLUDED.session_id,
                    run_id = EXCLUDED.run_id, acquired_at = now()`);
  }
  return { session: s.id, boxRunId };
}

/** A verdict on criterion `n`, sent with `as`'s credential; `run` names the run sending it. */
function verdict(
  issueId: string,
  n: number,
  value: 'pass' | 'short' | 'fail' | 'skipped',
  extra: Doc = {},
  as = boxToken,
) {
  const observable = n === 1;
  return api(as, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: n,
    verdict: value,
    reason: `${value} on the running build`,
    identity: { kind: 'commit', sha: NEW },
    ...(value === 'skipped' ? {} : { evidence: ['shot.png'] }),
    ...(observable && value !== 'skipped'
      ? { probe: PROBE, withoutClip: 'judged by command' }
      : {}),
    ...(observable ? {} : { judge: 'review' }),
    ...extra,
  });
}

type Bc = { code: string; verdict: string; issues: { notCounted: string | null }[] };
async function bc(req: string, code: string): Promise<Bc> {
  const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
    standing: { coverage: Bc[] };
  };
  return d.standing.coverage.find((c) => c.code === code) as Bc;
}

async function recordedSession(verdictId: string): Promise<string | null> {
  const [r] = await rows<{ run_session_id: string | null }>(
    sql`SELECT run_session_id FROM criterion_verdicts WHERE id = ${verdictId}`,
  );
  return r?.run_session_id ?? null;
}

const codes = (res: { body: unknown }): string[] =>
  (((res.body as Doc).error?.refusals ?? []) as Doc[]).map((r) => String(r.code));

describe('c1: the building run records its pass, which never counts, named VERDICT_BY_BUILDER', () => {
  it("keeps the building run's pass on an observable criterion with its probe, answers notCounted, and the count reads it unproven", async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    const builder = await declaredRun(issue.key, 'open', true);

    const res = await ok(verdict(issue.id, 1, 'pass'));

    expect(res.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    expect(res.criterion.probe).toMatchObject({ kind: 'command' });
    expect(await recordedSession(String(res.verdictId))).toBe(builder.session);
    const one = await bc(req, 'BC-1');
    expect(one.verdict).toBe('not_judged');
    expect(one.issues[0]?.notCounted).toBe(BUILDER_WHY);
    const events = await ok(api(token, 'GET', `/api/issues/${issue.id}/events?kind=verdict`));
    const fields = (events.items as Doc[]).flatMap((e) => e.fields as Doc[]);
    expect(fields).toContainEqual({ key: 'not-counted', value: 'VERDICT_BY_BUILDER' });
    expect(fields).toContainEqual({ key: 'run-session', value: builder.session });
  });

  it("the building run's pass does not start counting once a judge takes the issue's lease from it", async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);
    await ok(verdict(issue.id, 1, 'pass'));
    const judge = await declaredRun(issue.key, 'awaiting_release', true);
    // the judge's run opened after the builder's verdict, as a release judge's does
    await db.execute(
      sql`UPDATE agent_sessions SET created_at = now() + interval '1 minute' WHERE id = ${judge.session}`,
    );

    const one = await bc(req, 'BC-1');

    expect(one.verdict).toBe('not_judged');
    expect(one.issues[0]?.notCounted).toBe(BUILDER_WHY);
  });

  it('names a short the same, and leaves a fail and a skip unnamed: a fail counts whoever writes it', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'in_progress', true);

    expect((await ok(verdict(issue.id, 1, 'short'))).notCounted).toMatchObject({
      code: 'VERDICT_BY_BUILDER',
    });
    expect((await ok(verdict(issue.id, 1, 'skipped'))).notCounted).toBeNull();
    expect((await ok(verdict(issue.id, 1, 'fail'))).notCounted).toBeNull();
    expect((await bc(req, 'BC-1')).verdict).toBe('failing');
  });

  it("names the building run's pass on a code property too: under independent QA no builder's pass counts", async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);

    const res = await ok(verdict(issue.id, 2, 'pass'));

    expect(res.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    expect((await bc(req, 'BC-2')).verdict).toBe('not_judged');
  });

  it('under qa: self the same pass after the cutover does not count either, and says so (ISS-683, REQ-74 BC-2)', async () => {
    await truncateAll();
    await world('self');
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);

    const res = await ok(verdict(issue.id, 1, 'pass'));
    // the write reads it at the moment it was recorded: before the cutover it still counts, marked
    if (Date.now() < Date.parse(BUILDER_PASS_CUTOVER)) {
      expect(res).toMatchObject({ notCounted: null, countedUnderCutover: true });
    } else {
      expect(res.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    }
    await db.execute(
      sql`UPDATE criterion_verdicts SET created_at = '2026-10-26T10:00:00Z' WHERE id = ${String(res.verdictId)}`,
    );
    expect((await bc(req, 'BC-1')).verdict).toBe('not_judged');
  });

  it('refuses a run naming no live run of the box, and a run named on a person’s credential, with nothing written', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);

    const unknown = await verdict(issue.id, 1, 'pass', { run: 'no-such-run' });
    const person = await verdict(issue.id, 1, 'pass', { run: 'no-such-run' }, token);

    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
    expect(codes(unknown)).toEqual(['VERDICT_RUN_UNKNOWN']);
    expect(codes(person)).toEqual(['VERDICT_RUN_UNKNOWN']);
    const [n] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${issue.id}`,
    );
    expect(n?.n).toBe(0);
  });
});

// adminhub-api, 2026-10-27: judge run bc3a1c72 (box run 4a73a09c) was declared at 07:04 over
// ISS-23/24, merged at 06:45 and 06:50 but still `in_progress` (`developed` is refused
// ISSUE_STATUS_LEGACY), so the run's opening status read it as the builder and 13 passes did not
// count, the detail saying only "recorded by the run that built this issue"
describe('a run declared after the work landed is not its builder, whatever status word it opened at', () => {
  const mergedEarlier = (issueId: string) =>
    db.execute(sql`
      UPDATE issues SET merged_at = now() - interval '10 minutes', merged_commit_sha = ${NEW}
       WHERE id = ${issueId}`);

  it('counts the pass of a judge declared over an in_progress issue whose merge was recorded before it', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);
    await mergedEarlier(issue.id);
    const judge = await declaredRun(issue.key, 'in_progress', true);

    const res = await ok(verdict(issue.id, 1, 'pass'));

    expect(res.notCounted).toBeNull();
    expect(await recordedSession(String(res.verdictId))).toBe(judge.session);
    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'passing' });
  });

  it('names the status a run was declared over before the work landed, and the way out', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'in_progress', true);

    const res = await ok(verdict(issue.id, 1, 'pass'));

    expect(res.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    const detail = String((res.notCounted as Doc).detail);
    expect(detail).toContain(
      'declared while this issue stood at `in_progress` with no merge recorded',
    );
    expect(detail).toContain('`awaiting_release`');
    expect(detail).toContain('declare a new judge run');
  });

  it("reads a run declared after a design approval's stamp alone as the builder: that stamp lands no code", async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await db.execute(sql`
      UPDATE issues SET merged_at = now() - interval '10 minutes',
             merged_artifacts = ${JSON.stringify([{ surface: 'design', ref: 'checkout@rev2', change: 'changed' }])}::jsonb
       WHERE id = ${issue.id}`);
    await declaredRun(issue.key, 'in_progress', true);

    const res = await ok(verdict(issue.id, 1, 'pass'));

    expect(res.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    expect(await bc(req, 'BC-1')).not.toMatchObject({ verdict: 'passing' });
  });
});

describe('c2: the independent judge on the release is the verdict that counts', () => {
  it("counts the pass of a judge run declared over the awaiting_release issue on the builder's box, the builder still live", async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);
    await ok(verdict(issue.id, 1, 'pass'));
    const judge = await declaredRun(issue.key, 'awaiting_release', true);

    const res = await ok(verdict(issue.id, 1, 'pass'));

    expect(res.notCounted).toBeNull();
    expect(await recordedSession(String(res.verdictId))).toBe(judge.session);
    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'passing' });
  });

  it('a judge declared over released work, holding no lease, names itself in run; unnamed, its call is read as the lease holder, the builder, and says so', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);
    const judge = await declaredRun(issue.key, 'closed', false);

    const unnamed = await ok(verdict(issue.id, 1, 'pass'));
    const named = await ok(verdict(issue.id, 1, 'pass', { run: judge.boxRunId }));

    expect(unnamed.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    expect(named.notCounted).toBeNull();
    expect(await recordedSession(String(named.verdictId))).toBe(judge.session);
    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'passing' });
  });

  it("a newer builder pass does not take the judge's counting pass away", async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    const judge = await declaredRun(issue.key, 'awaiting_release', false);
    await ok(verdict(issue.id, 1, 'pass', { run: judge.boxRunId }));
    await declaredRun(issue.key, 'reopen', true);

    expect((await ok(verdict(issue.id, 1, 'pass'))).notCounted).toMatchObject({
      code: 'VERDICT_BY_BUILDER',
    });
    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'passing' });
  });

  it("moves the landed issue to awaiting_release with only the builder's uncounted pass on it: no verdict is asked", async () => {
    await seedProjectDocument(projectId, ownerId, { environments: {} });
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await declaredRun(issue.key, 'open', true);
    await ok(verdict(issue.id, 1, 'pass'));
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${issue.id}`),
    );

    const moved = await api(token, 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'awaiting_release',
    });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  });
});
