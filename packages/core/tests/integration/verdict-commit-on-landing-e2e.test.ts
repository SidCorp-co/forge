/**
 * ISS-981 (catalog-api FB-501): the verdict door took a commit verdict at any whole sha, and where the
 * issue's merge was recorded at another commit the weighing (`release-batch/landed-build-holds.ts`)
 * counted it for nothing in silence: catalog-api's verdict passed a CI job at a commit the landing does
 * not hold. With a merge recorded, a commit verdict is now refused by name, naming the landing, unless
 * its commit is the landing, a later commit holding it, or an earlier commit the landing descends from
 * (a builder's branch head, ISS-845). With no merge recorded it is taken as before. What holds what is
 * Forge's recorded landings first, then the project's ancestry source, planted per case as the
 * release-hold ancestry test plants it. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-landing.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-refused.ts
 * @direct-test-of packages/core/src/issues/commit-placement.ts
 * @direct-test-of packages/core/src/release-batch/verdict-commit-placement.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { AncestrySource } from '../../src/release-batch/ancestry-source.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const sha = (c: string) => c.repeat(40);
/** Where the issue's merge is recorded. */
const LANDED = sha('a');
/** The build the testing environment serves, a later base commit holding the landing. */
const LATER = sha('b');
/** The builder's branch head, which the landing descends from. */
const EARLIER = sha('c');
/** catalog-api's case: a commit on another line, holding the landing and held by it neither. */
const UNRELATED = sha('d');
/** A commit the ancestry source cannot place. */
const UNREAD = sha('e');
/** A later landing Forge recorded on the same branch, which the host is never asked about. */
const RECORDED_LATER = sha('f');

const HOLDS = new Set([`${LANDED}@${LATER}`, `${EARLIER}@${LANDED}`]);
const LACKS = new Set([
  `${LANDED}@${UNRELATED}`,
  `${UNRELATED}@${LANDED}`,
  `${LANDED}@${EARLIER}`,
  `${LATER}@${LANDED}`,
]);
const asked: string[] = [];

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
  ancestrySourceFor: async (): Promise<AncestrySource> => ({
    kind: 'box',
    why: 'the planted box',
    reader: {
      async ask(pairs) {
        return new Map(
          pairs.map((p) => {
            const key = `${p.commit}@${p.release}`;
            asked.push(key);
            return [
              key,
              HOLDS.has(key) ? true : LACKS.has(key) ? false : { unread: 'no history reaches it' },
            ];
          }),
        );
      },
      witness: () => ({ via: 'source-host' }),
    },
  }),
}));

let token = '';
let ownerId = '';
let projectId = '';

beforeAll(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  plantLiveBuild(LATER, { [LANDED]: true });
}, 120_000);

/** ISS-`seq` with one criterion, its merge recorded at `landing` on `main` where one is given. */
async function issueLanded(seq: number, landing: string | null): Promise<string> {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const put = await api(token, 'PUT', `/api/issues/${id}/criteria`, {
    criteria: [{ statement: 'The CI job passes on the merge request pipeline' }],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  if (landing) {
    await db.execute(sql`
      UPDATE issues SET merged_at = now() - interval '1 hour', merged_commit_sha = ${landing},
             merged_target = 'main'
       WHERE id = ${id}`);
  }
  return id;
}

const verdict = (issueId: string, commit: string) =>
  api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'the pipeline at this commit passed every job',
    identity: { kind: 'commit', sha: commit },
    evidence: ['https://gitlab.example.test/catalog-api/-/pipelines/1'],
  });

const refusalOf = (res: { body: unknown }) =>
  ((res.body as Doc).error?.refusals ?? [])[0] as
    | { code: string; path: string; detail: string }
    | undefined;

describe('ISS-981 a commit verdict on an issue with a recorded merge is held to its landing', () => {
  it('takes one at the landing itself, asking no reader', async () => {
    const id = await issueLanded(101, LANDED);
    asked.length = 0;

    const res = await verdict(id, LANDED);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(asked).toEqual([]);
  });

  it('takes one at a later base commit holding the landing', async () => {
    const id = await issueLanded(102, LANDED);

    expect((await verdict(id, LATER)).status).toBe(201);
  });

  it("takes one at an earlier commit the landing descends from, a builder's branch head", async () => {
    const id = await issueLanded(103, LANDED);

    expect((await verdict(id, EARLIER)).status).toBe(201);
  });

  it('takes one at a later landing Forge recorded on the same branch, asking no reader', async () => {
    const id = await issueLanded(104, LANDED);
    const after = await issueLanded(105, null);
    await db.execute(sql`
      UPDATE issues SET merged_at = now(), merged_commit_sha = ${RECORDED_LATER}, merged_target = 'main'
       WHERE id = ${after}`);
    asked.length = 0;

    const res = await verdict(id, RECORDED_LATER);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(asked).toEqual([]);
  });

  it("refuses catalog-api's verdict at an unrelated commit by name, naming the landing, and writes nothing", async () => {
    const id = await issueLanded(106, LANDED);

    const res = await verdict(id, UNRELATED);

    expect(res.status).toBe(422);
    const refusal = refusalOf(res);
    expect([refusal?.code, refusal?.path]).toEqual(['VERDICT_COMMIT_OFF_LANDING', '/identity/sha']);
    expect(refusal?.detail).toContain(`names commit \`${UNRELATED}\``);
    expect(refusal?.detail).toContain(`recorded landing \`${LANDED}\``);
    expect(refusal?.detail).toContain('at a later commit on `main` that holds it');
    expect(refusal?.detail).toContain('at an earlier commit the landing descends from');
    const [count] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${id}`,
    )) as unknown as Array<{ n: number }>;
    expect(count?.n).toBe(0);
  });

  it('refuses one the ancestry source cannot place, saying it could not be read and why', async () => {
    const id = await issueLanded(107, LANDED);

    const res = await verdict(id, UNREAD);

    expect(res.status).toBe(422);
    const refusal = refusalOf(res);
    expect(refusal?.code).toBe('VERDICT_COMMIT_UNPLACED');
    expect(refusal?.detail).toContain('could not be read');
    expect(refusal?.detail).toContain('no history reaches it');
    expect(refusal?.detail).toContain(`recorded landing is \`${LANDED}\``);
  });

  it('takes a commit verdict at any commit where no merge is recorded, as before', async () => {
    const id = await issueLanded(108, null);

    expect((await verdict(id, UNRELATED)).status).toBe(201);
  });
});
