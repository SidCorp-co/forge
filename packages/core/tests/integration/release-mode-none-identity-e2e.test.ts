/**
 * Under release mode `none` only a verdict whose identity is the commit the landing records earns a
 * criterion, at the record door and in a requirement's coverage alike. Planted from adminhub-api
 * ISS-10..16 on 2026-10-22: QA judged each criterion with a runtime identity whose ref was the whole
 * landed sha, the record door closed the issues on them, and coverage read the same verdicts as not
 * judged, so REQ-1 read 0/6. The two doors read one verdict two ways.
 *
 * Since 2026-10-26 (coordinator ruling) the verdict door refuses that runtime identity by name on a
 * project that declares no production environment, where it took it and it could never count. The
 * rows those runs wrote before then are still read, so the record door and coverage are planted
 * with them as stored history (`storedRuntime`).
 *
 * @direct-test-of packages/core/src/issues/criteria/unobserved-runtime.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
  D9,
  F4,
  judgedAll,
  landedIssue,
  ok,
  record,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { seedProduction, seedProjectDocument } from '../helpers/release-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

// adminhub-api's own policy: its issues owe no verdict at the landing, so QA may judge after it
beforeEach(() => seedLandedWorld({ verdictsRequired: false }));

/** QA's verdict on criterion `n` through the verdict route, as the master's QA writes it. */
const judged = (
  issueId: string,
  n: number,
  identity: Record<string, string>,
  verdict: 'pass' | 'fail' = 'pass',
) =>
  api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: n,
    verdict,
    reason: `Ran it on the box at ${F4.slice(0, 7)}.`,
    identity,
  });

/** A runtime verdict on criterion `n` as the verdict door stored it before it refused one here. */
async function storedRuntime(issueId: string, n: number, ref: string) {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, runtime_ref,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', 'Ran it on the box.', 'runtime', ${ref}, ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `);
}

