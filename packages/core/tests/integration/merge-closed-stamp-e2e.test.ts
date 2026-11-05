/**
 * ISS-1027 (adminhub-api FB-528): MR 5162 was opened from `fix/strict-check-recursive-not-iss-50-2`,
 * its branch was read as naming ISS-50 and ISS-2, and `POST /api/issues/:id/merge-pull-request` on
 * ISS-50 answered `stampedIssues: [ISS-50, ISS-2]`, ISS-2 closed and unrelated. A branch names the
 * one key it carries (REQ-63 BC-4 r11), a merge never writes onto another linked issue already
 * closed or dropped, and the answer names the reading that named each issue.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  issue,
  issueRow,
  mergeOf,
  mergeRequest,
  rows,
  seedWorld,
  stampObserved,
} from '../helpers/host-merge-world.js';
import { merged } from '../helpers/planted-gitlab-merges.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const HEAD = 'b1'.repeat(20);
const SHIPPED = 'b87cbba2'.repeat(5);
const SHIPPED_AT = '2026-10-01T10:00:00.000Z';

interface MergeAnswer {
  stampedIssues: string[];
  refusedStamps: unknown[];
  skippedStamps: Array<{
    issueId: string;
    issue: string;
    status: string;
    namedBy: string;
    detail: string;
  }>;
  linkedIssues: Array<{ issueId: string; issue: string; namedBy: string; stamp: string }>;
}

const activity = (issueId: string) =>
  rows<{ action: string }>(sql`
    SELECT action FROM activity_log WHERE issue_id = ${issueId} ORDER BY created_at`);

/** An issue that shipped long ago: its own landing stamped, then closed by its release. */
async function shipped(seq: number): Promise<string> {
  const id = await issue(seq, 'awaiting_release');
  await stampObserved(id, SHIPPED, SHIPPED_AT);
  await seedIssueStatus(id, 'closed');
  return id;
}

async function merge(issueId: string, number: number) {
  const res = await mergeOf(issueId, number);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as MergeAnswer;
}

describe('a merge stamps no other linked issue already over (ISS-1027)', () => {
  beforeEach(async () => seedWorld({ approval: { required: true } }));

  it('reads MR 5162’s run suffix as no key: ISS-50 is stamped, closed ISS-2 is not linked', async () => {
    const fifty = await issue(50, 'awaiting_release');
    const two = await shipped(2);
    await mergeRequest(51, 'fix/strict-check-recursive-not-iss-50-2', HEAD, null);

    const body = await merge(fifty, 51);

    expect(body.stampedIssues).toEqual([fifty]);
    expect(body.linkedIssues).toEqual([
      { issueId: fifty, issue: 'ISS-50', namedBy: 'branch-tail', stamp: 'stamped' },
    ]);
    expect((await issueRow(fifty))?.merged_commit_sha).toBe(merged.get(51));
    expect((await issueRow(two))?.merged_commit_sha).toBe(SHIPPED);
  });

  it('skips a closed issue the body names, leaves its row and history untouched, and says why', async () => {
    const fifty = await issue(50, 'awaiting_release');
    const two = await shipped(2);
    const before = await activity(two);
    await mergeRequest(52, 'fix/x-iss-50', HEAD, 'Closes ISS-2.');

    const body = await merge(fifty, 52);

    expect(body.stampedIssues).toEqual([fifty]);
    expect(body.refusedStamps).toEqual([]);
    expect(body.skippedStamps).toMatchObject([
      { issueId: two, issue: 'ISS-2', status: 'closed', namedBy: 'body' },
    ]);
    expect(body.skippedStamps[0]?.detail).toContain(
      'ISS-2 is closed, so this merge did not stamp it',
    );
    expect(body.linkedIssues).toEqual([
      { issueId: fifty, issue: 'ISS-50', namedBy: 'branch-tail', stamp: 'stamped' },
      { issueId: two, issue: 'ISS-2', namedBy: 'body', stamp: 'skipped' },
    ]);
    const row = await issueRow(two);
    expect(row?.merged_commit_sha).toBe(SHIPPED);
    expect(new Date(String(row?.merged_at)).toISOString()).toBe(SHIPPED_AT);
    expect(row?.status).toBe('closed');
    expect(await activity(two)).toEqual(before);
  });

  it('skips a dropped issue the title names', async () => {
    const fifty = await issue(50, 'awaiting_release');
    const seven = await issue(7, 'dropped');
    await mergeRequest(53, 'fix/iss-50-login', HEAD, null, 'ISS-7: login');

    const body = await merge(fifty, 53);

    expect(body.stampedIssues).toEqual([fifty]);
    expect(body.skippedStamps).toMatchObject([
      { issueId: seven, issue: 'ISS-7', status: 'dropped', namedBy: 'title' },
    ]);
    expect(body.linkedIssues.map((l) => [l.issue, l.namedBy, l.stamp])).toEqual([
      ['ISS-50', 'branch-lead', 'stamped'],
      ['ISS-7', 'title', 'skipped'],
    ]);
    expect((await issueRow(seven))?.merged_at).toBeNull();
    expect((await issueRow(seven))?.status).toBe('dropped');
  });

  it('stamps every open issue a request delivers, each named by its reading', async () => {
    const sixteen = await issue(16, 'awaiting_release');
    const thirtyOne = await issue(31, 'in_progress');
    await mergeRequest(54, 'feat/x-iss-16', HEAD, 'Also delivers ISS-31.');

    const body = await merge(sixteen, 54);

    expect([...body.stampedIssues].sort()).toEqual([sixteen, thirtyOne].sort());
    expect(body.skippedStamps).toEqual([]);
    expect(body.linkedIssues.map((l) => [l.issue, l.namedBy, l.stamp])).toEqual([
      ['ISS-16', 'branch-tail', 'stamped'],
      ['ISS-31', 'body', 'stamped'],
    ]);
    for (const id of [sixteen, thirtyOne]) {
      expect((await issueRow(id))?.merged_commit_sha).toBe(merged.get(54));
    }
  });

  it('keeps today’s stamp on the issue the call names, even when it is closed', async () => {
    const fifty = await shipped(50);
    await mergeRequest(55, 'fix/iss-50-again', HEAD, null);

    const body = await merge(fifty, 55);

    expect(body.skippedStamps).toEqual([]);
    expect(body.linkedIssues).toEqual([
      { issueId: fifty, issue: 'ISS-50', namedBy: 'branch-lead', stamp: 'stamped' },
    ]);
    expect((await issueRow(fifty))?.merged_commit_sha).toBe(merged.get(55));
  });
});
