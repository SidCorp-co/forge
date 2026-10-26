/**
 * ISS-1300 — a commit an issue records as where it landed, which the project's repository was read
 * and does not hold, is named once as the defect when its verdicts are weighed, never reported as
 * every verdict superseded. Real Postgres, the GitHub double bound as the project's repository, and
 * the row planted past the mark writer, as a stored value read back.
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
const PARENT = '1111111111111111111111111111111111111111';
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

beforeEach(async () => {
  await truncateAll(harness.db);
  repo.reset();
  repo.parents.set(JUDGED, PARENT);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (
    await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  forgetCarriage();
});

/** Two criteria judged at JUDGED; the row then made to record `merged` and `head`, past any writer. */
async function plant(record: { merged: string | null; head?: string }): Promise<string> {
  const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');
  const context = record.head ? { landing: { head: record.head } } : {};
  await harness.db.execute(sql`
    UPDATE issues SET merged_commit_sha = ${record.merged},
                      session_context = ${JSON.stringify(context)}::jsonb
     WHERE id = ${id}
  `);
  return id;
}

/** A third criterion judged at `commit`, beside the two `judgedRow` wrote. */
async function judgeThird(id: string, commit: string): Promise<void> {
  const body = [
    '## Verdict',
    '',
    '```forge-record',
    'criterion: 3 — ok',
    'verdict: pass',
    `commit: ${commit}`,
    'evidence: judge.txt',
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
  await harness.db.execute(sql`
    UPDATE issues SET acceptance_criteria = ${'1. ok\n2. ok\n3. ok'} WHERE id = ${id}
  `);
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body)
    VALUES (gen_random_uuid(), ${id}, ${ownerId}, ${body})
  `);
}

async function weigh(id: string, serving: ServingReading = UNREADABLE) {
  const { readWeighingNow } = await import('../../src/release-batch/runtime-weighing.js');
  const { unearnedCriteriaReports } = await import('../../src/issues/criteria-verdicts.js');
  const weighing = await readWeighingNow(projectId, serving, [id]);
  const [one] = await unearnedCriteriaReports([id], serving, weighing);
  if (!one) throw new Error('no report came back');
  return one;
}

const askedFor = (commit: string) => repo.asked.filter((url) => url.includes(`/commits/${commit}`));

describe('a recorded merged commit the repository does not hold (ISS-1300)', () => {
  it('names it and the repository on every criterion, as one reason (criteria 1, 3)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });

    const got = await weigh(id);

    expect(got.unearned.map((c) => c.criterion)).toEqual([1, 2]);
    const whys = new Set(got.unearned.map((c) => c.why));
    expect(whys.size).toBe(1);
    const [why] = [...whys];
    expect(why).toContain(ABSENT);
    expect(why).toContain(REPOSITORY);
    expect(why).toContain('no verdict can be weighed against it');
    expect(why).not.toContain('now stands at');
  });

  it('gives a verdict naming that same commit the same reason, never the source it stands at (criterion 2)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });
    await judgeThird(id, ABSENT);

    const got = await weigh(id);

    expect(got.unearned.map((c) => c.criterion)).toEqual([1, 2, 3]);
    expect(new Set(got.unearned.map((c) => c.why)).size).toBe(1);
    expect(got.unearned[2]?.why).not.toContain('still the source this issue stands at');
  });

  it('reports the commit, the repository and the merge mark once for the issue (criterion 4)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });

    const got = await weigh(id);

    expect(got.unresolvedLanding).toEqual({
      commit: ABSENT,
      repository: REPOSITORY,
      from: 'merge',
    });
  });

  it("leads the release's hold with the record, and names correcting it as the act (criterion 5)", async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });
    const { criteriaHold } = await import('../../src/pipeline/release-hold-kinds.js');

    const hold = criteriaHold(await weigh(id));

    expect(hold.words?.[0]).toBe(
      'The automatic release leaves this issue out, because the commit it records as landed is not in its repository.',
    );
    expect(hold.words?.[1]).toBe(
      "A person uses Mark a later merge in the issue's properties, and names the commit that landed under Commit.",
    );
    expect(hold.words?.join(' ')).not.toContain('records a verdict on each');
    expect(hold.reason).toContain(ABSENT);
  });

  it('names a landing head the repository does not hold the same way, with the landing record as what to correct (criterion 6)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: null, head: ABSENT });
    const { criteriaHold } = await import('../../src/pipeline/release-hold-kinds.js');

    const got = await weigh(id);

    expect(got.unresolvedLanding).toEqual({
      commit: ABSENT,
      repository: REPOSITORY,
      from: 'landing',
    });
    expect(got.unearned[0]?.why).toContain('its landing record');
    expect(criteriaHold(got).words?.[1]).toBe(
      'A person uses Mark merged, or Mark a later merge once marked, and names the commit that landed under Commit.',
    );
  });

  it('weighs a recorded commit the repository holds as before (criterion 7)', async () => {
    await repo.bind(projectId, ownerId);
    const HELD = '2222222222222222222222222222222222222222';
    repo.parents.set(HELD, PARENT);
    const id = await plant({ merged: HELD });

    const got = await weigh(id);

    expect(got.unresolvedLanding).toBeUndefined();
    expect(got.unearned[0]?.standing).toBe('superseded');
    expect(got.unearned[0]?.why).toContain(
      `judged at ${JUDGED}, and this issue now stands at ${HELD}`,
    );
  });

  it('weighs a recorded commit the repository could not be read for as before, never as absent (criterion 8)', async () => {
    const id = await plant({ merged: ABSENT });

    const got = await weigh(id);

    expect(got.unresolvedLanding).toBeUndefined();
    expect(got.unearned[0]?.standing).toBe('superseded');
    expect(got.unearned[0]?.why).toContain(`this issue now stands at ${ABSENT}`);
  });

  // judge-113: GitHub answers 404 for a repository the installation cannot see, 422 for a commit a
  // repository it shows lacks. A bound repository answering 404 says nothing of the commit.
  it('weighs a recorded commit a bound repository answering 404 could not be read for as before, never as absent (criterion 8)', async () => {
    await repo.bind(projectId, ownerId);
    repo.hidden = true;
    const id = await plant({ merged: JUDGED });
    const { criteriaHold } = await import('../../src/pipeline/release-hold-kinds.js');

    const got = await weigh(id);

    expect(askedFor(JUDGED)).toHaveLength(1);
    expect(got.unresolvedLanding).toBeUndefined();
    expect(got.unearned.map((c) => c.standing)).toEqual(['unwitnessed', 'unwitnessed']);
    expect(got.unearned[0]?.why).not.toContain('is not a commit');
    expect(criteriaHold(got).words?.join(' ')).not.toContain('not in its repository');
  });

  it('refuses no mark as absent at the merge door where the repository answers 404, and still refuses one a readable repository lacks', async () => {
    await repo.bind(projectId, ownerId);
    const { resolveMarkCommit } = await import('../../src/issues/commit-landing.js');

    repo.hidden = true;
    const hidden = await resolveMarkCommit({ projectId, commit: JUDGED });
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.code).toBe('COMMIT_UNVERIFIED');
    expect(hidden.detail).toContain(`${REPOSITORY} answered HTTP 404`);
    expect(hidden.detail).toContain(`Restore ${REPOSITORY}`);
    expect(hidden.unread).toBeDefined();

    repo.hidden = false;
    const absent = await resolveMarkCommit({ projectId, commit: ABSENT });
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.code).toBe('COMMIT_NOT_IN_REPOSITORY');
    expect(absent.detail).toContain(REPOSITORY);
  });

  it('gives the release readiness and its refusal the same act as the issue hold', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });
    const { readWeighingNow } = await import('../../src/release-batch/runtime-weighing.js');
    const { criteriaHold } = await import('../../src/release-batch/criteria-hold.js');
    const { landingCorrection } = await import('../../src/issues/landing-correction.js');
    const out: Array<{ code: string; message: string }> = [];

    const weighing = await readWeighingNow(projectId, UNREADABLE, [id]);
    await criteriaHold(projectId, [id], out as never, [], UNREADABLE, weighing);

    const [blocked] = out;
    expect(blocked?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    const said = blocked?.message ?? '';
    expect(said).toContain(`records ${ABSENT} as landed, which ${REPOSITORY} does not hold`);
    expect(said).toContain(landingCorrection('merge'));
    expect(said).not.toContain('owes');
  });

  it('asks the repository once per weighing, however many verdicts name the commit (criterion 9)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });
    await judgeThird(id, ABSENT);

    await weigh(id);

    expect(askedFor(ABSENT)).toHaveLength(1);
  });

  it('does not ask the repository where what the project serves is read (criterion 9)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });

    await weigh(id, {
      kind: 'serving',
      served: [{ commit: JUDGED, where: 'https://app.example.test/api/build-info' }],
      unread: [],
      readAt: '2026-10-25T03:00:00.000Z',
    });

    expect(askedFor(ABSENT)).toHaveLength(0);
  });
});

const person = () => ({
  agency: 'human' as const,
  commentAuthorId: ownerId,
  hookActor: { type: 'user' as const, id: ownerId, agency: 'human' as const },
});

async function columns(id: string) {
  const r = await harness.db.execute(sql`
    SELECT merged_at, merged_commit_sha, merged_commit_stated FROM issues WHERE id = ${id}
  `);
  const rows = (r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[]);
  return rows[0] as {
    merged_at: unknown;
    merged_commit_sha: string | null;
    merged_commit_stated: boolean;
  };
}

/** A person's mark through the one writer the page and the API share, as the page sends it. */
async function personMarks(id: string, commit: string, marked = true) {
  const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  const at = marked ? new Date('2026-10-01T09:00:00Z') : null;
  const answer = await applyMergeMarker({
    issue: { id, projectId, mergedAt: at, declaredLandingShape: null },
    op: 'mark',
    target: 'main',
    commit,
    actor: person(),
  });
  forgetCarriage();
  return answer;
}

/** A merged pull request Forge projected for the issue, merged at `sha`. */
async function observedPull(id: string, sha: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO repo_pull_requests (project_id, binding_id, issue_id, number, repo_full_name, title,
      state, head_ref, head_sha, base_ref, base_sha, merged_at, merge_commit_sha)
    SELECT ${projectId}, b.id, ${id}, 578, ${REPOSITORY}, 'the pull', 'merged', 'feature', ${PARENT},
      'main', ${PARENT}, '2026-10-01T09:00:00Z'::timestamptz, ${sha}
      FROM integration_bindings b WHERE b.project_id = ${projectId} LIMIT 1
  `);
}

