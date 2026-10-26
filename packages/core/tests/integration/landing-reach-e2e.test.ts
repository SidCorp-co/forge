/**
 * ISS-1300 r4 (judge-121) — what one GitHub installation read never answers for another, and the
 * words a person reads where a repository is hidden, lacks a branch, or lacks the commit a mark
 * names. Real Postgres, the GitHub double bound as the project's repository, rows planted past the
 * mark writer as stored values read back.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServingReading } from '../../src/release-batch/serving-reading.js';
import { type GitHubDouble, startGitHubDouble } from '../helpers/github-double.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

/** sid-desk ISS-578's pair: the real merge, and a commit sharing its first eight characters. */
const JUDGED = '0d018a9ac5897cd4ef3fe299f9c13e4c252162e2';
const ABSENT = '0d018a9a0e1cf5dadf2b1b3be9ba1b81c5e9cb40';
const REPOSITORY = 'SidCorp-co/forge';

const UNREADABLE: ServingReading = {
  kind: 'unreadable',
  why: 'https://app.example.test/api/build-info answered HTTP 503',
  hosts: ['https://app.example.test'],
  readAt: '2026-10-25T03:00:00.000Z',
};

let repo: GitHubDouble;
let harness: TestDatabase;
let projectId: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  repo = await startGitHubDouble();
}, 60_000);

