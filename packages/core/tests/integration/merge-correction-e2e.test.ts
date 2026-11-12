/**
 * ISS-1027: adminhub-api ISS-2 still reads `mergedCommitSha` 6a40f293, the commit of MR 5162 that
 * misread it, over its real landing b87cbba2, and it is closed: an unmark answers
 * UNMARK_REQUIRES_NOT_CLOSED and a re-mark keeps the wrong commit. `POST /api/issues/:id/merge/correction`
 * replaces a closed issue's landing commit in place, never moves its status, and writes the
 * correction on its history with the commit it replaced.
 *
 * @direct-test-of packages/core/src/issues/landed-at.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  issue,
  issueRow,
  rows,
  seedWorld,
  stampObserved,
  world,
} from '../helpers/host-merge-world.js';

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const WRONG = '6a40f293'.repeat(5);
const REAL = 'b87cbba2'.repeat(5);
const MISREAD_AT = '2026-11-06T03:00:00.000Z';
const REASON = 'MR 5162 stamped ISS-2 through its branch suffix; ISS-2 landed at b87cbba2';

const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

const correct = (issueId: string, body: Record<string, unknown>) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge/correction`, body);

/** When the issues these tests file were created: before every landing a correction names. */
const FILED_AT = '2026-09-01T00:00:00.000Z';

/** ISS-2 as adminhub-api holds it: closed, its mark the commit of a merge that misread it. */
async function misreadClosed(): Promise<string> {
  const id = await issue(2, 'awaiting_release');
  await rows(sql`UPDATE issues SET created_at = ${FILED_AT}::timestamptz WHERE id = ${id}`);
  await stampObserved(id, WRONG, MISREAD_AT);
  await seedIssueStatus(id, 'closed');
  return id;
}

const corrections = (issueId: string) =>
  rows<{ action: string; actor_id: string; payload: Record<string, unknown> }>(sql`
    SELECT action, actor_id, payload FROM activity_log
     WHERE issue_id = ${issueId} AND action = 'issue.mergeCorrected'`);

