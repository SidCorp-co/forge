// A requirement the project's steward has checked since its head was agreed (REQ-67): a finished
// intake check run on it, as the steward's turn leaves one. The move into delivery asks for it while
// the steward is on; a test world runs no steward turn, so it plants the record the turn would write.

import { sql } from 'drizzle-orm';

/** Plants the finished check on the requirement of `projectId` that `ref` names, by key (REQ-n) or id. */
export async function stewardChecked(projectId: string, ref: string): Promise<void> {
  const { db } = await import('../../src/db/client.js');
  const seq = /^REQ-(\d+)$/i.exec(ref)?.[1];
  const [row] = [
    ...((await db.execute(
      seq
        ? sql`SELECT id, req_seq FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(seq)}`
        : sql`SELECT id, req_seq FROM requirements WHERE project_id = ${projectId} AND id = ${ref}::uuid`,
    )) as unknown as Iterable<{ id: string; req_seq: number }>),
  ];
  if (!row) throw new Error(`stewardChecked: project ${projectId} holds no requirement ${ref}`);
  await db.execute(sql`
    INSERT INTO steward_runs
      (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run, state,
       not_before, started_at, ended_at)
    VALUES (${projectId}, 'requirement', ${row.id}, ${`REQ-${row.req_seq}`},
            'requirement.agreed', '[]'::jsonb, ARRAY['intake_check']::text[], 'done',
            now(), now(), now())`);
}

/**
 * A requirement ready for delivery: checked by the steward, and each workflow it links traced from
 * its first live criterion to the workflow's first step, so its picture lights a step (REQ-67 BC-2).
 */
export async function readyForDelivery(projectId: string, ref: string): Promise<void> {
  await stewardChecked(projectId, ref);
  const { db } = await import('../../src/db/client.js');
  const seq = /^REQ-(\d+)$/i.exec(ref)?.[1];
  await db.execute(sql`
    INSERT INTO requirement_criterion_steps (project_id, requirement_id, code, workflow_id, step_id, created_by)
    SELECT r.project_id, r.id, c.code, w.id, w.document -> 'steps' -> 0 ->> 'id', r.owner_id
      FROM requirements r
      JOIN requirement_workflows rw ON rw.requirement_id = r.id
      JOIN project_workflows w ON w.id = rw.workflow_id
      JOIN LATERAL (
        SELECT code FROM requirement_criteria
         WHERE requirement_id = r.id AND retired_revision IS NULL
         ORDER BY code LIMIT 1) c ON true
     WHERE r.project_id = ${projectId}
       AND ${seq ? sql`r.req_seq = ${Number(seq)}` : sql`r.id = ${ref}::uuid`}
       AND w.document -> 'steps' -> 0 ->> 'id' IS NOT NULL
    ON CONFLICT DO NOTHING`);
}
