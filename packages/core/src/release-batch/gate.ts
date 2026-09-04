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
import { effectiveConfig, listActiveBindingsForEnvironment } from '../integrations/store.js';

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
// cm:guard a prod binding is required and is never enough on its own — rule 3 of ISS-897 puts the release runner ON that binding, so a gate with no binding could never pick a box. What makes the binding a RELEASE TARGET rather than observability is one of two declarations, and the OR is deliberate: a production branch distinct from the base (the release unit is a branch promotion), or `releaseRunnerLabel` on the binding (the operator naming the box that ships it, which no observability binding has any reason to carry). The branch test alone was the whole rule until 2026-09-04 and it read the wrong thing on a storefront: pixelight publishes a theme, so its release unit is the BINDING and its branches are identical by nature — it could not declare a gate at all, and 8 issues sat at `released` with no way forward. Provider identity is NOT the discriminator and must not become one: forge-dev carries an epodsystem prod binding on a trunk repo for the storefront MCP, and reading `epodsystem` as a release target would gate this repo's own closes.
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
  const pair = bindings[0];
  const provider = pair?.binding.provider ?? null;
  const label = pair ? effectiveConfig(pair).releaseRunnerLabel : null;
  const declaresReleaseBox = typeof label === 'string' && label.trim().length > 0;

  return {
    hasProduction: provider !== null && (productionBranch !== baseBranch || declaresReleaseBox),
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