describe('a closed issue’s misread landing is corrected in place (ISS-1027)', () => {
  beforeEach(async () => seedWorld({ approval: { required: true } }));

  it('replaces the commit, keeps the issue closed, and writes the correction on its history', async () => {
    const two = await misreadClosed();
    expect((await api(world.token, 'DELETE', `/api/issues/${two}/merge`, {})).status).toBe(422);

    const res = await correct(two, { commit: REAL, reason: REASON, misread: 'MR 5162' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: two,
      status: 'closed',
      corrected: { from: WRONG, to: REAL, mergedAt: MISREAD_AT },
      reason: REASON,
      misread: 'MR 5162',
    });
    const row = await issueRow(two);
    expect(row?.merged_commit_sha).toBe(REAL);
    expect(row?.status).toBe('closed');
    expect(await corrections(two)).toMatchObject([
      {
        actor_id: world.ownerId,
        payload: {
          from: { commitSha: WRONG },
          to: { commitSha: REAL },
          reason: REASON,
          misread: 'MR 5162',
        },
      },
    ]);
    const history = await api(world.token, 'GET', `/api/issues/${two}/activity`);
    expect(history.status).toBe(200);
    const items = (history.body as { items: Array<{ action: string; createdAt: string }> }).items;
    const shown = items.find((i) => i.action === 'issue.mergeCorrected');
    expect(shown?.createdAt).toBeTruthy();
  });

  it('takes the real landing time where the correction names one', async () => {
    const two = await misreadClosed();
    const res = await correct(two, {
      commit: REAL,
      reason: REASON,
      mergedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(new Date(String((await issueRow(two))?.merged_at)).toISOString()).toBe(
      '2026-10-01T10:00:00.000Z',
    );
  });

  // ISS-1226 (FB-628): the time a correction names is the landing a release's containment reads, so it
  // is held to the mark's refusals, under the mark's name `landedAt` and its older spelling `mergedAt`
  it('takes the landing time named as `landedAt`', async () => {
    const two = await misreadClosed();
    const res = await correct(two, {
      commit: REAL,
      reason: REASON,
      landedAt: '2026-10-29T10:00:00.000Z',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(new Date(String((await issueRow(two))?.merged_at)).toISOString()).toBe(
      '2026-10-29T10:00:00.000Z',
    );
  });

  const unchanged = async (id: string) => {
    const row = await issueRow(id);
    expect(row?.merged_commit_sha).toBe(WRONG);
    expect(new Date(String(row?.merged_at)).toISOString()).toBe(MISREAD_AT);
    expect(await corrections(id)).toEqual([]);
  };

  it.each(['landedAt', 'mergedAt'])(
    'refuses a %s in the future, and changes nothing',
    async (field) => {
      const two = await misreadClosed();
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      const res = await correct(two, { commit: REAL, reason: REASON, [field]: future });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(codeOf(res.body)).toBe('MERGE_LANDED_AT_FUTURE');
      expect(JSON.stringify(res.body)).toContain(`/${field}`);
      await unchanged(two);
    },
  );

  it.each(['landedAt', 'mergedAt'])(
    'refuses a %s before the issue existed, and changes nothing',
    async (field) => {
      const two = await misreadClosed();
      const res = await correct(two, {
        commit: REAL,
        reason: REASON,
        [field]: '2026-08-01T00:00:00.000Z',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(codeOf(res.body)).toBe('MERGE_LANDED_AT_BEFORE_ISSUE');
      expect(JSON.stringify(res.body)).toContain(`/${field}`);
      await unchanged(two);
    },
  );

  it('refuses both spellings at once, and changes nothing', async () => {
    const two = await misreadClosed();
    const at = '2026-10-29T10:00:00.000Z';
    const res = await correct(two, { commit: REAL, reason: REASON, landedAt: at, mergedAt: at });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('MERGE_LANDED_AT_TWICE');
    await unchanged(two);
  });

  it('refuses a landing that is not a timestamp, naming the field, and changes nothing', async () => {
    const two = await misreadClosed();
    for (const landedAt of ['yesterday', '2026-10-29', 1761696000000]) {
      const res = await correct(two, { commit: REAL, reason: REASON, landedAt });
      expect(res.status, String(landedAt)).toBe(400);
      expect(JSON.stringify(res.body), String(landedAt)).toContain('/landedAt');
    }
    await unchanged(two);
  });

  it('refuses an issue that is not closed, and changes nothing', async () => {
    const open = await issue(3, 'awaiting_release');
    await stampObserved(open, WRONG, MISREAD_AT);
    const res = await correct(open, { commit: REAL, reason: REASON });
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('CORRECTION_REQUIRES_CLOSED');
    expect((await issueRow(open))?.merged_commit_sha).toBe(WRONG);
    expect(await corrections(open)).toEqual([]);
  });

  it('refuses a commit that is not a whole sha', async () => {
    const two = await misreadClosed();
    for (const commit of ['b87cbba2', 'not-a-sha', `${REAL}0`]) {
      const res = await correct(two, { commit, reason: REASON });
      expect(res.status, commit).toBe(422);
      expect(codeOf(res.body), commit).toBe('COMMIT_NOT_WHOLE');
    }
    expect((await issueRow(two))?.merged_commit_sha).toBe(WRONG);
  });

  it('refuses a correction with no reason', async () => {
    const two = await misreadClosed();
    for (const body of [{ commit: REAL }, { commit: REAL, reason: '   ' }]) {
      const res = await correct(two, body);
      expect(res.status).toBe(422);
      expect(codeOf(res.body)).toBe('CORRECTION_REASON_MISSING');
    }
    expect((await issueRow(two))?.merged_commit_sha).toBe(WRONG);
    expect(await corrections(two)).toEqual([]);
  });

  it('refuses the commit the mark already holds', async () => {
    const two = await misreadClosed();
    const res = await correct(two, { commit: WRONG, reason: REASON });
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('MARK_ALREADY_STANDS');
  });
});
