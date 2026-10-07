import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  projectWorkflowDesigns,
  projectWorkflows,
  workflowBuilds,
} from '../db/schema-workflows.js';

/** How many of a project's flows are listed when the one named is not among them. */
const FLOWS_LISTED = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A workflow a verdict's design identity names, with every revision it holds — by id anywhere, so
 * a design in another project is refused by name rather than as missing; by flow only within the
 * project, the flow being unique per project and meaningless outside it.
 */
export async function workflowDesign(projectId: string, workflow: string, tx: Tx) {
  const columns = {
    id: projectWorkflows.id,
    flow: projectWorkflows.flow,
    projectId: projectWorkflows.projectId,
    revision: projectWorkflows.revision,
  };
  const [byId] = UUID.test(workflow)
    ? await tx
        .select(columns)
        .from(projectWorkflows)
        .where(eq(projectWorkflows.id, workflow))
        .limit(1)
    : [];
  const [found] = byId
    ? [byId]
    : await tx
        .select(columns)
        .from(projectWorkflows)
        .where(and(eq(projectWorkflows.projectId, projectId), eq(projectWorkflows.flow, workflow)))
        .limit(1);
  if (!found) {
    const flows = await tx
      .select({ flow: projectWorkflows.flow })
      .from(projectWorkflows)
      .where(eq(projectWorkflows.projectId, projectId))
      .orderBy(asc(projectWorkflows.flow))
      .limit(FLOWS_LISTED);
    return { kind: 'missing' as const, flows: flows.map((row) => row.flow) };
  }
  const stored = await tx
    .select({ revision: projectWorkflowDesigns.revision })
    .from(projectWorkflowDesigns)
    .where(eq(projectWorkflowDesigns.workflowId, found.id))
    .orderBy(asc(projectWorkflowDesigns.revision));
  const revisions = [
    found.revision,
    ...stored.map((row) => row.revision).filter((n) => n !== found.revision),
  ];
  return {
    kind: 'found' as const,
    design: { id: found.id, flow: found.flow, projectId: found.projectId, revisions },
  };
}

/** Which of these issues are linked as the build of a workflow: an approval on one is evidence on
 *  it, never its landing (how migration 0450 tells a design issue from one carrying code work). */
export async function buildIssuesAmong(issueIds: readonly string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = await db
    .select({ issueId: workflowBuilds.issueId })
    .from(workflowBuilds)
    .where(inArray(workflowBuilds.issueId, [...issueIds]));
  return new Set(rows.map((r) => r.issueId));
}

/** When each approved revision of these flows was approved, keyed `<flow>@rev<n>`. */
export async function approvedDesignRevisions(
  projectId: string,
  flows: readonly string[],
): Promise<Map<string, Date>> {
  if (flows.length === 0) return new Map();
  const rows = await db
    .select({
      flow: projectWorkflows.flow,
      revision: projectWorkflowDesigns.revision,
      decidedAt: projectWorkflowDesigns.decidedAt,
    })
    .from(projectWorkflowDesigns)
    .innerJoin(projectWorkflows, eq(projectWorkflows.id, projectWorkflowDesigns.workflowId))
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        inArray(projectWorkflows.flow, [...new Set(flows)]),
        eq(projectWorkflowDesigns.decision, 'approve'),
      ),
    );
  return new Map(
    rows.flatMap((r) =>
      r.decidedAt ? [[`${r.flow}@rev${r.revision}`, r.decidedAt] as const] : [],
    ),
  );
}
