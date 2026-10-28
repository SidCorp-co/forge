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
  createTestDevice,
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

/** A promotion or deploy declared on the run through the ledger, settled with `verdict` unless it
 *  is `null`. */
async function deliver(
  runId: string,
  stage: 'promote' | 'deploy',
  key: string,
  verdict: 'ok' | 'failed' | 'unverified' | null,
): Promise<void> {
  const { openAttempt, settleAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage, idempotencyKey: key, commit: 'b'.repeat(40) });
  if (verdict) await settleAttempt({ runId, idempotencyKey: key, verdict });
}

const deploy = (runId: string, key: string, verdict: 'ok' | 'failed' | 'unverified' | null) =>
  deliver(runId, 'deploy', key, verdict);

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

/** Every comment on the issue, oldest first, with who wrote it. */
async function thread(issueId: string): Promise<Array<{ body: string; author: string }>> {
  const rows = await harness.db.execute(sql`
    SELECT body, author_id FROM comments WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
  return rows.map((r) => ({ body: String(r.body), author: String(r.author_id) }));
}

async function claimOf(issueId: string): Promise<unknown> {
  const rows = await harness.db.execute(sql`
    SELECT release_batch_run_id FROM issues WHERE id = ${issueId}
  `);
  return rows[0]?.release_batch_run_id ?? null;
}

// ISS-1421 r43 (judge-171 on 406): a finish whose run declared a promotion that never reported back
// held the issue at Releasing, saying the code "may be on production" and that the issue stays at
// Releasing "while its run is live", though the finish ended the run; forty seconds later the sweep
// wrote "The release run completed without finishing its release" under "The release finished".
// One account of one release: the finish settles its own issue, and the sweep finds nothing to say.
describe('a finish whose run recorded a promotion', () => {
  it.each([
    ['reported going out', 'ok', true],
    ['never reported back', null, false],
    ['reported failing', 'failed', false],
  ] as const)(
    'returns the issue it could not close to Awaiting release when the promotion %s, and the sweep adds nothing',
    async (_what, verdict, wentOut) => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const { settleStrandedReleasing } = await import(
        '../../src/release-batch/releasing-settle.js'
      );
      const { FORGE_AUTHOR_ID } = await import('../../src/comments/forge-author.js');
      const held = await fx.insertIssue();
      const { runId, version } = await fx.claim([held]);
      await deliver(runId, 'promote', 'promote-1', verdict);
      await askOn(held);

      await finishReleaseBatch(runId, { type: 'user', id: ownerId });

      expect((await fx.stored(held)).status).toBe('awaiting_release');
      expect(await claimOf(held)).toBeNull();
      expect(await fx.runStatus(runId)).toBe('completed');
      const before = await thread(held);
      const said = before.at(-1)?.body ?? '';
      expect(said).not.toMatch(/may be on production|stays? at Releasing|while its run is live/);
      if (wentOut) {
        expect(said).toContain(`The release finished and went out as version ${version}`);
        expect(said).toContain('and its code went out with that release.');
      } else {
        expect(said).toContain(`The release finished as version ${version}, but`);
        expect(said).toContain(
          'No promotion or deploy of that release reported going out, so nothing says its code is live.',
        );
        expect(said).not.toMatch(/went out (as|with)|code went out/);
      }
      // Forge writes it, naming who reported the finish (criteria 419, 420).
      expect(before.at(-1)?.author).toBe(FORGE_AUTHOR_ID);
      expect(said).toMatch(
        /could not be closed\. The finish was reported by [^.]+\. The close was refused/,
      );

      expect(await settleStrandedReleasing()).toEqual({ settled: 0, closed: 0, failed: 0 });
      const after = await thread(held);
      expect(after).toEqual(before);
      expect(after.map((c) => c.body).join('\n')).not.toMatch(/without finishing/);
    },
  );

  it('names the box that reported the finish', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { FORGE_AUTHOR_ID } = await import('../../src/comments/forge-author.js');
    const box = await createTestDevice(harness.db, ownerId, { name: 'sid-desk' });
    const held = await fx.insertIssue();
    const { runId } = await fx.claim([held]);
    await askOn(held);

    await finishReleaseBatch(runId, { type: 'device', id: box.id, ownerId });

    const [said] = (await thread(held)).slice(-1);
    expect(said?.author).toBe(FORGE_AUTHOR_ID);
    expect(said?.body).toContain('The finish was reported by the box sid-desk.');
  });
});
