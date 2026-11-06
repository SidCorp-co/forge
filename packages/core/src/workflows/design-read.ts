// The design page's own read (`GET /api/projects/:id/workflows/:workflow/design`): the design with
// what it owes a person past its step, read from the same records Needs you lists it from
// (`development/needs-you.ts:designRowsOf`): the re-pin group of which it is the base
// (`design-repin-service.ts:repinGroupsOf`), and the places its code and design differ that a person
// decides (`health-read.ts:readWorkflowHealthAs`, `needsYou`), which Needs you leaves to the re-pin
// row where the design is itself one of a group's dependents. So Where it stands never says
// "Nobody · nothing next" while Needs you counts something owed on the design (REQ-68 BC-5; judge
// run d47d6de0 at dev.489 on Issue lifecycle and Forge in context).

import type { DesignOwed } from '@forge/contracts/design-owed';
import type { DesignStatus } from '@forge/contracts/design-status';
import { whoOwes } from '@forge/contracts/who-owes';
import { requireDeclaredOn } from '../permissions/index.js';
import { readOwedPolicy } from '../project-config/index.js';
import { repinGroupsOf } from './design-repin-service.js';
import { designView, rowIn } from './design-service.js';
import { readWorkflowHealthAs } from './health-read.js';
import type { WorkflowWriter } from './service.js';
import type { StoredWorkflow } from './store.js';

/** The design steps whose own wait names somebody: the page's line is theirs, and nothing owed is read. */
const STEP_OWES: ReadonlySet<DesignStatus> = new Set(['draft', 'proposed', 'returned']);

/** What the design owes a person past its step, as Needs you lists it. */
export async function designOwedOf(
  viewer: WorkflowWriter,
  projectId: string,
  row: StoredWorkflow,
): Promise<DesignOwed> {
  const [groups, health, policy] = await Promise.all([
    repinGroupsOf(projectId),
    readWorkflowHealthAs(viewer, projectId, row.id),
    readOwedPolicy(projectId),
  ]);
  const own = groups.find((g) => g.baseId === row.id) ?? null;
  const dependent = groups.some((g) => g.ready.some((d) => d.workflowId === row.id));
  return {
    flow: row.flow,
    repin: own ? { flow: own.flow, revision: own.revision, n: own.ready.length } : null,
    settle: dependent ? 0 : health.needsYou,
    settleBy: whoOwes('design.decide', policy).by,
  };
}

export async function readDesignAs(viewer: WorkflowWriter, projectId: string, id: string) {
  await requireDeclaredOn(projectId, viewer.userId, 'project.read');
  const row = await rowIn(projectId, id);
  const stepOwes = row.designStatus !== null && STEP_OWES.has(row.designStatus);
  return designView(row, viewer, stepOwes ? null : await designOwedOf(viewer, projectId, row));
}
