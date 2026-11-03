/**
 * ISS-927 (REQ-67 BC-6, BC-7): a hand reopen for a defect found live is a defect stall, decided only
 * by the transition's structured `cause: defect` and its `evidence`, never by the reason's words. The
 * stall stands until the issue's next merge mark and is counted under Defect on the release that
 * ships the issue. A reopen without the cause is a plain reopen; a defect without its proof, a proof
 * without its cause, a proof not on the issue, and a cause off a reopen are each refused by name.
 */

// @direct-test-of packages/core/src/issues/reopen-cause.ts
// @direct-test-of packages/core/src/issues/stalls.ts
// @direct-test-of packages/core/src/issues/apply-transition.ts
// @direct-test-of packages/core/src/issues/transition.ts
// @direct-test-of packages/core/src/issues/transition-body.ts
// @direct-test-of packages/core/src/db/schema-stalls.ts
// @direct-test-of packages/contracts/src/stalls.ts

import type { ReleasePage } from '@forge/contracts/release-page';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { recordIssueMerge } from '../../src/issues/merge-record.js';
import { api, type Body } from '../helpers/api.js';
import { issue, shipRelease, type World, world } from '../helpers/forecast-world.js';

let w: World;

beforeAll(async () => {
  w = await world();
}, 120_000);

type StallRow = {
  cause: string;
  issue_id: string | null;
  evidence: unknown;
  ended_at: Date | null;
  ended_by: string | null;
};

async function stallsOn(issueId: string): Promise<StallRow[]> {
  return (await db.execute(
    sql`SELECT cause, issue_id, evidence, ended_at, ended_by FROM stalls
        WHERE issue_id = ${issueId} ORDER BY started_at`,
  )) as unknown as StallRow[];
}

/** An issue whose work landed and waits on its release: where a defect found live reopens it. */
const shipped = () =>
  issue(w, { createdAt: new Date(), status: 'awaiting_release', mergedAt: new Date() });

const move = (id: string, body: Record<string, unknown>) =>
  api(w.token, 'POST', `/api/issues/${id}/transition`, body);

const statusOf = async (id: string): Promise<string> => {
  const [row] = (await db.execute(
    sql`SELECT status FROM issues WHERE id = ${id}`,
  )) as unknown as { status: string }[];
  return row?.status as string;
};

const codeOf = (body: Body): string | undefined =>
  (body as { error?: { code?: string } }).error?.code ??
  (body as { code?: string }).code ??
  (body as { refusals?: { code?: string }[] }).refusals?.[0]?.code;

/** Marks the issue merged again, as the next landing's mark does. */
async function markMerged(id: string): Promise<void> {
  await db.execute(sql`UPDATE issues SET merged_at = NULL WHERE id = ${id}`);
  await db.transaction((tx) =>
    recordIssueMerge(tx, {
      issueId: id,
      evidence: { kind: 'asserted' },
      actor: null,
      via: 'kernel',
    }),
  );
}

describe('a reopen naming cause defect with its evidence (c0)', () => {
  it('starts a defect stall on the issue, keeping its evidence, and the next merge mark ends it', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the invoice total is missing on the served build',
      cause: 'defect',
      evidence: { liveRead: 'GET /invoices/42 on forge-dev: the total cell is empty' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [open] = await stallsOn(live.id);
    expect(open, 'the defect reopen started no stall').toMatchObject({
      cause: 'defect',
      issue_id: live.id,
      evidence: { liveRead: 'GET /invoices/42 on forge-dev: the total cell is empty' },
      ended_at: null,
      ended_by: null,
    });

    await markMerged(live.id);
    const stalls = await stallsOn(live.id);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.ended_by).toBe('merged');
    expect(stalls[0]?.ended_at).not.toBeNull();
  });

  it('takes an attachment on the issue as its evidence', async () => {
    const live = await shipped();
    const [attached] = (await db.execute(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
      VALUES (${live.id}, ${w.userId}, 'empty-total.png', 'x/empty-total.png', 'image/png', 10)
      RETURNING id
    `)) as unknown as { id: string }[];
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the screenshot shows the total missing',
      cause: 'defect',
      evidence: { attachmentId: attached?.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await stallsOn(live.id)).toEqual([
      expect.objectContaining({ cause: 'defect', evidence: { attachmentId: attached?.id } }),
    ]);
  });
});

describe('a reopen without the cause, and the refusals (c1)', () => {
  it('a plain reopen starts no stall, whatever its reason says', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'a defect found live: the total is missing',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await stallsOn(live.id)).toEqual([]);
  });

  it('refuses cause defect without evidence by name, and the issue stays where it was', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the total is missing',
      cause: 'defect',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body), JSON.stringify(res.body)).toBe('DEFECT_EVIDENCE_REQUIRED');
    expect(JSON.stringify(res.body)).toContain('liveRead');
    expect(await statusOf(live.id)).toBe('awaiting_release');
    expect(await stallsOn(live.id)).toEqual([]);
  });

  it('refuses evidence without its cause by name', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the total is missing',
      evidence: { liveRead: 'the total cell is empty' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('DEFECT_CAUSE_REQUIRED');
    expect(await statusOf(live.id)).toBe('awaiting_release');
  });

  it('refuses evidence in a shape it does not take by name, naming the shapes it does', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the total is missing',
      cause: 'defect',
      evidence: 'the total cell is empty',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(codeOf(res.body), JSON.stringify(res.body)).toBe('DEFECT_EVIDENCE_SHAPE');
    expect(JSON.stringify(res.body)).toContain('verdictId');
  });

  it('refuses a verdict that is not on the issue by name', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the total is missing',
      cause: 'defect',
      evidence: { verdictId: '00000000-0000-4000-8000-000000000927' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(codeOf(res.body)).toBe('DEFECT_EVIDENCE_NOT_FOUND');
    expect(await statusOf(live.id)).toBe('awaiting_release');
    expect(await stallsOn(live.id)).toEqual([]);
  });

  it('refuses a cause on a move to any status but reopen by name', async () => {
    const built = await issue(w, { createdAt: new Date(), status: 'in_progress' });
    const res = await move(built.id, {
      toStatus: 'on_hold',
      reason: 'paused while the total is fixed',
      cause: 'defect',
      evidence: { liveRead: 'the total cell is empty' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('CAUSE_NOT_APPLICABLE');
    expect(await statusOf(built.id)).toBe('in_progress');
    expect(await stallsOn(built.id)).toEqual([]);
  });
});

describe('the release that ships the issue (c2)', () => {
  it('counts the defect reopen under Defect on the release page', async () => {
    const live = await shipped();
    const res = await move(live.id, {
      toStatus: 'reopen',
      reason: 'the invoice total is missing on the served build',
      cause: 'defect',
      evidence: { liveRead: 'GET /invoices/42 on forge-dev: the total cell is empty' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await markMerged(live.id);

    const version = await shipRelease(w, [live.id], new Date(Date.now() + 60_000));
    await db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || '{"source":"release-record"}'::jsonb
      WHERE project_id = ${w.projectId} AND release_version = ${version}
    `);
    const page = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/releases/${version}/page?view=user`,
    );
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const stalls = (page.body as unknown as ReleasePage).stalls;
    expect(stalls?.counts).toEqual({ unclear_item: 0, defect: 1, waiting_on_person: 0 });
    expect(stalls?.stalls).toEqual([
      expect.objectContaining({
        cause: 'defect',
        issue: expect.objectContaining({ key: live.key }),
        endedAt: expect.any(String),
      }),
    ]);
  });
});
