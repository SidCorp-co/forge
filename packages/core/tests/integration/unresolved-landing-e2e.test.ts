/**
 * ISS-1300 — a commit an issue records as where it landed, which the project's repository was read
 * and does not hold, is named once as the defect when its verdicts are weighed, never reported as
 * every verdict superseded. Real Postgres, the GitHub double bound as the project's repository, and
 * the row planted past the mark writer, as a stored value read back.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import type { ServingReading } from '../../src/release-batch/serving-reading.js';

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
      'A person removes its merge mark, then marks it merged at the commit that landed.',
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
      'Its run records the landing again at the commit that landed.',
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
    expect(got.unearned[0]?.why).toContain(`judged at ${JUDGED}, and this issue now stands at ${HELD}`);
  });

  it('weighs a recorded commit the repository could not be read for as before, never as absent (criterion 8)', async () => {
    const id = await plant({ merged: ABSENT });

    const got = await weigh(id);

    expect(got.unresolvedLanding).toBeUndefined();
    expect(got.unearned[0]?.standing).toBe('superseded');
    expect(got.unearned[0]?.why).toContain(`this issue now stands at ${ABSENT}`);
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
