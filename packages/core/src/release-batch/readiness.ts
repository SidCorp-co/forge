// What this project still has to declare before its first issue runs.
//
// Every gap below used to be found by a job: the driver discovered it had no
// build command, the release batch discovered no box carried the credential,
// the release agent discovered no procedure and fell back to a floor written
// for somebody else's repo. Each of those is the same fact arriving at the
// worst moment, hours after a person could have typed it.
//
// So the answers are computed where settings can render them. Nothing here
// refuses anything — the refusals live at the point of use (`service.ts` for
// the runner, `release-gate-hold.ts` for the gate). This is the same question
// asked early.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { missingAutonomousFacts } from '../projects/autonomous-contract.js';
import { resolveReleaseChannel } from './channel.js';
import { resolveProductionDeclaration } from './gate.js';
import { RELEASE_PROCEDURE_FACT } from './plan.js';

export type ReleaseGapKey = string;

export interface ReleaseReadiness {
  hasProduction: boolean;
  baseBranch: string;
  productionBranch: string;
  /** Provider of the prod binding, or `null` when the project declares none. */
  provider: string | null;
  releaseRunnerLabel: string | null;
  /** Verbatim rollback declaration; `null` means abort-and-comment on failure. */
  rollback: string | null;
  hasVerify: boolean;
  /** Everything still undeclared. Empty means settings has nothing to say. */
  gaps: ReleaseGapKey[];
}

function isDeclared(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The contract this project owes, and which parts of it are missing.
 *
 * `rollback` is reported as a gap on a project WITH production because rule 2
 * of ISS-897 makes an undeclared rollback mean "abort and comment, never roll
 * back blind" — a defensible default that an operator should still be told
 * they are running under.
 */
// cm:guard the contract facts are owed by EVERY project, production or not — they are what the driver needs to prove its own work. Only the three release gaps are conditional. Reporting the contract conditionally would make a project with no production look complete while its very first issue has nothing to run.
export async function loadReleaseReadiness(projectId: string): Promise<ReleaseReadiness | null> {
  const decl = await resolveProductionDeclaration(projectId);
  if (!decl) return null;

  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const facts = ((row?.agentConfig as { projectFacts?: Record<string, unknown> } | null)
    ?.projectFacts ?? {}) as Record<string, unknown>;

  const channel = await resolveReleaseChannel(projectId);
  // cm:edge contract -> packages/core/src/projects/autonomous-contract.ts — the unconditional half of the contract is DECLARED there and read here; listing `build-commands` and `test-commands` again would let the two disagree about what a project owes
  const gaps: ReleaseGapKey[] = missingAutonomousFacts(facts).map((f) => f.key);
  if (decl.hasProduction) {
    if (!isDeclared(facts[RELEASE_PROCEDURE_FACT])) gaps.push('release-procedure');
    if (!channel.releaseRunnerLabel) gaps.push('release-runner');
    if (!channel.rollback) gaps.push('rollback');
  }

  return {
    hasProduction: decl.hasProduction,
    baseBranch: decl.baseBranch,
    productionBranch: decl.productionBranch,
    provider: decl.provider,
    releaseRunnerLabel: channel.releaseRunnerLabel,
    rollback: channel.rollback,
    hasVerify: channel.verify !== null,
    gaps,
  };
}
