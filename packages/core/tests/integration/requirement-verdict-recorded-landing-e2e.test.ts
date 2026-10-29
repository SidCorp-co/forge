/**
 * A verdict recorded at a requirement on a project with no production environment counts where the
 * commit it names is a landing Forge recorded on the branch every traced issue landed on, at or
 * after each of their landings (catalog-fe REQ-7 BC-2, 2026-10-30: a real-login pass at the served
 * dev build 4ba60495, ISS-42's landing, read `not_judged` for ever, "with no production environment
 * no running build is read to hold it", while the project's issue verdicts counted on their own
 * landings). A commit no landing records, one recorded before a traced issue landed, and one on
 * another branch still do not count, each naming the record that is missing. No host is asked.
 * Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/requirements/recorded-landings.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** ISS-1's landing on dev, the work BC-1 traces. */
const TRACED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** ISS-2's landing on dev, later: the build the dev environment served when BC-1 was judged. */
const SERVED = '4ba60495990f7f51d4b20ab0d3407f12b68c3627';
/** ISS-3's landing on dev, before ISS-1 landed. */
const EARLIER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** ISS-4's landing on another branch, later still. */
const OTHER_BRANCH = 'cccccccccccccccccccccccccccccccccccccccc';
/** No landing records it. */
const UNRECORDED = 'dddddddddddddddddddddddddddddddddddddddd';
const CLIP = 'https://catalog-dev.example/clips/bc2.webm';

let projectId = '';
let ownerId = '';
let token = '';

type Doc = Record<string, unknown>;
type Verdict = { commit: string | null; notCounted: string | null };
type Bc = { code: string; verdict: string; verdicts: Verdict[] };

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
}

async function landed(seq: number, sha: string, at: string, target = 'dev'): Promise<string> {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'closed',
    createdAt: new Date('2026-10-28T00:00:00Z'),
    mergedAt: new Date(at),
  });
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = ${sha}, merged_target = ${target}, merged_at = ${at}::timestamptz
     WHERE id = ${id}`);
  return id;
}

async function requirementTracedBy(issueId: string): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Errors show once',
      reason: 'planted',
      criteria: [{ body: 'A failing call shows its error exactly once' }],
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
  const [bc] = (await db.execute(sql`
    SELECT rc.id FROM requirement_criteria rc JOIN requirements r ON r.id = rc.requirement_id
     WHERE r.project_id = ${projectId} AND rc.code = 'BC-1' LIMIT 1`)) as unknown as Array<{
    id: string;
  }>;
  if (!bc) throw new Error('no BC-1 seeded');
  const [issue] = (await db.execute(
    sql`SELECT iss_seq FROM issues WHERE id = ${issueId}`,
  )) as unknown as Array<{ iss_seq: number }>;
  await ok(onProject('POST', `/requirements/${key}/issues`, { issue: `ISS-${issue?.iss_seq}` }));
  await db.execute(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position, requirement_criterion_id)
    VALUES (${issueId}, 1, 'the error shows once', 0, ${bc.id})`);
  return key;
}

const judgeAt = (req: string, sha: string) =>
  onProject('POST', `/requirements/${req}/verdicts`, {
    criterion: 'BC-1',
    verdict: 'pass',
    reason: 'pass on the served dev build',
    identity: { kind: 'commit', sha },
    evidence: [CLIP],
  });

async function bc1(req: string): Promise<Bc> {
  const standing = (await ok(onProject('GET', `/requirements/${req}`))).standing as {
    coverage: Bc[];
  };
  return standing.coverage.find((c) => c.code === 'BC-1') as Bc;
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  // catalog-fe's shape: one dev environment deploying `dev` on landing, no production
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'dev',
    environments: {
      dev: { tier: 'dev', deploysFrom: 'dev', deployment: { mode: 'external' } },
    },
  });
});

describe('a verdict at a requirement, on a project with no production environment', () => {
  it('counts at a landing Forge recorded on dev after every traced issue landed', async () => {
    const traced = await landed(1, TRACED, '2026-10-29T02:42:46Z');
    await landed(2, SERVED, '2026-10-29T14:48:53Z');
    const req = await requirementTracedBy(traced);
    await ok(judgeAt(req, SERVED));
    const read = await bc1(req);
    const mine = read.verdicts.find((v) => v.commit === SERVED);
    expect(mine?.notCounted, JSON.stringify(read)).toBeNull();
    expect(read.verdict).toBe('passing');
  });

  it('does not count at a commit no landing records, naming the missing record', async () => {
    const traced = await landed(1, TRACED, '2026-10-29T02:42:46Z');
    const req = await requirementTracedBy(traced);
    await ok(judgeAt(req, UNRECORDED));
    const read = await bc1(req);
    expect(read.verdict).toBe('not_judged');
    expect(read.verdicts[0]?.notCounted).toContain(
      'which no landing Forge recorded on this project names',
    );
  });

  it('does not count at a landing recorded before a traced issue landed, naming both', async () => {
    await landed(3, EARLIER, '2026-10-28T09:00:00Z');
    const traced = await landed(1, TRACED, '2026-10-29T02:42:46Z');
    const req = await requirementTracedBy(traced);
    await ok(judgeAt(req, EARLIER));
    const read = await bc1(req);
    const said = read.verdicts[0]?.notCounted ?? JSON.stringify(read);
    expect(said).toContain("ISS-3's landing on `dev`");
    expect(said).toContain("before ISS-1's landing");
  });

  it('does not count at a landing on another branch than the traced work', async () => {
    const traced = await landed(1, TRACED, '2026-10-29T02:42:46Z');
    await landed(4, OTHER_BRANCH, '2026-10-29T20:00:00Z', 'release/stg');
    const req = await requirementTracedBy(traced);
    await ok(judgeAt(req, OTHER_BRANCH));
    const read = await bc1(req);
    const said = read.verdicts[0]?.notCounted ?? JSON.stringify(read);
    expect(said).toContain('ISS-1 landed on `dev`, another branch');
  });
});
