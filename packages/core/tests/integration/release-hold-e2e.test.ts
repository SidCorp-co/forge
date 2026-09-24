/**
 * ISS-1215 — on an automatic-release project a waiting row either leaves `awaiting_release`
 * without a person, or carries the reason it may not. Against real Postgres, because what is
 * asserted is what the row holds after a tick, and a mocked `db` holds whatever it is handed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';

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
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);
const { declareProduction, seedReleaseRunner, insertIssue, stored } = fx;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (
    await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;
  await declareProduction();
  await seedReleaseRunner();
});

function verdictBlock(criterion: number, text: string, verdict: string): string {
  return [
    `criterion: ${criterion} — ${text}`,
    `verdict: ${verdict}`,
    `runtime: ${SERVING}`,
    'evidence: judge-evidence.txt',
    'why: exercised directly',
    'judge: judge-1',
    'judge-from: inherited',
  ].join('\n');
}

function verdictComment(blocks: string[]): string {
  return [
    '## Judged',
    '',
    '```forge-record',
    ...blocks,
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
}

async function postVerdict(issueId: string, body: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body)
    VALUES (${randomUUID()}, ${issueId}, ${ownerId}, ${body})
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
    SELECT ${randomUUID()}, ${issueId}, ${ownerId}, 'judge-evidence.txt', ${`uploads/${issueId}`},
           'text/plain', 64
     WHERE NOT EXISTS (SELECT 1 FROM issue_attachments WHERE issue_id = ${issueId})
  `);
}

/** A waiting row whose criterion 1 carries `verdict` and whose criterion 2 passed. */
async function heldRow(verdict = 'skipped'): Promise<string> {
  const id = await insertIssue();
  const landing = JSON.stringify({ landing: { head: 'dce6f354c', deployment: SERVING } });
  await harness.db.execute(sql`
    UPDATE issues SET acceptance_criteria = ${'1. ok\n2. ok'}, session_context = ${landing}::jsonb
     WHERE id = ${id}
  `);
  await postVerdict(
    id,
    verdictComment([verdictBlock(1, 'a', verdict), verdictBlock(2, 'b', 'pass')]),
  );
  return id;
}

async function holdOf(issueId: string): Promise<Record<string, unknown> | null> {
  const rows = (await harness.db.execute(sql`
    SELECT session_context -> 'releaseHold' AS hold FROM issues WHERE id = ${issueId}
  `)) as unknown as Array<{ hold: Record<string, unknown> | null }>;
  return rows[0]?.hold ?? null;
}

async function holdComments(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT body FROM comments
     WHERE issue_id = ${issueId} AND body LIKE '%release-hold: %'
     ORDER BY created_at ASC, id ASC
  `)) as unknown as Array<{ body: string }>;
  return rows.map((r) => r.body);
}

async function sweep() {
  const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  return sweepAutomaticReleases();
}

describe('a held row says why, once per reason', () => {
  it('writes the hold and one comment, and a second tick with the same reason adds neither', async () => {
    const id = await heldRow();

    const first = await sweep();
    const written = await holdOf(id);
    expect(first.holdsWritten).toBe(1);
    expect(written?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(written?.status).toBe('awaiting_release');
    expect(String(written?.reason)).toContain('criterion 1');
    expect(String(written?.reason)).not.toContain('criterion 2');
    expect(written?.owes).toBe('human');
    expect(String(written?.reason)).toContain(`serving it, \`${SERVING}\``);
    const comments = await holdComments(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('criterion 1');
    expect(comments[0]).toContain('which a person owes');

    const second = await sweep();
    expect(second.holdsWritten).toBe(0);
    expect(await holdComments(id)).toHaveLength(1);
    expect(await holdOf(id)).toEqual(written);
  }, 30_000);

  it('replaces the hold and posts one new comment when the reason changes', async () => {
    const id = await heldRow();
    await sweep();

    await postVerdict(
      id,
      verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'fail')]),
    );
    await sweep();

    const hold = await holdOf(id);
    expect(String(hold?.reason)).toContain('criterion 2');
    expect(String(hold?.reason)).not.toContain('criterion 1:');
    const comments = await holdComments(id);
    expect(comments).toHaveLength(2);
    expect(comments[1]).toContain('criterion 2');
  }, 30_000);
});