async function verdictRows(issueId: string): Promise<number> {
  const [row] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${issueId}`,
  )) as unknown as Array<{ n: number }>;
  return row?.n ?? -1;
}

type Refusal = { code: string; path: string; detail: string };
const doorRefusals = (body: unknown) =>
  ((body as { error?: { refusals?: Refusal[] } }).error?.refusals ?? []) as Refusal[];

const NO_PRODUCTION =
  'and this project declares no production environment and names no testing environment: nothing runs there that Forge observes, so a runtime verdict never counts';

describe('the verdict door, on a project that declares no production environment', () => {
  it('refuses a runtime identity by name, naming the commit verdict at the landing, and writes nothing', async () => {
    const issue = await landedIssue(11, F4);

    const res = await judged(issue, 1, { kind: 'runtime', ref: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const [refusal, ...rest] = doorRefusals(res.body);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ code: 'VERDICT_RUNTIME_UNOBSERVED', path: '/identity' });
    expect(refusal?.detail).toContain(
      `criterion 1 names identity runtime \`${F4}\`, ${NO_PRODUCTION}`,
    );
    expect(refusal?.detail).toContain(
      `send a commit verdict there: identity \`{ kind: 'commit', sha: '${F4}' }\`, the build \`GET /api/issues/:id/judged-build\` names`,
    );
    expect(await verdictRows(issue)).toBe(0);
  });

  it('refuses the same runtime line in a comment record by name, and keeps no verdict of it', async () => {
    const issue = await landedIssue(11, F4);

    const res = await api(world.token, 'POST', `/api/issues/${issue}/comments`, {
      intent: 'note',
      body: [
        '```forge-record: verdict · contract 1',
        'criterion: 1',
        'verdict: pass',
        `runtime: ${F4}`,
        'evidence: judge-log.txt',
        'why: ran it on the box',
        '```',
      ].join('\n'),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.detail)).toContain('VERDICT_RUNTIME_UNOBSERVED');
    expect(String(res.body.detail)).toContain(NO_PRODUCTION);
    expect(await verdictRows(issue)).toBe(0);
  });

  it('takes the commit verdict at the landing it names', async () => {
    const issue = await landedIssue(11, F4);

    const res = await judged(issue, 1, { kind: 'commit', sha: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictRows(issue)).toBe(1);
  });

  it('refuses it on a project that releases through its change requests as well', async () => {
    const issue = await landedIssue(11, F4);
    await seedProjectDocument(world.projectId, world.ownerId, {
      environments: {},
      defaultBranch: BRANCH,
      extra: { release: { approval: { required: false }, changeRequests: true } },
    });

    const res = await judged(issue, 1, { kind: 'runtime', ref: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(doorRefusals(res.body).map((r) => r.code)).toEqual(['VERDICT_RUNTIME_UNOBSERVED']);
    expect(await verdictRows(issue)).toBe(0);
  });

  it('still takes a runtime identity once the project declares production', async () => {
    await seedProduction({
      projectId: world.projectId,
      ownerId: world.ownerId,
      deploysFrom: BRANCH,
    });
    const issue = await landedIssue(11, F4);

    const res = await judged(issue, 1, { kind: 'runtime', ref: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictRows(issue)).toBe(1);
  });
});

describe('a runtime identity naming the landed sha, stored before the door refused it', () => {
  it('is refused by the record door by name, as adminhub-api ISS-11 was not', async () => {
    const issue = await landedIssue(11, F4);
    for (const n of [1, 2, 3]) await storedRuntime(issue, n, F4);

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals.map((r) => r.code)).toEqual([
      'RELEASE_LANDING_UNJUDGED',
      'RELEASE_LANDING_UNJUDGED',
      'RELEASE_LANDING_UNJUDGED',
    ]);
    expect(refusals[0]?.detail).toContain('ISS-11 criterion 1');
    expect(refusals[0]?.detail).toContain(
      `it was judged against runtime \`${F4}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts`,
    );
    expect(refusals[0]?.detail).toContain(
      `it needs a verdict whose identity is commit \`${F4.slice(0, 12)}\``,
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('is not counted by coverage either, naming the same rule', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(11, F4);
    await traced(req, issue, 11);
    await storedRuntime(issue, 1, F4);

    const bc = await bcOf(req);

    expect(bc.verdict).toBe('not_judged');
    expect(bc.issues[0]?.notCounted).toBe(
      `judged against runtime \`${F4}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts, or, where the project names its testing environment (\`delivery.judgedOn\`), one judged on the whole commit it serves`,
    );
  });
});

describe('where none is owed', () => {
  it('still closes an issue with no verdict, which QA may judge after the landing', async () => {
    const issue = await landedIssue(11, F4);

    expect((await record([issue], F4)).status).toBe(201);
  });

  // ISS-630 c1, judge K64 at dev.304: the record closed the issue over this fail (201)
  it('refuses a criterion judged fail at the landed commit by name, and the issue stays open', async () => {
    const issue = await landedIssue(11, F4);
    await ok(judged(issue, 1, { kind: 'commit', sha: F4 }));
    await ok(judged(issue, 2, { kind: 'commit', sha: F4 }, 'fail'));

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: 'RELEASE_LANDING_UNJUDGED' });
    expect(refusals[0]?.detail).toContain('ISS-11 criterion 2: its verdict is `fail`');
    expect(refusals[0]?.detail).toContain('a recorded fail never does');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('closes over a fail judged at an earlier commit, which judged another build', async () => {
    const issue = await landedIssue(11, F4);
    await ok(judged(issue, 2, { kind: 'commit', sha: D9 }, 'fail'));

    expect((await record([issue], F4)).status).toBe(201);
  });
});

describe('where verdicts are owed', () => {
  it('refuses the same stored runtime identity by the same sentence', async () => {
    await seedLandedWorld();
    const issue = await landedIssue(11, F4);
    for (const n of [1, 2, 3]) await storedRuntime(issue, n, F4);

    const refusals = refusalsOf((await record([issue], F4)).body);

    expect(refusals[0]?.detail).toContain(
      `ISS-11 criterion 1: it was judged against runtime \`${F4}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts, or, where the project names its testing environment (\`delivery.judgedOn\`), one judged on the whole commit it serves; it needs a \`pass\` whose identity is commit \`${F4.slice(0, 12)}\``,
    );
  });
});

describe('a closed issue', () => {
  it('takes a verdict re-written as commit identity at its recorded sha, which coverage then counts', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(11, F4);
    await traced(req, issue, 11);
    await judgedAll(issue, F4);
    expect((await record([issue], F4)).status).toBe(201);
    expect(await statusOf(issue)).toBe('closed');

    const res = await judged(issue, 1, { kind: 'commit', sha: F4 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await bcOf(req)).toMatchObject({ verdict: 'passing' });
  });
});
