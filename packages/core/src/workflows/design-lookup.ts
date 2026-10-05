import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { projectWorkflowDesigns, projectWorkflows } from '../db/schema-workflows.js';

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
