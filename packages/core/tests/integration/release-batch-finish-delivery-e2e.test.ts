/**
 * ISS-1421 r42 (judge-169, criterion 398) — what a finish says of an issue's code on an issue it
 * could not close. An unmarked issue under a release whose deploy went out was told "its code went
 * out with that release", and a deploy declared and never reported back counted as one that went
 * out. The claim needs both halves: a promotion or deploy that reported going out, and a mark that
 * says where the issue's work landed. Through the ledger's own writers, never a hand INSERT.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

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

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

async function askOn(issueId: string): Promise<void> {
  const step = {
    round: 1,
    prompt: 'Which tenant?',
    askedAt: '2026-10-07T10:00:00Z',
    answerShape: 'free_text',
  };
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'open', 'human', ${JSON.stringify([step])}::jsonb)
  `);
}

/** A deploy declared on the run through the ledger, settled with `verdict` unless it is `null`. */
async function deploy(
  runId: string,
  key: string,
  verdict: 'ok' | 'failed' | 'unverified' | null,
): Promise<void> {
  const { openAttempt, settleAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage: 'deploy', idempotencyKey: key, commit: 'b'.repeat(40) });
  if (verdict) await settleAttempt({ runId, idempotencyKey: key, verdict });
}

async function unmark(issueId: string): Promise<void> {
  await harness.db.execute(sql`
    UPDATE issues SET merged_at = NULL, merged_commit_sha = NULL, merged_landing = NULL
     WHERE id = ${issueId}
  `);
}

async function lastComment(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`
    SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at DESC LIMIT 1
  `);
  return String(rows[0]?.body ?? '');
}

describe('whether a finish says an issue’s code went out', () => {
  it('says the code went out with a release whose run recorded a deploy', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const { runId, version } = await fx.claim([held]);
    await deploy(runId, 'deploy-1', 'ok');
    await askOn(held);

    await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    expect((await fx.stored(held)).status).toBe('awaiting_release');
    const said = await lastComment(held);
    expect(said).toContain(`The release finished and went out as version ${version}`);
    expect(said).toContain(
      'The issue is back at Awaiting release, and its code went out with that release.',
    );
  });

  // ISS-1421 r42 (judge-169, criterion 398): with a deploy that went out, an issue refused for its
  // missing mark was told its code went out with that release.
  it('says an unmarked issue’s code is not known to have gone out, though its release went out', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const unmarked = await fx.insertIssue();
    const { runId, version } = await fx.claim([unmarked]);
    await deploy(runId, 'deploy-1', 'ok');
    await unmark(unmarked);

    await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    const said = await lastComment(unmarked);
    expect(said).toContain(`The release finished and went out as version ${version}`);
    expect(said).toContain(
      'The issue is back at Awaiting release. It is not marked merged, so nothing says its code went out with that release.',
    );
    expect(said).not.toContain('and its code went out with that release');
  });

  // ISS-1421 r42: a deploy declared and never reported back, or reported failing, counted as one
  // that went out.
  it.each([
    ['never reported back', null],
    ['reported failing', 'failed'],
  ] as const)('never says a release went out whose deploy %s', async (_what, verdict) => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const { runId, version } = await fx.claim([held]);
    await deploy(runId, 'deploy-1', verdict);
    await askOn(held);

    await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    const said = await lastComment(held);
    expect(said).toContain(`The release finished as version ${version}, but`);
    expect(said).toContain(
      'No promotion or deploy of that release reported going out, so nothing says its code is live.',
    );
    expect(said).not.toMatch(/went out (as|with)|code went out/);
  });

  it('says it went out where one deploy reported going out beside one that failed', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const { runId, version } = await fx.claim([held]);
    await deploy(runId, 'deploy-1', 'failed');
    await deploy(runId, 'deploy-2', 'ok');
    await askOn(held);

    await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    const said = await lastComment(held);
    expect(said).toContain(`The release finished and went out as version ${version}`);
    expect(said).toContain('and its code went out with that release.');
  });
});
