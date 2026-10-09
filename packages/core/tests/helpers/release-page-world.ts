/**
 * A cut release of two issues tracing one requirement's four criteria (REQ-40): its build the commit
 * its approval was asked at, the verdicts recorded on that build after the cut, and a clip and a
 * picture QA kept of the first. Shared by the files that read a release page: the page itself and
 * What's new, which shows the release this instance serves.
 */

import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { getStorage } from '../../src/integrations/index.js';
import { addVerdict, replaceCriteria } from '../../src/issues/criteria/service.js';
import { seedIssueStatus } from './factories.js';
import type { releaseWorld } from './release-world.js';

export const BUILD = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';
export const MERGED = '3b1c2d4e5f60718293a4b5c6d7e8f90112233445';
export const CLIP_BYTES = Buffer.from('webm-bytes-of-the-reminder-clip');

export interface ReleasePageWorldContext {
  projectId: string;
  ownerId: string;
  call(
    who: 'owner' | 'member' | 'agent',
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  fx: ReturnType<typeof releaseWorld>;
}

export interface ReleasePageWorld {
  a: string;
  b: string;
  runId: string;
  approvalId: string;
  clipId: string;
}

const rows = async (query: ReturnType<typeof sql>) => [...(await db.execute(query))];

export function releasePageWorld(context: () => ReleasePageWorldContext) {
  const CTX = new Proxy({} as ReleasePageWorldContext, {
    get: (_t, key) => context()[key as keyof ReleasePageWorldContext],
  });
  async function agreedRequirement(): Promise<{ id: string; bc: Record<string, string> }> {
    const created = await CTX.call('owner', 'POST', '/requirements', {
      title: 'Visit reminders',
      reason: 'planted',
      criteria: [
        { body: 'A nurse sees the reminder' },
        { body: 'A nurse sees it on a phone' },
        { body: 'A doctor sees the visit report' },
        { body: 'A report keeps its filter' },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const key = String(created.body.key);
    for (const [path, body] of [
      [`/requirements/${key}/revisions/1/propose`, {}],
      [`/requirements/${key}/revisions/1/accept`, {}],
      [`/requirements/${key}/agree`, { revision: 1 }],
    ] as const) {
      const r = await CTX.call('owner', 'POST', path, body);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
    }
    const [req] = await rows(sql`SELECT id FROM requirements WHERE project_id = ${CTX.projectId}`);
    const id = String((req as { id: string }).id);
    const bcs = await rows(
      sql`SELECT id, code FROM requirement_criteria WHERE requirement_id = ${id}`,
    );
    return { id, bc: Object.fromEntries(bcs.map((b) => [String(b.code), String(b.id)])) };
  }

  async function traceIssue(issueId: string, requirementId: string, bcs: string[]) {
    await seedIssueStatus(issueId, 'in_progress');
    await db.execute(
      sql`UPDATE issues SET requirement_id = ${requirementId}, planned_revision = 1 WHERE id = ${issueId}`,
    );
    await replaceCriteria(
      issueId,
      bcs.map((bc, i) => ({
        n: i + 1,
        statement: `criterion ${i + 1}`,
        requirementCriterionId: bc,
      })),
    );
    await seedIssueStatus(issueId, 'awaiting_release');
  }

  async function judge(
    issueId: string,
    criterion: number,
    verdict: 'pass' | 'short' | 'fail',
    sha: string,
    extra: { evidence?: string[]; reason?: string } = {},
  ) {
    await addVerdict({
      issue: { id: issueId, projectId: CTX.projectId },
      draft: {
        criterion,
        verdict,
        reason: extra.reason ?? null,
        identity: { kind: 'commit', sha },
        evidence: extra.evidence ?? ['vitest'],
      },
      author: { userId: CTX.ownerId, deviceId: null, agency: 'agent' },
    });
  }

  async function attach(
    issueId: string,
    name: string,
    mime: string,
    bytes: Buffer,
  ): Promise<string> {
    const { path } = await getStorage().put(`release-page/${issueId}/${name}`, bytes, mime);
    const [row] = await rows(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
      VALUES (${issueId}, ${CTX.ownerId}, ${name}, ${path}, ${mime}, ${bytes.length}) RETURNING id
    `);
    return String((row as { id: string }).id);
  }

  /**
   * A cut release of two issues tracing one requirement's four criteria, its build the commit its
   * approval was asked at; then the verdicts recorded on that build after the cut.
   */
  async function releaseWorldOfFour(): Promise<ReleasePageWorld> {
    const req = await agreedRequirement();
    const a = await CTX.fx.insertIssue('awaiting_release', {
      section: 'Added',
      userFacing: 'Nurses see a reminder before each visit.',
    });
    const b = await CTX.fx.insertIssue('awaiting_release', {
      section: 'Fixed',
      userFacing: 'A visit report keeps its filter after a reload.',
      technical: 'The filter is kept in the URL.',
    });
    await traceIssue(a, req.id, [req.bc['BC-1'] as string, req.bc['BC-2'] as string]);
    await traceIssue(b, req.id, [req.bc['BC-3'] as string, req.bc['BC-4'] as string]);
    await db.execute(sql`
      UPDATE issues SET merged_artifacts = ${JSON.stringify([
        {
          surface: 'data',
          ref: 'packages/core/drizzle/migrations/0999_reminders.sql',
          change: 'added',
        },
        { surface: 'config', ref: 'reminders.leadHours', change: 'added' },
        { surface: 'config', ref: 'shares.write', change: 'changed' },
      ])}::jsonb WHERE id = ${a}
    `);
    const clipId = await attach(a, 'reminder.webm', 'video/webm', CLIP_BYTES);
    await attach(a, 'reminder.png', 'image/png', Buffer.from('png-bytes'));
    await judge(a, 1, 'pass', BUILD, { evidence: ['reminder.png', 'reminder.webm'] });
    await judge(a, 2, 'pass', MERGED);
    await judge(b, 1, 'pass', MERGED);
    await judge(b, 2, 'pass', BUILD);
    const cut = await CTX.call('owner', 'POST', '/release-batches', { issueIds: [a, b] });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const runId = String(cut.body.runId);
    const ask = await CTX.call('agent', 'POST', `/release-batches/${runId}/approvals`, {
      evidence: { environment: 'beta', commit: BUILD, reading: 'GET /api/health 200' },
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(201);
    await judge(a, 2, 'short', BUILD, { reason: 'only on a desktop browser' });
    await judge(b, 2, 'fail', BUILD, { reason: 'the filter resets on reload' });
    return { a, b, runId, approvalId: String(ask.body.id ?? ask.body.approvalId), clipId };
  }

  return { agreedRequirement, traceIssue, judge, attach, releaseWorldOfFour };
}
