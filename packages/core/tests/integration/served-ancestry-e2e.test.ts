/**
 * A runtime verdict at what an earlier release served is carried by the release serving now, read
 * from Forge's release records, never from a cache a deploy empties. forge-dev, 2026-10-30: ISS-781
 * criterion 1 passed at runtime c12a03d16 (release dev.376); dev.377 deployed 1c911cea4, which
 * descends from it; the new process held no carriage, a read asks the source host nothing
 * (ISS-774), and the criteria read said "which is not a commit this project is serving — whether
 * what it serves carries it could not be read", counting it superseded: REQ-79 fell from 4/9 to 2/9
 * with no new verdict. A pair nothing could read is `unread`: never read as not carried, and not
 * earned until a release pass, which asks the host, decides it.
 *
 * Every read here runs in a process that has asked nothing about these pairs, as a deploy leaves it:
 * the planted host counts every call and refuses each one.
 *
 * @direct-test-of packages/core/src/release-batch/recorded-carriage.ts
 * @direct-test-of packages/core/src/release-batch/runtime-weighing.ts
 * @direct-test-of packages/core/src/issues/runtime-standing.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { unearnedCriteriaReports } from '../../src/issues/index.js';
import { READ_PATH_HELD_ONLY, readWeighingNow } from '../../src/release-batch/runtime-weighing.js';
import { readServingNow } from '../../src/release-batch/serving-reading.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const H = vi.hoisted(() => {
  const asked = { calls: 0 };
  const refuse = async () => {
    asked.calls += 1;
    throw new Error('429 Too Many Requests');
  };
  return {
    asked,
    host: {
      fullName: 'SidCorp-co/forge',
      compare: refuse,
      compareFiles: refuse,
      commitFiles: refuse,
    },
  };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host,
}));

const PROBE = 'https://forge-dev-api.example.test/api/health/version';
/** dev.376's commit, at which ISS-781 criterion 1 was judged. */
const DEV_376 = 'c12a03d16e0b1f2a3b4c5d6e7f8091a2b3c4d5e6';
/** dev.377's commit, which descends from it and is served now. */
const DEV_377 = '1c911cea4f0e1d2c3b4a59687766554433221100';
/** dev.378's commit, cut after dev.377 and rolled back: what is served does not hold it. */
const DEV_378 = '7ab0c0de11223344556677889900aabbccddeeff';
/** A commit no release Forge recorded was cut at or shipped. */
const UNRECORDED = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';
const LANDING = 'e82fd89d6ab457143f8ba9429fe211c2401b3d28';

let projectId: string;
let ownerId: string;
let token: string;

async function forgeDevProject(): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'dev',
        deployment: { mode: 'external' },
        url: 'https://forge-dev-api.example.test',
        verification: {
          runtime: [{ type: 'http', url: PROBE, path: 'commit', identifies: 'source' }],
        },
      },
    } as never,
    defaultBranch: 'dev',
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** A release Forge recorded shipping `commit`, cut `daysAgo`, carrying `issueIds`. */
async function shippedRelease(
  version: string,
  commit: string,
  daysAgo: number,
  issueIds: string[] = [],
): Promise<void> {
  const meta = { source: 'release-batch', issueIds, finish: { state: 'finished', commit } };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, created_at, started_at, release_version,
                               release_released_at, metadata)
    VALUES (${randomUUID()}, ${projectId}, 'system', 'completed',
            now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}),
            ${version}, now() - make_interval(days => ${daysAgo}), ${JSON.stringify(meta)}::jsonb)
  `);
}

let seq = 0;

/** A closed issue landed at `LANDING`, one criterion each passed at runtime `refs[i]`. */
async function judgedIssue(refs: readonly string[]): Promise<string> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${projectId}, ${seq}, ${`ISS-${seq}`}, 'in_progress', ${ownerId}, now(), ${LANDING}, 'dev')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(
    id,
    refs.map((_, i) => ({ n: i + 1, statement: `Criterion ${i + 1} holds on dev.` })),
  );
  for (const [i, ref] of refs.entries()) {
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                      runtime_ref, author_user_id, author_agency, judge)
      SELECT id, ${id}, 'pass', 'Called the route on dev.', 'runtime', ${ref}, ${ownerId}, 'agent', 'qa'
        FROM issue_criteria WHERE issue_id = ${id} AND n = ${i + 1} AND retired_at IS NULL
    `);
  }
  await seedIssueStatus(id, 'closed');
  return id;
}