// ISS-1300 r3 — judge-117 found the act the hold names could not carry a commit: a person's mark
// kept none, so the hold came back or every criterion fell to `unanchored`. A person's commit the
// repository holds is now the landing the weighing reads, ahead of the head and a pull request's.
describe('the act the hold names clears it (criteria 5, 6)', () => {
  async function cleared(id: string) {
    const { criteriaHold } = await import('../../src/pipeline/release-hold-kinds.js');
    const got = await weigh(id);
    expect(got.unresolvedLanding).toBeUndefined();
    expect(got.unearned.map((c) => c.standing)).toEqual(['unwitnessed', 'unwitnessed']);
    expect(criteriaHold(got).words?.join(' ')).not.toContain('not in its repository');
  }

  it('stamps the commit a person names over a merge mark the repository lacks (criterion 5)', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });

    const answer = await personMarks(id, JUDGED);

    expect(answer.action).toBe('merged');
    expect(answer.mark).toBe('asserted');
    // ISS-1300 r4 (judge-121): the pair shares eight characters, so each is shown past them.
    expect(answer.markDetail).toBe(
      `Commit 0d018a9ac, which ${REPOSITORY} holds, replaces commit 0d018a9a0, which it does not. ` +
        'Forge did not see this merge, so the mark is a claim.',
    );
    expect(await columns(id)).toMatchObject({
      merged_commit_sha: JUDGED,
      merged_commit_stated: true,
    });
    await cleared(id);
  });

  it('stamps it where a landing record the repository lacks is all the issue records, marked or not (criterion 6)', async () => {
    await repo.bind(projectId, ownerId);
    const marked = await plant({ merged: null, head: ABSENT });
    const unmarked = await plant({ merged: null, head: ABSENT });
    await harness.db.execute(sql`UPDATE issues SET merged_at = NULL WHERE id = ${unmarked}`);

    expect((await personMarks(marked, JUDGED)).action).toBe('merged');
    expect((await personMarks(unmarked, JUDGED, false)).action).toBe('merged');

    for (const id of [marked, unmarked]) {
      expect(await columns(id)).toMatchObject({
        merged_commit_sha: JUDGED,
        merged_commit_stated: true,
      });
      await cleared(id);
    }
  });

  it('stamps it ahead of a merged pull request whose merge commit the repository lacks', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });
    await observedPull(id, ABSENT);

    await personMarks(id, JUDGED);

    expect((await columns(id)).merged_commit_sha).toBe(JUDGED);
    await cleared(id);
  });

  it('refuses a named commit the repository lacks by name, and writes nothing', async () => {
    await repo.bind(projectId, ownerId);
    const id = await plant({ merged: ABSENT });
    const OTHER = '3333333333333333333333333333333333333333';

    await expect(personMarks(id, OTHER)).rejects.toMatchObject({
      code: 'COMMIT_NOT_IN_REPOSITORY',
    });
    expect(await columns(id)).toMatchObject({
      merged_commit_sha: ABSENT,
      merged_commit_stated: false,
    });
  });

  it('leaves a merge mark the repository holds to its own rules: a person names no other commit over it', async () => {
    await repo.bind(projectId, ownerId);
    const HELD = '2222222222222222222222222222222222222222';
    repo.parents.set(HELD, PARENT);
    const id = await plant({ merged: HELD });

    await personMarks(id, JUDGED).catch(() => undefined);

    expect(await columns(id)).toMatchObject({
      merged_commit_sha: HELD,
      merged_commit_stated: false,
    });
  });
});

