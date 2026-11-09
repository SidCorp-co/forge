// What waits on a person in some of forge-dev's projects and in none of the plain seed's (ISS-1070
// r20): a cleanup fire that ran a session, a question about a requirement, a design that builds on
// another, a design change an agent proposed. Each is read once a project that holds one, so a
// person's attention sent its statement once for each such project (forge-dev, 2026-11-08: the
// steward reports five times, a question's requirement and the re-pin designs three, a design
// change's workflow twice) while the live mix, holding none, sent it never.

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';

/**
 * A cleanup window whose newest fire ran a session that left the steward's report, as forge's
 * cleanup fires do: the automation standing reads each fire's report through its session
 * (`automation/facts.ts:fireFacts`).
 */
export async function stewardFired(projectId: string, ownerId: string): Promise<void> {
  await db.execute(sql`
    WITH schedule AS (
      INSERT INTO schedules (project_id, name, cron, kind, owner_id)
      VALUES (${projectId}, 'Cleanup window', '0 3 * * *', 'cleanup', ${ownerId}) RETURNING id
    ), run AS (
      INSERT INTO pipeline_runs (project_id, kind, status, started_at, finished_at, metadata)
      VALUES (${projectId}, 'system', 'completed', now() - interval '3 hours', now() - interval '2 hours', '{}'::jsonb)
      RETURNING id
    ), session AS (
      INSERT INTO agent_sessions (project_id, pipeline_run_id, kind, status, metadata)
      SELECT ${projectId}, run.id, 'pipeline', 'completed',
             jsonb_build_object('stewardReport', jsonb_build_object('actions', jsonb_build_array(
               jsonb_build_object('skill', 'cleanup', 'kind', 'proposed', 'summary', 'simplify one read'))))
        FROM run RETURNING id
    )
    INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, session_id, started_at, finished_at)
    SELECT schedule.id, ${projectId}, 'scheduled', 'success', session.id, now() - interval '3 hours', now() - interval '2 hours'
      FROM schedule, session`);
}

/**
 * Two open questions a person owes about the project's first agreed requirement: one asked on no
 * item and one on an open issue, as a run asks a business question (ISS-678). Each names what it
 * is about (`questions/subject.ts:subjectsOf`).
 */
export async function askAboutRequirement(projectId: string): Promise<void> {
  const ask = (issue: SQL, prompt: string) => {
    const steps = [
      {
        round: 1,
        prompt,
        askedAt: new Date(Date.now() - 3_600_000).toISOString(),
        answerShape: 'free_text',
        needed: 'which way the requirement reads',
      },
    ];
    return db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps, about)
      SELECT gen_random_uuid(), ${projectId}, (${issue}), 'open', 'human', ${JSON.stringify(steps)}::jsonb,
             jsonb_build_object('kind', 'requirement', 'requirementId', r.id)
        FROM requirements r WHERE r.project_id = ${projectId} AND r.status = 'agreed'
       ORDER BY r.req_seq LIMIT 1`);
  };
  await ask(sql`NULL::uuid`, 'Which customers does the requirement mean?');
  await ask(
    sql`SELECT id FROM issues WHERE project_id = ${projectId} AND status = 'open' ORDER BY iss_seq LIMIT 1`,
    'Does the issue deliver the whole requirement?',
  );
}

/**
 * Every second design builds on the project's first, pinned at the revision approved: a project
 * whose designs declare a base reads them for a re-pin (`workflows/design-repin-service.ts:repinGroupsOf`).
 */
export async function baseDesigns(projectId: string): Promise<void> {
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      WITH base AS (
        SELECT flow, approved_revision FROM project_workflows
         WHERE project_id = ${projectId} ORDER BY flow LIMIT 1
      ), based AS (
        UPDATE project_workflows w
           SET document = w.document || jsonb_build_object('basedOn', jsonb_build_array(
                 jsonb_build_object('workflow', base.flow, 'revision', base.approved_revision)))
          FROM base
         WHERE w.project_id = ${projectId} AND w.flow <> base.flow
           AND substr(w.flow, 6)::int % 2 = 0
        RETURNING w.id, w.document, w.revision
      )
      UPDATE project_workflow_designs d SET document = based.document
        FROM based WHERE d.workflow_id = based.id AND d.revision = based.revision`);
  });
}

/** An agent's proposed change to each of the project's first two designs, waiting on a person. */
export async function proposeDesignChanges(projectId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO suggestions (project_id, kind, workflow_id, base_revision, payload, fingerprint, status, producer_kind)
    SELECT ${projectId}, 'design_change', w.id, w.revision,
           jsonb_build_object('steps', jsonb_build_array(w.document->'steps'->0->>'id'),
                              'change', 'change', 'reason', 'the step stalls'),
           md5('design-change' || w.id::text), 'proposed', 'agent'
      FROM (SELECT id, revision, document FROM project_workflows
             WHERE project_id = ${projectId} ORDER BY flow LIMIT 2) w`);
}