interface Weighing {
  earned: boolean | null;
  standing: string | null;
  reason: string;
}

async function criteriaRead(issueId: string): Promise<Map<number, Weighing>> {
  const res = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{ n: number; weighing: Weighing }>;
  return new Map(criteria.map((c) => [c.n, c.weighing]));
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  await forgeDevProject();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PROBE)) return Response.json({ commit: DEV_377 });
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a deploy does not take a verdict it carried away (forge-dev ISS-781, REQ-79)', () => {
  it('reads a pass at dev.376 as carried by dev.377 from the release records, asking nothing', async () => {
    const id = await judgedIssue([DEV_376]);
    await shippedRelease('0.4.0-dev.376', DEV_376, 2, [id]);
    await shippedRelease('0.4.0-dev.377', DEV_377, 1);
    const asked = H.asked.calls;

    const read = await criteriaRead(id);

    expect(H.asked.calls).toBe(asked);
    expect(read.get(1)).toMatchObject({ earned: true, standing: 'carried' });
    expect(read.get(1)?.reason).toBe(
      `judged at ${DEV_376}, which is not a commit this project is serving, and what it serves carries it: \`${DEV_377}\` descends from it: release 0.4.0-dev.376 was cut at it, and release 0.4.0-dev.377, which serves \`${DEV_377}\`, was cut no earlier on the same line`,
    );
  });

  it('carries a pass at an issue landing a release no later than the served one shipped', async () => {
    const id = await judgedIssue([LANDING]);
    await shippedRelease('0.4.0-dev.376', DEV_376, 2, [id]);
    await shippedRelease('0.4.0-dev.377', DEV_377, 1);

    const read = await criteriaRead(id);

    expect(read.get(1)).toMatchObject({ earned: true, standing: 'carried' });
    expect(read.get(1)?.reason).toContain('release 0.4.0-dev.376 shipped the issue landed at it');
  });

  it('the release sweep, which may ask the host, answers the recorded pair without asking', async () => {
    const id = await judgedIssue([DEV_376]);
    await shippedRelease('0.4.0-dev.376', DEV_376, 2, [id]);
    await shippedRelease('0.4.0-dev.377', DEV_377, 1);
    await seedIssueStatus(id, 'awaiting_release');
    const asked = H.asked.calls;

    const serving = await readServingNow(projectId);
    const [report] = await unearnedCriteriaReports(
      [id],
      serving,
      await readWeighingNow(projectId, serving, [id]),
    );

    expect(H.asked.calls).toBe(asked);
    expect(report?.unearned).toEqual([]);
    expect(report?.uncorroborated).toEqual([]);
  });
});

describe('what the record says against it, and what nothing records', () => {
  it('supersedes a pass at a release cut after the one served, naming both', async () => {
    const id = await judgedIssue([DEV_378]);
    await shippedRelease('0.4.0-dev.377', DEV_377, 2);
    await shippedRelease('0.4.0-dev.378', DEV_378, 1);

    const read = await criteriaRead(id);

    expect(read.get(1)).toMatchObject({ earned: false, standing: 'superseded' });
    expect(read.get(1)?.reason).toContain(
      'what it serves does not carry it: release 0.4.0-dev.378 was cut at it, after release 0.4.0-dev.377',
    );
  });

  it('reads a pair no release places as unknown, never superseded, saying why', async () => {
    const id = await judgedIssue([UNRECORDED]);
    await shippedRelease('0.4.0-dev.377', DEV_377, 1);

    const read = await criteriaRead(id);

    expect(read.get(1)).toMatchObject({ earned: null, standing: 'unread' });
    expect(read.get(1)?.reason).toBe(
      `judged at ${UNRECORDED}, which is not a commit this project is serving — whether what it serves carries it could not be read: ${READ_PATH_HELD_ONLY}`,
    );
  });

  it('holds a pair the host could not answer in the release sweep as unread, not superseded', async () => {
    const id = await judgedIssue([UNRECORDED]);
    await shippedRelease('0.4.0-dev.377', DEV_377, 1);
    await seedIssueStatus(id, 'awaiting_release');

    const serving = await readServingNow(projectId);
    const [report] = await unearnedCriteriaReports(
      [id],
      serving,
      await readWeighingNow(projectId, serving, [id]),
    );

    expect(report?.earned).toEqual([]);
    expect(report?.unearned).toMatchObject([{ criterion: 1, standing: 'unread', undecided: true }]);
    expect(report?.unearned[0]?.why).toContain('429 Too Many Requests');
  });
});
