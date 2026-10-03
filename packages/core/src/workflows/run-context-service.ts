import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { DesignStatus } from './design.js';
import {
  ARTIFACT_CONTEXT_KEY,
  artifactContext,
  artifactContextRecord,
  type LoadedArtifact,
  type TracedDesignRow,
} from './run-context.js';

/** Every workflow `issueId` builds, with the design row of its approved revision (null when none holds it). */
export async function tracedDesignsOf(issueId: string): Promise<TracedDesignRow[]> {
  const rows = (await db.execute(sql`
    SELECT w.id, w.flow, w.design_status, w.revision, w.approved_revision,
           d.workflow_id IS NOT NULL AS has_row, d.document, d.decision
    FROM workflow_builds wb
    JOIN project_workflows w ON w.id = wb.workflow_id
    LEFT JOIN project_workflow_designs d
      ON d.workflow_id = w.id AND d.revision = w.approved_revision
    WHERE wb.issue_id = ${issueId}
    ORDER BY w.flow
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    workflowId: String(r.id),
    flow: String(r.flow),
    designStatus: (r.design_status as DesignStatus | null) ?? null,
    workflowRevision: Number(r.revision),
    approvedRevision: r.approved_revision == null ? null : Number(r.approved_revision),
    revisionRow: r.has_row
      ? { document: r.document, decision: (r.decision as string | null) ?? null }
      : null,
  }));
}

/** The approved designs a build job on `issueId` is given; empty when the issue builds none. */
export async function loadArtifactContext(issueId: string): Promise<LoadedArtifact[]> {
  return artifactContext(await tracedDesignsOf(issueId));
}

/** Stamps the load on the job's session metadata, merged so no other key is touched. */
export async function recordArtifactContext(
  agentSessionId: string,
  loaded: readonly LoadedArtifact[],
  source: string,
): Promise<void> {
  const patch = { [ARTIFACT_CONTEXT_KEY]: artifactContextRecord(loaded, source) };
  await db
    .update(agentSessions)
    .set({
      metadata: sql`coalesce(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(agentSessions.id, agentSessionId));
}
