// Does this project have a production to release TO, and therefore a gate?
//
// ISS-764 asked the question of `states.tested` — a stage of the staged ladder,
// whose `mode: 'manual'` was read as "this project parks before release". That
// made the gate an artefact of a lane that no longer exists, and it meant a
// project answered "do I ship to production?" by configuring a stage it never
// ran. ISS-897 asks the project instead: a production is a place to send code
// (an active `prod` binding) AND a branch that is not the one the driver
// already merged into.
//
// The answer is `'released'` or nothing. There is no third state and no
// per-project status name: `released` means merged to the base branch, run and
// verified on staging, waiting for production — and a project with nothing to
// release does not get a button for it.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { listActiveBindingsForEnvironment } from '../integrations/store.js';

/** The one status an issue waits at for production. */
export const RELEASE_GATE_STATUS: IssueStatus = 'released';

export interface ProductionDeclaration {
  hasProduction: boolean;
  baseBranch: string;
  productionBranch: string;
  /** Provider of the oldest active `prod` binding, or `null` when there is none. */
  provider: string | null;
}

/**
 * The two halves of "has production", answered together because a caller that
 * has one and not the other cannot explain to an operator which half is
 * missing — and rule 6 of ISS-897 is that settings must say which.
 */
// cm:guard both halves are required, and the AND is the whole rule. A prod binding on a trunk-based project (base === production) is an observability or storefront binding, not a release target — forge-dev carries two and deliberately has no gate. A distinct production branch with no binding is a project that has not finished declaring how it ships, and rule 3 of ISS-897 makes the release runner live on that binding, so a gate without one could never pick a box.
export async function resolveProductionDeclaration(
  projectId: string,
): Promise<ProductionDeclaration | null> {
  const [row] = await db
    .select({
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;

  const baseBranch = row.baseBranch ?? 'main';
  const productionBranch = row.productionBranch ?? 'main';
  const bindings = await listActiveBindingsForEnvironment(projectId, 'prod');
  const provider = bindings[0]?.binding.provider ?? null;

  return {
    hasProduction: provider !== null && productionBranch !== baseBranch,
    baseBranch,
    productionBranch,
    provider,
  };
}

/**
 * The status issues must be at to join a batch release, or `null` when the
 * project ships nowhere else and the driver's `closed` means what it says.
 *
 * The caller 409s with `NO_RELEASE_GATE` on `null`; the UI hides the release
 * action; `issues/release-gate-hold.ts` stops rewriting the agent's close.
 */
export async function resolveReleaseGate(projectId: string): Promise<IssueStatus | null> {
  const decl = await resolveProductionDeclaration(projectId);
  return decl?.hasProduction ? RELEASE_GATE_STATUS : null;
}