describe('every exit before the cut is written on the row', () => {
  it('writes RELEASE_TARGET_UNDECLARED when the project has nowhere to release onto', async () => {
    const id = await heldRow('pass');
    await harness.db.execute(sql`
      UPDATE integration_bindings SET active = false WHERE project_id = ${projectId}
    `);

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    expect((await holdOf(id))?.code).toBe('RELEASE_TARGET_UNDECLARED');
    expect((await stored(id)).claim).toBeNull();
  }, 30_000);

  it('writes NO_RELEASE_GATE on a row still waiting on a project that declares no release', async () => {
    const id = await heldRow('pass');
    await harness.db.execute(sql`
      UPDATE projects SET release_model = 'none', live_branch = NULL, release_strategy = NULL
       WHERE id = ${projectId}
    `);

    await sweep();

    expect((await holdOf(id))?.code).toBe('NO_RELEASE_GATE');
  }, 30_000);

  it('writes the refusal code and message when the release cut is refused', async () => {
    const id = await heldRow('pass');
    await harness.db.execute(sql`DELETE FROM runners WHERE project_id = ${projectId}`);

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_POOL_EMPTY');
    expect(String(hold?.reason)).toContain('The automatic release was refused:');
    expect(String(hold?.reason)).toContain('no runner registered');
    expect(await holdComments(id)).toHaveLength(1);
    expect((await stored(id)).status).toBe('awaiting_release');
  }, 30_000);
});

describe('a hold does not outlive the wait it describes', () => {
  it('clears a hold when the row is cut into a release', async () => {
    const id = await heldRow();
    await sweep();
    expect(await holdOf(id)).not.toBeNull();

    await postVerdict(
      id,
      verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'pass')]),
    );
    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect((await stored(id)).status).toBe('releasing');
    expect(await holdOf(id)).toBeNull();
  }, 30_000);

  it('clears a hold on a row a person moved off the gate, on the next tick', async () => {
    const id = await heldRow();
    await sweep();
    expect(await holdOf(id)).not.toBeNull();
    await harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`);

    await sweep();

    expect(await holdOf(id)).toBeNull();
  }, 30_000);

  it('writes no hold on a project that is not automatic, and clears the one a row carried', async () => {
    const id = await heldRow();
    await sweep();
    expect(await holdOf(id)).not.toBeNull();
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = '{}'::jsonb WHERE id = ${projectId}
    `);
    const other = await heldRow();

    const result = await sweep();

    expect(result.holdsWritten).toBe(0);
    expect(await holdOf(id)).toBeNull();
    expect(await holdOf(other)).toBeNull();
  }, 30_000);
});

describe('the hold and its comment commit together', () => {
  it('keeps the hold unwritten when its comment cannot be stored, so the next tick tries both', async () => {
    const id = await heldRow();
    const { writeReleaseHolds, NO_ACTOR_HOLD } = await import('../../src/pipeline/release-hold.js');

    await expect(
      writeReleaseHolds({
        issueIds: [id],
        holdFor: () => NO_ACTOR_HOLD,
        authorId: randomUUID(),
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(await holdOf(id)).toBeNull();
    expect(await holdComments(id)).toHaveLength(0);
  }, 30_000);

  it('comments once when two writers race from the same prior hold', async () => {
    const id = await heldRow();
    const { writeReleaseHolds, NO_ACTOR_HOLD } = await import('../../src/pipeline/release-hold.js');
    const write = () =>
      writeReleaseHolds({
        issueIds: [id],
        holdFor: () => NO_ACTOR_HOLD,
        authorId: ownerId,
        now: new Date(),
      });

    const [a, b] = await Promise.all([write(), write()]);

    expect(a.written + b.written).toBe(1);
    expect(await holdComments(id)).toHaveLength(1);
    expect((await holdOf(id))?.code).toBe('RELEASE_NO_ACTOR');
  }, 30_000);
});
