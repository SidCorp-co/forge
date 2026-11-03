/**
 * ISS-696 (REQ-67 BC-7): each release page reports its stalls by cause — unclear item, defect,
 * waiting on a person — read through the release's roster: a stall on a roster issue, or asked on no
 * issue about an item a roster issue delivers or carries, that started before the release went out.
 * One still standing reads open; a release with none counts zero of each.
 */

// @direct-test-of packages/core/src/issues/stalls-read.ts
// @direct-test-of packages/core/src/release-page/read.ts
// @direct-test-of packages/core/src/release-page/share-source.ts
// @direct-test-of packages/contracts/src/release-page.ts
// @direct-test-of packages/contracts/src/stalls.ts

import { randomUUID } from 'node:crypto';
import type { ReleasePage } from '@forge/contracts/release-page';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { reopenOnFail } from '../../src/issues/fail-reopen.js';
import { askQuestion } from '../../src/questions/index.js';
import { api } from '../helpers/api.js';
import {
  ago,
  feedback,
  issue,
  requirement,
  shipRelease,
  type World,
  world,
} from '../helpers/forecast-world.js';

let w: World;

beforeAll(async () => {
  w = await world();
  // the in-process ask below queues its notice: the first request starts the queue it needs
  await api(w.token, 'GET', `/api/projects/${w.projectId}`);
}, 120_000);

/** A release recorded as shipping `issueIds` at `at`, as the release record reads one. */
async function cut(world: World, issueIds: readonly string[], at: Date): Promise<string> {
  const version = await shipRelease(world, issueIds, at);
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = metadata || '{"source":"release-record"}'::jsonb
    WHERE project_id = ${world.projectId} AND release_version = ${version}
  `);
  return version;
}

async function page(version: string): Promise<ReleasePage> {
  const res = await api(
    w.token,
    'GET',
    `/api/projects/${w.projectId}/releases/${version}/page?view=user`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as ReleasePage;
}

const ask = (over: Record<string, unknown>) =>
  askQuestion({
    id: randomUUID(),
    projectId: w.projectId,
    askedBy: w.userId,
    prompt: 'Which currency do exports show?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the currency' },
    ...over,
  } as Parameters<typeof askQuestion>[0]);

describe('a release reports its stalls by cause', () => {
  it('counts each cause on its roster and lists each stall with its item and question', async () => {
    const req = await requirement(w, 'Exports show a currency');
    const unclear = await issue(w, {
      createdAt: new Date(),
      status: 'in_progress',
      requirementId: req.id,
    });
    await ask({ issueId: unclear.id, about: { requirement: null } });

    const defect = await issue(w, {
      createdAt: new Date(),
      status: 'awaiting_release',
      mergedAt: new Date(),
    });
    await reopenOnFail({
      issueId: defect.id,
      verdictId: randomUUID(),
      authorUserId: w.userId,
      authorDeviceId: null,
      agency: 'human',
      criterion: 1,
      requirement: null,
      reason: 'the export has no currency',
    });

    const waiting = await issue(w, { createdAt: new Date(), status: 'in_progress' });
    const parked = await api(w.token, 'POST', `/api/issues/${waiting.id}/transition`, {
      toStatus: 'needs_info',
      reason: 'Who signs off the rounding rule?',
      waitingKind: 'needs_decision',
    });
    expect(parked.status, JSON.stringify(parked.body)).toBeLessThan(300);

    // a reporter's clarification on an item a roster issue carries counts too
    const fb = await feedback(w);
    const clarified = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/feedback/${fb}/clarification`,
      { prompt: 'Which export?', needed: 'The export', recommended: 'The CSV one' },
    );
    expect(clarified.status, JSON.stringify(clarified.body)).toBe(200);
    await withKernelMarker(db, async (tx) => {
      const where = sql`project_id = ${w.projectId} AND fb_seq = ${Number(fb.slice(3))}`;
      await tx.execute(sql`UPDATE feedback SET status = 'triaged', route = 'issue' WHERE ${where}`);
      await tx.execute(sql`
        INSERT INTO feedback_route_issues (feedback_id, issue_id)
        SELECT id, ${unclear.id} FROM feedback WHERE ${where}
      `);
    });

    // an issue off the roster stalls nothing here
    const elsewhere = await issue(w, { createdAt: new Date(), status: 'in_progress' });
    await ask({ issueId: elsewhere.id, about: { requirement: req.key } });

    const version = await cut(
      w,
      [unclear.id, defect.id, waiting.id],
      new Date(Date.now() + 60_000),
    );
    const read = await page(version);
    expect(read.stalls, 'the release page carries no stalls section').not.toBeNull();
    expect(read.stalls?.counts).toEqual({ unclear_item: 2, defect: 1, waiting_on_person: 1 });
    const byCause = (cause: string) => read.stalls?.stalls.filter((s) => s.cause === cause) ?? [];
    expect(byCause('unclear_item')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: { kind: 'requirement', key: req.key, title: 'Exports show a currency' },
          issue: expect.objectContaining({ key: unclear.key }),
          question: 'Which currency do exports show?',
          endedAt: null,
        }),
        expect.objectContaining({
          item: expect.objectContaining({ kind: 'feedback', key: fb }),
          issue: null,
          question: 'Which export?',
        }),
      ]),
    );
    expect(byCause('defect')[0]).toMatchObject({
      item: null,
      issue: { key: defect.key },
      endedAt: null,
    });
    expect(byCause('waiting_on_person')[0]).toMatchObject({ issue: { key: waiting.key } });
  });

  it('leaves out a stall that started after the release went out', async () => {
    const shipped = await issue(w, { createdAt: ago(3), status: 'in_progress' });
    const version = await cut(w, [shipped.id], ago(1));
    const parked = await api(w.token, 'POST', `/api/issues/${shipped.id}/transition`, {
      toStatus: 'needs_info',
      reason: 'Who owns the follow-up?',
      waitingKind: 'needs_answer',
    });
    expect(parked.status, JSON.stringify(parked.body)).toBeLessThan(300);
    const read = await page(version);
    expect(read.stalls).toEqual({
      counts: { unclear_item: 0, defect: 0, waiting_on_person: 0 },
      stalls: [],
    });
  });

  it('counts zero of each on a release nothing stalled', async () => {
    const clean = await issue(w, { createdAt: new Date(), status: 'awaiting_release' });
    const version = await cut(w, [clean.id], new Date());
    expect((await page(version)).stalls?.counts).toEqual({
      unclear_item: 0,
      defect: 0,
      waiting_on_person: 0,
    });
  });
});
