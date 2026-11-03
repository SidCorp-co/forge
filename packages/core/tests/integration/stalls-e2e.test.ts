/**
 * ISS-696 (REQ-67 BC-6): each delivery stall is recorded against the item that caused it, with the
 * question it raised, in the transaction of the act that starts it, and ended by the act that clears
 * it. Unclear item: a question about a requirement or feedback item, or a reporter's clarification,
 * ended by its answer or void. Defect: a failed verdict's reopen, ended by the next merge mark or a
 * drop. Waiting on a person: a `needs_info` park, ended by leaving it. A park on another issue's
 * merge mark waits on ordering, and a steward's decision about an item is triage: neither is a stall.
 */

// @direct-test-of packages/core/src/issues/stalls.ts
// @direct-test-of packages/core/src/issues/apply-transition.ts
// @direct-test-of packages/core/src/issues/park-question.ts
// @direct-test-of packages/core/src/issues/fail-reopen.ts
// @direct-test-of packages/core/src/issues/merge-record.ts
// @direct-test-of packages/core/src/questions/stall-start.ts
// @direct-test-of packages/core/src/questions/write.ts
// @direct-test-of packages/core/src/db/schema-stalls.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { reopenOnFail } from '../../src/issues/fail-reopen.js';
import { askQuestion } from '../../src/questions/index.js';
import { api, type Body } from '../helpers/api.js';
import { feedback, issue, requirement, type World, world } from '../helpers/forecast-world.js';

let w: World;

beforeAll(async () => {
  w = await world();
  // the in-process ask below queues its notice: the first request starts the queue it needs
  await api(w.token, 'GET', `/api/projects/${w.projectId}`);
}, 120_000);

type StallRow = {
  cause: string;
  requirement_id: string | null;
  feedback_id: string | null;
  issue_id: string | null;
  question_id: string | null;
  question: string | null;
  ended_at: Date | null;
  ended_by: string | null;
};

async function stallsOn(where: { issueId?: string; feedbackId?: string }): Promise<StallRow[]> {
  const filter = where.issueId
    ? sql`issue_id = ${where.issueId}`
    : sql`feedback_id = ${where.feedbackId}`;
  return (await db.execute(
    sql`SELECT cause, requirement_id, feedback_id, issue_id, question_id, question, ended_at, ended_by
        FROM stalls WHERE ${filter} ORDER BY started_at`,
  )) as unknown as StallRow[];
}

async function feedbackId(key: string): Promise<string> {
  const [row] = (await db.execute(
    sql`SELECT id FROM feedback WHERE project_id = ${w.projectId} AND fb_seq = ${Number(key.slice(3))}`,
  )) as unknown as { id: string }[];
  return row?.id as string;
}

const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Body> => {
  const res = await api(w.token, method, path, body);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
};

const ask = (over: Record<string, unknown>) =>
  askQuestion({
    id: randomUUID(),
    projectId: w.projectId,
    askedBy: w.userId,
    prompt: 'Is the total shown before or after tax?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'before or after' },
    ...over,
  } as Parameters<typeof askQuestion>[0]);

