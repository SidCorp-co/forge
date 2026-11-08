// What a project on forge-dev holds beside its rows that the scale seed (`scale-world.ts`) does not:
// a production environment deployed through a binding, a live master with an open pass, a place in
// an ecosystem, and suggestions waiting on a feedback item and a requirement (ISS-1070 r12). Each
// sends a read of its own that the seed never reached, so a read once a project looked flat here
// while forge-dev's header (`X-Forge-Statement-Shapes`) named it ten or thirteen times. Forge's own
// project also lists feedback reported through the Forge door from other projects' issues.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { ecosystemDoc } from './ecosystem-world.js';
import { createTestDevice } from './factories.js';
import { seedProduction } from './release-world.js';
import { TRIAGE_ANSWERS } from './triage-answers.js';

/** One ecosystem stewarded by `orgId`, which {@link wireLive} puts each project in. */
export async function seedEcosystem(ownerId: string, orgId: string): Promise<string> {
  const id = randomUUID();
  const code = `W${id.slice(0, 4).toUpperCase()}`;
  const doc = ecosystemDoc(orgId, `wired-${id.slice(0, 8)}`, code);
  doc.ecosystem.id = id;
  await db.execute(sql`
    INSERT INTO ecosystems (id, slug, channel_code, steward_org_id, revision, document, updated_by)
    VALUES (${id}, ${doc.ecosystem.slug}, ${code}, ${orgId}, 1, ${JSON.stringify(doc)}::jsonb, ${ownerId})`);
  return id;
}

/**
 * Wires one seeded project as a forge-dev project is: production deployed through a deploy binding
 * (no probe and no deploy target, so reading it reaches no network), a live master on a box with an
 * open pass naming an issue, an active membership of `ecosystemId`, and a proposed triage on its
 * first feedback item and breakdown on its first requirement.
 */
export async function wireLive(
  projectId: string,
  ownerId: string,
  ecosystemId: string,
): Promise<void> {
  await seedProduction({ projectId, ownerId, probes: 'none' });
  const deviceId = await createTestDevice(ownerId);
  const runId = randomUUID();
  const master = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now() - interval '1 hour', '{}'::jsonb)`);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, started_at, created_at, last_heartbeat_at)
    VALUES (${master}, ${projectId}, ${deviceId}, ${runId}, 'master', 'running', now() - interval '1 hour',
            now() - interval '1 hour', now() - interval '10 seconds')`);
  await db.execute(sql`
    INSERT INTO master_passes (project_id, master_session_id, verb, issue_key, started_at)
    VALUES (${projectId}, ${master}, 'dispatch', 'ISS-1', now() - interval '5 minutes')`);
  await db.execute(sql`
    INSERT INTO ecosystem_memberships (ecosystem_id, project_id, state, invited_by, decided_by, decided_at)
    VALUES (${ecosystemId}, ${projectId}, 'active', ${ownerId}, ${ownerId}, now())`);
  const payload = {
    answers: TRIAGE_ANSWERS,
    route: 'issue',
    issue: 'ISS-1',
    note: 'the same crash',
  };
  await db.execute(sql`
    INSERT INTO suggestions (project_id, kind, feedback_id, payload, fingerprint, status, producer_kind)
    SELECT ${projectId}, 'feedback_triage', f.id, ${JSON.stringify(payload)}::jsonb, md5(f.id::text), 'proposed', 'agent'
      FROM feedback f WHERE f.project_id = ${projectId} ORDER BY f.fb_seq LIMIT 1`);
  await db.execute(sql`
    INSERT INTO suggestions (project_id, kind, requirement_id, base_revision, payload, fingerprint, status, producer_kind)
    SELECT ${projectId}, 'breakdown', r.id, r.current_revision, '{"issues":[]}'::jsonb, md5(r.id::text), 'proposed', 'agent'
      FROM requirements r WHERE r.project_id = ${projectId} AND r.current_revision IS NOT NULL
     ORDER BY r.req_seq LIMIT 1`);
}

/**
 * Reports of `home`'s feedback through the Forge door, each from another project and naming one of
 * its issues, as Forge's own feedback is reported from every project on forge-dev.
 */
export async function forgeDoorReports(
  home: string,
  from: readonly string[],
  reportedBy: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO feedback_occurrences (feedback_id, reported_by, reporter_agency, source_project_id, source_issue_id)
    SELECT f.id, ${reportedBy}, 'agent', s.project_id,
           (SELECT i.id FROM issues i WHERE i.project_id = s.project_id ORDER BY i.iss_seq LIMIT 1)
      FROM (SELECT id, row_number() OVER (ORDER BY fb_seq) AS n FROM feedback WHERE project_id = ${home}) f
      JOIN (SELECT p, row_number() OVER () AS n FROM unnest(${sql.param([...from])}::uuid[]) AS p) s(project_id, n)
        ON s.n = f.n`);
}
