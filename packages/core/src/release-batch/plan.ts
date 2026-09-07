// The shape of a release, with nothing attached that can touch the database.
//
// `channel.ts` reaches Postgres to answer these questions; the prompt builder
// only needs the answers' shape and the fallback text, and importing the
// resolver for that dragged the db client — and therefore the whole env
// contract — into a pure string test.

/** The `projectFacts` key holding this project's repo-side release ritual. */
export const RELEASE_PROCEDURE_FACT = 'release-procedure';

/**
 * What a project gets when it has not written its own procedure: the steps
 * that were hardcoded into the state prompt before this split.
 */
// cm:guard this text is a MIGRATION FLOOR, not a recommendation. Measured 2026-08-24: 17 projects have a release gate and NONE has declared a procedure, so making "no procedure" mean "refuse" would have broken every existing release the day it shipped. Delete it only once every gated project declares its own.
export const DEFAULT_RELEASE_PROCEDURE = `1. If productionBranch ≠ baseBranch: merge baseBranch → productionBranch and push.
   A conflict is an abort, not something to resolve here.
2. If a deploy channel is declared above: \`forge_coolify_deploy { action:'deploy', pipelineRunId: runId }\`.
   Poll \`forge_coolify_deploy { action:'status' }\` in the FOREGROUND until every target is
   'ok' or 'failed' — never end the turn while polling. pendingHumanConfirm:true → abort.
   Any 'failed' → abort.
3. Append ONE line under \`## [Unreleased]\` in CHANGELOG.md on the production branch — one
   sentence for the whole batch, synthesised from the issues' \`releaseNotes.userFacing\`
   (issues with section='Skip' contribute nothing).
   Idempotency: check \`git log --grep="batch release <runId first 8>" --oneline -1\` first;
   non-empty → skip the append.
   Commit message: \`docs(changelog): batch release <runId first 8> (<n> issues)\`.`;

import { type ProjectLike, resolveIssueBranches } from '../branches/resolve.js';
import type { VerifyConfig } from './verify.js';

/** The project has no `baseBranch`, so there is nothing a release could promote from. */
export class ReleaseBranchesUndeclaredError extends Error {
  constructor() {
    super('RELEASE_BRANCHES_UNDECLARED');
    this.name = 'ReleaseBranchesUndeclaredError';
  }
}

export interface ReleaseBranches {
  baseBranch: string;
  productionBranch: string;
  /** False when the project promotes nothing — production IS the base branch. */
  productionMergePlanned: boolean;
}

// cm:guard the branches come from the `projects` columns through the same resolver every other surface uses, and an undeclared base is an ERROR, never `'main'`. The loader this replaced read `agentConfig.branchConfig` — a key nothing writes — and defaulted both sides to `main`; on 2026-09-03 sidpeak (staging → master) cut three release batches whose envelope said `main → main`, and every one aborted on a branch origin does not have.
export function releaseBranches(project: ProjectLike): ReleaseBranches {
  const resolved = resolveIssueBranches({}, project);
  if (!resolved.baseBranch) throw new ReleaseBranchesUndeclaredError();
  const productionBranch = resolved.prodBranch ?? resolved.baseBranch;
  return {
    baseBranch: resolved.baseBranch,
    productionBranch,
    productionMergePlanned: productionBranch !== resolved.baseBranch,
  };
}

/**
 * What this project's channel can do when a deploy comes up dead.
 *
 * `manual` is operator prose for a channel whose API cannot express a
 * rollback. `coolify-image` is the action Forge performs itself.
 * `unrepresentable` is a Coolify binding still carrying prose from before
 * ISS-925: the text is carried so it can be shown, and it is NOT executed.
 */
export type ReleaseRollback =
  | { kind: 'manual'; text: string }
  | { kind: 'coolify-image' }
  | { kind: 'unrepresentable'; text: string };

export interface ReleaseChannel {
  /** `null` when the project declares no production binding: cut and stop. */
  provider: string | null;
  /** Verbatim operator text for the channel. Never contains a credential. */
  instructions: string | null;
  /** Matched against `runners.labels` to pick the boxes allowed to release. */
  releaseRunnerLabel: string | null;
  /** How the kernel proves the deploy landed. `null` → nothing is proven. */
  verify: VerifyConfig | null;
  /** How this project gets back, or `null` when it declares no way. */
  rollback: ReleaseRollback | null;
}

export interface ReleasePlan extends ReleaseChannel {
  /** `projectFacts.release-procedure`, verbatim. */
  procedure: string | null;
}