describe('unclear item', () => {
  it('a question about the requirement an issue delivers starts a stall on that requirement, and its answer ends it', async () => {
    const req = await requirement(w, 'Invoices show their total');
    const built = await issue(w, {
      createdAt: new Date(),
      status: 'in_progress',
      requirementId: req.id,
    });
    const asked = await ask({ issueId: built.id, about: { requirement: null } });

    const [open] = await stallsOn({ issueId: built.id });
    expect(open, 'the question about the requirement started no stall').toMatchObject({
      cause: 'unclear_item',
      requirement_id: req.id,
      issue_id: built.id,
      question_id: asked.id,
      question: 'Is the total shown before or after tax?',
      ended_at: null,
    });

    await call('POST', `/api/questions/${asked.id}/answer`, { round: 1, text: 'after tax' });
    const [ended] = await stallsOn({ issueId: built.id });
    expect(ended?.ended_by).toBe('answered');
    expect(ended?.ended_at).not.toBeNull();
  });

  it('a question voided ends its stall as withdrawn', async () => {
    const req = await requirement(w, 'Invoices carry a due date');
    const built = await issue(w, {
      createdAt: new Date(),
      status: 'in_progress',
      requirementId: req.id,
    });
    const asked = await ask({ issueId: built.id, about: { requirement: null } });
    await call('POST', `/api/questions/${asked.id}/void`, { reason: 'settled in the spec' });
    const [ended] = await stallsOn({ issueId: built.id });
    expect(ended).toMatchObject({ cause: 'unclear_item', ended_by: 'withdrawn' });
  });

  it("a reporter's clarification starts a stall on the feedback item, open until answered", async () => {
    const key = await feedback(w);
    await call('POST', `/api/projects/${w.projectId}/feedback/${key}/clarification`, {
      prompt: 'Which browser shows it?',
      needed: 'The browser and its version',
      recommended: 'Chrome 130 on macOS',
    });
    const [open] = await stallsOn({ feedbackId: await feedbackId(key) });
    expect(open, "the reporter's clarification started no stall").toMatchObject({
      cause: 'unclear_item',
      feedback_id: await feedbackId(key),
      issue_id: null,
      question: 'Which browser shows it?',
      ended_at: null,
    });
  });

  it("a steward's decision about a feedback item is triage, not a stall", async () => {
    const key = await feedback(w);
    const id = await feedbackId(key);
    await ask({ about: { feedbackId: id } });
    expect(await stallsOn({ feedbackId: id })).toEqual([]);
  });
});

describe('defect', () => {
  it("a failed verdict's reopen starts a defect stall on the issue, and its next merge mark ends it", async () => {
    const shipped = await issue(w, {
      createdAt: new Date(),
      status: 'awaiting_release',
      mergedAt: new Date(),
    });
    await reopenOnFail({
      issueId: shipped.id,
      verdictId: randomUUID(),
      authorUserId: w.userId,
      authorDeviceId: null,
      agency: 'human',
      criterion: 1,
      requirement: null,
      reason: 'the total is missing',
    });
    const [open] = await stallsOn({ issueId: shipped.id });
    expect(open, 'the reopen started no defect stall').toMatchObject({
      cause: 'defect',
      issue_id: shipped.id,
      ended_at: null,
    });

    await db.execute(sql`UPDATE issues SET merged_at = NULL WHERE id = ${shipped.id}`);
    const { recordIssueMerge } = await import('../../src/issues/merge-record.js');
    await db.transaction((tx) =>
      recordIssueMerge(tx, {
        issueId: shipped.id,
        evidence: { kind: 'asserted' },
        actor: null,
        via: 'kernel',
      }),
    );
    const [ended] = await stallsOn({ issueId: shipped.id });
    expect(ended?.ended_by).toBe('merged');
  });

  it('a drop ends the defect the issue still holds', async () => {
    const shipped = await issue(w, {
      createdAt: new Date(),
      status: 'awaiting_release',
      mergedAt: new Date(),
    });
    await reopenOnFail({
      issueId: shipped.id,
      verdictId: randomUUID(),
      authorUserId: w.userId,
      authorDeviceId: null,
      agency: 'human',
      criterion: 1,
      requirement: null,
      reason: 'the total is missing',
    });
    await call('POST', `/api/issues/${shipped.id}/transition`, {
      toStatus: 'dropped',
      reason: 'the invoice screen is retired',
    });
    const [ended] = await stallsOn({ issueId: shipped.id });
    expect(ended).toMatchObject({ cause: 'defect', ended_by: 'dropped' });
  });
});

describe('waiting on a person', () => {
  it('a needs_info park starts a wait on the issue, and leaving the park ends it', async () => {
    const built = await issue(w, { createdAt: new Date(), status: 'in_progress' });
    await call('POST', `/api/issues/${built.id}/transition`, {
      toStatus: 'needs_info',
      reason: 'Which tax rate applies to exports?',
      waitingKind: 'needs_answer',
    });
    const [open] = await stallsOn({ issueId: built.id });
    expect(open, 'the park started no wait').toMatchObject({
      cause: 'waiting_on_person',
      issue_id: built.id,
      ended_at: null,
    });

    await call('POST', `/api/issues/${built.id}/transition`, {
      toStatus: 'in_progress',
      reason: 'zero-rated, the owner said',
    });
    const [ended] = await stallsOn({ issueId: built.id });
    expect(ended).toMatchObject({ cause: 'waiting_on_person', ended_by: 'resumed' });
  });
});
