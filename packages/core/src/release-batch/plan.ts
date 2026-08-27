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

import type { VerifyConfig } from './verify.js';

export interface ReleaseChannel {
  /** `null` when the project declares no production binding: cut and stop. */
  provider: string | null;
  /** Verbatim operator text for the channel. Never contains a credential. */
  instructions: string | null;
  /** Matched against `runners.labels` to pick the boxes allowed to release. */
  releaseRunnerLabel: string | null;
  /** How the kernel proves the deploy landed. `null` → nothing is proven. */
  verify: VerifyConfig | null;
  /** What to do when a deploy comes up dead, verbatim from the operator. */
  rollback: string | null;
}

export interface ReleasePlan extends ReleaseChannel {
  /** `projectFacts.release-procedure`, verbatim. */
  procedure: string | null;
}
