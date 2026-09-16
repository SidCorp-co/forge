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
import { releaseRunnerLabelOf, resolveReleaseChannels } from './channel.js';
import { resolveReleaseDeclaration } from './gate.js';
import type { ReleaseModel, ReleaseStrategy } from '../db/schema.js';
import { RELEASE_PROCEDURE_FACT, type ReleaseRollback } from './plan.js';

export type ReleaseGapKey = string;

export interface ReleaseReadiness {
  hasReleaseGate: boolean;
  releaseModel: ReleaseModel;
  releaseStrategy: ReleaseStrategy | null;
  baseBranch: string;
  /** Non-null only under `promote`. */
  liveBranch: string | null;
  /**
   * `true` where the project declares a release model and has NO live deploy binding — the
   * misconfiguration that used to be indistinguishable from "this project ships nothing".
   */
  targetUndeclared: boolean;
  /** Providers of every live deploy binding. Empty when the project declares none. */
  providers: string[];
  releaseRunnerLabel: string | null;
  /** Verbatim rollback declaration; `null` when the channel performs it or none is declared. */
  rollback: string | null;
  /** How the declaration was read. `null` means abort-and-comment on failure. */
  rollbackMode: ReleaseRollback['kind'] | null;
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
 * `verify-probes` is the hard one: `createReleaseBatch` refuses without it, because
 * a gate with no probes closes its roster on the agent's word (ISS-1042).
 *
 * `rollback` is reported as a gap on a project WITH production because rule 2
 * of ISS-897 makes an undeclared rollback mean "abort and comment, never roll
 * back blind" — a defensible default that an operator should still be told
 * they are running under. `rollback-prose` is the ISS-925 case: a Coolify
 * binding whose declaration is free text Forge no longer executes, which is
 * the same abort wearing a declaration, and names the one binding to convert.
 */
// cm:guard the contract facts are owed by EVERY project, production or not — they are what the driver needs to prove its own work. Only the three release gaps are conditional. Reporting the contract conditionally would make a project with no production look complete while its very first issue has nothing to run.
export async function loadReleaseReadiness(projectId: string): Promise<ReleaseReadiness | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (!decl) return null;

  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const facts = ((row?.agentConfig as { projectFacts?: Record<string, unknown> } | null)
    ?.projectFacts ?? {}) as Record<string, unknown>;

  const channels = decl.kind === 'gated' ? await resolveReleaseChannels(projectId) : [];
  // cm:edge contract -> packages/core/src/projects/autonomous-contract.ts — the unconditional half of the contract is DECLARED there and read here; listing `build-commands` and `test-commands` again would let the two disagree about what a project owes
  const gaps: ReleaseGapKey[] = missingAutonomousFacts(facts).map((f) => f.key);
  // cm:guard `undeclared-target` earns a gap of its own rather than silently behaving like a project
  // with no release step. Settings is where an operator finds out that the project says it releases
  // and has nowhere to release to; before ISS-1046 both shapes answered `null` and the second one was
  // discovered by a release agent being handed an error tracker.
  if (decl.kind === 'undeclared-target') gaps.push('release-target');
  // cm:why the label is read through the same refusal `createReleaseBatch` makes, and a disagreement
  // is reported as a gap rather than thrown: settings must render for a misconfigured project.
  let releaseRunnerLabel: string | null = null;
  try {
    releaseRunnerLabel = releaseRunnerLabelOf(projectId, channels);
  } catch {
    gaps.push('release-runner-ambiguous');
  }
  // cm:why the FIRST channel's verify/rollback answers the readiness flags: settings asks "is the
  // contract declared at all", and a set where one member declares nothing is reported by its own
  // gap rather than by averaging. `createReleaseBatch` is the reader that refuses per channel.
  const first = channels[0] ?? null;
  if (decl.kind === 'gated') {
    if (!isDeclared(facts[RELEASE_PROCEDURE_FACT])) gaps.push('release-procedure');
    if (!releaseRunnerLabel && !gaps.includes('release-runner-ambiguous')) gaps.push('release-runner');
    // cm:edge lockstep -> packages/core/src/release-batch/service.ts — `createReleaseBatch` REFUSES on this, and reporting it here is what gives the operator the gap before a release discovers it. Drop this line and the refusal arrives with nothing in settings having said it was coming.
    if (channels.some((c) => !c.verify)) gaps.push('verify-probes');
    if (channels.some((c) => !c.rollback)) gaps.push('rollback');
    else if (channels.some((c) => c.rollback?.kind === 'unrepresentable')) gaps.push('rollback-prose');
  }

  return {
    hasReleaseGate: decl.kind === 'gated',
    releaseModel: decl.kind === 'no-release' ? 'none' : decl.releaseModel,
    releaseStrategy: decl.kind === 'gated' ? decl.releaseStrategy : null,
    baseBranch: decl.kind === 'undeclared-target' ? '' : decl.baseBranch,
    liveBranch: decl.kind === 'gated' ? decl.liveBranch : null,
    targetUndeclared: decl.kind === 'undeclared-target',
    providers: channels.map((c) => c.provider),
    releaseRunnerLabel,
    rollback: first?.rollback && 'text' in first.rollback ? first.rollback.text : null,
    rollbackMode: first?.rollback?.kind ?? null,
    hasVerify: channels.length > 0 && channels.every((c) => c.verify !== null),
    gaps,
  };
}
