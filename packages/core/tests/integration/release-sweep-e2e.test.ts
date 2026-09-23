/**
 * ISS-1117 — the ISS-1139/ISS-1114 reproduction, against real Postgres.
 *
 * The negative case is the point of this file: an issue at `awaiting_release`
 * holding a criterion whose latest verdict is `skipped` must be left exactly
 * where it is by `sweepAutomaticReleases`, on a project that has otherwise
 * opted all the way into "nobody presses release." ISS-1139 was closed by
 * hand over exactly this shape on 2026-09-20 and had to be reverted; this
 * suite is what proves the automation that replaces that hand does not
 * repeat the mistake.
 *
 * Uses `release-batch-fixture.ts`, the seeding already built for a project
 * that can legally reach `awaiting_release` and cut a release.
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

/** The identity the issues seeded here record as serving them. */
const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
/** A runtime that is not that one: the head a repair replaced, as ISS-1185 carried it. */
const REPLACED = '34450f4420ae4a3b6de40b6d3cfb2b0e66aa2f51';

/** One criterion's verdict block, in the exact shape `forge record verdict` writes. */
function verdictBlock(
  criterion: number,
  text: string,
  verdict: string,
  runtime: string | null = SERVING,
): string {
  return [
    `criterion: ${criterion} — ${text}`,
    `verdict: ${verdict}`,
    ...(runtime === null ? ['commit: dce6f354c'] : [`runtime: ${runtime}`]),
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

describe('release sweep E2E (ISS-1117)', () => {
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
  const { declareProduction, seedReleaseRunner, insertIssue, stored, commentCount } = fx;

  async function setCriteria(issueId: string, text: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE issues SET acceptance_criteria = ${text} WHERE id = ${issueId}
    `);
  }

  /** The landing an issue records, which is what a verdict's identity is resolved against. */
  async function setServing(issueId: string, deployment: string): Promise<void> {
    const landing = JSON.stringify({ landing: { head: 'dce6f354c', deployment } });
    await harness.db.execute(sql`
      UPDATE issues SET session_context = ${landing}::jsonb WHERE id = ${issueId}
    `);
  }

  /**
   * The comment, and the file every block in it cites. ISS-1198 resolves a verdict's `evidence:`
   * against what the tracker holds, so a fixture that posts the verdict and attaches nothing is
   * one whose criteria are unearned for a citation that does not resolve.
   */
  async function postVerdict(issueId: string, body: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body)
      VALUES (${randomUUID()}, ${issueId}, ${ownerId}, ${body})
    `);
    await harness.db.execute(sql`
      INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
      VALUES (${randomUUID()}, ${issueId}, ${ownerId}, ${'judge-evidence.txt'},
              ${`uploads/${issueId}`}, ${'text/plain'}, ${64})
    `);
  }

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

  it('cuts the earned issue and leaves the ISS-1139-shaped skipped one untouched', async () => {
    const earnedId = await insertIssue();
    await setCriteria(earnedId, '1. ok\n2. ok');
    await setServing(earnedId, SERVING);
    await postVerdict(
      earnedId,
      verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'pass')]),
    );

    const unearnedId = await insertIssue();
    await setCriteria(unearnedId, '1. ok\n2. ok');
    await setServing(unearnedId, SERVING);
    await postVerdict(
      unearnedId,
      verdictComment([
        verdictBlock(1, 'a', 'pass'),
        verdictBlock(2, 'the runner close loop sends its run project id', 'skipped'),
      ]),
    );

    const beforeUnearned = await stored(unearnedId);
    const unearnedCommentsBefore = await commentCount(unearnedId);

    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(1);
    expect(result.issuesExcluded).toBe(1);

    const earned = await stored(earnedId);
    expect(earned.status).toBe('releasing');
    expect(earned.claim).not.toBeNull();

    const unearned = await stored(unearnedId);
    expect(unearned.status).toBe(beforeUnearned.status);
    expect(unearned.claim).toBeNull();
    expect(await commentCount(unearnedId)).toBe(unearnedCommentsBefore);
  }, 30_000);

  it('touches nothing when every waiting issue is unearned', async () => {
    const id = await insertIssue();
    await setCriteria(id, '1. ok');
    await setServing(id, SERVING);
    await postVerdict(id, verdictComment([verdictBlock(1, 'never reached', 'skipped')]));

    const before = await stored(id);

    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(0);
    expect(result.issuesExcluded).toBe(1);
    const after = await stored(id);
    expect(after).toEqual(before);
  }, 30_000);

  it('leaves an issue whose every criterion passed at a runtime a repair replaced', async () => {
    const id = await insertIssue();
    await setCriteria(id, '1. ok\n2. ok');
    await setServing(id, SERVING);
    await postVerdict(
      id,
      verdictComment([
        verdictBlock(1, 'a', 'pass', REPLACED),
        verdictBlock(2, 'b', 'pass', REPLACED),
      ]),
    );

    const before = await stored(id);

    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(0);
    expect(result.issuesExcluded).toBe(1);
    expect(await stored(id)).toEqual(before);
  }, 30_000);

  it('leaves an issue whose passes name only a source, with no runtime to witness them', async () => {
    const id = await insertIssue();
    await setCriteria(id, '1. ok');
    await setServing(id, SERVING);
    await postVerdict(id, verdictComment([verdictBlock(1, 'a', 'pass', null)]));

    const before = await stored(id);

    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(0);
    expect(result.issuesExcluded).toBe(1);
    expect(await stored(id)).toEqual(before);
  }, 30_000);

  it('does nothing for a project that has not opted into autoProdDeploy', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = '{}'::jsonb WHERE id = ${projectId}
    `);
    const id = await insertIssue();
    await setCriteria(id, '1. ok');
    await postVerdict(id, verdictComment([verdictBlock(1, 'a', 'pass')]));

    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(0);
    const after = await stored(id);
    expect(after.status).toBe('awaiting_release');
    expect(after.claim).toBeNull();
  }, 30_000);
});