afterAll(async () => {
  if (repo) await repo.close();
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

const newProject = async (owner: string) =>
  (
    await createTestProject(harness.db, owner, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;

beforeEach(async () => {
  await truncateAll(harness.db);
  repo.reset();
  repo.parents.set(JUDGED, '1111111111111111111111111111111111111111');
  ownerId = (await createTestUser(harness.db)).id;
  projectId = await newProject(ownerId);
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  forgetCarriage();
});

/** Two criteria judged at JUDGED; the row then made to record `merged`, past any writer. */
async function plant(record: { merged: string | null }): Promise<string> {
  const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');
  await harness.db.execute(
    sql`UPDATE issues SET merged_commit_sha = ${record.merged} WHERE id = ${id}`,
  );
  return id;
}

async function weigh(id: string) {
  const { readWeighingNow } = await import('../../src/release-batch/runtime-weighing.js');
  const { unearnedCriteriaReports } = await import('../../src/issues/criteria-verdicts.js');
  const weighing = await readWeighingNow(projectId, UNREADABLE, [id]);
  const [one] = await unearnedCriteriaReports([id], UNREADABLE, weighing);
  if (!one) throw new Error('no report came back');
  return one;
}

async function mergedCommit(id: string): Promise<string | null> {
  const r = await harness.db.execute(sql`SELECT merged_commit_sha FROM issues WHERE id = ${id}`);
  const rows = (r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[]);
  return (rows[0] as { merged_commit_sha: string | null }).merged_commit_sha;
}

/** A person's mark through the one writer the page and the API share, as the page sends it. */
async function personMarks(id: string, commit: string | undefined, marked = true) {
  const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
  return applyMergeMarker({
    issue: {
      id,
      projectId,
      mergedAt: marked ? new Date('2026-10-01T09:00:00Z') : null,
      declaredLandingShape: null,
    },
    op: 'mark',
    target: 'main',
    commit,
    actor: {
      agency: 'human',
      commentAuthorId: ownerId,
      hookActor: { type: 'user', id: ownerId, agency: 'human' },
    },
  });
}

describe('a repository hidden from the installation, on the readiness page', () => {
  // ISS-1300 r4 (judge-121) — the request it was read by stays behind the sentence, in the details.
  it('keeps the raw request out of what a person reads, and in the details behind it', async () => {
    await fx.declareProduction();
    await repo.bind(projectId, ownerId);
    repo.hidden = true;
    await plant({ merged: JUDGED });
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const blockers = (await loadReleaseReadiness(projectId))?.blockers ?? [];
    const carried = blockers.find((b) => b.details?.check === 'carried');

    for (const said of [carried?.reader, carried?.message]) {
      expect(said).not.toMatch(/GET \/repos|HTTP 404|tracker/);
    }
    expect(carried?.details?.detail).toContain('GET /repos/SidCorp-co/forge/commits/main');
  });
});

// ISS-1300 r4 (judge-121) — a repository GitHub shows, which lacks a branch the range names, says
// which one, and what supplies it: no retry finds it there.
describe('a carried range its readable repository lacks a branch of', () => {
  it('names the branch on the readiness page and in the refusal, never to load the page again', async () => {
    await fx.declareProduction();
    await repo.bind(projectId, ownerId);
    repo.heads.set('main', JUDGED);
    await plant({ merged: JUDGED });
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const blockers = (await loadReleaseReadiness(projectId))?.blockers ?? [];
    const carried = blockers.find((b) => b.details?.check === 'carried');

    const lacks = `${REPOSITORY} has no branch production, so this answer cannot say whether a release would start: whatever that check would have found is missing from this list. It is read again once ${REPOSITORY} has a branch production, or the project's release chain names only branches it has.`;
    expect(carried?.reader).toBe(
      `Reading which landings this release would carry beyond its issues failed: ${lacks}`,
    );
    expect(carried?.message).toBe(lacks);
    expect(`${carried?.reader} ${carried?.message}`).not.toMatch(/retry|Load this page|GET \//i);
  });
});

// ISS-1300 r4 (judge-121, probe E9) — what one installation read never answers for another.
describe('a found commit, read through one installation', () => {
  it('is not taken as read through another installation that cannot see the repository', async () => {
    await repo.bind(projectId, ownerId);
    const other = await startGitHubDouble();
    try {
      other.hidden = true;
      const first = await plant({ merged: JUDGED });
      expect((await weigh(first)).unreadLanding).toBeUndefined();

      const keep = projectId;
      projectId = await newProject(ownerId);
      try {
        await other.bind(projectId, ownerId);
        const second = await plant({ merged: JUDGED });
        const got = await weigh(second);
        expect(other.asked.filter((u) => u.includes(`/commits/${JUDGED}`))).toHaveLength(1);
        expect(got.unreadLanding).toEqual({ commit: JUDGED, repository: REPOSITORY });
      } finally {
        projectId = keep;
      }
    } finally {
      await other.close();
    }
  });
});

describe('the words a mark answers with, about a commit the repository lacks', () => {
  // ISS-1300 r4 (judge-121, F1) — Commit left blank names the act the hold names, never Unmark,
  // which would leave the criteria with no commit to weigh against at all.
  it('answers a blank Commit over a merge mark the repository lacks with the act the hold names', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });

    const answer = await personMarks(id, undefined);

    expect(answer.action).toBe('already_merged');
    expect(answer.markDetail).toBe(
      'Already marked merged on 1 Oct 2026, so this call changed nothing. ' +
        'The mark stays at commit 0d018a9a0e1c, which its repository does not hold. ' +
        'To record the commit that landed, use Mark a later merge and name it under Commit.',
    );
    expect(await mergedCommit(id)).toBe(ABSENT);
  });

  it('still answers a blank Commit over a mark the repository holds with Unmark', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: JUDGED });

    const answer = await personMarks(id, undefined);

    expect(answer.action).toBe('already_merged');
    expect(answer.markDetail).toContain(
      'The mark stays at commit 0d018a9. To change the mark, use Unmark, then Mark merged again.',
    );
  });

  // ISS-1300 r4 (judge-121, F2): seven characters of ABSENT name JUDGED, which the repository holds.
  it('names a commit the repository lacks by twelve characters, so it reads apart from its neighbour', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: null });

    await expect(personMarks(id, ABSENT, false)).rejects.toMatchObject({
      code: 'COMMIT_NOT_IN_REPOSITORY',
      message: expect.stringContaining(`${REPOSITORY} holds no commit 0d018a9a0e1c.`),
    });
  });
});
