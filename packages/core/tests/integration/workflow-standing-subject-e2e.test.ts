// REQ-68 BC-5 (ISS-687): a workflow is a standing subject. Migration 0597 admits `workflow` in
// `steward_notes_subject_kind_chk` and `steward_runs_subject_kind_chk`, so the steward's note and run
// on a workflow are kept and read back; the standing read lists a workflow under a design step, by its
// flow, with the step it is at, whom it waits on and what is next, and rests an approved one.
//
// @direct-test-of packages/core/drizzle/migrations/0597_a_workflow_is_a_standing_subject.sql
// @direct-test-of packages/core/src/workflows/standing-read.ts
// @direct-test-of packages/core/src/standing/read.ts

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { openStandings, standingOfSubject } from '../../src/standing/index.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let projectId = '';
let userId = '';

async function workflow(flow: string, status: string, approved: number | null): Promise<string> {
  const doc = { schema: 1, kind: 'flow', project: projectId, flow, steps: [] };
  return withKernelMarker(db, async (tx) => {
    const [wf] = (await tx.execute(sql`
      INSERT INTO project_workflows
        (project_id, flow, kind, revision, document, design_status, approved_revision, written_by_user)
      VALUES (${projectId}, ${flow}, 'flow', 1, ${JSON.stringify(doc)}::jsonb, ${status}, ${approved}, ${userId})
      RETURNING id`)) as unknown as { id: string }[];
    if (!wf) throw new Error(`no workflow ${flow}`);
    await tx.execute(sql`
      INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user)
      VALUES (${wf.id}, 1, ${JSON.stringify(doc)}::jsonb, ${userId})`);
    return wf.id;
  });
}

beforeAll(async () => {
  userId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(userId)).id;
});

describe('a workflow is a standing subject (REQ-68 BC-5)', () => {
  it('keeps a steward note and a steward run on a workflow and reads them back', async () => {
    const id = await workflow('ward-round', 'proposed', null);
    const [run] = await rows<{ id: string; subject_kind: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before)
      VALUES (${projectId}, 'workflow', ${id}, 'ward-round', 'standing.changed', '[]'::jsonb,
              ARRAY['note']::text[], 'queued', now())
      RETURNING id, subject_kind`);
    expect(run?.subject_kind).toBe('workflow');
    await rows(sql`
      INSERT INTO steward_notes (project_id, subject_kind, subject_id, lines, cites, claims, basis,
                                 written_by, run_id)
      VALUES (${projectId}, 'workflow', ${id},
              ARRAY['ward-round waits on its design approver.', 'Next: approve or return it.']::text[],
              ${JSON.stringify([{ kind: 'workflow', ref: 'ward-round' }])}::jsonb, '{}'::jsonb, 'b',
              ${userId}, ${run?.id})`);
    const back = await rows<{ subject_kind: string; lines: string[] }>(sql`
      SELECT subject_kind, lines FROM steward_notes WHERE subject_id = ${id}`);
    expect(back).toEqual([
      {
        subject_kind: 'workflow',
        lines: ['ward-round waits on its design approver.', 'Next: approve or return it.'],
      },
    ]);
    const runs = await rows<{ subject_kind: string }>(sql`
      SELECT subject_kind FROM steward_runs WHERE subject_id = ${id}`);
    expect(runs).toEqual([{ subject_kind: 'workflow' }]);
  });

  it('refuses a subject kind the CHECK does not name', async () => {
    const refused = await rows(sql`
        INSERT INTO steward_notes (project_id, subject_kind, subject_id, lines, cites, claims, basis, written_by)
        VALUES (${projectId}, 'release', gen_random_uuid(), ARRAY['x']::text[], '[]'::jsonb, '{}'::jsonb,
                'b', ${userId})`).then(
      () => null,
      (e: { cause?: { constraint_name?: string } }) => e.cause?.constraint_name ?? String(e),
    );
    expect(refused).toBe('steward_notes_subject_kind_chk');
  });

  it('lists a workflow under a design step with its step, whom it waits on and what is next', async () => {
    await workflow('discharge', 'returned', null);
    await workflow('admission', 'approved', 1);
    const items = await openStandings(projectId);
    const flows = items.filter((i) => i.subject.kind === 'workflow').map((i) => i.subject.key);
    expect(flows.sort()).toEqual(['discharge', 'ward-round']);
    const proposed = items.find((i) => i.subject.key === 'ward-round');
    expect(proposed?.waitingOn.kind).toBe('person');
    expect(proposed?.waitingOn.says.who.key).toBe('standing.who.holderOf');
    expect(proposed?.waitingOn.says.act.key).toBe('designs.act.approveOrReturn');
    const returned = await standingOfSubject(projectId, 'workflow', 'discharge');
    expect(returned?.waitingOn.kind).toBe('agent');
    expect(returned?.waitingOn.says.act.key).toBe('designs.act.reviseR');
    // the note written in the first case is its current note, read with it
    expect(proposed?.note?.lines[0]).toBe('ward-round waits on its design approver.');
    // an approved design owes nobody a step: it rests, and is no open item
    expect(flows).not.toContain('admission');
    const approved = await standingOfSubject(projectId, 'workflow', 'admission');
    expect(approved?.group).toBe('done');
    expect(approved?.waitingOn.kind).toBe('none');
  });
});