// ISS-1300 r3 — a bound repository that refuses the read (404, 401, 403) holds no verdict back as
// absent, and the hold, the readiness page and the release-create refusal name it and what restores it.
describe('a recorded landing its bound repository refuses to be read for', () => {
  it('names the repository Forge cannot read in the hold, and the act that restores it', async () => {
    await repo.bind(projectId, ownerId);
    repo.hidden = true;
    const id = await plant({ merged: JUDGED });
    const { criteriaHold } = await import('../../src/pipeline/release-hold-kinds.js');

    const got = await weigh(id);
    const hold = criteriaHold(got);

    expect(got.unearned.map((c) => c.standing)).toEqual(['unwitnessed', 'unwitnessed']);
    expect(got.unreadLanding).toEqual({ commit: JUDGED, repository: REPOSITORY });
    expect(got.unearned[0]?.why).toContain(`whether ${REPOSITORY} holds ${JUDGED}`);
    expect(hold.words?.[0]).toBe(
      `The automatic release leaves this issue out, because criteria 1 and 2 are unearned and Forge cannot read ${REPOSITORY}.`,
    );
    expect(hold.words?.[1]).toBe(
      `A person makes ${REPOSITORY} readable to Forge again, then records a verdict on each or closes the issue.`,
    );
    expect(hold.reason).toContain(
      `Forge cannot read ${REPOSITORY}, and checks again once Forge can read ${REPOSITORY} again:`,
    );
    expect(hold.reason).not.toMatch(/tracker/);
    expect(hold.words?.join(' ')).not.toContain('at the running deployment');
  });

  it('says the same on the release readiness page and in the release-create refusal', async () => {
    await repo.bind(projectId, ownerId);
    repo.hidden = true;
    const id = await plant({ merged: JUDGED });
    const { readWeighingNow } = await import('../../src/release-batch/runtime-weighing.js');
    const { criteriaHold } = await import('../../src/release-batch/criteria-hold.js');
    const out: Array<{ code: string; message: string }> = [];

    const weighing = await readWeighingNow(projectId, UNREADABLE, [id]);
    await criteriaHold(projectId, [id], out as never, [], UNREADABLE, weighing);

    expect(out[0]?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(out[0]?.message).toContain(
      `Forge cannot read ${REPOSITORY}, and checks again once Forge can read ${REPOSITORY} again:`,
    );
  });

  it('says it of the carried range on the readiness page too, never to load the page again', async () => {
    await fx.declareProduction();
    await repo.bind(projectId, ownerId);
    repo.hidden = true;
    await plant({ merged: JUDGED });
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const blockers = (await loadReleaseReadiness(projectId))?.blockers ?? [];
    const carried = blockers.find((b) => b.details?.check === 'carried');

    expect(carried?.reader).toBe(
      `Reading which landings this release would carry beyond its issues failed: Forge cannot read ${REPOSITORY}, and checks again once Forge can read ${REPOSITORY} again: give the GitHub App installation behind this project's binding access to it, or bind the project to where it now lives. Until then this answer cannot say whether a release would start: whatever that check would have found is missing from this list.`,
    );
    expect(blockers.map((b) => `${b.reader} ${b.message}`).join(' ')).not.toMatch(
      /retry|again to/i,
    );
  });
});
